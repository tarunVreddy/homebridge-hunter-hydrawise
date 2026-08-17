/* Copyright(C) 2020-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * matter-controller.ts: Hydrawise Matter irrigation controller.
 */
import type { HydrawiseController, HydrawiseZoneHintLedger, HydrawiseZoneHints } from "./controller.ts";
import type { HydrawiseControllerConfig, HydrawiseMatterAccessoryContext, HydrawiseZoneConfig } from "./types.ts";
import type { MatterAPI, MatterAccessory } from "homebridge";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.ts";
import { prefixedLog, sanitizeName } from "homebridge-plugin-utils";
import type { HomebridgePluginLogging } from "homebridge-plugin-utils";
import type { HydrawisePlatform } from "./platform.ts";

type MatterAccessoryPart = NonNullable<MatterAccessory["parts"]>[number];

export class HydrawiseMatterController {

  private readonly controller: HydrawiseControllerConfig;
  private readonly hapController: HydrawiseController;
  private isRegistered: boolean;
  private readonly lastPublishedState = new Map<string, string>();
  private readonly log: HomebridgePluginLogging;
  private readonly matter: MatterAPI;
  private readonly platform: HydrawisePlatform;
  public readonly uuid: string;

  constructor(platform: HydrawisePlatform, controller: HydrawiseControllerConfig, hapController: HydrawiseController) {

    this.controller = controller;
    this.hapController = hapController;
    this.isRegistered = false;
    this.log = prefixedLog(platform.log, (): string => this.controller.name + " (Matter)");
    this.matter = platform.getMatterApi() ?? {} as MatterAPI;
    this.platform = platform;

    this.uuid = this.matter.uuid.generate("matter:hydrawise:" + this.controller.controller_id.toString());
  }

  // Part identifier for a zone.
  private partId(relayId: number): string {

    return "zone-" + relayId.toString();
  }

  // Build a zone's MatterAccessoryPart.
  private buildZonePart(zone: HydrawiseZoneConfig, hint?: Readonly<HydrawiseZoneHints>): MatterAccessoryPart {

    const isOpen = (hint?.isOn ?? false) || (zone.time === 1);

    return {

      clusters: {

        valveConfigurationAndControl: {

          currentState: isOpen ? 1 : 0,
          defaultOpenDuration: Math.max(0, zone.run),
          openDuration: isOpen ? Math.max(0, zone.run) : null,
          remainingDuration: isOpen ? Math.max(0, zone.run) : null,
          targetState: isOpen ? 1 : 0
        }
      },
      deviceType: this.matter.deviceTypes.WaterValve,
      displayName: sanitizeName(zone.name),
      handlers: {

        valveConfigurationAndControl: {

          close: async (): Promise<void> => {

            this.log.info("%s [%s]: Matter command to stop zone.", this.controller.name, zone.name);

            const response = await this.hapController.sendCommand(zone, "stop");

            if(!response) {

              throw new Error("Unable to stop zone " + zone.name);
            }
          },
          open: async (request?: { openDuration?: number | null }): Promise<void> => {

            const duration = request?.openDuration ?? (zone.run > 0 ? zone.run : 900);

            this.log.info("%s [%s]: Matter command to run zone for %s seconds.", this.controller.name, zone.name, duration.toString());

            const response = await this.hapController.sendCommand(zone, "run", duration);

            if(!response) {

              throw new Error("Unable to start zone " + zone.name);
            }
          }
        }
      },
      id: this.partId(zone.relay_id)
    };
  }

  // Configure and register our composed Matter accessory with Homebridge.
  private async configure(zones: HydrawiseZoneConfig[], hints: HydrawiseZoneHintLedger): Promise<void> {

    if(this.isRegistered) {

      return;
    }

    const anyRunning = zones.some(zone => (hints.get(zone.relay_id)?.isOn ?? false) || (zone.time === 1));
    const parts: MatterAccessoryPart[] = zones.map(zone => this.buildZonePart(zone, hints.get(zone.relay_id)));

    const accessory: MatterAccessory<HydrawiseMatterAccessoryContext> = {

      UUID: this.uuid,
      clusters: {

        valveConfigurationAndControl: {

          currentState: anyRunning ? 1 : 0,
          defaultOpenDuration: null,
          openDuration: null,
          remainingDuration: null,
          targetState: anyRunning ? 1 : 0
        }
      },
      context: {

        controllerId: this.controller.controller_id,
        serialNumber: this.controller.serial_number
      },
      deviceType: this.matter.deviceTypes.WaterValve,
      displayName: sanitizeName(this.controller.name),
      handlers: {

        valveConfigurationAndControl: {

          close: async (): Promise<void> => {

            this.log.info("%s: Matter command to stop all running zones.", this.controller.name);

            for(const zone of zones.filter(z => (z.time === 1) || (hints.get(z.relay_id)?.isOn ?? false))) {

              // eslint-disable-next-line no-await-in-loop
              await this.hapController.sendCommand(zone, "stop");
            }
          },
          open: async (): Promise<void> => {

            this.log.info("%s: Open command received on master valve controller. Please activate individual zones.", this.controller.name);
          }
        }
      },
      manufacturer: "Hunter",
      model: "Hydrawise",
      parts,
      serialNumber: this.controller.serial_number
    };

    try {

      await this.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);

      this.isRegistered = true;

      this.log.info("Configured Matter irrigation controller: %s (serial: %s id: %s with %s zones).",
        this.controller.name, this.controller.serial_number, this.controller.controller_id.toString(), zones.length.toString());
    } catch(error) {

      this.log.error("Unable to register Matter accessory for %s: %s", this.controller.name, error);
    }
  }

  // Synchronize live state updates from polling cycles.
  public async updateZoneStates(zones: HydrawiseZoneConfig[], hints: HydrawiseZoneHintLedger): Promise<void> {

    if(!this.isRegistered) {

      await this.configure(zones, hints);
    }

    // Update each zone part.
    for(const zone of zones) {

      const hint = hints.get(zone.relay_id);
      const isOpen = (hint?.isOn ?? false) || (zone.time === 1);
      const pid = this.partId(zone.relay_id);

      const state = {

        currentState: isOpen ? 1 : 0,
        defaultOpenDuration: Math.max(0, zone.run),
        openDuration: isOpen ? Math.max(0, zone.run) : null,
        remainingDuration: isOpen ? Math.max(0, zone.run) : null,
        targetState: isOpen ? 1 : 0
      };

      const serialized = JSON.stringify(state);

      if(this.lastPublishedState.get(pid) === serialized) {

        continue;
      }

      try {

        // eslint-disable-next-line no-await-in-loop
        await this.matter.updateAccessoryState(this.uuid, "valveConfigurationAndControl", state, pid);

        this.lastPublishedState.set(pid, serialized);
      } catch(error) {

        this.lastPublishedState.delete(pid);

        this.log.error("%s [%s]: Failed to update Matter zone state: %s", this.controller.name, zone.name, error);
      }
    }

    // Update master controller aggregate valve state.
    const anyRunning = zones.some(zone => (hints.get(zone.relay_id)?.isOn ?? false) || (zone.time === 1));

    const parentState = {

      currentState: anyRunning ? 1 : 0,
      targetState: anyRunning ? 1 : 0
    };

    const parentSerialized = JSON.stringify(parentState);

    if(this.lastPublishedState.get("parent") !== parentSerialized) {

      try {

        await this.matter.updateAccessoryState(this.uuid, "valveConfigurationAndControl", parentState);

        this.lastPublishedState.set("parent", parentSerialized);
      } catch(error) {

        this.lastPublishedState.delete("parent");

        this.log.error("%s: Failed to update Matter controller master state: %s", this.controller.name, error);
      }
    }
  }
}
