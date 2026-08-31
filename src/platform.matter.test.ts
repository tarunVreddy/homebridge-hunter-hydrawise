/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.matter.test.ts: The Matter lifecycle the platform owns - the capability gate, the cold-boot cache rebuild and its ORDERING against discovery, the
 * per-controller transport, the late-bound command surface, and the orphan sweep.
 *
 * The ordering pin in this file is the important one. Everything else here is bookkeeping; the reason the boot rebuild exists at all is that a Matter bridge
 * advertises whatever endpoints it holds at the moment it comes up, so a plugin that registers after its first network call comes up empty and every restart
 * reads to a commissioned ecosystem as a fresh batch of devices. That failure is invisible in a running plugin and only shows up as duplicated or re-announced
 * devices days later, which is exactly the kind of thing that needs a test standing on it.
 */

import { buildPlatform, installMockDispatcher, loggedAt, programJsonReply, waitFor } from "./testing/platform.helpers.ts";
import { describe, test } from "node:test";
import { makeCustomerDetails, normalSchedule } from "./api.helpers.ts";
import type { HydrawiseMatterAccessoryContext } from "./types.ts";
import type { MatterAccessory } from "homebridge";
import assert from "node:assert/strict";
import { firstOf } from "./testing.helpers.ts";
import { matterZoneUuid } from "./matter.ts";
import { syntheticController } from "./api.fixtures.ts";

const DID_FINISH_LAUNCHING = "didFinishLaunching";
const SHUTDOWN = "shutdown";

// Matter is off for every controller unless a test opts in, which is the shipped default.
const MATTER_ON = ["Enable.Matter"];

/* A UUID generator matching the platform double's, which is the identity function - it hands back whatever seed it is given. Deriving expectations through the
 * REAL matterZoneUuid rather than writing the seed string out here is what keeps these pins honest: a change to the derivation moves both sides together, so
 * these tests assert that the platform and the transport agree about a zone's identity rather than re-stating a literal that could drift from both.
 */
const matterApi = { uuid: { generate: (seed: string): string => seed } } as unknown as Parameters<typeof matterZoneUuid>[0];

function zoneUuid(relayId: number, serialNumber: string = syntheticController.serial_number): string {

  return matterZoneUuid(matterApi, serialNumber, relayId);
}

// A cached Matter accessory in the shape Homebridge restores it: a JSON round-trip, so the device type is a bare named object with no behavior behind it.
function cachedZone(options: { controllerId?: number; deviceType?: string; relayId: number; serialNumber?: string }): MatterAccessory {

  const serialNumber = options.serialNumber ?? syntheticController.serial_number;

  return { UUID: zoneUuid(options.relayId, serialNumber),
    context: { controllerId: options.controllerId ?? syntheticController.controller_id, relayId: options.relayId, serialNumber },
    deviceType: { name: options.deviceType ?? "OnOffPlugInUnit" }, displayName: "Zone " + options.relayId.toString() } as unknown as MatterAccessory;
}

describe("HydrawisePlatform Matter capability gate", () => {

  test("a bridge without Matter registers nothing and reports nothing, however the options are set", async (t) => {

    const { emit, lines, matterRegistered, matterUnregistered, updated } = buildPlatform({ matter: false,
      matterCached: [cachedZone({ relayId: 700001 })], options: MATTER_ON });

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await waitFor(() => (updated.length >= 1) ? true : undefined);

    /* Matter is the BRIDGE's setting, not the plugin's, so a user who turns the feature option on without enabling Matter on their bridge gets a plugin that
     * behaves exactly as it did before Matter existed - including leaving a cache it cannot act on undisturbed rather than unregistering it.
     */
    assert.equal(matterRegistered.length, 0, "nothing is registered on a bridge that has no Matter");
    assert.equal(matterUnregistered.length, 0, "and nothing cached is swept either, since the sweep cannot know what is orphaned");
    assert.equal(lines().filter(line => line.level === "error").length, 0, "the absence is a degrade, not a fault");
  });

  test("a bridge with Matter but no controller opted in registers nothing", async (t) => {

    const { emit, matterRegistered, updated } = buildPlatform({ matter: true });

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await waitFor(() => (updated.length >= 1) ? true : undefined);

    assert.equal(matterRegistered.length, 0, "the feature option is off by default, so an existing install is untouched");
  });
});

describe("HydrawisePlatform Matter cold boot", () => {

  test("cached endpoints are registered BEFORE discovery makes its first call", async (t) => {

    const { emit, matterRegistered, updated } = buildPlatform({ matter: true, matterCached: [ cachedZone({ relayId: 700001 }), cachedZone({ relayId: 700002 }) ],
      options: MATTER_ON });

    t.after(() => emit(SHUTDOWN));

    /* Discovery is deliberately left UNANSWERED: the MockAgent is installed but no reply is programmed for customerdetails.php, so the platform spends the whole
     * of this test still waiting on the network. That is precisely the window a restart spends with its Matter bridge already advertising, and the window the
     * endpoints must be live in - so a registration observed here can only have come from the boot path and not from discovery.
     */
    await using dispatcher = installMockDispatcher();

    assert.ok(dispatcher.agent, "the dispatcher is installed but silent");

    emit(DID_FINISH_LAUNCHING);

    await waitFor(() => (matterRegistered.length >= 2) ? true : undefined);

    assert.deepEqual(matterRegistered.map(accessory => accessory.UUID).toSorted(), [ zoneUuid(700001), zoneUuid(700002) ].toSorted(),
      "both cached endpoints are live before Hydrawise has said a word");

    // The negative half, which is what makes the ordering claim rather than merely a registration claim: discovery has not completed, so nothing downstream of it
    // has run. A platform that registered from configureController instead would have had to get past this.
    assert.equal(updated.length, 0, "no controller accessory has been configured yet, so the registration cannot have come from discovery");
  });

  test("a cached endpoint is rebuilt clean, with a live device type and working handlers", async (t) => {

    const { emit, matterRegistered } = buildPlatform({ matter: true, matterCached: [cachedZone({ relayId: 700001 })], options: MATTER_ON });

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    emit(DID_FINISH_LAUNCHING);
    await waitFor(() => (matterRegistered.length >= 1) ? true : undefined);

    const accessory = firstOf(matterRegistered);

    assert.equal((accessory.context as HydrawiseMatterAccessoryContext).relayId, 700001, "the rebuilt endpoint stands for the zone the cache named");
    assert.ok(accessory.handlers?.onOff, "and it is commandable, which the prototype-less object from disk never is");
    assert.deepEqual(accessory.clusters?.onOff, { onOff: false }, "it registers closed, because nobody has checked the zone since the process stopped");
    assert.ok(dispatcher.agent, "discovery is left unanswered, so this is the boot path's work alone");
  });

  test("a command arriving before discovery finishes is refused with a reason rather than dropped", async (t) => {

    const { emit, lines, matterRegistered } = buildPlatform({ matter: true, matterCached: [cachedZone({ relayId: 700001 })], options: MATTER_ON });

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    emit(DID_FINISH_LAUNCHING);
    await waitFor(() => (matterRegistered.length >= 1) ? true : undefined);

    const handlers = firstOf(matterRegistered).handlers as { onOff: { on: () => Promise<void> } };

    // The endpoint is live and the controller is not, which is the whole point of the late-bound command surface: the window is real, and a user in it deserves
    // a failed command and a log line rather than a button that silently does nothing.
    await assert.rejects(() => handlers.onOff.on(), /not ready/, "the command fails rather than appearing to succeed");
    assert.ok(loggedAt(lines(), "warn", "before its controller was ready"), "and the reason is written down");
    assert.ok(dispatcher.agent, "discovery is left unanswered, which is what keeps the controller absent");
  });

  test("a cache entry whose device type no longer matches the option is declined while its matching sibling is restored", async (t) => {

    /* Two cached endpoints for the same controller, differing only in the device type the cache remembers. The options ask for an outlet, so one matches and one
     * does not - which is what the boot after flipping Matter.Valve off looks like. Both are in the same run deliberately: the restored sibling is what makes the
     * declined one's absence meaningful rather than a rebuild that simply never happened.
     */
    const { emit, matterRegistered, updated } = buildPlatform({ matter: true,
      matterCached: [ cachedZone({ deviceType: "WaterValve", relayId: 700001 }), cachedZone({ deviceType: "OnOffPlugInUnit", relayId: 700002 }) ],
      options: MATTER_ON });

    t.after(() => emit(SHUTDOWN));

    // Discovery is left unanswered so the only thing that has run when these assertions fire is the boot rebuild. Letting discovery complete would let each
    // controller's first poll register its whole zone roster, which is correct behavior - the declined zone IS rebuilt a moment later - but it would drown the
    // one distinction this test exists to draw.
    await using dispatcher = installMockDispatcher();

    assert.ok(dispatcher.agent, "the dispatcher is installed but silent");

    emit(DID_FINISH_LAUNCHING);
    await waitFor(() => (matterRegistered.length >= 1) ? true : undefined);

    assert.deepEqual(matterRegistered.map(accessory => accessory.UUID), [zoneUuid(700002)],
      "the endpoint whose clusters are changing is left for its controller to rebuild, while the one that still matches is restored");
    assert.equal(updated.length, 0, "and discovery has not run, so this is the boot rebuild's decision alone");
  });
});

describe("HydrawisePlatform Matter orphan sweep", () => {

  test("a cached endpoint no live controller claims is unregistered once discovery has run", async (t) => {

    const orphan = cachedZone({ controllerId: 999999, relayId: 700001, serialNumber: "GONE12345" });
    const { emit, matterUnregistered, updated } = buildPlatform({ matter: true, matterCached: [orphan], options: MATTER_ON });

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await waitFor(() => (updated.length >= 1) ? true : undefined);
    await waitFor(() => (matterUnregistered.length >= 1) ? true : undefined);

    // Leaving it would strand a dead device in the user's home and resurrect it on every boot thereafter.
    assert.equal(firstOf(matterUnregistered).UUID, orphan.UUID, "the endpoint whose controller left the account is retired");
  });

  test("a cached endpoint its controller still claims survives the sweep", async (t) => {

    const { emit, matterUnregistered, updated } = buildPlatform({ matter: true, matterCached: [cachedZone({ relayId: 700001 })], options: MATTER_ON });

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await waitFor(() => (updated.length >= 1) ? true : undefined);

    // The claim happens in configureController, which the sweep follows in the same discovery pass - so a surviving endpoint proves the claim ran first.
    assert.equal(matterUnregistered.length, 0, "an endpoint a live, enabled controller adopted is left alone");
  });

  test("turning the Matter option off retires that controller's endpoints", async (t) => {

    const { emit, matterUnregistered, updated } = buildPlatform({ matter: true, matterCached: [cachedZone({ relayId: 700001 })] });

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await waitFor(() => (updated.length >= 1) ? true : undefined);
    await waitFor(() => (matterUnregistered.length >= 1) ? true : undefined);

    // No controller builds a transport with the option off, so nothing claims the entry and the sweep finds it - which is how turning the feature off actually
    // removes the devices rather than merely stopping their updates.
    assert.equal(firstOf(matterUnregistered).UUID, zoneUuid(700001), "the endpoint is removed rather than left behind un-updated");
  });
});
