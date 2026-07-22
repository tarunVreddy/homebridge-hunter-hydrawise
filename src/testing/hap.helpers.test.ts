/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hap.helpers.test.ts: Self-test for the HAP double. Pins that the REAL homebridge-plugin-utils service helpers (acquireService, validService) run unmodified
 * against the marker namespaces - the seeded first characteristic lets getCharacteristicConstructor recover a constructor without throwing - and that the
 * characteristic trigger knobs, the service accessors, and the accessory accessors behave as production expects.
 */
import { Characteristic, Service, TestService, makeTestAccessory } from "./hap.helpers.ts";
import { acquireService, validService } from "homebridge-plugin-utils";
import { describe, test } from "node:test";
import type { AcquireServiceTarget } from "homebridge-plugin-utils";
import type { PlatformAccessory } from "homebridge";
import assert from "node:assert/strict";

// Confine the double-to-HAP casts the real service helpers require to these two adapters, so the test bodies below stay cast-free.
function asAccessory(accessory: ReturnType<typeof makeTestAccessory>): PlatformAccessory {

  return accessory as unknown as PlatformAccessory;
}

function asTarget(service: typeof Service[keyof typeof Service]): AcquireServiceTarget {

  return service as unknown as AcquireServiceTarget;
}

function asTestService(service: object): TestService {

  return service as unknown as TestService;
}

describe("acquireService against the HAP double", () => {

  test("creates a new service and recovers the characteristic constructor without throwing", () => {

    const accessory = makeTestAccessory();
    const service = acquireService(asAccessory(accessory), asTarget(Service.Valve), "Test Valve", "700001");

    assert.ok(service, "the real acquireService should create a valve against the double");
    assert.ok(accessory.getServiceById(Service.Valve, "700001"), "the created valve should be retrievable by its subtype");
  });

  test("returns the existing service on re-acquisition rather than creating a duplicate", () => {

    const accessory = makeTestAccessory();

    acquireService(asAccessory(accessory), asTarget(Service.Valve), "Test Valve", "700001");
    acquireService(asAccessory(accessory), asTarget(Service.Valve), "Test Valve", "700001");

    const valves = accessory.services.filter(service => service.UUID === "Valve");

    assert.equal(valves.length, 1, "re-acquiring the same subtype should not duplicate the service");
  });

  test("validService removes a service when validation fails", () => {

    const accessory = makeTestAccessory();

    acquireService(asAccessory(accessory), asTarget(Service.Switch), "Test Switch", "All");
    assert.ok(accessory.getServiceById(Service.Switch, "All"), "the switch should exist before validation");

    validService(asAccessory(accessory), asTarget(Service.Switch), false, "All");
    assert.equal(accessory.getServiceById(Service.Switch, "All"), undefined, "a false validation should remove the service");
  });
});

describe("TestCharacteristic", () => {

  test("triggerGet returns the bound onGet handler's value", async () => {

    const service = new TestService(Service.Valve, "Test", "700001");
    const characteristic = service.getCharacteristic(Characteristic.On);

    characteristic.onGet(() => "handler-value");

    assert.equal(await characteristic.triggerGet(), "handler-value", "triggerGet should invoke the bound read handler");
  });

  test("triggerGet falls through to the cached value with no handler bound", async () => {

    const service = new TestService(Service.Valve, "Test", "700001");
    const characteristic = service.getCharacteristic(Characteristic.On);

    characteristic.updateValue("cached");

    assert.equal(await characteristic.triggerGet(), "cached", "triggerGet should read the cache when no handler is bound");
  });

  test("triggerSet runs the bound onSet handler and then caches the value", async () => {

    const service = new TestService(Service.Valve, "Test", "700001");
    const characteristic = service.getCharacteristic(Characteristic.Active);
    const received: unknown[] = [];

    characteristic.onSet(value => { received.push(value); });
    await characteristic.triggerSet(1);

    assert.deepEqual(received, [1], "triggerSet should invoke the bound write handler with the value");
    assert.equal(characteristic.value, 1, "triggerSet should cache the value after the handler resolves");
  });
});

describe("TestService and TestAccessory accessors", () => {

  test("getCharacteristic returns the same instance across calls", () => {

    const service = new TestService(Service.Valve, "Test", "700001");

    assert.equal(service.getCharacteristic(Characteristic.Active), service.getCharacteristic(Characteristic.Active), "the same kind should resolve to one instance");
  });

  test("testCharacteristic is a pure predicate that does not create", () => {

    const service = new TestService(Service.Valve, "Test", "700001");

    assert.equal(service.testCharacteristic(Characteristic.On), false, "an unseen characteristic should test false without being created");

    service.getCharacteristic(Characteristic.On);

    assert.equal(service.testCharacteristic(Characteristic.On), true, "a created characteristic should test true");
  });

  test("removeService detaches a service from the accessory", () => {

    const accessory = makeTestAccessory();
    const service = acquireService(asAccessory(accessory), asTarget(Service.Valve), "Test Valve", "700001");

    assert.ok(service, "the valve should be created");
    accessory.removeService(asTestService(service));
    assert.equal(accessory.getServiceById(Service.Valve, "700001"), undefined, "the removed valve should be gone");
  });
});
