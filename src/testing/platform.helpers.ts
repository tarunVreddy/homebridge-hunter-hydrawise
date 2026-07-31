/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.helpers.ts: The plugin-specific test harness - the platform double for controller tests, the API double for real-platform construction, the recording
 * MQTT client, the programmable retrieve recorder, the undici MockAgent installer, and the buildController / buildPlatform construction workhorses. Every cast
 * that bridges a double to a production constructor's parameter type is confined to a workhorse, so test bodies stay cast-free.
 *
 * Two wire boundaries by design. Controller tests never touch undici: the platform double's retrieve is a programmable recorder that records every call and
 * returns fixture-programmed response shapes. Platform tests construct a REAL HydrawisePlatform and drive its retrieve() through a MockAgent installed as the
 * global dispatcher after construction, so the real status-code classification and error taxonomy run unchanged.
 */
import { Characteristic, Service, TestAccessory, makeTestAccessory } from "./hap.helpers.ts";
import type { HomebridgePluginLogging, Nullable, RateBudget } from "homebridge-plugin-utils";
import type { HydrawiseControllerConfig, HydrawiseControllerIdentity } from "../hydrawise-types.ts";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { featureOptionCategories, featureOptions } from "../hydrawise-options.ts";
import type { CapturedLogLine } from "../testing.helpers.ts";
import type { Dispatcher } from "undici";
import { FeatureOptions } from "homebridge-plugin-utils";
import { HydrawiseController } from "../hydrawise-controller.ts";
import type { HydrawiseOptions } from "../hydrawise-options.ts";
import { HydrawisePlatform } from "../hydrawise-platform.ts";
import { capturingLog } from "../testing.helpers.ts";
import { setTimeout as delay } from "node:timers/promises";
import { syntheticController } from "../hydrawise-api.fixtures.ts";
import util from "node:util";

/**
 * Scan captured log lines for one at the given level whose fully-formatted text contains the substring. The plugin logs printf-style (a format string plus
 * separate args) through the prefixedLog wrapper, so a raw message-field match would miss any value carried in the args; formatting each line through util.format
 * reproduces the operator-visible text - the controller name prefix, the interpolated values, and all - before the substring check.
 *
 * @param lines     - The captured log lines from a harness result's lines() accessor.
 * @param level     - The log level to match.
 * @param substring - The text to find in the formatted line.
 *
 * @returns True when at least one line at the level formats to a string containing the substring.
 */
export function loggedAt(lines: CapturedLogLine[], level: CapturedLogLine["level"], substring: string): boolean {

  return lines.some(line => (line.level === level) && util.format(line.message, ...line.args).includes(substring));
}

/**
 * Count the captured log lines at the given level whose fully-formatted text contains the substring. Used where a test asserts a line appeared a specific number
 * of times - for example that a repeated discovery pass logged its success line twice.
 *
 * @param lines     - The captured log lines from a harness result's lines() accessor.
 * @param level     - The log level to match.
 * @param substring - The text to find in the formatted line.
 *
 * @returns The number of matching lines.
 */
export function countLogged(lines: CapturedLogLine[], level: CapturedLogLine["level"], substring: string): number {

  return lines.filter(line => (line.level === level) && util.format(line.message, ...line.args).includes(substring)).length;
}

// A recorded MQTT get subscription. The get handler answers the current controller status as a JSON string.
interface RecordedMqttGet {

  handler: () => string;
  topic: string;
  type: string;
}

// A recorded MQTT set subscription. The set handler drives a controller command; only the first (normalized) argument is read by production.
interface RecordedMqttSet {

  handler: (value: string, rawValue: string, signal: AbortSignal) => Promise<void> | void;
  topic: string;
  type: string;
}

// A recorded MQTT publish.
interface RecordedMqttPublish {

  payload: string;
  topic: string;
}

/* A recording double of the homebridge-plugin-utils MqttClient surface the controller consumes: subscribeGet, subscribeSet, publish. It records every
 * subscription and publish so tests invoke a registered get / set handler and assert on the published topics and payloads, all without a live broker. The
 * per-subscription abort signal the controller passes is ignored - these tests assert on recorded traffic, not teardown.
 */
export class TestMqttClient {

  public readonly gets: RecordedMqttGet[] = [];
  public readonly publishes: RecordedMqttPublish[] = [];
  // When set, publish() rejects with this error instead of recording, so a test can drive the guarded-publish failure path. Persistent for the double's per-test
  // lifetime; every test builds a fresh client, so there is no reset machinery.
  public publishRejection: Nullable<Error> = null;
  public readonly sets: RecordedMqttSet[] = [];

  public subscribeGet(topic: string, type: string, getValue: () => string): void {

    this.gets.push({ handler: getValue, topic, type });
  }

  public subscribeSet(topic: string, type: string, setValue: (value: string, rawValue: string, signal: AbortSignal) => Promise<void> | void): void {

    this.sets.push({ handler: setValue, topic, type });
  }

  public async publish(topic: string, payload: string): Promise<void> {

    if(this.publishRejection) {

      throw this.publishRejection;
    }

    this.publishes.push({ payload, topic });
  }

  // Invoke the recorded get handler for a topic suffix (matched by suffix so callers need not reproduce the full per-controller prefix). Returns the handler's value.
  public invokeGet(topicSuffix: string): string | undefined {

    return this.gets.find(entry => entry.topic.endsWith(topicSuffix))?.handler();
  }

  // Invoke the recorded set handler for a topic suffix. The controller's set handler reads only the first (normalized) argument, so rawValue mirrors value by default.
  public async invokeSet(topicSuffix: string, value: string): Promise<void> {

    const entry = this.sets.find(record => record.topic.endsWith(topicSuffix));

    await entry?.handler(value, value, new AbortController().signal);
  }
}

// One recorded retrieve call: the endpoint the controller asked for and the params it passed. The recorder keeps these so a test asserts on the wire traffic
// (the statusschedule cadence, the setzone params) without any real network.
export interface RecordedRetrieveCall {

  endpoint: string;
  params: Record<string, string> | undefined;
}

/* A single programmed response for the retrieve recorder. "response" resolves body.json() to the given body; "null" returns null (the recoverable-error shape
 * the callers treat as a failed poll or command); "malformed" returns a response whose body.json() rejects (the malformed-body shape bug 10 pins).
 */
export type ProgrammedResponse =
  { body: unknown; kind: "response"; statusCode?: number } |
  { kind: "malformed"; statusCode?: number } |
  { kind: "null" };

/* The programmable retrieve recorder that stands in for the platform's retrieve(). It records every call and answers with a per-endpoint FIFO queue of programmed
 * responses, falling back to a per-endpoint steady default (so a live polling loop keeps receiving the same shape once its queue drains) and finally to null.
 * body.json() returns a fresh deep clone per call, so production's reassign-and-trim of this.status never leaks back into the program.
 */
export class RetrieveRecorder {

  public readonly calls: RecordedRetrieveCall[] = [];
  private readonly defaults = new Map<string, ProgrammedResponse>();
  private readonly queues = new Map<string, ProgrammedResponse[]>();

  // Queue a one-shot response for an endpoint, consumed in FIFO order.
  public program(endpoint: string, response: ProgrammedResponse): void {

    const queue = this.queues.get(endpoint) ?? [];

    queue.push(response);
    this.queues.set(endpoint, queue);
  }

  // Set the steady response an endpoint answers with once its one-shot queue drains. A live loop polling faster than the test programs keeps this shape.
  public programDefault(endpoint: string, response: ProgrammedResponse): void {

    this.defaults.set(endpoint, response);
  }

  // Count the recorded calls to a given endpoint.
  public callsTo(endpoint: string): RecordedRetrieveCall[] {

    return this.calls.filter(call => call.endpoint === endpoint);
  }

  // The retrieve replacement handed to the platform double. Records the call, then materializes the next programmed response.
  public readonly retrieve = async (endpoint: string, params?: Record<string, string>): Promise<Nullable<Dispatcher.ResponseData<unknown>>> => {

    this.calls.push({ endpoint, params });

    const chosen = this.queues.get(endpoint)?.shift() ?? this.defaults.get(endpoint) ?? { kind: "null" };

    return this.materialize(chosen);
  };

  // Turn a programmed response into the response shape the callers consume (a body with an async json()), or null. The cast is confined here: the callers touch
  // only body.json() and the null check, so the minimal shape is a faithful stand-in for the full ResponseData.
  private materialize(response: ProgrammedResponse): Nullable<Dispatcher.ResponseData<unknown>> {

    if(response.kind === "null") {

      return null;
    }

    if(response.kind === "malformed") {

      return { body: { json: async (): Promise<unknown> => { throw new Error("Malformed response body."); } }, statusCode: response.statusCode ?? 200 } as
        unknown as Dispatcher.ResponseData<unknown>;
    }

    const body = response.body;

    return { body: { json: async (): Promise<unknown> => structuredClone(body) }, statusCode: response.statusCode ?? 200 } as unknown as
      Dispatcher.ResponseData<unknown>;
  }
}

// The HAP namespace shape both doubles expose: the Service / Characteristic test namespaces plus a deterministic uuid generator that echoes its input, so an
// accessory's UUID is simply the controller id string production hands it.
interface TestHap {

  Characteristic: typeof Characteristic;
  Service: typeof Service;
  uuid: { generate: (data: string) => string };
}

const testHap: TestHap = { Characteristic, Service, uuid: { generate: (data: string): string => data } };

// The platform double's read surface, as the controller and its configure chain consume it. The construction-boundary cast to HydrawisePlatform happens in
// buildController. The api carries updatePlatformAccessories because the controller flushes its persisted zone roster through it; the double records each flush.
export interface TestPlatform {

  api: { hap: TestHap; updatePlatformAccessories: (accessories: TestAccessory[]) => void };
  config: HydrawiseOptions;
  featureOptions: FeatureOptions;
  hap: TestHap;
  log: HomebridgePluginLogging;
  mqtt: Nullable<TestMqttClient>;
  retrieve: RetrieveRecorder["retrieve"];
  signal: AbortSignal;
}

// Options for makeTestPlatform: the platform config overrides, whether to attach a recording MQTT double, whether the platform signal starts pre-aborted (the
// default, which lets a controller construct fully while its polling loop exits silently), and the feature-option strings.
export interface MakeTestPlatformOptions {

  config?: Partial<HydrawiseOptions>;
  mqtt?: boolean;
  signalAborted?: boolean;
  userOptions?: string[];
}

// The handles makeTestPlatform returns: the platform double plus the doubles and capture buffers a test asserts against and the lever to abort a live signal. The
// flushes buffer records every updatePlatformAccessories call the controller makes, so a test asserts on the zone-roster flush cadence.
export interface MakeTestPlatformResult {

  abort: (reason?: string) => void;
  flushes: TestAccessory[][];
  lines: () => CapturedLogLine[];
  mqtt: Nullable<TestMqttClient>;
  platform: TestPlatform;
  retrieve: RetrieveRecorder;
  signalController: AbortController;
}

/* Build a platform double around a REAL FeatureOptions engine seeded with the supplied userOptions, so the production feature-option logic (test / logFeature)
 * runs unchanged. A capturing log records every line and keeps a mutable debug the production platform would reassign; a recording MQTT double captures
 * subscriptions and publishes; the retrieve recorder stands in for the network. The signal starts pre-aborted by default so a constructed controller's loop
 * exits at once; pass signalAborted false for a live-loop test and abort it via the returned lever.
 */
export function makeTestPlatform(options: MakeTestPlatformOptions = {}): MakeTestPlatformResult {

  const { lines, logger } = capturingLog();
  const signalController = new AbortController();

  if(options.signalAborted ?? true) {

    signalController.abort("pre-aborted");
  }

  const mqtt = options.mqtt ? new TestMqttClient() : null;
  const retrieve = new RetrieveRecorder();
  const flushes: TestAccessory[][] = [];
  const featureOpts = new FeatureOptions(featureOptionCategories, featureOptions, options.userOptions);
  const config: HydrawiseOptions = {

    apiKey: "test-api-key",
    debug: false,
    mqttTopic: "hydrawise",
    options: options.userOptions ?? [],
    ...options.config
  };

  const platform: TestPlatform = {

    api: { hap: testHap, updatePlatformAccessories: (accessories: TestAccessory[]): void => { flushes.push(accessories); } },
    config,
    featureOptions: featureOpts,
    hap: testHap,
    log: logger,
    mqtt,
    retrieve: retrieve.retrieve,
    signal: signalController.signal
  };

  return { abort: (reason?: string): void => signalController.abort(reason ?? "test-teardown"), flushes, lines, mqtt, platform, retrieve, signalController };
}

// Options for buildController: the controller-config overrides, an optional program hook, and everything makeTestPlatform accepts.
export interface BuildControllerOptions extends MakeTestPlatformOptions {

  controller?: Partial<HydrawiseControllerConfig>;

  // Program the retrieve recorder before the controller is constructed. The controller's polling loop issues its first retrieve synchronously during
  // construction, so a live-loop test must seed the recorder here rather than after buildController returns, or that first poll consumes the empty program.
  program?: (recorder: RetrieveRecorder) => void;

  // The denormalized account roster the platform would pass into the controller constructor. Defaults to a single-entry roster derived from the controller config,
  // so a test that does not care about siblings gets a sensible self-only roster; a multi-controller test supplies its own.
  roster?: HydrawiseControllerIdentity[];

  // Seed the accessory context before construction, as Homebridge does when it restores a cached accessory. Runs before the controller constructs, so a test can
  // prove configureDevice's wipe-then-seed preserves (or shape-degrades) a prior persisted zone roster.
  seedContext?: (accessory: TestAccessory) => void;
}

// The handles buildController returns: the constructed production controller plus the underlying doubles and capture buffers a test asserts against.
export interface BuildControllerResult extends MakeTestPlatformResult {

  accessory: TestAccessory;
  controller: HydrawiseController;
  controllerConfig: HydrawiseControllerConfig;
}

/* Construct a REAL HydrawiseController against the doubles - the controller-test workhorse. The two construction-boundary casts (platform, accessory) are the only
 * casts a controller test needs; everything the controller then does runs the real production code against the doubles. Returns the constructed controller plus
 * every handle a test asserts on: the TestAccessory (to read services and characteristics), the capture buffers, the recording MQTT double, and the retrieve
 * recorder.
 */
export function buildController(options: BuildControllerOptions = {}): BuildControllerResult {

  const platformResult = makeTestPlatform(options);
  const controllerConfig: HydrawiseControllerConfig = { ...syntheticController, ...options.controller };
  const accessory = makeTestAccessory(controllerConfig.name, testHap.uuid.generate(controllerConfig.controller_id.toString()));
  const roster: HydrawiseControllerIdentity[] = options.roster ?? [{ controllerId: controllerConfig.controller_id, name: controllerConfig.name,
    serialNumber: controllerConfig.serial_number }];

  // Seed the accessory context before construction, as Homebridge restores a cached accessory ahead of configure, so a test can drive the preservation path.
  options.seedContext?.(accessory);

  // Seed the recorder before construction, because the controller's polling loop issues its first retrieve synchronously as the constructor runs.
  options.program?.(platformResult.retrieve);

  // The construction-boundary casts (platform, accessory) bridge the doubles to the production constructor's parameter types - the only casts a controller test needs.
  const controller = new HydrawiseController(platformResult.platform as unknown as ConstructorParameters<typeof HydrawiseController>[0],
    accessory as unknown as ConstructorParameters<typeof HydrawiseController>[1], controllerConfig, roster);

  return { accessory, controller, controllerConfig, ...platformResult };
}

// A double of Homebridge's PlatformAccessory constructor: `new api.platformAccessory(name, uuid)` yields a TestAccessory, exactly what the real platform does on
// its new-device branch.
class TestPlatformAccessory extends TestAccessory {}

// A recorded HAP event handler registered through api.on. The platform stores its DID_FINISH_LAUNCHING and SHUTDOWN handlers here; a test fires them explicitly.
type ApiEventHandler = () => void;

// The API double's surface and the capture buffers a platform test asserts against.
export interface TestApiResult {

  api: unknown;
  emit: (event: string) => void;
  makeAccessory: (displayName: string, uuid: string) => TestAccessory;
  registered: TestAccessory[];
  unregistered: TestAccessory[];
  updated: TestAccessory[][];
}

/* Build the API double for real-platform construction. hap carries the double namespaces and the deterministic uuid generator; platformAccessory is the
 * constructable accessory double; register / update / unregister record their accessories; on captures each handler by event name so a test fires
 * DID_FINISH_LAUNCHING (to run the private configureHydrawise) and SHUTDOWN (to drive teardown) explicitly. emit invokes every handler registered for an event.
 */
export function makeTestApi(): TestApiResult {

  const handlers = new Map<string, ApiEventHandler[]>();
  const registered: TestAccessory[] = [];
  const unregistered: TestAccessory[] = [];
  const updated: TestAccessory[][] = [];

  const api = {

    hap: testHap,
    on: (event: string, handler: ApiEventHandler): unknown => {

      const list = handlers.get(event) ?? [];

      list.push(handler);
      handlers.set(event, list);

      return api;
    },
    platformAccessory: TestPlatformAccessory,
    registerPlatformAccessories: (_plugin: string, _platform: string, accessories: TestAccessory[]): void => { registered.push(...accessories); },
    unregisterPlatformAccessories: (_plugin: string, _platform: string, accessories: TestAccessory[]): void => { unregistered.push(...accessories); },
    updatePlatformAccessories: (accessories: TestAccessory[]): void => { updated.push(accessories); }
  };

  const emit = (event: string): void => {

    for(const handler of handlers.get(event) ?? []) {

      handler();
    }
  };

  return { api, emit, makeAccessory: (displayName: string, uuid: string): TestAccessory => new TestPlatformAccessory(displayName, uuid), registered,
    unregistered, updated };
}

/**
 * Seed a cached accessory onto a real platform through its configureAccessory path, as Homebridge does when it restores accessories before DID_FINISH_LAUNCHING.
 * The construction-boundary cast to the PlatformAccessory parameter type is confined here so a configure test's body stays cast-free.
 *
 * @param platform    - The real HydrawisePlatform to seed.
 * @param displayName - The cached accessory's display name.
 * @param uuid        - The cached accessory's UUID (the platform matches this against the generated controller UUID to reuse it).
 *
 * @returns The seeded TestAccessory, so a test can read its services after discovery reuses it.
 */
export function seedAccessory(platform: HydrawisePlatform, displayName: string, uuid: string): TestAccessory {

  const accessory = new TestPlatformAccessory(displayName, uuid);

  platform.configureAccessory(accessory as unknown as Parameters<HydrawisePlatform["configureAccessory"]>[0]);

  return accessory;
}

/**
 * Read the platform's undici dispatcher through its private field, exposing just the destroyed flag a teardown test asserts on. undici's composed dispatcher
 * carries a public destroyed boolean that flips synchronously when destroy() is called, so a SHUTDOWN test can confirm the handler tore the pool down. The cast
 * is confined here so the test body stays cast-free.
 *
 * @param platform - The constructed HydrawisePlatform.
 *
 * @returns The dispatcher's destroyed view, or undefined when the platform never armed one (the no-API-key path).
 */
export function dispatcherOf(platform: HydrawisePlatform): { destroyed: boolean } | undefined {

  return (platform as unknown as { dispatcher?: { destroyed: boolean } }).dispatcher;
}

/**
 * Read the platform's two rate budgets through their private fields, so a wiring test can assert on the capacities they were constructed with and on the slots a
 * sequence of retrieve() calls consumed. The privacy this reaches past is compile-time only, which is this codebase's posture for every private member, so the
 * cast is confined here exactly as dispatcherOf confines its own: no production code outside the platform can name these budgets without deliberately repeating
 * the same cast.
 *
 * @param platform - The constructed HydrawisePlatform.
 *
 * @returns The account-wide budget and the zone-command budget.
 */
export function budgetsOf(platform: HydrawisePlatform): { account: RateBudget; command: RateBudget } {

  const budgets = platform as unknown as { accountBudget: RateBudget; commandBudget: RateBudget };

  return { account: budgets.accountBudget, command: budgets.commandBudget };
}

// Options for buildPlatform: the platform config the real HydrawisePlatform reads through its bracket-access parameter.
export interface BuildPlatformOptions {

  apiKey?: string;
  debug?: boolean;
  mqttTopic?: string;
  mqttUrl?: string;
  options?: string[];
}

// The handles buildPlatform returns: the constructed production platform plus the API double's capture buffers and the log capture.
export interface BuildPlatformResult extends TestApiResult {

  lines: () => CapturedLogLine[];
  platform: HydrawisePlatform;
}

/* Construct a REAL HydrawisePlatform against the API double - the platform-test workhorse. The two construction-boundary casts (log, api) are the only casts a
 * platform test needs: Homebridge's Logging is a callable with prefix / success / log members, so the plain-object capturing log bridges by cast rather than
 * being reshaped into a callable. The platform's constructor runs its full networking and MQTT setup; a test installs a MockAgent afterward to drive retrieve().
 */
export function buildPlatform(options: BuildPlatformOptions = {}): BuildPlatformResult {

  const { lines, logger } = capturingLog();
  const apiResult = makeTestApi();
  const config = {

    apiKey: options.apiKey ?? "test-api-key",
    debug: options.debug ?? false,
    mqttTopic: options.mqttTopic ?? "hydrawise",
    mqttUrl: options.mqttUrl,
    options: options.options ?? []
  };

  // The construction-boundary casts (log, api) bridge the doubles to the production constructor's parameter types - the only casts a platform test needs.
  const platform = new HydrawisePlatform(logger as unknown as ConstructorParameters<typeof HydrawisePlatform>[0],
    config as unknown as ConstructorParameters<typeof HydrawisePlatform>[1], apiResult.api as ConstructorParameters<typeof HydrawisePlatform>[2]);

  return { lines, platform, ...apiResult };
}

// The Hydrawise API origin every retrieve() request targets. The MockAgent intercepts against this origin.
const HYDRAWISE_ORIGIN = "https://api.hydrawise.com";

// The AsyncDisposable handle installMockDispatcher returns: the MockAgent to program replies on, disposed with `await using` to restore the prior global
// dispatcher and close the agent.
export interface MockDispatcherHandle extends AsyncDisposable {

  agent: MockAgent;
}

/* Install a MockAgent as undici's global dispatcher, snapshotting the dispatcher in place so dispose restores it exactly. undici 8's request() reads the global
 * dispatcher fresh per call, so a MockAgent installed after the platform's constructor already armed a real Pool intercepts every retrieve() from that point.
 * The returned handle is an AsyncDisposable bound with `await using`, so the prior dispatcher is restored and the agent closed at scope exit regardless of throw.
 */
export function installMockDispatcher(): MockDispatcherHandle {

  const prior = getGlobalDispatcher();
  const agent = new MockAgent();

  // Disable net connect so any unintercepted request fails loudly rather than reaching the real Hydrawise API.
  agent.disableNetConnect();
  setGlobalDispatcher(agent);

  return {

    agent,
    async [Symbol.asyncDispose](): Promise<void> {

      setGlobalDispatcher(prior);

      await agent.close();
    }
  };
}

/**
 * Program a JSON reply for a Hydrawise endpoint on the MockAgent, matched by endpoint substring so the api_key query string is ignored. Persists so a controller's
 * repeated polling loop keeps receiving the reply.
 *
 * @param agent    - The MockAgent returned by installMockDispatcher.
 * @param endpoint - The endpoint filename to match (for example "statusschedule.php").
 * @param body     - The JSON body to answer with.
 * @param statusCode - The HTTP status to answer with. Defaults to 200.
 */
export function programJsonReply(agent: MockAgent, endpoint: string, body: object | string, statusCode = 200): void {

  agent.get(HYDRAWISE_ORIGIN).intercept({ method: "GET", path: (path: string): boolean => path.includes(endpoint) }).reply(statusCode, body).persist();
}

/**
 * Program a persisted JSON reply for a Hydrawise endpoint that also counts the requests it serves. undici invokes the body callback once per matched request, so
 * the returned reader measures WIRE calls rather than logical retrieve() calls. That is the distinction a rate-budget pin rests on: a draw that was dispatched
 * instead of awaited lets its caller fall straight through to the request, which shows up here as a request the ceiling should have withheld.
 *
 * @param agent    - The MockAgent returned by installMockDispatcher.
 * @param endpoint - The endpoint filename to match (for example "setzone.php").
 * @param body     - The JSON body to answer with.
 *
 * @returns A reader for the number of requests served so far.
 */
export function programCountedReply(agent: MockAgent, endpoint: string, body: object): () => number {

  let served = 0;

  agent.get(HYDRAWISE_ORIGIN).intercept({ method: "GET", path: (path: string): boolean => path.includes(endpoint) })
    .reply(200, (): object => {

      served++;

      return body;
    }).persist();

  return (): number => served;
}

/**
 * Program a reply that carries a body but a non-JSON status code path, used to drive retrieve()'s status classification. Matched by endpoint substring, one-shot
 * unless persisted by the caller's scenario.
 *
 * @param agent      - The MockAgent returned by installMockDispatcher.
 * @param endpoint   - The endpoint filename to match.
 * @param statusCode - The HTTP status to answer with.
 * @param body       - The reply body. Defaults to an empty string.
 */
export function programStatusReply(agent: MockAgent, endpoint: string, statusCode: number, body: string | object = ""): void {

  agent.get(HYDRAWISE_ORIGIN).intercept({ method: "GET", path: (path: string): boolean => path.includes(endpoint) }).reply(statusCode, body);
}

/**
 * Poll a synchronous predicate until it returns a non-undefined value, yielding through a real short timer between attempts so work waiting on a real event-loop
 * turn - a MockAgent round trip, a fast polling-loop cadence - can complete. Unlike expectAt (which drains only the microtask queue), this advances real time,
 * which is what a MockAgent-driven or live-loop assertion needs. Bounded by a millisecond budget so a never-satisfied predicate fails rather than hanging.
 *
 * @param predicate - Function returning the awaited value, or undefined when not yet available.
 * @param options   - Optional timeout (default 5000ms) and poll interval (default 5ms).
 *
 * @returns The first non-undefined value the predicate returns.
 *
 * @throws If the predicate never returns a value within the timeout budget.
 */
export async function waitFor<T>(predicate: () => T | undefined, options: { intervalMs?: number; timeoutMs?: number } = {}): Promise<T> {

  const intervalMs = options.intervalMs ?? 5;
  const timeoutMs = options.timeoutMs ?? 5000;
  const deadline = Date.now() + timeoutMs;

  for(;;) {

    const value = predicate();

    if(value !== undefined) {

      return value;
    }

    if(Date.now() >= deadline) {

      throw new Error("waitFor: predicate did not yield a value within " + timeoutMs.toString() + "ms.");
    }

    // eslint-disable-next-line no-await-in-loop
    await delay(intervalMs);
  }
}
