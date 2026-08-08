/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.ts: homebridge-hunter-hydrawise platform class.
 */
import type { API, Categories, DynamicPlatformPlugin, HAP, Logging, PlatformAccessory, PlatformConfig } from "homebridge";
import { APIEvent, FeatureOptions, RateBudget, composeSignals, createMqttClient, loopFaultReporter, retry, sanitizeName, superviseLoop }
  from "homebridge-plugin-utils";
import type { CustomerDetailsResponse, HydrawiseAccessory, HydrawiseAccessoryContext, HydrawiseControllerConfig, HydrawiseControllerIdentity, HydrawiseEndpoint,
  HydrawiseZoneIdentity } from "./types.ts";
import { HYDRAWISE_API_BUDGET_CALLS, HYDRAWISE_API_BUDGET_WINDOW, HYDRAWISE_API_RETRY_INTERVAL, HYDRAWISE_API_TIMEOUT, HYDRAWISE_COMMAND_BUDGET_CALLS,
  HYDRAWISE_COMMAND_BUDGET_WINDOW, HYDRAWISE_COMMAND_ENDPOINT, HYDRAWISE_ZONE_ACCESSORY_CATEGORY, HYDRAWISE_ZONE_ACCESSORY_GRACE_POLLS, PLATFORM_NAME,
  PLUGIN_NAME } from "./settings.ts";
import type { HydrawiseGlobalFlagOption, HydrawiseGlobalValueOption, HydrawiseOptions } from "./options.ts";
import type { MqttClient, Nullable } from "homebridge-plugin-utils";
import { Pool, errors, interceptors, request, setGlobalDispatcher } from "undici";
import { controllerIdentity, isZoneAccessoryContext, sameControllerIdentity, sameZoneIdentity, zoneAccessoryId } from "./types.ts";
import { featureOptionCategories, featureOptions } from "./options.ts";
import type { Dispatcher } from "undici";
import { HydrawiseController } from "./controller.ts";
import { STATUS_CODES } from "node:http";
import util from "node:util";

export class HydrawisePlatform implements DynamicPlatformPlugin {

  private readonly accessories: HydrawiseAccessory[];
  private account: CustomerDetailsResponse;
  private readonly accountBudget: RateBudget;
  public readonly api: API;
  private readonly commandBudget: RateBudget;
  private dispatcher?: Dispatcher;
  public readonly featureOptions: FeatureOptions;
  public config: HydrawiseOptions;
  public readonly configuredDevices: Record<string, HydrawiseController | undefined>;
  public readonly hap: HAP;
  public readonly log: Logging;
  public readonly mqtt: Nullable<MqttClient>;
  private readonly shutdownController: AbortController;
  public readonly signal: AbortSignal;

  /* Everything shutdown has to undo, declared in one place and disposed in one call. A DisposableStack runs its registered work in reverse registration order, so
   * the ordering teardown depends on is expressed by the order things are registered rather than by a handler body that has to be read to be trusted, and the
   * order and the work stay together at each registration site.
   *
   * The SYNCHRONOUS variant, deliberately: every teardown this platform registers completes synchronously, and Homebridge's shutdown is observable within the
   * single frame that fires it, so the asynchronous stack would insert a microtask gap between disposers and buy nothing in return. The class is reached as a
   * platform global, which the entry point's polyfill import guarantees exists on every runtime this package supports.
   */
  private readonly teardown = new DisposableStack();

  /* The wire-absence grace state behind reconcileZoneAccessories, keyed by zone-accessory UUID and holding that accessory's count of consecutive polls whose report
   * omitted its zone. It lives in memory only and is deliberately not persisted: a restart clears it, which errs toward RETAINING a HomeKit identity the user
   * placed in a room rather than toward destroying one, and the count rebuilds from the next few polls at no cost.
   */
  private readonly zoneAccessoryGrace = new Map<string, number>();

  constructor(log: Logging, config: PlatformConfig | undefined, api: API) {

    // PlatformConfig exposes user values through an any-typed index signature, so we read each value through a bracket-access cast to its declared type and keep the
    // reads type-checked rather than any. We resolve the options list once and share it between the feature-options engine and our own config snapshot.
    const options = (config?.["options"] as string[] | undefined) ?? [];

    this.accessories = [];
    this.account = {} as CustomerDetailsResponse;
    this.api = api;
    this.configuredDevices = {};
    this.featureOptions = new FeatureOptions(featureOptionCategories, featureOptions, options);
    this.hap = api.hap;
    this.log = log;
    this.log.debug = this.debug.bind(this);
    this.mqtt = null;

    // Scope an AbortController to the platform's lifetime. We assign it and its signal at the top of the constructor, before the missing-API-key early return below,
    // because strict definite-assignment checking requires every constructor path to initialize these readonly fields. Aborting the controller on Homebridge shutdown
    // tears down every signal-aware resource we own through one composed signal.
    this.shutdownController = new AbortController();
    this.signal = this.shutdownController.signal;

    // Make the two ceilings Hydrawise publishes structural rather than advisory. Each window is stated in seconds by its own constant and converted to the
    // milliseconds a RateBudget takes right here, so the conversion sits once, immediately beside the constant it applies to. Both budgets carry the platform's
    // shutdown signal, so a caller still waiting for a slot when Homebridge stops is rejected rather than left pending forever. Construction schedules nothing, so
    // both are built here alongside the signal, ahead of the missing-API-key return below that leaves the rest of the platform unbuilt.
    this.accountBudget = new RateBudget({ capacity: HYDRAWISE_API_BUDGET_CALLS, signal: this.signal, window: HYDRAWISE_API_BUDGET_WINDOW * 1000 });
    this.commandBudget = new RateBudget({ capacity: HYDRAWISE_COMMAND_BUDGET_CALLS, signal: this.signal, window: HYDRAWISE_COMMAND_BUDGET_WINDOW * 1000 });

    // Assemble the effective configuration. This is the one place a raw configuration property and a configured feature option meet: every consolidated setting
    // resolves through the same precedence here, so no reader downstream has to know that a setting has two possible homes.
    this.config = {

      apiKey: this.consolidatedValue("Account.ApiKey", config?.["apiKey"] as string | undefined) ?? "",
      debug: this.consolidatedFlag("Log.Debug", typeof config?.["debug"] === "boolean" ? config["debug"] : undefined),
      mqttTopic: this.consolidatedValue("Mqtt.Topic", config?.["mqttTopic"] as string | undefined),
      mqttUrl: this.consolidatedValue("Mqtt.Url", config?.["mqttUrl"] as string | undefined),
      options
    };

    // No Hydrawise API key, we're done.
    if(!this.config.apiKey.length) {

      this.log.error("Unable to startup: no Hunter Hydrawise API key has been configured. Please configure one and restart the plugin.");

      return;
    }

    // Initialize our network connectivity.
    this.initNetworking();

    /* Initialize MQTT, if needed. The guarded factory answers null for both of the ways MQTT can fail to start - a broker URL or topic prefix that resolves to
     * nothing, and a URL the client cannot parse - so a mistyped MQTT setting degrades to MQTT being off rather than keeping the rest of the plugin from
     * loading. An unusable URL is reported once at error level, with the URL itself redacted so a broker password embedded in it never reaches the log. The
     * platform's shutdown signal ties the client's lifetime to ours.
     */
    this.mqtt = createMqttClient({ brokerUrl: this.config.mqttUrl, log: this.log, topicPrefix: this.config.mqttTopic }, { signal: this.signal });

    this.log.debug("Debug logging on. Expect a lot of data.");

    // Fire up the Hydrawise API once Homebridge has loaded all the cached accessories it knows about and called configureAccessory() on each. We supervise the
    // discovery loop so a genuine configuration fault surfaces once through the reporter, while a shutdown abort unwinds it silently.
    api.on(APIEvent.DID_FINISH_LAUNCHING, () => void superviseLoop({ loop: () => this.configureHydrawise(), onError: loopFaultReporter(this.log, "controller discovery"),
      signal: this.signal }));

    // Tear ourselves down cleanly when Homebridge shuts down. This is the single owner of platform shutdown, and it is one call: disposing the stack runs every
    // registered teardown, synchronously, inside this frame.
    api.on(APIEvent.SHUTDOWN, () => this.teardown.dispose());

    /* Register that teardown work last, once everything it undoes has actually been built. Disposal is reverse registration order, so the dispatcher destroy named
     * first here runs LAST and the signal abort named second runs FIRST: the abort cancels every signal-aware resource we own - the MQTT client, the retry waits,
     * the polling loops, the rate-budget waits - and the destroy then closes the keep-alive Pool connection so it does not outlive us.
     *
     * The dispatcher is read live at disposal time rather than captured here, which keeps this registration correct across initNetworking's destroy-and-rearm. The
     * MQTT client gets no registration of its own: its lifetime IS the composed shutdown signal the abort above already ends, so registering it here would tear it
     * down a second time.
     */
    this.teardown.defer(() => void this.dispatcher?.destroy());
    this.teardown.defer(() => this.shutdownController.abort("shutdown"));
  }

  // This gets called when homebridge restores cached accessories at startup. We intentionally avoid doing anything significant here, and save all that logic for
  // Hydrawise API enumeration.
  public configureAccessory(accessory: HydrawiseAccessory): void {

    // Add this to the accessory array so we can track it.
    this.accessories.push(accessory);
  }

  // Configure and connect to the Hydrawise API.
  private async configureHydrawise(): Promise<void> {

    // Retrieve the account's controllers, retrying forever at a fixed 60-second cadence against the rate-limited API. The retried operation covers only the network
    // truth - the request and the JSON parse - and throws on any failure so retry loops; a resolved value is a successful fetch. Everything downstream runs once,
    // outside the retry, so a genuine configuration fault escapes to the supervisor's reporter rather than becoming a silent 60-second retry.
    this.account = await retry(async (): Promise<CustomerDetailsResponse> => {

      // Get our list of controllers.
      const response = await this.retrieve("customerdetails.php");

      // A null response is a recoverable API error (or a shutdown abort) that retrieve() already classified and logged. Throw so retry waits and tries again.
      if(!response) {

        throw new Error("Unable to retrieve the list of controllers.");
      }

      try {

        return await response.body.json() as CustomerDetailsResponse;
      } catch(error) {

        // A shutdown abort mid-read is orderly teardown - rethrow quietly so the retry loop unwinds through its own signal without logging a spurious parse failure.
        if(this.signal.aborted) {

          throw error;
        }

        this.log.error("Unable to retrieve the list of controllers: %s", util.inspect(error, { colors: true, depth: null, sorted: true }));

        throw error;
      }
    }, { attempts: Infinity, backoff: (): number => HYDRAWISE_API_RETRY_INTERVAL * 1000, signal: this.signal });

    this.log.info("Successfully connected to the Hydrawise API.");

    this.log.debug(util.inspect(this.account, { colors: true, depth: null, sorted: true }));

    // Trim whitespace on irrigation controller names.
    this.account.controllers = this.account.controllers.map(x => ({ ...x, name: x.name.trim() }));

    // Map the trimmed account to the persisted controller-identity shape once, so every controller we configure seeds the same denormalized roster into its accessory
    // context - each accessory then knows every sibling, enabled or not, which is what lets the webUI list the whole account from any one accessory with no cloud call.
    const roster: HydrawiseControllerIdentity[] = this.account.controllers.map(controller => controllerIdentity(controller));

    for(const controller of this.account.controllers) {

      this.log.info("Discovered irrigation controller: %s (serial: %s id: %s).", controller.name, controller.serial_number, controller.controller_id);

      this.configureController(controller, roster);
    }

    // Find all the orphaned accessories this account does not claim and remove them, clearing any grace state a removed accessory carried. We walk a filtered
    // SNAPSHOT of the tracked array so the removal splice never races the walk that drives it.
    for(const accessory of this.accessories.filter(entry => this.isOrphanedAccessory(entry))) {

      this.zoneAccessoryGrace.delete(accessory.UUID);
      this.removeAccessory(accessory);
    }
  }

  /* Whether discovery should sweep an accessory away, dispatched by accessory KIND. Each kind answers to a different authority, which is the whole reason this is
   * a dispatch rather than one predicate.
   *
   * A standalone zone accessory is judged on its OWNER alone - gone from the account, or turned off by the device gate - because discovery cannot know zones at
   * all: customerdetails.php carries no relays, so the only reader that ever sees a zone roster is the poll-cadence reconcile, and zone-level staleness is that
   * reconcile's job. Attempting to re-derive zone truth here would mean guessing.
   *
   * Every other accessory is a controller accessory and keeps the existing rule: it survives only while the account still claims its generated UUID. An accessory
   * whose cached context is malformed or ambiguous fails the zone-kind predicate and is therefore judged by this controller rule - a corrupt zone accessory is
   * removed here and, if its zone is still standalone, promoted again at the next poll. That is self-healing churn, which we prefer to leaving an accessory whose
   * identity we cannot read in place.
   */
  private isOrphanedAccessory(accessory: HydrawiseAccessory): boolean {

    const context = accessory.context;

    if(isZoneAccessoryContext(context)) {

      return !this.account.controllers.some(controller => controller.controller_id === context.ownerController.controllerId) ||
        !this.isControllerEnabled(context.ownerController.serialNumber);
    }

    return !this.account.controllers.some(controller => this.hap.uuid.generate(controller.controller_id.toString()) === accessory.UUID);
  }

  // Whether the user has left a controller enabled. The controller-wide Device gate is keyed on the serial number in the canonical controller position, with the
  // device slot left undefined, matching the runtime's hasFeature convention so the whole plugin resolves controller-scope options against one identity. Discovery
  // and the orphan sweep both ask this question, so it is asked in one place.
  private isControllerEnabled(serialNumber: string): boolean {

    return this.featureOptions.test("Device", undefined, serialNumber);
  }

  /* Resolve one consolidated setting to its effective value. An explicitly configured feature option always rules - its enabled, disabled, and valueless states
   * alike - because configuring an option is the user saying what they want. A legacy configuration property, where one is present, otherwise outranks the
   * catalog default, so a configuration that names only the properties runs correctly without the webUI ever being opened. The legacy arm is transitional and
   * sunsets at the plugin's next major version, at which point the option is the only home a setting has.
   *
   * The legacy argument keeps this file's bracket-access cast posture. A non-string smuggled past that cast by a hand-edited configuration degrades safely at
   * every consumer: the API key gate reads it as no key, and the MQTT factory reads it as nothing configured.
   */
  private consolidatedValue(option: HydrawiseGlobalValueOption, legacy: string | undefined): Nullable<string | undefined> {

    return this.featureOptions.exists(option) ? this.featureOptions.value(option) : legacy ?? this.featureOptions.value(option);
  }

  /* Resolve one consolidated boolean setting to its effective state, the flag twin of the resolver above and the same rule in boolean terms. An explicitly
   * configured feature option rules, enabled or disabled alike, because configuring an option is the user saying what they want. A legacy configuration property,
   * where one carries an actual boolean, otherwise decides. The catalog's own declared default closes the chain, which is what lets a flag whose default is on
   * resolve honestly without a line changing here. The legacy arm sunsets alongside the others.
   */
  private consolidatedFlag(option: HydrawiseGlobalFlagOption, legacy: boolean | undefined): boolean {

    return this.featureOptions.exists(option) ? this.featureOptions.test(option) : legacy ?? this.featureOptions.defaultValue(option);
  }

  // Configure a discovered irrigation controller. The account roster is threaded through to the controller so it can seed its accessory context with every sibling's
  // identity.
  private configureController(controller: HydrawiseControllerConfig, roster: HydrawiseControllerIdentity[]): Nullable<HydrawiseController> {

    // Generate this controller's unique identifier.
    const uuid = this.hap.uuid.generate(controller.controller_id.toString());

    // See if we already know about this accessory or if it's truly new.
    let accessory = this.accessories.find(x => x.UUID === uuid);

    // Check to see if the user has disabled the device.
    if(!this.isControllerEnabled(controller.serial_number)) {

      // If the accessory already exists, let's remove it.
      if(accessory) {

        this.removeAccessory(accessory);
      }

      // We're done.
      return null;
    }

    // If we've already configured this device before, we're done.
    if(this.configuredDevices[uuid]) {

      return null;
    }

    // It's a new device - let's add it to HomeKit.
    accessory ??= this.addAccessory(controller.name, uuid);

    // Inform the user.
    this.log.info("Configuring irrigation controller: %s (serial: %s id: %s).", controller.name, controller.serial_number, controller.controller_id);

    // Add it to our list of configured devices. The controller seeds its accessory context during construction; the flush just below persists that seed.
    this.configuredDevices[uuid] = new HydrawiseController(this, accessory, controller, roster);

    // Refresh the accessory cache.
    this.api.updatePlatformAccessories([accessory]);

    return this.configuredDevices[uuid];
  }

  /* The one creation path for every accessory this platform registers: construct it, register it with Homebridge, and track it. Every creation cadence -
   * discovery-time controller accessories and poll-time standalone zone accessories alike - lands here, so the registration and the tracked array can never
   * disagree about what exists. The category is optional: a controller accessory takes the PlatformAccessory constructor's own default, while a zone accessory
   * declares itself a sprinkler so the Home app renders a lone valve correctly.
   */
  private addAccessory(displayName: string, uuid: string, category?: Categories): HydrawiseAccessory {

    const accessory = new this.api.platformAccessory<HydrawiseAccessoryContext>(displayName, uuid, category);

    // Register this accessory with Homebridge and add it to the accessory array so we can track it. Registration comes first so a failed registration leaves
    // nothing in the tracked array to clean up.
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.accessories.push(accessory);

    return accessory;
  }

  /* Remove the accessory from HomeKit. Removal is reachable from more than one cadence, so it opens with a presence guard: an accessory that is not in the tracked
   * array must be a no-op here, because an indexOf miss would otherwise splice(-1, 1) and silently delete the LAST accessory in the array. The guard precedes the
   * log line too, so a no-op never narrates a removal that did not happen.
   */
  private removeAccessory(accessory: PlatformAccessory): void {

    const index = this.accessories.indexOf(accessory);

    if(index === -1) {

      return;
    }

    // Inform the user.
    this.log.info("%s: Removing device from HomeKit.", accessory.displayName);

    // Unregister the accessory and delete it's remnants from HomeKit.
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.accessories.splice(index, 1);
    this.api.updatePlatformAccessories(this.accessories);
  }

  /* Reconcile this controller's standalone zone accessories against one poll's truth - the single chokepoint through which every zone-accessory creation, context
   * write, and removal passes, so the platform stays the sole registrar and the accessory roster the orphan sweep reads can never fork. The controller calls it
   * once per poll and hosts each zone's valve from the map it returns, so the hosting decision and the pruning decision read one source of truth.
   *
   * The inputs are deliberately different populations, and the difference is what makes configuration intent and wire absence tellable apart. `zones` is the
   * REQUEST - one entry per zone that should be standalone right now, carrying the zone's effective display name and its wire identity. `presentRelayIds` is
   * EVERY zone the poll's report carried, before any enablement filtering. A zone the wire still reports but the request omits can only be a configuration
   * change, so it is demoted at once; a zone missing from both is a wire absence, which is graced for a few polls because a transient flake must never destroy a
   * HomeKit identity the user placed in a room.
   *
   * The flush shape differs by arm, and every one of them is strictly on-change. A demotion flushes the whole array through removeAccessory's own tail, while a
   * creation or a context refresh flushes just its accessory. A poll on which a zone is renamed on the wire can therefore produce this context flush and the
   * controller's own accessory-name flush for the same accessory - two flushes on one rename poll, self-limiting and accepted.
   *
   * This method never touches a service: what lands on a hosted accessory is the controller's business.
   *
   * @param options - The owning controller, the id set of every zone the poll reported, and the standalone request.
   *
   * @returns The hosting map, from relay id to accessory, carrying one entry per requested zone that exists and seeded cleanly.
   */
  public reconcileZoneAccessories({ controller, presentRelayIds, zones }: { controller: HydrawiseControllerConfig; presentRelayIds: Set<number>;
    zones: { displayName: string; identity: HydrawiseZoneIdentity }[]; }): Map<number, HydrawiseAccessory> {

    const hosts = new Map<number, HydrawiseAccessory>();
    const requestedIds = new Set(zones.map(zone => zone.identity.relayId));

    /* Derive this controller's own zone accessories, projected to the pair each arm below reads. Filtering on the owning controller id is what keeps a
     * multi-controller account isolated: another controller's zone accessories are never this call's business. The projection is a SNAPSHOT, so the removals the
     * arms perform - which splice the tracked array - never race the walk that drives them.
     */
    const owned = this.accessories.flatMap(entry => (isZoneAccessoryContext(entry.context) &&
      (entry.context.ownerController.controllerId === controller.controller_id)) ? [{ accessory: entry, relayId: entry.context.zone.relayId }] : []);

    // One pass maintains both membership and the grace state, branching on where each owned accessory's zone turns up: in the request, on the wire alone, or in
    // neither.
    for(const { accessory, relayId } of owned) {

      // REQUESTED: the zone is still standalone and still reported. Clearing its counter here - in the arm every healthy zone visits - is what makes a
      // reappearance reset the grace window, so a later absence always counts from zero.
      if(requestedIds.has(relayId)) {

        this.zoneAccessoryGrace.delete(accessory.UUID);

        continue;
      }

      // PRESENT BUT NOT REQUESTED: the wire still reports this zone, so its absence from the request is configuration intent - the Standalone or the Device
      // option resolved off - and the demotion is immediate. The user asked for this identity change, so there is nothing to grace.
      if(presentRelayIds.has(relayId)) {

        this.demoteZoneAccessory(accessory);

        continue;
      }

      // WIRE-ABSENT: the report carried no such zone. Count the absence and hold the accessory until the count says the zone is genuinely gone rather than
      // momentarily missing.
      const absences = (this.zoneAccessoryGrace.get(accessory.UUID) ?? 0) + 1;

      if(absences < HYDRAWISE_ZONE_ACCESSORY_GRACE_POLLS) {

        this.zoneAccessoryGrace.set(accessory.UUID, absences);

        continue;
      }

      this.demoteZoneAccessory(accessory);
    }

    // Promote each requested zone, establishing its accessory when it has none and keeping its persisted identity current.
    for(const zone of zones) {

      const uuid = this.hap.uuid.generate(zoneAccessoryId(controller.controller_id, zone.identity.relayId));
      let accessory = this.accessories.find(entry => entry.UUID === uuid);

      // The accessory this call itself registered, if any. It is the only thing a fault below may undo: an accessory that already existed is not this call's to
      // remove, and one whose registration threw was never tracked in the first place.
      let created: Nullable<HydrawiseAccessory> = null;

      /* The whole per-zone sequence sits in one try. A fault establishing one zone must never end the controller's polling loop, and must leave no ghost behind:
       * we undo a registration this call performed, omit the zone from the returned map - which sends the controller's hosting back to the controller accessory
       * for this poll - and carry on with the remaining zones. The next poll retries.
       */
      try {

        if(!accessory) {

          accessory = this.addAccessory(sanitizeName(zone.displayName), uuid, HYDRAWISE_ZONE_ACCESSORY_CATEGORY);
          created = accessory;

          // A fresh accessory starts with a fresh grace window even when an earlier accessory at this UUID was removed for sustained absence, so an inherited
          // count can never truncate the new one.
          this.zoneAccessoryGrace.delete(uuid);

          this.log.info("%s: Added a standalone HomeKit accessory for this zone so it can be assigned to a room. Automations, scenes, and room assignments " +
            "that referenced this zone on the controller accessory must be set up again in the Home app.", zone.displayName);
        }

        /* Seed or refresh the persisted identity pair. The comparison is field-wise because both halves are freshly built projections, so a reference check would
         * differ every poll and flush every poll. On any difference - or on a context that fails the kind predicate, which is how an ambiguous or corrupt cache
         * entry heals - we assign a COMPLETE fresh object rather than individual fields, which re-asserts the kinds' mutual exclusivity at every write.
         */
        const ownerController = controllerIdentity(controller);
        const context = accessory.context;

        if(!isZoneAccessoryContext(context) || !sameControllerIdentity(context.ownerController, ownerController) ||
          !sameZoneIdentity(context.zone, zone.identity)) {

          accessory.context = { ownerController, zone: zone.identity };
          this.api.updatePlatformAccessories([accessory]);
        }

        hosts.set(zone.identity.relayId, accessory);
      } catch(error) {

        this.log.error("%s: Unable to establish a standalone accessory for this zone: %s", zone.displayName,
          util.inspect(error, { colors: true, depth: null, sorted: true }));

        if(created) {

          this.removeAccessory(created);
        }
      }
    }

    return hosts;
  }

  // Remove one standalone zone accessory and clear the grace state it carried, so the counter map never holds an entry for an accessory that is gone. The removal
  // itself narrates through removeAccessory; the line here carries what the user has to act on, since a HomeKit identity is going away.
  private demoteZoneAccessory(accessory: HydrawiseAccessory): void {

    this.removeAccessory(accessory);
    this.zoneAccessoryGrace.delete(accessory.UUID);

    this.log.info("%s: Automations, scenes, and room assignments that referenced this zone's standalone accessory must be set up again in the Home app.",
      accessory.displayName);
  }

  // Initialize our network stack.
  private initNetworking(): void {

    // Create an interceptor that allows us to set the user agent to our liking.
    const ua: Dispatcher.DispatcherComposeInterceptor = (dispatch) => (opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) => {

      opts.headers ??= {};
      (opts.headers as Record<string, string>)["user-agent"] = "homebridge-hunter-hydrawise";

      return dispatch(opts, handler);
    };

    // Destroy any existing dispatcher before we re-arm. With a single HTTP/2 connection a wedged session carries every in-flight request, so destroy fails them fast
    // onto the fresh pool through their own retry loops, where a graceful drain would instead wait on the very wedge the re-arm is clearing.
    void this.dispatcher?.destroy();

    // We want to enable the use of HTTP/2 and retry a request up to three times.
    this.dispatcher = new Pool("https://api.hydrawise.com", { allowH2: true, clientTtl: 60 * 1000, connections: 1 })
      .compose(ua, interceptors.retry({ maxRetries: 3, maxTimeout: 5000, minTimeout: 1000, statusCodes: [ 400, 404, 429, 500, 502, 503, 504 ], timeoutFactor: 2 }));

    setGlobalDispatcher(this.dispatcher);
  }

  // Communicate HTTP requests with the Hydrawise API.
  public async retrieve(endpoint: HydrawiseEndpoint, params?: Record<string, string>): Promise<Nullable<Dispatcher.ResponseData<unknown>>> {

    // Catch Hydrawise server-side issues:
    //
    // 400: Bad request.
    // 404: Not found.
    // 429: Too many requests.
    // 500: Internal server error.
    // 502: Bad gateway.
    // 503: Service temporarily unavailable.
    // 504: Gateway timeout.
    const serverErrors = new Set([ 400, 404, 429, 500, 502, 503, 504 ]);

    let response: Dispatcher.ResponseData<unknown>;

    // The request URL, assembled inside the try below once the budgets have admitted this call. It is declared out here because the timeout branch of the catch
    // reports it, and a variable assigned only inside a try cannot be read from its own catch. The empty starting value is never what reaches that log: the only
    // steps preceding the assignment are the two budget waits, and the sole way either ends early is a shutdown rejection, which the catch answers above the
    // timeout branch.
    let url = "";

    try {

      /* Pace this call against both ceilings Hydrawise publishes, at the one place every request to the API passes through. A zone command draws the stricter
       * command budget first and the account-wide budget second, so a command queued behind a saturated command window is not also holding an account slot while
       * it waits. Both waits sit inside this try, which is what makes an escaping budget rejection unrepresentable: a shutdown while a caller is queued rejects
       * into the classification below, whose aborted-signal branch returns the same quiet null every other teardown path returns.
       *
       * Two limits on what these budgets can promise, stated plainly. They admit LOGICAL calls and sit above undici's retry interceptor, so one admitted call can
       * still put up to four requests on the wire during a failure storm - accepted headroom, because retries exist to ride out exactly the trouble a ceiling is
       * not the cause of. And they account only for this process: the Homebridge config UI runs its own server process against the same account, one
       * customerdetails call per refresh plus one statusschedule call per controller it holds no cached context for, which an in-process window cannot see.
       */
      if(endpoint === HYDRAWISE_COMMAND_ENDPOINT) {

        await this.commandBudget.acquire();
      }

      await this.accountBudget.acquire();

      params ??= {};

      // Set our API key.
      params["api_key"] = this.config.apiKey;

      const queryParams = new URLSearchParams(params);

      // Construct our API call.
      url = "https://api.hydrawise.com/api/v1/" + endpoint + "?" + queryParams.toString();

      // Compose a per-request timeout with the platform's shutdown signal, so a slow request aborts on the timeout and an in-flight request aborts on shutdown, all
      // through one signal handed to undici. The timeout is armed only now, after both budgets have admitted the call, so a wait for a rate-limit slot never eats
      // into the time the request itself is allowed.
      const signal = composeSignals(AbortSignal.timeout(HYDRAWISE_API_TIMEOUT * 1000), this.signal);

      // Execute the API call.
      response = await request(url, { signal });

      // Bad username and password.
      if(response.statusCode === 404) {

        this.log.error("Invalid API key. Please check your Hydrawise API key.");

        return null;
      }

      // API rate limit exceeded.
      if(response.statusCode === 429) {

        this.log.error("Hydrawise API rate limit has been exceeded.");

        return null;
      }

      // Any response outside the 2xx success range is an error. A status the retry interceptor treats as a server-side failure shares the temporarily-unavailable
      // message once it has survived retries; every other non-2xx status reports its raw code and reason phrase.
      if((response.statusCode < 200) || (response.statusCode >= 300)) {

        this.log.error(serverErrors.has(response.statusCode) ? "Hydrawise API is temporarily unavailable." : response.statusCode.toString() + ": " +
          (STATUS_CODES[response.statusCode] ?? ""));

        return null;
      }

      return response;
    } catch(error) {

      // A shutdown abort supersedes every other classification. Near the timeout boundary the composed rejection's shape is ambiguous, so the platform signal's own
      // aborted flag is the truth: we exit quietly here, which also guarantees the timeout branch below can never re-arm the Pool after shutdown.
      if(this.signal.aborted) {

        return null;
      }

      // The request exceeded our timeout budget.
      if((error instanceof DOMException) && (error.name === "TimeoutError")) {

        this.log.error("The Hydrawise API is taking too long to respond to a request. This error can usually be safely ignored.");
        this.log.debug("Original request was: %s", url);

        // Reset our network stack, just in case.
        this.initNetworking();

        return null;
      }

      // Connection timed out.
      if(error instanceof errors.ConnectTimeoutError) {

        this.log.error("Connection timed out.");

        return null;
      }

      // We destroyed the pool due to a reset event and our inflight connections are failing.
      if(error instanceof errors.RequestRetryError) {

        this.log.error("Unable to connect to the Hydrawise API. This is usually temporary and will retry automatically.");

        return null;
      }

      if(error instanceof TypeError) {

        const cause = error.cause as NodeJS.ErrnoException;

        switch(cause.code) {

          case "ECONNREFUSED":
          case "EHOSTDOWN":

            this.log.error("Connection refused.");

            break;

          case "ECONNRESET":

            this.log.error("Connection has been reset.");

            break;

          case "ENOTFOUND":

            this.log.error("Hostname or IP address not found. Please ensure you're connected to the Internet.");

            break;

          default:

            this.log.error("Error: %s | %s.", cause.code, cause.message);
            this.log.error(util.inspect(error, { colors: true, depth: null, sorted: true}));

            break;
        }

        return null;
      }

      this.log.error(util.inspect(error, { colors: true, depth: null, sorted: true}));

      return null;
    }
  }

  // Utility for debug logging. We route this through log.warn rather than log.debug so that plugin-level debug output stays visible regardless of whether
  // Homebridge itself is run with its own debug flag, which is what gates log.debug.
  public debug(message: string, ...parameters: unknown[]): void {

    if(this.config.debug) {

      this.log.warn(util.format(message, ...parameters));
    }
  }
}
