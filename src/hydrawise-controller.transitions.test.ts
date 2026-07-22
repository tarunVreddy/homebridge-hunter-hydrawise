/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hydrawise-controller.transitions.test.ts: Multi-poll transition behavior of the HydrawiseController polling loop. Each test programs a queue of poll responses
 * and drives the live loop across them at the fast cadence, waiting on the observable each transition produces. Covers zone start / stop logging (globally and
 * per-zone by the Log.Zone feature), rain-sensor transitions, zone appearance and disappearance with valve pruning, and zone-scoped Device disable.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id and controller_id, so camelcase is disabled here to let these literals mirror the wire verbatim.
/* eslint-disable camelcase */
import type { HydrawiseZoneConfig, StatusScheduleResponse } from "./hydrawise-types.ts";
import { bareSensors, rainSensors } from "./hydrawise-api.fixtures.ts";
import { buildController, loggedAt, waitFor } from "./testing/platform.helpers.ts";
import { describe, test } from "node:test";
import { fastPolling, makeStatusSchedule, makeZone } from "./hydrawise-api.helpers.ts";
import { Service } from "./testing/hap.helpers.ts";
import assert from "node:assert/strict";

// Compose a fast-cadence schedule from a zone list and an optional sensor block (the bare, non-referencing sensor by default).
function schedule(zones: HydrawiseZoneConfig[], sensors: StatusScheduleResponse["sensors"] = bareSensors): StatusScheduleResponse {

  return fastPolling(makeStatusSchedule({ relays: zones, sensors }));
}

// A single zone scheduled to run later (not currently running, outside the active window).
function scheduledZone(overrides: Partial<HydrawiseZoneConfig> = {}): HydrawiseZoneConfig {

  return makeZone({ name: "Alpha", relay: 1, relay_id: 700001, run: 480, time: 68000, timestr: "16:00", ...overrides });
}

// A single zone running now.
function runningZone(overrides: Partial<HydrawiseZoneConfig> = {}): HydrawiseZoneConfig {

  return makeZone({ name: "Alpha", relay: 1, relay_id: 700001, run: 600, time: 1, timestr: "", ...overrides });
}

// A single zone stopped by a rain sensor (suspend sentinel, no run, no schedule string).
function rainZone(overrides: Partial<HydrawiseZoneConfig> = {}): HydrawiseZoneConfig {

  return makeZone({ name: "Alpha", relay: 1, relay_id: 700001, run: 0, time: 1576800000, timestr: "", ...overrides });
}

describe("HydrawiseController updateState transitions", () => {

  test("logs a zone start and stop when Log.Zone is at its enabled default", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
      recorder.program("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    // Poll 1 seeds the valve (no transition), poll 2 turns it on (Started), the default poll turns it back off (Stopped).
    await waitFor(() => loggedAt(h.lines(), "info", "Stopped") ? true : undefined);

    assert.ok(loggedAt(h.lines(), "info", "Started"), "turning a zone on across polls should log a start");
    assert.ok(loggedAt(h.lines(), "info", "Stopped"), "turning a zone off across polls should log a stop");
  });

  test("suppresses a zone's start log when Log.Zone is disabled for that zone", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
    }, signalAborted: false, userOptions: ["Disable.Log.Zone.700001"] });

    t.after(() => h.abort());

    // Wait until at least two polls have run so the on-transition has certainly been processed, then confirm it produced no start log.
    await waitFor(() => (h.retrieve.callsTo("statusschedule.php").length >= 3) ? true : undefined);

    assert.ok(!loggedAt(h.lines(), "info", "Started"), "a zone with Log.Zone disabled should not log its start");
  });

  test("logs the rain sensor stopping and then allowing irrigation", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
      recorder.program("statusschedule.php", { body: schedule([rainZone()], rainSensors), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    await waitFor(() => loggedAt(h.lines(), "info", "Rain sensor is allowing irrigation") ? true : undefined);

    assert.ok(loggedAt(h.lines(), "info", "Rain sensor is stopping irrigation"), "a rain stop should be logged");
    assert.ok(loggedAt(h.lines(), "info", "Rain sensor is allowing irrigation"), "a rain clear should be logged");
  });

  test("prunes a valve when its zone disappears from the response", async (t) => {

    const twoZones = [ scheduledZone(), makeZone({ name: "Beta", relay: 2, relay_id: 700002, run: 480, time: 69000, timestr: "16:08" }) ];

    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule(twoZones), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    // Both valves appear on poll 1; Beta vanishes from every later poll, so its valve is pruned while Alpha's survives.
    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700002") ? true : undefined);
    await waitFor(() => (h.accessory.getServiceById(Service.Valve, "700002") === undefined) ? true : undefined);

    assert.ok(h.accessory.getServiceById(Service.Valve, "700001"), "the surviving zone's valve should remain");
    assert.equal(h.accessory.getServiceById(Service.Valve, "700002"), undefined, "the vanished zone's valve should be pruned");
  });

  test("creates a valve for a zone that appears on a later poll", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule([ scheduledZone(),
        makeZone({ name: "Gamma", relay: 3, relay_id: 700003, run: 480, time: 70000, timestr: "16:16" }) ]), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700003") ? true : undefined);

    assert.ok(h.accessory.getServiceById(Service.Valve, "700003"), "a newly appearing zone should get a valve");
  });

  test("omits the valve for a zone disabled at zone scope", async (t) => {

    const threeZones = [ scheduledZone(), makeZone({ name: "Beta", relay: 2, relay_id: 700002, run: 480, time: 69000, timestr: "16:08" }),
      makeZone({ name: "Gamma", relay: 3, relay_id: 700003, run: 480, time: 70000, timestr: "16:16" }) ];

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(threeZones), kind: "response" }),
      signalAborted: false, userOptions: ["Disable.Device.700002"] });

    t.after(() => h.abort());

    // Wait for the enabled zones' valves, then confirm the disabled zone never got one.
    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700003") ? true : undefined);

    assert.ok(h.accessory.getServiceById(Service.Valve, "700001"), "the first enabled zone should have a valve");
    assert.equal(h.accessory.getServiceById(Service.Valve, "700002"), undefined, "the zone disabled at zone scope should have no valve");
    assert.ok(h.accessory.getServiceById(Service.Valve, "700003"), "the third enabled zone should have a valve");
  });

  test("a zone-scoped Enable override keeps one valve while a controller disable omits the siblings", async (t) => {

    const threeZones = [ scheduledZone(), makeZone({ name: "Beta", relay: 2, relay_id: 700002, run: 480, time: 69000, timestr: "16:08" }),
      makeZone({ name: "Gamma", relay: 3, relay_id: 700003, run: 480, time: 70000, timestr: "16:16" }) ];

    // The controller-scoped disable turns every zone off, and the zone-scoped enable override - resolved at the device slot ahead of the controller slot - flips
    // just zone 700001 back on. The controller itself is built directly, so the whole-device platform gate is not in play here.
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(threeZones), kind: "response" }),
      signalAborted: false, userOptions: [ "Disable.Device.SN0A1B2C3D4", "Enable.Device.700001" ] });

    t.after(() => h.abort());

    // Wait for a full pass (the last enabled zone would be 700001 here) then confirm only the overridden zone got a valve.
    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001") ? true : undefined);
    await waitFor(() => (h.retrieve.callsTo("statusschedule.php").length >= 2) ? true : undefined);

    assert.ok(h.accessory.getServiceById(Service.Valve, "700001"), "the zone with the enable override should have a valve");
    assert.equal(h.accessory.getServiceById(Service.Valve, "700002"), undefined, "a sibling zone under the controller disable should have no valve");
    assert.equal(h.accessory.getServiceById(Service.Valve, "700003"), undefined, "a sibling zone under the controller disable should have no valve");
  });
});
