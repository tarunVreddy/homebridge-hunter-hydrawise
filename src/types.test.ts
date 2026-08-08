/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * types.test.ts: The reserved-name constants and the fixture-versus-interface conformance check. The interfaces are compile-time contracts; this file
 * pins the one runtime value the types module exports and verifies the synthetic fixtures carry the required wire fields with wire-accurate types.
 */
import { UNSCHEDULED_SENTINEL, normalZoneMatrix, sentinelZoneMatrix, syntheticController, syntheticCustomerDetails } from "./api.fixtures.ts";
import { describe, test } from "node:test";
import { HydrawiseReservedNames } from "./types.ts";
import assert from "node:assert/strict";
import { firstOf } from "./testing.helpers.ts";

describe("hydrawise reserved names", () => {

  test("names the suspend-all switch subtype", () => {

    assert.equal(HydrawiseReservedNames.SWITCH_SUSPEND_ALL, "All", "the suspend-all switch subtype is All");
  });
});

describe("fixture conformance", () => {

  test("the synthetic controller carries the required controller fields with the right types", () => {

    assert.equal(typeof syntheticController.controller_id, "number", "controller_id is a number");
    assert.equal(typeof syntheticController.last_contact, "number", "last_contact is a number");
    assert.equal(typeof syntheticController.name, "string", "name is a string");
    assert.equal(typeof syntheticController.serial_number, "string", "serial_number is a string");
    assert.equal(typeof syntheticController.status, "string", "status is a string");
  });

  test("the synthetic customer details reference the controller list", () => {

    assert.equal(typeof syntheticCustomerDetails.customer_id, "number", "customer_id is a number");
    assert.equal(syntheticCustomerDetails.controllers.length, 1, "one synthetic controller is present");
    assert.equal(firstOf(syntheticCustomerDetails.controllers, "controller").serial_number, syntheticController.serial_number,
      "the controller list carries the synthetic controller");
  });

  test("the normal zone matrix mirrors the 19-zone wire shape with the required zone fields", () => {

    assert.equal(normalZoneMatrix.length, 19, "the normal matrix carries 19 zones");

    const zone = firstOf(normalZoneMatrix, "zone");

    assert.equal(typeof zone.name, "string", "name is a string");
    assert.equal(typeof zone.relay, "number", "relay is a number");
    assert.equal(typeof zone.relay_id, "number", "relay_id is a number");
    assert.equal(typeof zone.run, "number", "run is a number");
    assert.equal(typeof zone.time, "number", "time is a number");
    assert.equal(typeof zone.timestr, "string", "timestr is a string");
  });

  test("the sentinel matrix stamps every zone with the unscheduled sentinel and an empty schedule", () => {

    assert.equal(sentinelZoneMatrix.length, 19, "the sentinel matrix carries 19 zones");
    assert.ok(sentinelZoneMatrix.every(zone => zone.time === UNSCHEDULED_SENTINEL), "every sentinel zone carries the unscheduled sentinel");
    assert.ok(sentinelZoneMatrix.every(zone => (zone.run === 0) && (zone.timestr === "")), "every sentinel zone has no run and no schedule string");
  });
});
