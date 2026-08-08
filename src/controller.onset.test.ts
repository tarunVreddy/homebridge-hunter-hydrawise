/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller.onset.test.ts: HomeKit set-handler behavior on the HydrawiseController valves and the suspend switch, driven through the captured onSet
 * handlers. Covers the manual run and stop commands and their recorded setzone parameters, the system in-use collapse when the only running zone stops, the
 * command-failure revert, and the suspend / resume commands including the floored suspend timestamp pin (the bug 14 fix).
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id and controller_id, so camelcase is disabled here to let these literals mirror the wire verbatim.
/* eslint-disable camelcase */
import { Characteristic, Service } from "./testing/hap.helpers.ts";
import type { HydrawiseZoneConfig, StatusScheduleResponse } from "./types.ts";
import { buildController, loggedAt, waitFor } from "./testing/platform.helpers.ts";
import { describe, test } from "node:test";
import { fastPolling, makeStatusSchedule, makeZone } from "./api.helpers.ts";
import { HYDRAWISE_SUSPEND_DURATION } from "./settings.ts";
import assert from "node:assert/strict";
import { bareSensors } from "./api.fixtures.ts";
import { firstOf } from "./testing.helpers.ts";

function schedule(zones: HydrawiseZoneConfig[]): StatusScheduleResponse {

  return fastPolling(makeStatusSchedule({ relays: zones, sensors: bareSensors }));
}

function scheduledZone(): HydrawiseZoneConfig {

  return makeZone({ name: "Alpha", relay: 1, relay_id: 700001, run: 480, time: 68000, timestr: "16:00" });
}

function runningZone(): HydrawiseZoneConfig {

  return makeZone({ name: "Alpha", relay: 1, relay_id: 700001, run: 600, time: 1, timestr: "" });
}

describe("HydrawiseController valve and suspend onSet", () => {

  test("a manual run sends the run command with the custom duration and manual period", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    const valve = await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001"));

    await valve.getCharacteristic(Characteristic.Active).triggerSet(Characteristic.Active.ACTIVE);

    const command = firstOf(h.retrieve.callsTo("setzone.php"), "setzone call");

    assert.equal(command.params?.["action"], "run", "a manual start should send the run action");
    assert.equal(command.params?.["relay_id"], "700001", "the run command should target the zone relay");
    assert.equal(command.params?.["custom"], "480", "the run command should carry the scheduled duration");
    assert.equal(command.params?.["period_id"], "999", "the run command should use the manual period id");
  });

  test("a manual stop sends the stop command for the zone", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    const valve = await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001"));

    await valve.getCharacteristic(Characteristic.Active).triggerSet(Characteristic.Active.INACTIVE);

    const command = firstOf(h.retrieve.callsTo("setzone.php"), "setzone call");

    assert.equal(command.params?.["action"], "stop", "a manual stop should send the stop action");
    assert.equal(command.params?.["relay_id"], "700001", "the stop command should target the zone relay");
    assert.equal(command.params?.["custom"], undefined, "a stop command carries no custom duration");
  });

  test("stopping the only running zone collapses the system to not in use", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    const valve = await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001"));

    await valve.getCharacteristic(Characteristic.Active).triggerSet(Characteristic.Active.INACTIVE);

    const irrigation = h.accessory.getService(Service.IrrigationSystem);

    assert.ok(irrigation, "the irrigation system service should exist");
    assert.equal(irrigation.getCharacteristic(Characteristic.InUse).value, Characteristic.InUse.NOT_IN_USE,
      "stopping the last running zone leaves the system not in use");
  });

  test("a failed command reverts the valve state after the revert delay", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { kind: "null" });
    }, signalAborted: false });

    t.after(() => h.abort());

    const valve = await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001"));

    await valve.getCharacteristic(Characteristic.Active).triggerSet(Characteristic.Active.ACTIVE);

    // The null command schedules a 50ms revert that flips the optimistic ACTIVE back to INACTIVE.
    await waitFor(() => (valve.getCharacteristic(Characteristic.Active).value === Characteristic.Active.INACTIVE) ? true : undefined);

    assert.equal(valve.getCharacteristic(Characteristic.Active).value, Characteristic.Active.INACTIVE, "a failed run should revert the valve to inactive");
  });

  test("the suspend command floors its timestamp to a whole second (the bug 14 fix)", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false, userOptions: ["Enable.Device.Suspend.SN0A1B2C3D4"] });

    t.after(() => h.abort());

    // Wait until the first poll has run so the switch reflects live state, then drive the suspend.
    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001") ? true : undefined);

    const suspend = h.accessory.getServiceById(Service.Switch, "All");

    assert.ok(suspend, "the suspend switch should exist");

    // The production timestamp is Math.floor(Date.now() / 1000) + HYDRAWISE_SUSPEND_DURATION - the one-year offset added onto a whole-second floor. We bracket the
    // invocation with before/after Date.now() reads floored the same way: the captured custom param must be an integer lying inside the floored bracket.
    const before = Date.now();

    await suspend.getCharacteristic(Characteristic.On).triggerSet(true);

    const after = Date.now();
    const command = firstOf(h.retrieve.callsTo("setzone.php"), "setzone call");

    assert.equal(command.params?.["action"], "suspendall", "the suspend should send the suspendall action");
    assert.equal(command.params?.["period_id"], "999", "the suspend should use the manual period id");
    assert.equal(command.params?.["relay_id"], undefined, "a controller-wide suspend carries no relay id");

    const custom = Number(command.params?.["custom"]);
    const low = Math.floor(before / 1000) + HYDRAWISE_SUSPEND_DURATION;
    const high = Math.floor(after / 1000) + HYDRAWISE_SUSPEND_DURATION;

    assert.ok((custom >= low) && (custom <= high), "the floored suspend timestamp lies in the whole-second before/after bracket");
    assert.equal(custom % 1, 0, "the suspend timestamp is floored to a whole second");
  });

  test("a suspend command rejected by the API reverts the switch and logs the failure", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "denied", message_type: "error" }, kind: "response" });
    }, signalAborted: false, userOptions: ["Enable.Device.Suspend.SN0A1B2C3D4"] });

    t.after(() => h.abort());

    await waitFor(() => h.accessory.getServiceById(Service.Switch, "All") ? true : undefined);

    const suspend = h.accessory.getServiceById(Service.Switch, "All");

    assert.ok(suspend, "the suspend switch should exist");
    await suspend.getCharacteristic(Characteristic.On).triggerSet(true);

    // An error response schedules the 50ms revert that flips the optimistic true back off.
    await waitFor(() => (suspend.getCharacteristic(Characteristic.On).value === false) ? true : undefined);

    assert.ok(loggedAt(h.lines(), "error", "Unable to complete the suspend request"), "the suspend failure should be logged");
  });

  test("a suspend command with a malformed API response logs the read failure and reverts", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { kind: "malformed" });
    }, signalAborted: false, userOptions: ["Enable.Device.Suspend.SN0A1B2C3D4"] });

    t.after(() => h.abort());

    await waitFor(() => h.accessory.getServiceById(Service.Switch, "All") ? true : undefined);

    const suspend = h.accessory.getServiceById(Service.Switch, "All");

    assert.ok(suspend, "the suspend switch should exist");
    await suspend.getCharacteristic(Characteristic.On).triggerSet(true);

    await waitFor(() => (suspend.getCharacteristic(Characteristic.On).value === false) ? true : undefined);

    assert.ok(loggedAt(h.lines(), "error", "Unable to retrieve the result of the suspend request"), "the malformed suspend response should be logged");
  });

  test("a resume command sends suspendall with the current-time offset", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false, userOptions: ["Enable.Device.Suspend.SN0A1B2C3D4"] });

    t.after(() => h.abort());

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001") ? true : undefined);

    const suspend = h.accessory.getServiceById(Service.Switch, "All");

    assert.ok(suspend, "the suspend switch should exist");

    const before = Date.now();

    await suspend.getCharacteristic(Characteristic.On).triggerSet(false);

    const after = Date.now();
    const command = firstOf(h.retrieve.callsTo("setzone.php"), "setzone call");
    const custom = Number(command.params?.["custom"]);

    assert.equal(command.params?.["action"], "suspendall", "a resume also sends the suspendall action");
    assert.ok((custom >= Math.floor(before / 1000)) && (custom <= Math.floor(after / 1000)), "a resume timestamp is the current whole second, no one-year offset");
  });
});
