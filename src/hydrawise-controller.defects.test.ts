/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hydrawise-controller.defects.test.ts: Characterization pins for the HydrawiseController polling loop that fix current behavior with a distinguishing input,
 * including the preserved defects labeled with their bug-ledger numbers. Also covers the all-suspended versus rain-stopped program-mode distinction and the two
 * getStatus-failure backoff arms.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id and controller_id, so camelcase is disabled here to let these literals mirror the wire verbatim.
/* eslint-disable camelcase */
import { Characteristic, Service } from "./testing/hap.helpers.ts";
import type { HydrawiseZoneConfig, StatusScheduleResponse } from "./hydrawise-types.ts";
import { allSuspended, fastPolling, makeStatusSchedule, makeZone, rainStopped } from "./hydrawise-api.helpers.ts";
import { assertNoUnhandledRejections, firstOf } from "./testing.helpers.ts";
import { buildController, loggedAt, waitFor } from "./testing/platform.helpers.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { bareSensors } from "./hydrawise-api.fixtures.ts";

// Compose a fast-cadence single-zone schedule.
function schedule(zones: HydrawiseZoneConfig[], sensors: StatusScheduleResponse["sensors"] = bareSensors): StatusScheduleResponse {

  return fastPolling(makeStatusSchedule({ relays: zones, sensors }));
}

function scheduledZone(): HydrawiseZoneConfig {

  return makeZone({ name: "Alpha", relay: 1, relay_id: 700001, run: 480, time: 68000, timestr: "16:00" });
}

function runningZone(): HydrawiseZoneConfig {

  return makeZone({ name: "Alpha", relay: 1, relay_id: 700001, run: 600, time: 1, timestr: "" });
}

describe("HydrawiseController updateState defect pins", () => {

  test("BLESSED ghost-domain: a single zone vanishing recomputes the program mode over the empty domain to no-program-scheduled", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule([]), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    // The valve appears on poll 1 and is pruned once the zone vanishes; on that vanish poll the aggregate runs over the now-empty enabled domain, where the
    // all-stopped test 0 === 0 selects NO_PROGRAM_SCHEDULED. This is the slice-2 blessed ghost-domain reading, not a bug.
    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001") ? true : undefined);
    await waitFor(() => (h.accessory.getServiceById(Service.Valve, "700001") === undefined) ? true : undefined);

    const irrigation = h.accessory.getService(Service.IrrigationSystem);

    assert.ok(irrigation, "the irrigation system service should exist");
    assert.equal(irrigation.getCharacteristic(Characteristic.ProgramMode).value, Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED,
      "the empty enabled domain aggregates to no program scheduled");
  });

  test("Bug 15: a zone manually started, vanished, then reappearing while still running keeps the retained manual flag, so the program mode stays the stale " +
    "no-program-scheduled while the valve reports in use", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
      recorder.program("statusschedule.php", { body: schedule([]), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    // Poll 1 seeds the valve; a manual start marks the zone manual and sets the program mode to manual mode.
    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001") ? true : undefined);

    const firstValve = h.accessory.getServiceById(Service.Valve, "700001");

    assert.ok(firstValve, "the zone valve should exist after the first poll");
    await firstValve.getCharacteristic(Characteristic.Active).triggerSet(Characteristic.Active.ACTIVE);

    // Poll 2 drops the zone (valve pruned; the empty domain recomputes the program mode to no-program-scheduled), and the retained hint entry survives that
    // pruning. The default poll brings the zone back still running.
    await waitFor(() => (h.accessory.getServiceById(Service.Valve, "700001") === undefined) ? true : undefined);
    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001") ? true : undefined);

    const reappeared = h.accessory.getServiceById(Service.Valve, "700001");
    const irrigation = h.accessory.getService(Service.IrrigationSystem);

    assert.ok(reappeared, "the zone valve should reappear");
    assert.ok(irrigation, "the irrigation system service should exist");

    // The reappeared entry kept isManual true (the running-zone branch skips the manual clear), so the aggregate guard suppresses the program-mode recompute and
    // it remains the stale no-program-scheduled from the vanish poll, even as the valve reports in use. A pruning fix would create a fresh non-manual entry, the
    // guard would fire, and the program mode would recompute to program-scheduled.
    await waitFor(() => (reappeared.getCharacteristic(Characteristic.InUse).value === Characteristic.InUse.IN_USE) ? true : undefined);
    assert.equal(irrigation.getCharacteristic(Characteristic.ProgramMode).value, Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED,
      "the retained manual flag suppresses the recompute, leaving the program mode stale");
  });

  test("Bug 10: a malformed poll body leaves the prior status in place, logs the error, and still completes the poll - the update pass runs and the per-poll " +
    "MQTT publish fires from the stale status", async (t) => {

    const h = buildController({ mqtt: true, program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
      recorder.program("statusschedule.php", { kind: "malformed" });
      recorder.programDefault("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    // The second publish is the malformed poll completing from the stale running status. Once it lands - and before the recovering poll 250ms later flips the
    // zone to scheduled - a direct HomeKit read confirms this.status stayed the prior poll: the running zone's valve still reports in use.
    await waitFor(() => (mqtt.publishes.length >= 2) ? true : undefined);

    const valve = h.accessory.getServiceById(Service.Valve, "700001");

    assert.ok(valve, "the running zone's valve should exist");
    assert.equal(valve.getCharacteristic(Characteristic.InUse).value, Characteristic.InUse.IN_USE,
      "after the malformed poll a characteristic read still reflects the prior running poll");

    // The third publish is the recovering default poll (scheduled). Waiting on it confirms the loop kept running past the malformed poll.
    await waitFor(() => (mqtt.publishes.length >= 3) ? true : undefined);

    assert.ok(loggedAt(h.lines(), "error", "Unable to retrieve the current status"), "a malformed body should log the parse failure");
    assert.ok(h.retrieve.callsTo("statusschedule.php").length >= 3, "the loop should proceed to a further poll on the stale cadence");

    const first = firstOf(mqtt.publishes, "MQTT publish").payload;

    assert.equal(mqtt.publishes[1]?.payload, first, "the malformed poll publishes the stale prior status unchanged");
    assert.notEqual(mqtt.publishes[2]?.payload, first, "the recovering poll publishes fresh status distinct from the stale one");
  });

  test("all zones suspended aggregates to program-scheduled with the suspend switch on", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: fastPolling(allSuspended()), kind: "response" }),
      signalAborted: false, userOptions: ["Enable.Device.Suspend.SN0A1B2C3D4"] });

    t.after(() => h.abort());

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700019") ? true : undefined);

    const irrigation = h.accessory.getService(Service.IrrigationSystem);
    const suspend = h.accessory.getServiceById(Service.Switch, "All");

    assert.ok(irrigation, "the irrigation system service should exist");
    assert.ok(suspend, "the suspend switch should exist");
    assert.equal(irrigation.getCharacteristic(Characteristic.ProgramMode).value, Characteristic.ProgramMode.PROGRAM_SCHEDULED,
      "all-suspended zones are not sensor-stopped, so the program mode stays scheduled");
    assert.equal(suspend.getCharacteristic(Characteristic.On).value, true, "the suspend switch reports all zones suspended");
  });

  test("all zones rain-stopped aggregates to no-program-scheduled with the suspend switch off", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: fastPolling(rainStopped()), kind: "response" }),
      signalAborted: false, userOptions: ["Enable.Device.Suspend.SN0A1B2C3D4"] });

    t.after(() => h.abort());

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700019") ? true : undefined);

    const irrigation = h.accessory.getService(Service.IrrigationSystem);
    const suspend = h.accessory.getServiceById(Service.Switch, "All");

    assert.ok(irrigation, "the irrigation system service should exist");
    assert.ok(suspend, "the suspend switch should exist");
    assert.equal(irrigation.getCharacteristic(Characteristic.ProgramMode).value, Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED,
      "every zone rain-stopped drives the program mode to no program scheduled");
    assert.equal(suspend.getCharacteristic(Characteristic.On).value, false, "a rain stop is not a suspend, so the suspend switch stays off");
  });

  test("a steady-state poll failure after a success recovers through the short backoff arm", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
      recorder.program("statusschedule.php", { kind: "null" });
      recorder.programDefault("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    // Poll 1 succeeds (running, active); poll 2 returns null so getStatus throws and the isFirstRun-false ~250ms backoff arm runs; the recovering default poll
    // brings the zone back scheduled and inactive. Waiting for the valve to go inactive proves the recovery poll landed.
    await waitFor(() => {

      const valve = h.accessory.getServiceById(Service.Valve, "700001");

      return (valve?.getCharacteristic(Characteristic.Active).value === Characteristic.Active.INACTIVE) ? true : undefined;
    });

    assert.ok(h.retrieve.callsTo("statusschedule.php").length >= 3, "the loop should recover with a further poll after the failure");
  });

  test("a first-poll failure runs the fixed backoff arm and ends quietly on abort", async () => {

    const cleanup = assertNoUnhandledRejections();
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { kind: "null" }), signalAborted: false });

    // The very first poll returns null, so getStatus throws and retry evaluates the isFirstRun-true fixed backoff (60s) synchronously before suspending. A prompt
    // abort ends that wait; because backoff() ran before delay() suspended, the arm is exercised without any real 60-second wait.
    await waitFor(() => (h.retrieve.callsTo("statusschedule.php").length >= 1) ? true : undefined);

    h.abort();

    assert.equal(h.retrieve.callsTo("statusschedule.php").length, 1, "the loop should make exactly one poll before the abort ends the backoff wait");
    assert.ok(!loggedAt(h.lines(), "error", "stopped unexpectedly"), "a shutdown abort should unwind the loop without a fault report");

    cleanup();
  });
});
