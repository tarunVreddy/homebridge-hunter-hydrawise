/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller.matter.test.ts: The controller's Matter surface - the projection it hands the transport once per poll, and the narrow command path the transport
 * reaches back through.
 *
 * No Matter machinery appears anywhere in this file, which is the point. The controller's whole obligation to Matter is a flat projection and a command method,
 * so both are exercised through the platform double's recorder without a Matter API, a device type, or an endpoint being involved. The transport's own behavior
 * is pinned separately in src/matter.test.ts.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id and controller_id, so camelcase is disabled here to let these literals mirror the wire verbatim.
/* eslint-disable camelcase */
import type { HydrawiseZoneConfig, StatusScheduleResponse } from "./types.ts";
import { buildController, loggedAt, waitFor } from "./testing/platform.helpers.ts";
import { describe, test } from "node:test";
import { fastPolling, makeStatusSchedule, makeZone } from "./api.helpers.ts";
import { HYDRAWISE_UNSCHEDULED_SENTINEL } from "./types.ts";
import { Service } from "./testing/hap.helpers.ts";
import assert from "node:assert/strict";
import { bareSensors } from "./api.fixtures.ts";
import { firstOf } from "./testing.helpers.ts";

// Every zone in this suite is exposed over Matter unless a test says otherwise, because the projection is what is under test rather than the gate that reaches it.
const MATTER_ON = "Enable.Matter";

function schedule(zones: HydrawiseZoneConfig[]): StatusScheduleResponse {

  return fastPolling(makeStatusSchedule({ relays: zones, sensors: bareSensors }));
}

// A zone the wire reports as currently running. The wire spells that as time === 1, which the schedule classifier reads first among its arms.
function runningZone(): HydrawiseZoneConfig {

  return makeZone({ name: "Alpha", relay: 1, relay_id: 700001, run: 600, time: 1, timestr: "" });
}

function idleZone(): HydrawiseZoneConfig {

  return makeZone({ name: "Beta", relay: 2, relay_id: 700002, run: 300, time: 3600, timestr: "" });
}

// The last projection the controller published, once one has been made.
async function lastPublish(h: ReturnType<typeof buildController>): Promise<{ controllerId: number; zones: { isOpen: boolean; name: string; relayId: number;
  remainingSeconds: number; runSeconds: number; }[]; }> {

  return waitFor(() => (h.matterPublishes.length > 0) ? h.matterPublishes[h.matterPublishes.length - 1] : undefined);
}

describe("HydrawiseController Matter projection", () => {

  test("every enabled zone reaches the transport carrying its identity, name, and durations", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([ runningZone(), idleZone() ]),
      kind: "response" }), signalAborted: false, userOptions: [MATTER_ON] });

    t.after(() => h.abort());

    const publish = await lastPublish(h);

    assert.equal(publish.controllerId, h.controllerConfig.controller_id, "the publish names the controller whose poll produced it");
    assert.deepEqual(publish.zones.map(zone => zone.relayId), [ 700001, 700002 ], "both enabled zones are projected");
    assert.deepEqual(publish.zones.map(zone => zone.name), [ "Alpha", "Beta" ], "each zone carries the name it is displayed under");
    assert.deepEqual(publish.zones.map(zone => zone.runSeconds), [ 600, 300 ], "each zone carries its own configured run time");
  });

  test("a running zone is projected open with the time actually left on its run", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([ runningZone(), idleZone() ]),
      kind: "response" }), signalAborted: false, userOptions: [MATTER_ON] });

    t.after(() => h.abort());

    const publish = await lastPublish(h);
    const [ alpha, beta ] = publish.zones;

    assert.equal(alpha?.isOpen, true, "the zone the wire reports as running projects open");
    assert.equal(beta?.isOpen, false, "and the one it does not, does not");

    /* The remaining time is the classifier's own reading against the WIRE's clock, never a local one. A zone that started at the poll's own timestamp has its
     * whole run ahead of it, which is what makes this equal to the configured run rather than merely close to it - a local clock read would drift.
     */
    assert.equal(alpha?.remainingSeconds, 600, "a run that has just begun has its full duration left");
    assert.equal(beta?.remainingSeconds, 0, "a zone that is not running has no remaining time to report");
  });

  test("a zone the user excludes from Matter is not projected, while its siblings still are", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([ runningZone(), idleZone() ]),
      kind: "response" }), signalAborted: false, userOptions: [ MATTER_ON, "Disable.Matter.700002" ] });

    t.after(() => h.abort());

    const publish = await lastPublish(h);

    // The per-zone gate is a real exclusion rather than a display filter: an excluded zone never reaches the transport, so no endpoint is ever registered for it.
    assert.deepEqual(publish.zones.map(zone => zone.relayId), [700001], "only the zone that is still opted in reaches the transport");
  });

  test("a controller with Matter off publishes an empty projection rather than nothing at all", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" }),
      signalAborted: false });

    t.after(() => h.abort());

    // The publish is unconditional and the projection is empty, which keeps the decision about whether Matter is live in one place - the platform - rather than
    // splitting it between the controller and the transport.
    const publish = await lastPublish(h);

    assert.deepEqual(publish.zones, [], "no zone is opted in, so the projection carries none");
  });

  test("a zone that the schedule reports as unscheduled still projects, closed", async (t) => {

    const unscheduled = makeZone({ name: "Gamma", relay: 3, relay_id: 700003, run: 300, time: HYDRAWISE_UNSCHEDULED_SENTINEL, timestr: "" });

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([unscheduled]), kind: "response" }),
      signalAborted: false, userOptions: [MATTER_ON] });

    t.after(() => h.abort());

    const publish = await lastPublish(h);
    const zone = firstOf(publish.zones, "projected zone");

    assert.equal(zone.isOpen, false, "a zone with nothing scheduled is closed, not absent");
    assert.equal(zone.runSeconds, 300, "and it still reports the duration it would run for if asked");
  });
});

describe("HydrawiseController Matter commands", () => {

  test("a run with no duration falls back to the zone's own configured run time", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([idleZone()]), kind: "response" }),
      signalAborted: false, userOptions: [MATTER_ON] });

    t.after(() => h.abort());

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700002") ? true : undefined);

    h.retrieve.programDefault("setzone.php", { body: { message: "ok" }, kind: "response" });

    await h.controller.commandZone(700002, "run");

    const call = firstOf(h.retrieve.callsTo("setzone.php"), "command call");

    assert.equal(call.params?.["action"], "run", "the command runs the zone");
    assert.equal(call.params?.["custom"], "300", "and does so for the duration the zone would have run for on its own schedule");
    assert.equal(call.params?.["relay_id"], "700002", "against the zone that was named");
  });

  test("a run with an explicit duration honors it", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([idleZone()]), kind: "response" }),
      signalAborted: false, userOptions: [MATTER_ON] });

    t.after(() => h.abort());

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700002") ? true : undefined);

    h.retrieve.programDefault("setzone.php", { body: { message: "ok" }, kind: "response" });

    await h.controller.commandZone(700002, "run", 900);

    assert.equal(firstOf(h.retrieve.callsTo("setzone.php"), "command call").params?.["custom"], "900",
      "a duration the caller supplied is passed through untouched");
  });

  test("a stop reaches the API as a stop", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" }),
      signalAborted: false, userOptions: [MATTER_ON] });

    t.after(() => h.abort());

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001") ? true : undefined);

    h.retrieve.programDefault("setzone.php", { body: { message: "ok" }, kind: "response" });

    await h.controller.commandZone(700001, "stop");

    assert.equal(firstOf(h.retrieve.callsTo("setzone.php"), "command call").params?.["action"], "stop", "the zone is stopped");
  });

  test("a command names the zone in the log, so a Matter-driven run reads like a HomeKit one", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([idleZone()]), kind: "response" }),
      signalAborted: false, userOptions: [MATTER_ON] });

    t.after(() => h.abort());

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700002") ? true : undefined);

    h.retrieve.programDefault("setzone.php", { body: { message: "ok" }, kind: "response" });

    await h.controller.commandZone(700002, "run", 600);

    assert.ok(loggedAt(h.lines(), "info", "Manually started"), "the run is narrated the way every other manual start is");
  });

  test("a command for a zone this controller does not have throws rather than commanding something else", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([idleZone()]), kind: "response" }),
      signalAborted: false, userOptions: [MATTER_ON] });

    t.after(() => h.abort());

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700002") ? true : undefined);

    await assert.rejects(() => h.controller.commandZone(999999, "run"), /Unknown zone/, "an unknown relay is refused by name");
  });

  test("a command the API refuses throws, so the ecosystem reports a failure rather than a silent success", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([idleZone()]), kind: "response" }),
      signalAborted: false, userOptions: [MATTER_ON] });

    t.after(() => h.abort());

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700002") ? true : undefined);

    // A null answer is retrieve()'s recoverable-error shape - the one it returns having already reported the underlying failure itself.
    h.retrieve.programDefault("setzone.php", { kind: "null" });

    await assert.rejects(() => h.controller.commandZone(700002, "run"), /refused the command/, "the refusal propagates to the caller");
  });
});
