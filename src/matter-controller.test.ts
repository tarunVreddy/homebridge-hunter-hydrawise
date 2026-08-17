/* Copyright(C) 2020-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * matter-controller.test.ts: Tests for HydrawiseMatterController.
 */
/* eslint-disable camelcase */
import type { HydrawiseControllerConfig, HydrawiseZoneConfig } from "./types.ts";
import type { MatterAPI, MatterAccessory } from "homebridge";
import { describe, test } from "node:test";
import { firstOf, nthOf } from "./testing.helpers.ts";
import type { HydrawiseController } from "./controller.ts";
import { HydrawiseMatterController } from "./matter-controller.ts";
import type { HydrawisePlatform } from "./platform.ts";
import { HydrawiseZoneHintLedger } from "./controller.ts";
import assert from "node:assert/strict";
import { silentLog } from "./testing/loggers.helpers.ts";

describe("HydrawiseMatterController", () => {

  const controllerConfig: HydrawiseControllerConfig = {

    controller_id: 7167,
    last_contact: Date.now(),
    name: "Front Yard Controller",
    serial_number: "SN0A1B2C3D4",
    status: "OK"
  };

  const zone1: HydrawiseZoneConfig = {

    name: "Front Lawn",
    relay: 1,
    relay_id: 101,
    run: 900,
    time: 1576800000,
    timestr: "Never"
  };

  const zone2: HydrawiseZoneConfig = {

    name: "Flower Beds",
    relay: 2,
    relay_id: 102,
    run: 600,
    time: 1576800000,
    timestr: "Never"
  };

  const zones: HydrawiseZoneConfig[] = [ zone1, zone2 ];

  interface UpdatedStateRecord {

    attributes: Record<string, unknown>;
    cluster: string;
    partId?: string;
    uuid: string;
  }

  interface CommandRecord {

    command: string;
    duration?: number;
    zone?: HydrawiseZoneConfig;
  }

  function createTestHarness() {

    const registeredAccessories: MatterAccessory[] = [];
    const updatedStates: UpdatedStateRecord[] = [];
    const commandsSent: CommandRecord[] = [];

    const mockMatterApi = {

      deviceTypes: {

        WaterValve: { behaviors: {}, code: 66, name: "WaterValve" } as unknown as MatterAPI["deviceTypes"]["WaterValve"]
      } as unknown as MatterAPI["deviceTypes"],
      registerPlatformAccessories: async (_plugin: string, _platform: string, accessories: MatterAccessory[]): Promise<void> => {

        registeredAccessories.push(...accessories);
      },
      updateAccessoryState: async (uuid: string, cluster: string, attributes: Record<string, unknown>, partId?: string): Promise<void> => {

        updatedStates.push({ attributes, cluster, partId, uuid });
      },
      uuid: {

        generate: (seed: string): string => "uuid:" + seed
      } as unknown as MatterAPI["uuid"]
    } as unknown as MatterAPI;

    const mockPlatform = {

      getMatterApi: (): MatterAPI => mockMatterApi,
      hap: {

        uuid: {

          generate: (seed: string): string => "uuid:" + seed
        }
      },
      log: silentLog()
    };

    const mockHapController = {

      sendCommand: async (zoneOrCmd: HydrawiseZoneConfig | "suspendall", cmdOrDur: string | number, duration?: number) => {

        if(typeof zoneOrCmd === "string") {

          commandsSent.push({ command: zoneOrCmd, duration: cmdOrDur as number });
        } else {

          commandsSent.push({ command: cmdOrDur as string, duration, zone: zoneOrCmd });
        }

        return {} as unknown;
      }
    };

    const matterController = new HydrawiseMatterController(
      mockPlatform as unknown as HydrawisePlatform,
      controllerConfig,
      mockHapController as unknown as HydrawiseController
    );

    return {

      commandsSent,
      matterController,
      registeredAccessories,
      updatedStates
    };
  }

  test("generates a deterministic UUID based on controller ID", () => {

    const { matterController } = createTestHarness();

    assert.equal(matterController.uuid, "uuid:matter:hydrawise:7167");
  });

  test("registers composed Matter accessory with parts on initial state update", async () => {

    const { matterController, registeredAccessories } = createTestHarness();
    const hints = new HydrawiseZoneHintLedger();

    await matterController.updateZoneStates(zones, hints);

    assert.equal(registeredAccessories.length, 1);

    const accessory = firstOf(registeredAccessories, "registered Matter accessory");

    assert.equal(accessory.displayName, "Front Yard Controller");
    assert.equal(accessory.serialNumber, "SN0A1B2C3D4");
    assert.ok(accessory.parts);
    assert.equal(accessory.parts.length, 2);

    const part1 = firstOf(accessory.parts, "first zone part");
    const part2 = nthOf(accessory.parts, 1, "second zone part");

    assert.equal(part1.id, "zone-101");
    assert.equal(part1.displayName, "Front Lawn");

    assert.equal(part2.id, "zone-102");
    assert.equal(part2.displayName, "Flower Beds");
  });

  test("executes open command handler for a zone part", async () => {

    const { commandsSent, matterController, registeredAccessories } = createTestHarness();
    const hints = new HydrawiseZoneHintLedger();

    await matterController.updateZoneStates(zones, hints);

    const accessory = firstOf(registeredAccessories, "registered Matter accessory");
    const parts = accessory.parts ?? [];
    const zonePart = firstOf(parts, "zone part");
    const openHandler = zonePart.handlers?.valveConfigurationAndControl?.open;

    assert.ok(openHandler);

    await openHandler({ openDuration: 1200 });

    const sent = firstOf(commandsSent, "sent command");

    assert.equal(sent.zone?.relay_id, 101);
    assert.equal(sent.command, "run");
    assert.equal(sent.duration, 1200);
  });

  test("executes close command handler for a zone part", async () => {

    const { commandsSent, matterController, registeredAccessories } = createTestHarness();
    const hints = new HydrawiseZoneHintLedger();

    await matterController.updateZoneStates(zones, hints);

    const accessory = firstOf(registeredAccessories, "registered Matter accessory");
    const parts = accessory.parts ?? [];
    const zonePart = nthOf(parts, 1, "zone part");
    const closeHandler = zonePart.handlers?.valveConfigurationAndControl?.close;

    assert.ok(closeHandler);

    await closeHandler(undefined);

    const sent = firstOf(commandsSent, "sent command");

    assert.equal(sent.zone?.relay_id, 102);
    assert.equal(sent.command, "stop");
  });

  test("executes parent close handler to stop running zones", async () => {

    const { commandsSent, matterController, registeredAccessories } = createTestHarness();
    const hints = new HydrawiseZoneHintLedger();

    const runningZones: HydrawiseZoneConfig[] = [
      { ...zone1, time: 1 },
      { ...zone2, time: 1576800000 }
    ];

    await matterController.updateZoneStates(runningZones, hints);

    const accessory = firstOf(registeredAccessories, "registered Matter accessory");
    const parentClose = accessory.handlers?.valveConfigurationAndControl?.close;

    assert.ok(parentClose);

    await parentClose(undefined);

    const sent = firstOf(commandsSent, "sent command");

    assert.equal(sent.zone?.relay_id, 101);
    assert.equal(sent.command, "stop");
  });

  test("publishes state changes and skips duplicate updates", async () => {

    const { matterController, updatedStates } = createTestHarness();
    const hints = new HydrawiseZoneHintLedger();

    // Initial update
    await matterController.updateZoneStates(zones, hints);

    const initialUpdatesCount = updatedStates.length;

    assert.ok(initialUpdatesCount > 0);

    // Second update with same state should publish nothing new
    await matterController.updateZoneStates(zones, hints);

    assert.equal(updatedStates.length, initialUpdatesCount);

    // Third update with active zone should publish updates
    const activeZones: HydrawiseZoneConfig[] = [
      { ...zone1, time: 1 },
      zone2
    ];

    await matterController.updateZoneStates(activeZones, hints);

    assert.ok(updatedStates.length > initialUpdatesCount);

    const latestPart1Update = updatedStates.find(u => (u.partId === "zone-101") && (u.attributes["currentState"] === 1));

    assert.ok(latestPart1Update);
  });
});
