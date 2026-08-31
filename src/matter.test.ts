/* Copyright(C) 2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * matter.test.ts: Tests for the Matter transport.
 *
 * The Matter API is a hand-built double here rather than a mocked module, on the same terms as the HAP double in src/testing/hap.helpers.ts: it mirrors only the
 * surface this transport actually touches - the UUID generator, the device-type table, and the three register/update/unregister calls - so the REAL production
 * transport runs end to end against it with no Matter runtime, no Homebridge runtime, and no network anywhere in the process.
 *
 * The transport's own dependency posture is what makes that cheap. It imports nothing from controller.ts and is handed a flat projection of each poll, so a test
 * writes that projection directly and never has to stand up a controller to reach it.
 */
import type { HydrawiseMatterCommand, HydrawiseMatterDeviceType, HydrawiseMatterZone } from "./matter.ts";
import { HydrawiseMatterController, matterZoneUuid, rebuildCachedMatterAccessory } from "./matter.ts";
import type { MatterAPI, MatterAccessory } from "homebridge";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.ts";
import { capturingLog, firstOf } from "./testing.helpers.ts";
import { describe, test } from "node:test";
import type { HydrawiseMatterAccessoryContext } from "./types.ts";
import assert from "node:assert/strict";

// One recorded command the transport dispatched, as a test asserts on it.
interface RecordedCommand {

  action: "run" | "stop";
  duration: number | undefined;
  relayId: number;
}

// One recorded cluster-state publish.
interface RecordedUpdate {

  attributes: Record<string, unknown>;
  cluster: string;
  uuid: string;
}

const SERIAL = "ABC123";

/* The Matter API double. The device-type entries are opaque markers rather than real matter.js endpoint types - the transport only ever selects one and hands it
 * back, never calls into it - and the UUID generator is deliberately transparent so a test can assert on the SEED rather than on an opaque hash, which is what
 * makes the stability contract legible in the assertions below.
 */
function makeMatter(options: { failRegistration?: boolean; failUpdate?: (uuid: string) => boolean } = {}): {
  matter: MatterAPI; registered: MatterAccessory[]; unregistered: MatterAccessory[]; updates: RecordedUpdate[]; } {

  const registered: MatterAccessory[] = [];
  const unregistered: MatterAccessory[] = [];
  const updates: RecordedUpdate[] = [];

  const matter = {

    /* The names here are matter.js's own, which are NOT the keys Homebridge selects by: the plug-in-unit type is keyed "OnOffOutlet" and named
     * "OnOffPlugInUnit". That difference is load-bearing for the cache rebuild, so the double reproduces it rather than smoothing it over - a double that
     * echoed the key back would let a key-versus-name comparison bug pass here and only fail on a user's second restart.
     */
    deviceTypes: { OnOffOutlet: { name: "OnOffPlugInUnit" }, WaterValve: { name: "WaterValve" } },
    registerPlatformAccessories: async (plugin: string, platform: string, accessories: MatterAccessory[]): Promise<void> => {

      assert.equal(plugin, PLUGIN_NAME, "registration names this plugin");
      assert.equal(platform, PLATFORM_NAME, "registration names this platform");

      if(options.failRegistration) {

        throw new Error("Matter server unavailable.");
      }

      registered.push(...accessories);
    },
    unregisterPlatformAccessories: async (_plugin: string, _platform: string, accessories: MatterAccessory[]): Promise<void> => {

      unregistered.push(...accessories);
    },
    updateAccessoryState: async (uuid: string, cluster: string, attributes: Record<string, unknown>): Promise<void> => {

      if(options.failUpdate?.(uuid)) {

        throw new Error("Update rejected.");
      }

      updates.push({ attributes, cluster, uuid });
    },
    uuid: { generate: (seed: string): string => "uuid(" + seed + ")" }
  } as unknown as MatterAPI;

  return { matter, registered, unregistered, updates };
}

// A transport wired to a recording command surface, which is the whole of what a handler can reach.
function makeTransport(options: { deviceType?: HydrawiseMatterDeviceType; matter?: MatterAPI } = {}): {
  commands: RecordedCommand[]; lines: () => ReturnType<typeof capturingLog>["lines"] extends () => infer T ? T : never; transport: HydrawiseMatterController; } {

  const commands: RecordedCommand[] = [];
  const { lines, logger } = capturingLog();

  const command: HydrawiseMatterCommand = async (context, action, duration) => void commands.push({ action, duration, relayId: context.relayId });

  const transport = new HydrawiseMatterController({ command, controllerId: 7167, deviceType: options.deviceType ?? "OnOffOutlet", log: logger,
    matter: options.matter ?? makeMatter().matter, serialNumber: SERIAL });

  return { commands, lines, transport };
}

// A zone projection, with the fields a given test cares about overridden.
function zone(relayId: number, overrides: Partial<HydrawiseMatterZone> = {}): HydrawiseMatterZone {

  return { isOpen: false, name: "Zone " + relayId.toString(), relayId, remainingSeconds: 0, runSeconds: 600, ...overrides };
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

describe("Matter zone registration", () => {

  test("each zone becomes its own top-level accessory, not a part of a composed one", async () => {

    const { matter, registered } = makeMatter();
    const { transport } = makeTransport({ matter });

    await transport.publish([ zone(101), zone(102) ]);

    assert.equal(registered.length, 2, "two zones are two accessories");
    assert.equal(registered.filter(accessory => accessory.parts?.length).length, 0, "the flat topology registers no composed parts at all");
    assert.deepEqual(registered.map(accessory => accessory.UUID), [ matterZoneUuid(matter, SERIAL, 101), matterZoneUuid(matter, SERIAL, 102) ],
      "each accessory is addressed by its own zone's derived UUID");
  });

  test("an accessory carries the identity a cold boot needs to rebuild it, and the state it needs to be usable", async () => {

    const { matter, registered } = makeMatter();
    const { transport } = makeTransport({ matter });

    await transport.publish([zone(101, { isOpen: true, name: "Front Lawn", remainingSeconds: 240 })]);

    const accessory = firstOf(registered);

    assert.deepEqual(accessory.context, { controllerId: 7167, relayId: 101, serialNumber: SERIAL }, "the context carries identity alone, which is all a rebuild needs");
    assert.equal(accessory.displayName, "Front Lawn", "the accessory is named with the effective name the controller resolved");
    assert.equal(accessory.serialNumber, "ABC123-101", "each endpoint reports its own serial rather than sharing the controller's");
    assert.equal(accessory.manufacturer, "Hunter", "the manufacturer is reported");
    assert.equal((accessory.deviceType as unknown as { name: string }).name, "OnOffPlugInUnit", "the default device type is the one every ecosystem handles");
    assert.deepEqual(accessory.clusters?.onOff, { onOff: true }, "a zone that is running registers already open, so it never reads idle for a poll");
  });

  test("a zone is registered once and updated thereafter, never registered twice", async () => {

    const { matter, registered } = makeMatter();
    const { transport } = makeTransport({ matter });

    await transport.publish([zone(101)]);
    await transport.publish([zone(101, { isOpen: true })]);
    await transport.publish([zone(101, { isOpen: false })]);

    assert.equal(registered.length, 1, "the zone was registered exactly once across three polls");
  });

  test("a zone that appears on a later poll is registered then, because discovery never knew about it", async () => {

    const { matter, registered } = makeMatter();
    const { transport } = makeTransport({ matter });

    await transport.publish([zone(101)]);
    await transport.publish([ zone(101), zone(102) ]);

    assert.deepEqual(registered.map(accessory => (accessory.context as HydrawiseMatterAccessoryContext).relayId), [ 101, 102 ],
      "the second poll registered only the zone the first had not seen");
  });

  test("a failed registration records nothing, so the next poll tries again rather than losing the zone forever", async () => {

    const { matter } = makeMatter({ failRegistration: true });
    const { lines, transport } = makeTransport({ matter });

    await transport.publish([zone(101)]);

    assert.equal(lines().filter(line => line.level === "error").length, 1, "the failure is reported once");

    // A live server on the retry. The transport must not have marked the zone as registered on the way through the failure.
    const retry = makeMatter();
    const { transport: second } = makeTransport({ matter: retry.matter });

    await second.publish([zone(101)]);

    assert.equal(retry.registered.length, 1, "the zone registers on the following poll");
  });

  test("an endpoint restored from cache at boot is adopted, not registered a second time", async () => {

    const { matter, registered } = makeMatter();
    const { transport } = makeTransport({ matter });

    const cached = { UUID: matterZoneUuid(matter, SERIAL, 101),
      context: { controllerId: 7167, relayId: 101, serialNumber: SERIAL } } as MatterAccessory<HydrawiseMatterAccessoryContext>;

    transport.adopt(cached);

    await transport.publish([zone(101, { isOpen: true })]);

    assert.equal(registered.length, 0, "an adopted endpoint is already live, so registering it again would churn the bridge's endpoint list");
  });
});

describe("Matter zone commands", () => {

  test("an outlet's on and off reach the Hydrawise API as a run and a stop", async () => {

    const { matter, registered } = makeMatter();
    const { commands, transport } = makeTransport({ matter });

    await transport.publish([zone(101)]);

    const handlers = firstOf(registered).handlers as { onOff: { off: () => Promise<void>; on: () => Promise<void> } };

    await handlers.onOff.on();
    await handlers.onOff.off();

    /* The duration an outlet's "on" carries is deliberately undefined rather than a number invented here. An outlet's vocabulary has no duration in it, so the
     * transport declines to guess one and the controller answers with the zone's own configured run time - which is what the zone would have run for on its
     * schedule, and the only answer that is not arbitrary.
     */
    assert.deepEqual(commands, [ { action: "run", duration: undefined, relayId: 101 }, { action: "stop", duration: undefined, relayId: 101 } ],
      "on runs the zone and off stops it");
  });

  test("a valve's open passes its requested duration through, and falls back when the request carries none", async () => {

    const { matter, registered } = makeMatter();
    const { commands, transport } = makeTransport({ deviceType: "WaterValve", matter });

    await transport.publish([zone(101)]);

    const handlers = firstOf(registered).handlers as
      { valveConfigurationAndControl: { close: () => Promise<void>; open: (request?: { openDuration?: number | null }) => Promise<void> } };

    await handlers.valveConfigurationAndControl.open({ openDuration: 900 });
    await handlers.valveConfigurationAndControl.open({ openDuration: null });
    await handlers.valveConfigurationAndControl.open();
    await handlers.valveConfigurationAndControl.close();

    // A null openDuration is Matter's own spelling of "no duration set", so it must reach the controller as the same absence an omitted request does - not as a
    // null the controller would then have to know how to read.
    assert.deepEqual(commands, [ { action: "run", duration: 900, relayId: 101 }, { action: "run", duration: undefined, relayId: 101 },
      { action: "run", duration: undefined, relayId: 101 }, { action: "stop", duration: undefined, relayId: 101 } ],
    "a requested duration is honored and both spellings of its absence fall through");
  });

  test("a command that fails propagates, so the ecosystem reports a failure rather than a silent success", async () => {

    const { matter, registered } = makeMatter();
    const { lines, logger } = capturingLog();

    const transport = new HydrawiseMatterController({ command: async (): Promise<void> => { throw new Error("The Hydrawise API refused the command."); },
      controllerId: 7167, deviceType: "OnOffOutlet", log: logger, matter, serialNumber: SERIAL });

    await transport.publish([zone(101)]);

    const handlers = firstOf(registered).handlers as { onOff: { on: () => Promise<void> } };

    await assert.rejects(() => handlers.onOff.on(), /refused the command/, "the handler throws so Homebridge can map it to a Matter status");
    assert.equal(lines().length, 1, "the transport does not narrate a command failure it is passing on to the caller");
  });
});

describe("Matter state publishing", () => {

  test("an unchanged zone is not republished, because every write is a change notification to every commissioned fabric", async () => {

    const { matter, updates } = makeMatter();
    const { transport } = makeTransport({ matter });

    await transport.publish([zone(101)]);
    await transport.publish([zone(101)]);
    await transport.publish([zone(101)]);

    assert.equal(updates.length, 1, "three identical polls produce one publish");

    await transport.publish([zone(101, { isOpen: true })]);

    assert.equal(updates.length, 2, "a genuine change does publish");
    assert.deepEqual(firstOf(updates.slice(1)).attributes, { onOff: true }, "and it carries the new state");
  });

  test("a valve publishes the durations its cluster reports, and an outlet publishes only on and off", async () => {

    const valve = makeMatter();
    const { transport: valveTransport } = makeTransport({ deviceType: "WaterValve", matter: valve.matter });

    await valveTransport.publish([zone(101, { isOpen: true, remainingSeconds: 240, runSeconds: 600 })]);

    assert.deepEqual(firstOf(valve.updates), { attributes: { currentState: 1, defaultOpenDuration: 600, openDuration: 600, remainingDuration: 240, targetState: 1 },
      cluster: "valveConfigurationAndControl", uuid: matterZoneUuid(valve.matter, SERIAL, 101) }, "a running valve reports both its full run and what is left of it");

    const outlet = makeMatter();
    const { transport: outletTransport } = makeTransport({ matter: outlet.matter });

    await outletTransport.publish([zone(101, { isOpen: true, remainingSeconds: 240 })]);

    assert.deepEqual(firstOf(outlet.updates).attributes, { onOff: true }, "an outlet has nowhere to put a duration and does not invent one");
  });

  test("a closed valve reports no durations rather than stale ones", async () => {

    const { matter, updates } = makeMatter();
    const { transport } = makeTransport({ deviceType: "WaterValve", matter });

    await transport.publish([zone(101, { isOpen: false, runSeconds: 600 })]);

    assert.deepEqual(firstOf(updates).attributes, { currentState: 0, defaultOpenDuration: 600, openDuration: null, remainingDuration: null, targetState: 0 },
      "a zone that is not running has no run in progress to describe");
  });

  test("a failed publish is retried on the next poll rather than being suppressed by its own memo", async () => {

    let fail = true;

    const { matter, updates } = makeMatter({ failUpdate: () => fail });
    const { lines, transport } = makeTransport({ matter });

    await transport.publish([zone(101, { isOpen: true })]);

    assert.equal(updates.length, 0, "the publish did not land");
    assert.equal(lines().filter(line => line.level === "error").length, 1, "and the failure is reported");

    fail = false;

    // The same state as the failed attempt. A transport that recorded what it TRIED to write would treat this as unchanged and never retry it.
    await transport.publish([zone(101, { isOpen: true })]);

    assert.equal(updates.length, 1, "the next poll republishes the state the failed attempt never delivered");
  });

  test("a zone that leaves the projection stops being published without disturbing the zones that remain", async () => {

    const { matter, updates } = makeMatter();
    const { transport } = makeTransport({ matter });

    await transport.publish([ zone(101), zone(102) ]);
    await transport.publish([zone(101, { isOpen: true })]);

    assert.deepEqual(updates.slice(2).map(update => update.uuid), [matterZoneUuid(matter, SERIAL, 101)], "only the surviving zone published");
  });
});

describe("Matter cache rebuilding", () => {

  const deviceTypeFor = (): HydrawiseMatterDeviceType => "OnOffOutlet";
  const command: HydrawiseMatterCommand = async (): Promise<void> => undefined;

  test("a well-formed cache entry is rebuilt as a wholly fresh accessory rather than re-registered as found", () => {

    const { matter } = makeMatter();

    /* The shape Homebridge actually hands back: a JSON round-trip, so the device type is a bare object with a name and no behavior, plus the matter.js internals
     * that ride along with it. Re-registering this object is the thing the rebuild exists to prevent.
     */
    const cached = { UUID: matterZoneUuid(matter, SERIAL, 101), _eventEmitter: { on: (): void => undefined }, _parts: [],
      context: { controllerId: 7167, relayId: 101, serialNumber: SERIAL }, deviceType: { name: "OnOffPlugInUnit" },
      displayName: "Front Lawn" } as unknown as MatterAccessory;

    const rebuilt = rebuildCachedMatterAccessory({ cached, command, deviceTypeFor, matter });

    assert.ok(rebuilt, "a readable cache entry rebuilds");
    assert.equal(rebuilt.UUID, cached.UUID, "the rebuilt accessory keeps the identity the ecosystem already knows");
    assert.equal(rebuilt.displayName, "Front Lawn", "and the name it was last seen under");
    assert.equal((rebuilt as unknown as { _parts?: unknown })._parts, undefined, "the matter.js internals do not survive the rebuild");
    assert.equal((rebuilt as unknown as { _eventEmitter?: unknown })._eventEmitter, undefined, "nor does the event emitter");
    assert.equal(rebuilt.deviceType, matter.deviceTypes.OnOffOutlet, "the device type is the live one, not the prototype-less shell from disk");
    assert.ok(rebuilt.handlers?.onOff, "and the endpoint is commandable, which a restored object never is");
  });

  test("a rebuilt endpoint registers closed, because nobody has checked it since the process stopped", () => {

    const { matter } = makeMatter();

    const cached = { UUID: matterZoneUuid(matter, SERIAL, 101), context: { controllerId: 7167, relayId: 101, serialNumber: SERIAL },
      deviceType: { name: "OnOffPlugInUnit" }, displayName: "Front Lawn" } as unknown as MatterAccessory;

    const rebuilt = rebuildCachedMatterAccessory({ cached, command, deviceTypeFor, matter });

    // Under-reporting water running is the safe direction to be briefly wrong in; the first poll lands within seconds and corrects it either way.
    assert.deepEqual(rebuilt?.clusters?.onOff, { onOff: false }, "the cached run is not re-asserted as though it were current");
  });

  test("a cache entry whose device type no longer matches the configuration is declined, because its clusters are changing", () => {

    const { matter } = makeMatter();

    const cached = { UUID: matterZoneUuid(matter, SERIAL, 101), context: { controllerId: 7167, relayId: 101, serialNumber: SERIAL },
      deviceType: { name: "WaterValve" }, displayName: "Front Lawn" } as unknown as MatterAccessory;

    assert.equal(rebuildCachedMatterAccessory({ cached, command, deviceTypeFor, matter }), null,
      "a valve endpoint cannot be rebuilt as an outlet, so the entry is left for the sweep and the zone is registered fresh");
  });

  test("a cache entry this plugin cannot read is declined rather than guessed at", () => {

    const { matter } = makeMatter();

    const entries: unknown[] = [ undefined, null, {}, { controllerId: 7167 }, { controllerId: 7167, relayId: 101 },
      { controllerId: 7167, relayId: 101, serialNumber: "" }, { controllerId: "7167", relayId: 101, serialNumber: SERIAL },
      { controllerId: 7167, relayId: 1.5, serialNumber: SERIAL } ];

    for(const context of entries) {

      const cached = { UUID: "whatever", context, deviceType: { name: "OnOffPlugInUnit" }, displayName: "Front Lawn" } as unknown as MatterAccessory;

      assert.equal(rebuildCachedMatterAccessory({ cached, command, deviceTypeFor, matter }), null,
        "a context of " + JSON.stringify(context) + " cannot address a zone, so it is declined");
    }
  });

  test("a rebuilt endpoint routes its commands through the late-bound surface, not one captured at build time", async () => {

    const { matter } = makeMatter();
    const commands: RecordedCommand[] = [];

    const cached = { UUID: matterZoneUuid(matter, SERIAL, 101), context: { controllerId: 7167, relayId: 101, serialNumber: SERIAL },
      deviceType: { name: "OnOffPlugInUnit" }, displayName: "Front Lawn" } as unknown as MatterAccessory;

    const record: HydrawiseMatterCommand = async (context, action, duration) => void commands.push({ action, duration, relayId: context.relayId });
    const rebuilt = rebuildCachedMatterAccessory({ cached, command: record, deviceTypeFor, matter });

    await (rebuilt?.handlers?.onOff as { on: () => Promise<void> }).on();

    // The identity the handler passes is the one the cache carried, which is how a command that arrives before discovery finishes still knows which zone it means.
    assert.deepEqual(commands, [{ action: "run", duration: undefined, relayId: 101 }], "a cache-rebuilt endpoint is fully commandable");
  });
});
