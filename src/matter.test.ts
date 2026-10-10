/* Copyright(C) 2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * matter.test.ts: Tests for the Matter transport.
 *
 * The Matter API is a hand-built double here rather than a mocked module, on the same terms as the HAP double in src/testing/hap.helpers.ts: it mirrors only the
 * surface this transport actually touches - the UUID generator, the device-type table, and the three register/update/unregister calls - so the REAL production
 * transport runs end to end against it with no Matter runtime, no Homebridge runtime, and no network anywhere in the process. The feature options are the real
 * engine over the real catalog, so exposure is decided exactly as production decides it.
 *
 * The transport's own dependency posture is what makes that cheap. It imports nothing from controller.ts and is handed a flat projection of each poll, so a test
 * writes that projection directly and never has to stand up a controller to reach it.
 */

// The Hydrawise API wire shapes use snake_case keys such as controller_id and serial_number, so camelcase is disabled here to let these literals mirror the wire.
/* eslint-disable camelcase */
import type { API, MatterAPI, MatterAccessory } from "homebridge";
import { HYDRAWISE_ZONE_ACCESSORY_GRACE_POLLS, PLATFORM_NAME, PLUGIN_NAME } from "./settings.ts";
import type { HydrawiseMatterControllerIdentity, HydrawiseMatterTarget, HydrawiseMatterZone } from "./matter.ts";
import { capturingLog, firstOf } from "./testing.helpers.ts";
import { describe, test } from "node:test";
import { featureOptionCategories, featureOptions } from "./options.ts";
import { FeatureOptions } from "homebridge-plugin-utils";
import { HydrawiseMatter } from "./matter.ts";
import type { HydrawiseMatterAccessoryContext } from "./types.ts";
import assert from "node:assert/strict";
import { loggedAt } from "./testing/platform.helpers.ts";
import { matterZoneUuid } from "./matter.ts";

// One recorded command a Matter endpoint dispatched to its controller, as a test asserts on it.
interface RecordedCommand {

  action: "run" | "stop";
  controllerId: number;
  duration: number | undefined;
  relayId: number;
}

// One recorded cluster-state publish.
interface RecordedUpdate {

  attributes: Record<string, unknown>;
  cluster: string;
  uuid: string;
}

// Every call the Matter API double received, in order, so a test can pin sequencing across register, unregister, and update.
interface RecordedCall {

  kind: "register" | "unregister" | "update";
  uuids: string[];
}

// Matter is on for every controller unless a test says otherwise, because what is under test is what the transport does once a controller is exposed.
const MATTER_ON = "Enable.Matter";
const SERIAL = "ABC123";
const CONTROLLER: HydrawiseMatterControllerIdentity = { controller_id: 7167, serial_number: SERIAL };
const OTHER_CONTROLLER: HydrawiseMatterControllerIdentity = { controller_id: 8888, serial_number: "XYZ789" };

/* The Matter API double. The device-type entries are opaque markers rather than real matter.js endpoint types - the transport only ever selects one and hands it
 * back, never calls into it - and the UUID generator is deliberately transparent so a test can assert on the SEED rather than on an opaque hash.
 *
 * The device-type names are matter.js's own, which are NOT the keys Homebridge selects by: the plug-in-unit type is keyed "OnOffOutlet" and named
 * "OnOffPlugInUnit". The legacy cache comparison depends on that difference, so the double reproduces it rather than smoothing it over.
 */
function makeMatter(): { calls: RecordedCall[]; fail: { register: boolean; unregister: boolean; update: boolean }; matter: MatterAPI;
  registered: MatterAccessory[]; unregistered: MatterAccessory[]; updates: RecordedUpdate[]; } {

  const calls: RecordedCall[] = [];
  const fail = { register: false, unregister: false, update: false };
  const registered: MatterAccessory[] = [];
  const unregistered: MatterAccessory[] = [];
  const updates: RecordedUpdate[] = [];

  const matter = {

    deviceTypes: { OnOffOutlet: { name: "OnOffPlugInUnit" }, WaterValve: { name: "WaterValve" } },
    registerPlatformAccessories: async (plugin: string, platform: string, accessories: MatterAccessory[]): Promise<void> => {

      assert.equal(plugin, PLUGIN_NAME, "registration names this plugin");
      assert.equal(platform, PLATFORM_NAME, "registration names this platform");

      if(fail.register) {

        throw new Error("Matter server unavailable.");
      }

      calls.push({ kind: "register", uuids: accessories.map(accessory => accessory.UUID) });
      registered.push(...accessories);
    },
    unregisterPlatformAccessories: async (_plugin: string, _platform: string, accessories: MatterAccessory[]): Promise<void> => {

      if(fail.unregister) {

        throw new Error("Matter server unavailable.");
      }

      calls.push({ kind: "unregister", uuids: accessories.map(accessory => accessory.UUID) });
      unregistered.push(...accessories);
    },
    updateAccessoryState: async (uuid: string, cluster: string, attributes: Record<string, unknown>): Promise<void> => {

      if(fail.update) {

        throw new Error("Update rejected.");
      }

      calls.push({ kind: "update", uuids: [uuid] });
      updates.push({ attributes, cluster, uuid });
    },
    uuid: { generate: (seed: string): string => "uuid(" + seed + ")" }
  } as unknown as MatterAPI;

  return { calls, fail, matter, registered, unregistered, updates };
}

/* A transport over the double, its feature options, and a recording controller per configured controller id. `configured` names the controllers discovery has
 * configured; a controller absent from it is one whose commands arrive "before it is ready" and whose endpoints the sweep retires. `enabled` is the bridge's own
 * Matter setting.
 */
function makeTransport(options: { configured?: HydrawiseMatterControllerIdentity[]; enabled?: boolean; matter?: MatterAPI; options?: string[];
  target?: HydrawiseMatterTarget["commandZone"]; } = {}): { commands: RecordedCommand[]; lines: ReturnType<typeof capturingLog>["lines"];
  transport: HydrawiseMatter; } {

  const commands: RecordedCommand[] = [];
  const { lines, logger } = capturingLog();
  const enabled = options.enabled ?? true;
  const matter = options.matter ?? makeMatter().matter;
  const configured = new Map<number, HydrawiseMatterTarget>((options.configured ?? [CONTROLLER]).map(controller => [ controller.controller_id, {

    commandZone: options.target ?? (async (relayId, action, duration): Promise<void> => void commands.push({ action, controllerId: controller.controller_id, duration,
      relayId }))
  } ]));

  const api = { isMatterAvailable: (): boolean => true, isMatterEnabled: (): boolean => enabled, matter: enabled ? matter : undefined } as unknown as API;

  const transport = new HydrawiseMatter({ api, controllerFor: (controllerId: number) => configured.get(controllerId),
    featureOptions: new FeatureOptions(featureOptionCategories, featureOptions, options.options ?? [MATTER_ON]), log: logger });

  return { commands, lines, transport };
}

// A zone projection, with the fields a given test cares about overridden.
function zone(relayId: number, overrides: Partial<HydrawiseMatterZone> = {}): HydrawiseMatterZone {

  return { isOpen: false, name: "Zone " + relayId.toString(), relayId, remainingSeconds: 0, runSeconds: 600, ...overrides };
}

/* A cached Matter accessory in the shape Homebridge restores it: a JSON round-trip, so the device type is a bare named object with no behavior behind it, and
 * matter.js internals ride along. `typeName` is the matter.js name the cache remembers; `deviceType` is the key a context written by this version records, and is
 * omitted to model an entry written before the key was recorded.
 */
function cached(matter: MatterAPI, relayId: number, overrides: { context?: unknown; controller?: HydrawiseMatterControllerIdentity;
  deviceType?: string; typeName?: string; uuid?: string; } = {}): MatterAccessory {

  const controller = overrides.controller ?? CONTROLLER;
  const context = overrides.context ?? { controllerId: controller.controller_id, relayId, serialNumber: controller.serial_number,
    ...(overrides.deviceType ? { deviceType: overrides.deviceType } : {}) };

  return { UUID: overrides.uuid ?? matterZoneUuid(matter, controller.serial_number, relayId), _eventEmitter: { on: (): void => undefined }, _parts: [], context,
    deviceType: { name: overrides.typeName ?? "OnOffPlugInUnit" }, displayName: "Zone " + relayId.toString() } as unknown as MatterAccessory;
}

// The handlers of the first accessory a double recorded, typed as the outlet's.
function outletHandlers(accessories: MatterAccessory[]): { off: () => Promise<void>; on: () => Promise<void> } {

  return (firstOf(accessories).handlers as { onOff: { off: () => Promise<void>; on: () => Promise<void> } }).onOff;
}

describe("Matter zone identity", () => {

  test("a zone's UUID is derived from its controller serial and relay id, and nothing else", () => {

    const { matter } = makeMatter();

    assert.equal(matterZoneUuid(matter, SERIAL, 101), "uuid(hydrawise:matter:ABC123:zone:101)", "the seed names the serial and the relay");

    /* The stability pin, stated as an inequality in each direction the identity must be sensitive to, and an equality for repetition. Everything NOT in the seed -
     * the zone's name, its device type, its enablement - is what a rename or an option toggle changes, and any of them leaking in would retire a commissioned
     * endpoint and mint a replacement, taking the user's automations with it.
     */
    assert.equal(matterZoneUuid(matter, SERIAL, 101), matterZoneUuid(matter, SERIAL, 101), "the same zone derives the same UUID every time");
    assert.notEqual(matterZoneUuid(matter, SERIAL, 101), matterZoneUuid(matter, SERIAL, 102), "different relays derive different UUIDs");
    assert.notEqual(matterZoneUuid(matter, SERIAL, 101), matterZoneUuid(matter, "OTHER", 101), "the same relay on another controller derives another UUID");
  });
});

describe("Matter exposure", () => {

  test("a bridge without Matter registers nothing, however the options are set", async () => {

    const { registered, matter } = makeMatter();
    const { lines, transport } = makeTransport({ enabled: false, matter });

    await transport.publish(CONTROLLER, [zone(101)]);

    assert.equal(registered.length, 0, "Matter is the bridge's setting, so without it the transport does nothing");
    assert.equal(lines().length, 0, "and says nothing, because the absence is a degrade rather than a fault");
  });

  test("a controller without the Matter option registers nothing", async () => {

    const { matter, registered } = makeMatter();
    const { transport } = makeTransport({ matter, options: [] });

    await transport.publish(CONTROLLER, [zone(101)]);

    assert.equal(registered.length, 0, "the option is off by default, so an existing install is untouched");
  });

  test("a zone the user excludes from Matter is never registered, while its siblings are", async () => {

    const { matter, registered } = makeMatter();
    const { transport } = makeTransport({ matter, options: [ MATTER_ON, "Disable.Matter.102" ] });

    await transport.publish(CONTROLLER, [ zone(101), zone(102) ]);

    assert.deepEqual(registered.map(accessory => accessory.UUID), [matterZoneUuid(matter, SERIAL, 101)], "only the zone still opted in is exposed");
  });
});

describe("Matter zone registration", () => {

  test("each zone becomes its own top-level accessory, not a part of a composed one", async () => {

    const { matter, registered } = makeMatter();
    const { transport } = makeTransport({ matter });

    await transport.publish(CONTROLLER, [ zone(101), zone(102) ]);

    assert.equal(registered.length, 2, "two zones are two accessories");
    assert.equal(registered.filter(accessory => accessory.parts?.length).length, 0, "the flat topology registers no composed parts at all");
    assert.deepEqual(registered.map(accessory => accessory.UUID), [ matterZoneUuid(matter, SERIAL, 101), matterZoneUuid(matter, SERIAL, 102) ],
      "each accessory is addressed by its own zone's derived UUID");
  });

  test("an accessory carries the identity a cold boot needs to rebuild it, and the state it needs to be usable", async () => {

    const { matter, registered } = makeMatter();
    const { transport } = makeTransport({ matter });

    await transport.publish(CONTROLLER, [zone(101, { isOpen: true, name: "Front Lawn", remainingSeconds: 240 })]);

    const accessory = firstOf(registered);

    assert.deepEqual(accessory.context, { controllerId: 7167, deviceType: "OnOffOutlet", relayId: 101, serialNumber: SERIAL },
      "the context carries identity and the device type it was registered as, which is all a rebuild needs");
    assert.equal(accessory.displayName, "Front Lawn", "the accessory is named with the effective name the controller resolved");
    assert.equal(accessory.serialNumber, "ABC123-101", "each endpoint reports its own serial rather than sharing the controller's");
    assert.equal(accessory.manufacturer, "Hunter", "the manufacturer is reported");
    assert.equal(accessory.deviceType, matter.deviceTypes.OnOffOutlet, "the default device type is the one every ecosystem handles");
    assert.deepEqual(accessory.clusters, { onOff: { onOff: true } }, "a zone that is running registers already open, so it never reads idle for a poll");
  });

  test("a zone is registered once and updated thereafter, never registered twice", async () => {

    const { matter, registered } = makeMatter();
    const { transport } = makeTransport({ matter });

    await transport.publish(CONTROLLER, [zone(101)]);
    await transport.publish(CONTROLLER, [zone(101, { isOpen: true })]);
    await transport.publish(CONTROLLER, [zone(101, { isOpen: false })]);

    assert.equal(registered.length, 1, "the zone was registered exactly once across three polls");
  });

  test("a zone that appears on a later poll is registered then, because discovery never knew about it", async () => {

    const { matter, registered } = makeMatter();
    const { transport } = makeTransport({ matter });

    await transport.publish(CONTROLLER, [zone(101)]);
    await transport.publish(CONTROLLER, [ zone(101), zone(102) ]);

    assert.deepEqual(registered.map(accessory => (accessory.context as HydrawiseMatterAccessoryContext).relayId), [ 101, 102 ],
      "the second poll registered only the zone the first had not seen");
  });

  test("a failed registration records nothing, so the next poll registers the zone rather than publishing to an endpoint that does not exist", async () => {

    const { fail, matter, registered, updates } = makeMatter();
    const { lines, transport } = makeTransport({ matter });

    fail.register = true;
    await transport.publish(CONTROLLER, [zone(101)]);

    assert.equal(lines().filter(line => line.level === "error").length, 1, "the failure is reported once");
    assert.equal(updates.length, 0, "and nothing is published to the endpoint that failed to register");

    fail.register = false;
    await transport.publish(CONTROLLER, [zone(101)]);

    assert.equal(registered.length, 1, "the zone registers on the following poll");
  });
});

describe("Matter zone commands", () => {

  test("an outlet's on and off reach the owning controller as a run and a stop", async () => {

    const { matter, registered } = makeMatter();
    const { commands, transport } = makeTransport({ matter });

    await transport.publish(CONTROLLER, [zone(101)]);

    await outletHandlers(registered).on();
    await outletHandlers(registered).off();

    /* The duration an outlet's "on" carries is deliberately undefined rather than a number invented here. An outlet's vocabulary has no duration in it, so the
     * transport declines to guess one and the controller answers with the zone's own configured run time.
     */
    assert.deepEqual(commands, [ { action: "run", controllerId: 7167, duration: undefined, relayId: 101 },
      { action: "stop", controllerId: 7167, duration: undefined, relayId: 101 } ], "on runs the zone and off stops it");
  });

  test("a valve's open passes its requested duration through, and falls back when the request carries none", async () => {

    const { matter, registered } = makeMatter();
    const { commands, transport } = makeTransport({ matter, options: [ MATTER_ON, "Enable.Matter.Valve" ] });

    await transport.publish(CONTROLLER, [zone(101)]);

    const handlers = firstOf(registered).handlers as
      { valveConfigurationAndControl: { close: () => Promise<void>; open: (request?: { openDuration?: number | null }) => Promise<void> } };

    await handlers.valveConfigurationAndControl.open({ openDuration: 900 });
    await handlers.valveConfigurationAndControl.open({ openDuration: null });
    await handlers.valveConfigurationAndControl.open();
    await handlers.valveConfigurationAndControl.close();

    // A null openDuration is Matter's own spelling of "no duration set", so it must reach the controller as the same absence an omitted request does.
    assert.deepEqual(commands.map(({ action, duration }) => ({ action, duration })), [ { action: "run", duration: 900 }, { action: "run", duration: undefined },
      { action: "run", duration: undefined }, { action: "stop", duration: undefined } ],
    "a requested duration is honored and both spellings of its absence fall through");
  });

  test("a command that fails propagates, so the ecosystem reports a failure rather than a silent success", async () => {

    const { matter, registered } = makeMatter();
    const { lines, transport } = makeTransport({ matter, target: async (): Promise<void> => { throw new Error("The Hydrawise API refused the command."); } });

    await transport.publish(CONTROLLER, [zone(101)]);

    const before = lines().length;

    await assert.rejects(() => outletHandlers(registered).on(), /refused the command/, "the handler throws so Homebridge can map it to a Matter status");
    assert.equal(lines().length, before, "the transport does not narrate a command failure it is passing on to the caller");
  });

  test("a command for a controller discovery has not configured yet is refused with a reason rather than dropped", async () => {

    const { matter, registered } = makeMatter();
    const { lines, transport } = makeTransport({ configured: [], matter });

    transport.configureCached(cached(matter, 101));
    await transport.restore();

    await assert.rejects(() => outletHandlers(registered).on(), /not ready/, "the command fails rather than appearing to succeed");
    assert.ok(loggedAt(lines(), "warn", "before its controller was ready"), "and the reason is written down");
  });

  test("a command forgets the published state, so the next poll corrects an ecosystem even when the reading has not changed", async () => {

    const { matter, registered, updates } = makeMatter();
    const { transport } = makeTransport({ matter });

    await transport.publish(CONTROLLER, [zone(101)]);

    assert.equal(updates.length, 1, "the idle zone is published once");

    /* The user turns the zone on from their ecosystem, and Homebridge marks the endpoint on as soon as the handler returns. The run never starts - a rain sensor,
     * a suspension, an offline controller - so the next poll reads the zone idle, exactly as before. Without forgetting the memo, that reading would be judged
     * unchanged and skipped, and the ecosystem would show the zone on indefinitely.
     */
    await outletHandlers(registered).on();
    await transport.publish(CONTROLLER, [zone(101)]);

    assert.equal(updates.length, 2, "the unchanged reading is published anyway");
    assert.deepEqual(updates[1]?.attributes, { onOff: false }, "and it puts the endpoint back to what the zone is actually doing");

    await transport.publish(CONTROLLER, [zone(101)]);

    assert.equal(updates.length, 2, "after which the memo is trusted again");
  });
});

describe("Matter state publishing", () => {

  test("an unchanged zone is not republished, because every write is a change notification to every commissioned fabric", async () => {

    const { matter, updates } = makeMatter();
    const { transport } = makeTransport({ matter });

    await transport.publish(CONTROLLER, [zone(101)]);
    await transport.publish(CONTROLLER, [zone(101)]);
    await transport.publish(CONTROLLER, [zone(101)]);

    assert.equal(updates.length, 1, "three identical polls produce one publish");

    await transport.publish(CONTROLLER, [zone(101, { isOpen: true })]);

    assert.equal(updates.length, 2, "a genuine change does publish");
    assert.deepEqual(updates[1]?.attributes, { onOff: true }, "and it carries the new state");
  });

  test("a valve publishes the durations its cluster reports, and an outlet publishes only on and off", async () => {

    const valve = makeMatter();
    const { transport: valveTransport } = makeTransport({ matter: valve.matter, options: [ MATTER_ON, "Enable.Matter.Valve" ] });

    await valveTransport.publish(CONTROLLER, [zone(101, { isOpen: true, remainingSeconds: 240, runSeconds: 600 })]);

    assert.deepEqual(firstOf(valve.updates), { attributes: { currentState: 1, defaultOpenDuration: 600, openDuration: 600, remainingDuration: 240, targetState: 1 },
      cluster: "valveConfigurationAndControl", uuid: matterZoneUuid(valve.matter, SERIAL, 101) }, "a running valve reports both its full run and what is left of it");
    assert.deepEqual(firstOf(valve.registered).clusters, { valveConfigurationAndControl: firstOf(valve.updates).attributes },
      "and it registered in the same shape it publishes, because both are composed in one place");

    const outlet = makeMatter();
    const { transport: outletTransport } = makeTransport({ matter: outlet.matter });

    await outletTransport.publish(CONTROLLER, [zone(101, { isOpen: true, remainingSeconds: 240 })]);

    assert.deepEqual(firstOf(outlet.updates).attributes, { onOff: true }, "an outlet has nowhere to put a duration and does not invent one");
  });

  test("a closed valve reports no durations rather than stale ones", async () => {

    const { matter, updates } = makeMatter();
    const { transport } = makeTransport({ matter, options: [ MATTER_ON, "Enable.Matter.Valve" ] });

    await transport.publish(CONTROLLER, [zone(101, { isOpen: false, runSeconds: 600 })]);

    assert.deepEqual(firstOf(updates).attributes, { currentState: 0, defaultOpenDuration: 600, openDuration: null, remainingDuration: null, targetState: 0 },
      "a zone that is not running has no run in progress to describe");
  });

  test("a failed publish is retried on the next poll rather than being suppressed by its own memo", async () => {

    const { fail, matter, updates } = makeMatter();
    const { lines, transport } = makeTransport({ matter });

    fail.update = true;
    await transport.publish(CONTROLLER, [zone(101, { isOpen: true })]);

    assert.equal(updates.length, 0, "the publish did not land");
    assert.equal(lines().filter(line => line.level === "error").length, 1, "and the failure is reported");

    // The same state as the failed attempt. A transport that recorded what it TRIED to write would treat this as unchanged and never retry it.
    fail.update = false;
    await transport.publish(CONTROLLER, [zone(101, { isOpen: true })]);

    assert.equal(updates.length, 1, "the next poll republishes the state the failed attempt never delivered");
  });
});

describe("Matter zone retirement", () => {

  test("a zone missing from fewer than the grace count of consecutive polls is kept, and its count restarts when it returns", async () => {

    const { matter, unregistered, updates } = makeMatter();
    const { transport } = makeTransport({ matter });

    await transport.publish(CONTROLLER, [ zone(101), zone(102) ]);

    for(let absence = 1; absence < HYDRAWISE_ZONE_ACCESSORY_GRACE_POLLS; absence++) {

      // eslint-disable-next-line no-await-in-loop
      await transport.publish(CONTROLLER, [zone(101)]);
    }

    assert.equal(unregistered.length, 0, "an absence short of the grace count is not evidence the zone is gone");

    // The zone returns, then goes missing again. A count that did not restart would retire it on this first new absence.
    await transport.publish(CONTROLLER, [ zone(101), zone(102, { isOpen: true }) ]);
    await transport.publish(CONTROLLER, [zone(101)]);

    assert.equal(unregistered.length, 0, "the return reset the count");
    assert.equal(updates.at(-1)?.uuid, matterZoneUuid(matter, SERIAL, 102), "and the returning zone was published to, since its endpoint never left");
  });

  test("a zone missing from the grace count of consecutive polls is unregistered, and its siblings are untouched", async () => {

    const { matter, registered, unregistered } = makeMatter();
    const { lines, transport } = makeTransport({ matter });

    await transport.publish(CONTROLLER, [ zone(101), zone(102) ]);

    for(let absence = 1; absence <= HYDRAWISE_ZONE_ACCESSORY_GRACE_POLLS; absence++) {

      // eslint-disable-next-line no-await-in-loop
      await transport.publish(CONTROLLER, [zone(101)]);
    }

    assert.deepEqual(unregistered.map(accessory => accessory.UUID), [matterZoneUuid(matter, SERIAL, 102)], "the zone Hydrawise stopped reporting is retired");
    assert.ok(loggedAt(lines(), "info", "Zone 102: Removed from Matter"), "and the removal names the zone");

    // A zone that comes back after retirement is a new endpoint at the same identity, registered like any zone the transport has not seen.
    await transport.publish(CONTROLLER, [ zone(101), zone(102) ]);

    assert.equal(registered.filter(accessory => accessory.UUID === matterZoneUuid(matter, SERIAL, 102)).length, 2, "a returning zone is registered again");
  });

  test("a poll that names no zones at all counts against none of them", async () => {

    const { matter, unregistered } = makeMatter();
    const { transport } = makeTransport({ matter });

    await transport.publish(CONTROLLER, [zone(101)]);

    for(let poll = 0; poll <= HYDRAWISE_ZONE_ACCESSORY_GRACE_POLLS; poll++) {

      // eslint-disable-next-line no-await-in-loop
      await transport.publish(CONTROLLER, []);
    }

    // An empty roster is far likelier to be a bad answer from the cloud than a controller whose every zone was deleted, and unregistering would make the user
    // re-add every zone in their ecosystem.
    assert.equal(unregistered.length, 0, "an empty poll retires nothing");
  });

  test("a failed retirement is retried on the next poll", async () => {

    const { fail, matter, unregistered } = makeMatter();
    const { transport } = makeTransport({ matter });

    await transport.publish(CONTROLLER, [ zone(101), zone(102) ]);

    fail.unregister = true;

    for(let absence = 1; absence <= HYDRAWISE_ZONE_ACCESSORY_GRACE_POLLS; absence++) {

      // eslint-disable-next-line no-await-in-loop
      await transport.publish(CONTROLLER, [zone(101)]);
    }

    fail.unregister = false;
    await transport.publish(CONTROLLER, [zone(101)]);

    assert.deepEqual(unregistered.map(accessory => accessory.UUID), [matterZoneUuid(matter, SERIAL, 102)], "the zone is retired once the server takes the call");
  });

  test("one controller's poll never retires another controller's zones", async () => {

    const { matter, unregistered } = makeMatter();
    const { transport } = makeTransport({ configured: [ CONTROLLER, OTHER_CONTROLLER ], matter });

    await transport.publish(CONTROLLER, [zone(101)]);
    await transport.publish(OTHER_CONTROLLER, [zone(201)]);

    for(let poll = 0; poll <= HYDRAWISE_ZONE_ACCESSORY_GRACE_POLLS; poll++) {

      // eslint-disable-next-line no-await-in-loop
      await transport.publish(CONTROLLER, [zone(101)]);
    }

    assert.equal(unregistered.length, 0, "the other controller's zone is not this controller's poll's business");
  });
});

describe("Matter boot rebuild", () => {

  test("a well-formed cache entry is rebuilt as a wholly fresh accessory rather than re-registered as found", async () => {

    const { matter, registered } = makeMatter();
    const { transport } = makeTransport({ configured: [], matter });

    const entry = cached(matter, 101, { deviceType: "OnOffOutlet" });

    transport.configureCached(entry);
    await transport.restore();

    const rebuilt = firstOf(registered);

    assert.notEqual(rebuilt, entry, "the object from disk is not what is registered");
    assert.equal(rebuilt.UUID, entry.UUID, "the rebuilt accessory keeps the identity the ecosystem already knows");
    assert.equal(rebuilt.displayName, "Zone 101", "and the name it was last seen under");
    assert.equal((rebuilt as unknown as { _parts?: unknown })._parts, undefined, "the matter.js internals do not survive the rebuild");
    assert.equal(rebuilt.deviceType, matter.deviceTypes.OnOffOutlet, "the device type is the live one, not the prototype-less shell from disk");
    assert.ok(rebuilt.handlers?.onOff, "and the endpoint is commandable, which a restored object never is");

    // Under-reporting water running is the safe direction to be briefly wrong in; the first poll lands within seconds and corrects it either way.
    assert.deepEqual(rebuilt.clusters, { onOff: { onOff: false } }, "it registers closed, because nobody has checked the zone since the process stopped");
  });

  test("a restored endpoint is published to by the first poll, not registered a second time", async () => {

    const { matter, registered, updates } = makeMatter();
    const { transport } = makeTransport({ matter });

    transport.configureCached(cached(matter, 101));
    await transport.restore();
    await transport.publish(CONTROLLER, [zone(101, { isOpen: true })]);

    assert.equal(registered.length, 1, "the boot rebuild's registration is the only one");
    assert.deepEqual(updates.map(update => update.attributes), [{ onOff: true }], "and the first poll publishes the zone's actual state to it");
  });

  test("an entry written before the device type was recorded is matched by matter.js type name, and records the key from then on", async () => {

    const { matter, registered } = makeMatter();
    const { transport } = makeTransport({ matter });

    // The plug-in-unit name matter.js persists against the "OnOffOutlet" key the options select - which a key-against-name comparison would reject.
    transport.configureCached(cached(matter, 101, { typeName: "OnOffPlugInUnit" }));
    await transport.restore();

    assert.equal(registered.length, 1, "the legacy entry is restored rather than declined on a name mismatch");
    assert.equal((firstOf(registered).context as HydrawiseMatterAccessoryContext).deviceType, "OnOffOutlet", "and the rebuilt context records the key");
  });

  test("a changed device type unregisters the old endpoint at boot, and the first poll registers it in the new shape", async () => {

    const { calls, matter, registered, unregistered, updates } = makeMatter();
    const { transport } = makeTransport({ matter, options: [ MATTER_ON, "Enable.Matter.Valve" ] });
    const uuid = matterZoneUuid(matter, SERIAL, 101);

    // An outlet in the cache, a valve in the options: the boot after the user turned Matter.Valve on.
    transport.configureCached(cached(matter, 101, { deviceType: "OnOffOutlet" }));
    await transport.restore();

    assert.deepEqual(unregistered.map(accessory => accessory.UUID), [uuid], "the endpoint whose clusters are changing is unregistered at boot");
    assert.equal(registered.length, 0, "and is not registered in its old shape");

    await transport.publish(CONTROLLER, [zone(101)]);

    assert.equal(firstOf(registered).deviceType, matter.deviceTypes.WaterValve, "the first poll registers the zone as the type the options ask for");
    assert.deepEqual(calls.map(call => call.kind), [ "unregister", "register", "update" ],
      "the old endpoint was gone before the new one was registered, and nothing was published to an endpoint that was not registered");
    assert.equal(updates.length, 1, "the one update went to the newly registered endpoint");
  });

  test("an entry whose zone the options no longer expose is unregistered at boot", async () => {

    const { matter, registered, unregistered } = makeMatter();
    const { transport } = makeTransport({ matter, options: [ MATTER_ON, "Disable.Matter.102", "Disable.Device.103" ] });

    transport.configureCached(cached(matter, 101));
    transport.configureCached(cached(matter, 102));
    transport.configureCached(cached(matter, 103));
    await transport.restore();

    assert.deepEqual(registered.map(accessory => accessory.UUID), [matterZoneUuid(matter, SERIAL, 101)], "the zone still exposed is restored");
    assert.deepEqual(unregistered.map(accessory => accessory.UUID), [ matterZoneUuid(matter, SERIAL, 102), matterZoneUuid(matter, SERIAL, 103) ],
      "a zone excluded from Matter, and a zone hidden altogether, are retired before any network call");
  });

  test("an entry whose controller's Matter option is off is unregistered at boot rather than registered and swept", async () => {

    const { matter, registered, unregistered } = makeMatter();
    const { transport } = makeTransport({ matter, options: [] });

    transport.configureCached(cached(matter, 101));
    await transport.restore();

    assert.equal(registered.length, 0, "nothing is registered for a controller that is not exposed");
    assert.deepEqual(unregistered.map(accessory => accessory.UUID), [matterZoneUuid(matter, SERIAL, 101)], "its endpoint is retired");
  });

  test("an entry this plugin cannot read, or whose identity does not derive its UUID, is unregistered rather than guessed at", async () => {

    const { matter, registered, unregistered } = makeMatter();
    const { transport } = makeTransport({ matter });

    const contexts: unknown[] = [ undefined, null, {}, { controllerId: 7167 }, { controllerId: 7167, relayId: 101 },
      { controllerId: 7167, relayId: 101, serialNumber: "" }, { controllerId: "7167", relayId: 101, serialNumber: SERIAL },
      { controllerId: 7167, relayId: 1.5, serialNumber: SERIAL }, { controllerId: 7167, deviceType: "Sprinkler", relayId: 101, serialNumber: SERIAL } ];

    contexts.forEach((context, index) => transport.configureCached(cached(matter, 101, { context, uuid: "unreadable-" + index.toString() })));
    transport.configureCached(cached(matter, 101, { uuid: "not-derived-from-its-identity" }));

    await transport.restore();

    assert.equal(registered.length, 0, "no unreadable entry is restored");
    assert.equal(unregistered.length, contexts.length + 1, "and every one is retired");
  });

  test("a failed boot registration records nothing, so the first poll registers the zones rather than publishing to them", async () => {

    const { calls, fail, matter } = makeMatter();
    const { transport } = makeTransport({ matter });

    fail.register = true;
    transport.configureCached(cached(matter, 101));
    await transport.restore();

    fail.register = false;
    await transport.publish(CONTROLLER, [zone(101)]);

    assert.deepEqual(calls.map(call => call.kind), [ "register", "update" ], "the zone is registered before anything is published to it");
  });

  test("a bridge without Matter leaves the cache undisturbed", async () => {

    const { calls, matter } = makeMatter();
    const { transport } = makeTransport({ enabled: false, matter });

    transport.configureCached(cached(matter, 101));
    await transport.restore();
    await transport.sweep();

    assert.equal(calls.length, 0, "nothing is registered or retired, since nothing can be known about what is orphaned");
  });
});

describe("Matter controller sweep", () => {

  test("the endpoints of a controller discovery did not configure are unregistered, and a configured controller's are kept", async () => {

    const { matter, unregistered } = makeMatter();
    const { transport } = makeTransport({ matter });

    transport.configureCached(cached(matter, 101));
    transport.configureCached(cached(matter, 201, { controller: OTHER_CONTROLLER }));
    await transport.restore();
    await transport.sweep();

    assert.deepEqual(unregistered.map(accessory => accessory.UUID), [matterZoneUuid(matter, OTHER_CONTROLLER.serial_number, 201)],
      "only the endpoint whose controller left the account is retired");
  });
});
