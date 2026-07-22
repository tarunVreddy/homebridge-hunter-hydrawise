/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hydrawise-controller.updatestate.test.ts: Single-poll behavior of the HydrawiseController polling loop, driven live at the fast (~250ms) cadence against the
 * synthetic NORMAL matrix. Covers valve creation and enumeration, the Active / InUse mapping across running, active-soon, and inactive zones, and the
 * irrigation-system aggregate characteristics after one completed poll.
 */
import { Characteristic, Service } from "./testing/hap.helpers.ts";
import { buildController, waitFor } from "./testing/platform.helpers.ts";
import { describe, test } from "node:test";
import { fastPolling, normalSchedule } from "./hydrawise-api.helpers.ts";
import assert from "node:assert/strict";

describe("HydrawiseController updateState (single poll)", () => {

  test("creates one enumerated valve service per enabled zone", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: fastPolling(normalSchedule()), kind: "response" }),
      signalAborted: false });

    t.after(() => h.abort());

    // The last zone's valve appears only after the per-zone loop has processed every zone, so waiting on it confirms the whole first pass ran.
    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700019") ? true : undefined);

    const valves = h.accessory.services.filter(service => service.UUID === "Valve");

    assert.equal(valves.length, 19, "a valve should be created for each of the 19 enabled zones");

    const firstValve = h.accessory.getServiceById(Service.Valve, "700001");

    assert.ok(firstValve, "the first zone's valve should exist under its relay_id subtype");
    assert.equal(firstValve.getCharacteristic(Characteristic.ServiceLabelIndex).value, 1, "the valve label index should match the zone relay number");
    assert.equal(firstValve.getCharacteristic(Characteristic.IsConfigured).value, Characteristic.IsConfigured.CONFIGURED, "a new valve should be configured");
    assert.equal(firstValve.getCharacteristic(Characteristic.ValveType).value, Characteristic.ValveType.IRRIGATION, "a valve should be typed as irrigation");
  });

  test("maps a running zone to Active and InUse with its remaining duration", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: fastPolling(normalSchedule()), kind: "response" }),
      signalAborted: false });

    t.after(() => h.abort());

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700019") ? true : undefined);

    const running = h.accessory.getServiceById(Service.Valve, "700001");

    assert.ok(running, "the running zone's valve should exist");
    assert.equal(running.getCharacteristic(Characteristic.Active).value, Characteristic.Active.ACTIVE, "a running zone should be active");
    assert.equal(running.getCharacteristic(Characteristic.InUse).value, Characteristic.InUse.IN_USE, "a running zone should be in use");
    assert.equal(running.getCharacteristic(Characteristic.RemainingDuration).value, 600, "the running zone should report its remaining runtime");
  });

  test("marks a zone queued within the active window active but not in use", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: fastPolling(normalSchedule()), kind: "response" }),
      signalAborted: false });

    t.after(() => h.abort());

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700019") ? true : undefined);

    // Relay 3 sits exactly on the 3600-second active-zone boundary, which is inclusive.
    const boundary = h.accessory.getServiceById(Service.Valve, "700003");

    assert.ok(boundary, "the boundary zone's valve should exist");
    assert.equal(boundary.getCharacteristic(Characteristic.Active).value, Characteristic.Active.ACTIVE, "a zone at the 3600s boundary should be active");
    assert.equal(boundary.getCharacteristic(Characteristic.InUse).value, Characteristic.InUse.NOT_IN_USE, "a queued-but-not-running zone should not be in use");
  });

  test("marks a zone one second past the active window inactive", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: fastPolling(normalSchedule()), kind: "response" }),
      signalAborted: false });

    t.after(() => h.abort());

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700019") ? true : undefined);

    // Relay 4 sits one second past the 3600-second window, so it falls outside the active band.
    const justOver = h.accessory.getServiceById(Service.Valve, "700004");

    assert.ok(justOver, "the just-past-window zone's valve should exist");
    assert.equal(justOver.getCharacteristic(Characteristic.Active).value, Characteristic.Active.INACTIVE, "a zone past the active window should be inactive");
  });

  test("aggregates the system into in-use with the scheduled program mode", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: fastPolling(normalSchedule()), kind: "response" }),
      signalAborted: false });

    t.after(() => h.abort());

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700019") ? true : undefined);

    const irrigation = h.accessory.getService(Service.IrrigationSystem);

    assert.ok(irrigation, "the irrigation system service should exist");
    assert.equal(irrigation.getCharacteristic(Characteristic.InUse).value, Characteristic.InUse.IN_USE, "the system is in use while a zone runs");
    assert.equal(irrigation.getCharacteristic(Characteristic.RemainingDuration).value, 600, "the system remaining duration should sum the running zones");
    assert.equal(irrigation.getCharacteristic(Characteristic.ProgramMode).value, Characteristic.ProgramMode.PROGRAM_SCHEDULED,
      "with no manual run and not every zone rain-stopped the program mode stays scheduled");
  });
});
