/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hydrawise-controller.naming.test.ts: Zone naming and name synchronization. Pins the effective name a valve is created with (the user's Name option when set,
 * otherwise the name Hydrawise reports), the synchronization that keeps it current while SyncName holds, the exact-compare that keeps a matching name from being
 * rewritten on every poll, the creation-only behavior a SyncName opt-out restores, and the zone-only scope the framework enforces for the Name option.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id, so camelcase is disabled here to let the zone fixtures mirror the wire verbatim.
/* eslint-disable camelcase */
import { Characteristic, Service } from "./testing/hap.helpers.ts";
import { FeatureOptions, getServiceName } from "homebridge-plugin-utils";
import type { HydrawiseControllerOption, HydrawiseZoneOption, HydrawiseZoneValueOption } from "./hydrawise-options.ts";
import type { HydrawiseZoneConfig, StatusScheduleResponse } from "./hydrawise-types.ts";
import type { TestAccessory, TestService } from "./testing/hap.helpers.ts";
import { buildController, waitFor } from "./testing/platform.helpers.ts";
import { describe, test } from "node:test";
import { fastPolling, makeStatusSchedule, makeZone } from "./hydrawise-api.helpers.ts";
import { featureOptionCategories, featureOptions } from "./hydrawise-options.ts";
import type { BuildControllerResult } from "./testing/platform.helpers.ts";
import type { Service as HapService } from "homebridge";
import assert from "node:assert/strict";
import { bareSensors } from "./hydrawise-api.fixtures.ts";

// The single zone every scenario here works against, and the names standing in for each source a valve's name can come from: what the wire reports, what a user
// renamed it to in the Home app, and what the Name option configures.
const ZONE_RELAY_ID = 700001;
const ZONE_SUBTYPE = "700001";
const CONTROLLER_SERIAL = "SN0A1B2C3D4";
const WIRE_NAME = "Front Lawn";
const WIRE_RENAMED = "Front Lawn North";
const HOME_APP_NAME = "Sprinklers Out Front";
const OVERRIDE_NAME = "Front Lawn Drip Line";

// A free-form override exercising the value grammar's full latitude: interior periods and an "=" past the payload delimiter both ride through to the runtime
// verbatim, and HomeKit's own naming rules then decide what the valve can actually be called.
const FREE_FORM_OVERRIDE = "Front Lawn 2.0 = North Bed";
const FREE_FORM_SANITIZED = "Front Lawn 2.0 North Bed";

// A one-zone, fast-cadence schedule with a bare sensor block, so a live-loop test cycles in roughly 250ms.
function schedule(name: string): StatusScheduleResponse {

  return fastPolling(makeStatusSchedule({ relays: [zone(name)], sensors: bareSensors }));
}

// The zone under test, named as the wire reports it. It is scheduled well beyond the active-zone window, so a poll settles its valve without also driving a start
// or stop transition.
function zone(name: string): HydrawiseZoneConfig {

  return makeZone({ name, relay: 1, relay_id: ZONE_RELAY_ID, run: 480, time: 68000, timestr: "16:00" });
}

// Seed a cached valve already bearing a name, the shape Homebridge restores when an accessory returns from its cache carrying a rename the user made in the Home
// app. The name lands on ConfiguredName, which is the characteristic a Home-app rename writes and the one the name helpers read first.
function seedNamedValve(name: string): (accessory: TestAccessory) => void {

  return (accessory: TestAccessory): void => {

    accessory.addService(new Service.Valve(name, ZONE_SUBTYPE)).updateCharacteristic(Characteristic.ConfiguredName, name);
  };
}

// The double-to-HAP cast the real name helper requires, confined here so the test bodies stay cast-free.
function asHapService(service: object): HapService {

  return service as unknown as HapService;
}

// Wait for the zone's valve to exist, then hand it back.
async function valveOf(h: BuildControllerResult): Promise<TestService> {

  return waitFor(() => h.accessory.getServiceById(Service.Valve, ZONE_SUBTYPE));
}

// The name the valve presents to HomeKit, read through the same helper production reads it through.
function nameOf(valve: TestService): string | undefined {

  return getServiceName(asHapService(valve));
}

// The values written to either name characteristic. A valve takes routine writes on every poll - Active and its neighbors - so a claim about naming filters those
// out rather than reading the whole write log.
function nameWrites(valve: TestService): unknown[] {

  return valve.writesFor(Characteristic.ConfiguredName, Characteristic.Name).map(write => write.value);
}

// Let at least one complete polling pass run past the current one, so an assertion about what a later poll did or did not do has a poll to describe. Bounding on
// the second call ahead guarantees the intervening pass ran its zone loop to completion before we read.
async function pollPast(h: BuildControllerResult): Promise<void> {

  const seen = h.retrieve.callsTo("statusschedule.php").length;

  await waitFor(() => (h.retrieve.callsTo("statusschedule.php").length >= (seen + 2)) ? true : undefined);
}

describe("zone naming at creation", () => {

  test("creates a zone's valve with the name Hydrawise reports when no override is configured", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false });

    t.after(() => h.abort());

    assert.equal(nameOf(await valveOf(h)), WIRE_NAME, "an unconfigured zone's valve carries the name the wire reports");
  });

  test("creates a zone's valve bearing a free-form name override", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false, userOptions: ["Enable.Device.Name." + ZONE_SUBTYPE + "=" + FREE_FORM_OVERRIDE] });

    t.after(() => h.abort());

    // The configured value reaches the runtime verbatim - periods and the "=" past the payload delimiter and all - and HomeKit's naming rules then sanitize what
    // the valve is actually called, which is where the "=" becomes a space.
    const engine = new FeatureOptions(featureOptionCategories, featureOptions, ["Enable.Device.Name." + ZONE_SUBTYPE + "=" + FREE_FORM_OVERRIDE]);

    assert.equal(engine.value("Device.Name", ZONE_SUBTYPE, CONTROLLER_SERIAL), FREE_FORM_OVERRIDE, "the free-form value survives the grammar verbatim");
    assert.equal(nameOf(await valveOf(h)), FREE_FORM_SANITIZED, "the valve carries the override, sanitized to HomeKit's naming rules");
  });

  test("performs no further name write after the pass that created the valve", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false, userOptions: ["Enable.Device.Name." + ZONE_SUBTYPE + "=" + OVERRIDE_NAME] });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    await pollPast(h);
    h.abort();

    // Creation applies the effective name once, through each name characteristic the kind supports. Nothing in the pass that created the valve, and nothing in the
    // passes after it, applies it again.
    assert.deepEqual(nameWrites(valve), [ OVERRIDE_NAME, OVERRIDE_NAME ], "the creating pass writes the name once per name characteristic and never again");
    assert.equal(nameOf(valve), OVERRIDE_NAME, "the valve carries the override");
  });
});

describe("zone name synchronization at its default", () => {

  test("re-asserts the effective name over a rename made in the Home app", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      seedContext: seedNamedValve(HOME_APP_NAME), signalAborted: false });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    await waitFor(() => (nameOf(valve) === WIRE_NAME) ? true : undefined);

    assert.equal(nameOf(valve), WIRE_NAME, "a Home-app rename yields to the name Hydrawise reports");
  });

  test("re-asserts a configured override over a rename made in the Home app", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      seedContext: seedNamedValve(HOME_APP_NAME), signalAborted: false, userOptions: ["Enable.Device.Name." + ZONE_SUBTYPE + "=" + OVERRIDE_NAME] });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    await waitFor(() => (nameOf(valve) === OVERRIDE_NAME) ? true : undefined);

    assert.equal(nameOf(valve), OVERRIDE_NAME, "a Home-app rename yields to the configured override");
  });

  test("propagates a rename made on the Hydrawise side to the existing valve", async (t) => {

    // The seeded valve already matches the first poll's wire name, so the first pass writes nothing; the rename the second poll reports is then the sole cause of
    // any name write.
    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule(WIRE_RENAMED), kind: "response" });
    }, seedContext: seedNamedValve(WIRE_NAME), signalAborted: false });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    await waitFor(() => (nameOf(valve) === WIRE_RENAMED) ? true : undefined);

    assert.equal(nameOf(valve), WIRE_RENAMED, "a Hydrawise-side rename lands on the next poll");
  });

  test("does not rewrite a name that already matches", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      seedContext: seedNamedValve(WIRE_NAME), signalAborted: false });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    valve.clearWrites();

    await pollPast(h);
    h.abort();

    assert.deepEqual(nameWrites(valve), [], "a poll finding the name already correct performs no name write");
    assert.ok(valve.writes.length > 0, "the same poll still performs its routine writes, so the empty name-filtered view is a real skip");
  });

  test("does not rewrite an override whose HomeKit name differs from the configured value", async (t) => {

    // The override carries characters HomeKit's naming rules replace, so the name on the service can never equal the configured value. The comparison sanitizes
    // before comparing, which is what keeps this from rewriting the same name on every single poll.
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false, userOptions: ["Enable.Device.Name." + ZONE_SUBTYPE + "=" + FREE_FORM_OVERRIDE] });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    valve.clearWrites();

    await pollPast(h);
    h.abort();

    assert.deepEqual(nameWrites(valve), [], "a sanitized name that already matches is not rewritten on every poll");
    assert.equal(nameOf(valve), FREE_FORM_SANITIZED, "the valve still carries the sanitized override");
  });
});

describe("zone name synchronization opted out", () => {

  // The opt-out is honored wherever it is written: a single zone, or the controller the zone lives under.
  for(const { label, option } of [ { label: "the zone", option: "Disable.Device.SyncName." + ZONE_SUBTYPE },
    { label: "the controller", option: "Disable.Device.SyncName." + CONTROLLER_SERIAL } ]) {

    test("leaves a Home-app rename standing when synchronization is disabled at " + label, async (t) => {

      const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
        seedContext: seedNamedValve(HOME_APP_NAME), signalAborted: false, userOptions: [option] });

      t.after(() => h.abort());

      const valve = await valveOf(h);

      valve.clearWrites();

      await pollPast(h);
      h.abort();

      assert.deepEqual(nameWrites(valve), [], "no poll re-asserts a name while synchronization is disabled");
      assert.equal(nameOf(valve), HOME_APP_NAME, "the rename made in the Home app stands");
    });
  }

  test("still creates a new valve with the effective name, and never re-asserts it afterwards", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false, userOptions: [ "Disable.Device.SyncName." + ZONE_SUBTYPE, "Enable.Device.Name." + ZONE_SUBTYPE + "=" + OVERRIDE_NAME ] });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    assert.equal(nameOf(valve), OVERRIDE_NAME, "creation carries the override even with synchronization disabled");

    valve.clearWrites();

    await pollPast(h);
    h.abort();

    assert.deepEqual(nameWrites(valve), [], "nothing re-asserts the name after creation");
  });
});

describe("the zone name override's value semantics", () => {

  test("treats an empty configured value as no override", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false, userOptions: ["Enable.Device.Name." + ZONE_SUBTYPE + "="] });

    t.after(() => h.abort());

    assert.equal(nameOf(await valveOf(h)), WIRE_NAME, "an empty override leaves the wire name in place");
  });

  test("treats a value that is only whitespace as no override", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false, userOptions: ["Enable.Device.Name." + ZONE_SUBTYPE + "=    "] });

    t.after(() => h.abort());

    assert.equal(nameOf(await valveOf(h)), WIRE_NAME, "a whitespace-only override leaves the wire name in place");
  });

  test("applies a configured value with surrounding whitespace as its trimmed form", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false, userOptions: ["Enable.Device.Name." + ZONE_SUBTYPE + "=   " + OVERRIDE_NAME + "   "] });

    t.after(() => h.abort());

    assert.equal(nameOf(await valveOf(h)), OVERRIDE_NAME, "the override applies without its surrounding whitespace");
  });

  test("treats a disabled override as no override", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false, userOptions: ["Disable.Device.Name." + ZONE_SUBTYPE] });

    t.after(() => h.abort());

    assert.equal(nameOf(await valveOf(h)), WIRE_NAME, "a disabled name option resolves to no value at all, so the wire name stands");
  });
});

describe("the zone name option's declared scope", () => {

  test("does not resolve a name written at the global scope", () => {

    const engine = new FeatureOptions(featureOptionCategories, featureOptions, ["Enable.Device.Name=Every Zone"]);

    assert.notEqual(engine.value("Device.Name", ZONE_SUBTYPE, CONTROLLER_SERIAL), "Every Zone", "a global entry does not reach a zone");
    assert.equal(engine.value("Device.Name", ZONE_SUBTYPE, CONTROLLER_SERIAL), null, "the zone resolves no value at all, since the option defaults to disabled");
  });

  test("does not resolve a name written at the controller scope", () => {

    const engine = new FeatureOptions(featureOptionCategories, featureOptions, ["Enable.Device.Name." + CONTROLLER_SERIAL + "=Every Zone"]);

    assert.equal(engine.value("Device.Name", ZONE_SUBTYPE, CONTROLLER_SERIAL), null, "a controller entry does not reach a zone either");
  });

  test("leaves a valve at its wire name when a name is written outside the zone scope", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false, userOptions: ["Enable.Device.Name=Every Zone"] });

    t.after(() => h.abort());

    assert.equal(nameOf(await valveOf(h)), WIRE_NAME, "the runtime never sees a name the option's declared scope does not admit");
  });

  test("declares the name option as value-centric and the synchronization option as a plain toggle", () => {

    const engine = new FeatureOptions(featureOptionCategories, featureOptions, []);

    assert.equal(engine.isValue("Device.Name"), true, "the name option carries a value");
    assert.equal(engine.isValue("Device.SyncName"), false, "the synchronization option is a plain toggle");
    assert.equal(engine.test("Device.SyncName", ZONE_SUBTYPE, CONTROLLER_SERIAL), true, "synchronization is on by default");
  });

  test("names every scoped option in the union the runtime narrows against", () => {

    // The compile-time half of the scope contract: these literals only typecheck against the unions that admit them, so an option that changes scope without its
    // union changing fails here at build time rather than at a call site.
    const controllerOptions: HydrawiseControllerOption[] = [ "Device", "Device.Suspend", "Device.SyncName", "Log.Zone" ];
    const zoneOptions: HydrawiseZoneOption[] = [ "Device", "Device.SyncName", "Log.Zone" ];
    const zoneValueOptions: HydrawiseZoneValueOption[] = ["Device.Name"];

    assert.equal(controllerOptions.length, 4, "the controller union admits every controller-scoped option");
    assert.equal(zoneOptions.length, 3, "the zone union admits every zone-scoped toggle");
    assert.deepEqual(zoneValueOptions, ["Device.Name"], "the zone value union admits the name option alone");
  });
});
