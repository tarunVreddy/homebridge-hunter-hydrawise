/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hydrawise-matter-controller.ts: Matter controller class for Hydrawise.
 */
import type { API, MatterAccessory } from "homebridge";
import type { HydrawisePlatform } from "./hydrawise-platform.js";
import type { HydrawiseControllerConfig, HydrawiseZoneConfig, SetZoneResponse, StatusScheduleResponse } from "./hydrawise-types.js";
import { HYDRAWISE_ACTIVE_ZONE_INDICATOR, HYDRAWISE_API_JITTER, HYDRAWISE_API_RETRY_INTERVAL } from "./settings.js";
import { type HomebridgePluginLogging, type Nullable, retry, sleep } from "homebridge-plugin-utils";
import util from "node:util";

export class HydrawiseMatterController {


  private readonly platform: HydrawisePlatform;
  private readonly api: API;
  private readonly controller: HydrawiseControllerConfig;
  private readonly uuid: string;
  private accessory?: MatterAccessory;
  private status: StatusScheduleResponse;
  public readonly log: HomebridgePluginLogging;

  constructor(platform: HydrawisePlatform, controller: HydrawiseControllerConfig, uuid: string, accessory?: MatterAccessory) {


    this.platform = platform;
    this.api = platform.api;
    this.controller = controller;
    this.uuid = uuid;
    this.accessory = accessory;
    this.status = { nextpoll: -1, relays: [] as HydrawiseZoneConfig[] } as StatusScheduleResponse;

    this.log = {


      debug: (message: string, ...parameters: unknown[]): void => platform.debug(util.format(this.controller.name + ": " + message, ...parameters)),
      error: (message: string, ...parameters: unknown[]): void => platform.log.error(util.format(this.controller.name + ": " + message, ...parameters)),
      info: (message: string, ...parameters: unknown[]): void => platform.log.info(util.format(this.controller.name + ": " + message, ...parameters)),
      warn: (message: string, ...parameters: unknown[]): void => platform.log.warn(util.format(this.controller.name + ": " + message, ...parameters))
    };
  }

  // Resolves the restored or new MatterAccessory representation.
  public toAccessory(): MatterAccessory {


    if(!this.accessory) {


      throw new Error("Matter accessory not initialized yet.");
    }

    return this.accessory;
  }

  // Initialization: Fetches status, registers accessory parts if needed, and starts loop.
  public async init(): Promise<void> {


    let initialized = false;

    // Fetch initial status to discover zones/relays.
    await retry(async (): Promise<boolean> => {


      const response = await this.platform.retrieve("statusschedule.php", {


        controller_id: this.controller.controller_id.toString()
      });

      if(!response) {


        return false;
      }

      try {


        this.status = await response.body.json() as StatusScheduleResponse;
        initialized = true;

        return true;
      } catch(error) {


        this.log.error("Unable to retrieve the initial status: %s", util.inspect(error, { colors: true, depth: null, sorted: true }));

        return false;
      }
    }, HYDRAWISE_API_RETRY_INTERVAL * 1000);

    if(!initialized) {


      this.log.error("Failed to fetch initial Hydrawise status during Matter initialization.");

      return;
    }

    const matter = this.api.matter!;

    if(!this.accessory) {


      // Build valve endpoints (parts) dynamically from discovered relays.
      const parts: any[] = this.status.relays.map(zone => ({


        id: `zone-${zone.relay_id}`,
        displayName: zone.name,
        deviceType: matter.deviceTypes.WaterValve,
        clusters: {


          valveConfigurationAndControl: {


            currentState: 0,
            targetState: 0,
            defaultOpenDuration: 300
          }
        },
        handlers: {


          valveConfigurationAndControl: {


            open: async (args: any, context: any) => this.handleOpen(context?.partId || `zone-${zone.relay_id}`, args?.openDuration),
            close: async (_args: any, context: any) => this.handleClose(context?.partId || `zone-${zone.relay_id}`)
          }
        }
      }));

      // Add suspend switch part if enabled.
      if(this.hasFeature("Device.Suspend")) {


        parts.push({


          id: "suspend",
          displayName: this.controller.name + " Suspend All Zones",
          deviceType: matter.deviceTypes.OnOffOutlet,
          clusters: {


            onOff: { onOff: this.isAllSuspended }
          },
          handlers: {


            onOff: {


              on: async () => this.handleSuspend(true),
              off: async () => this.handleSuspend(false)
            }
          }
        });
      }

      this.accessory = {


        UUID: this.uuid,
        displayName: this.controller.name,
        deviceType: matter.deviceTypes.BridgedNode,
        serialNumber: this.controller.serial_number,
        manufacturer: "Hunter",
        model: "Hydrawise",
        firmwareRevision: "2.0.0",
        hardwareRevision: "1.0.0",
        context: { serialNumber: this.controller.serial_number },
        parts
      };
    } else {


      // Re-bind callbacks to the restored parts.
      if(this.accessory.parts) {


        for(const part of this.accessory.parts) {


          if(part.id.startsWith("zone-")) {


            part.handlers = {


              valveConfigurationAndControl: {


                open: async (args: any, context: any) => this.handleOpen(context?.partId || part.id, args?.openDuration),
                close: async (_args: any, context: any) => this.handleClose(context?.partId || part.id)
              }
            };
          } else if(part.id === "suspend") {


            part.handlers = {


              onOff: {


                on: async () => this.handleSuspend(true),
                off: async () => this.handleSuspend(false)
              }
            };
          }
        }
      }
    }

    // Configure MQTT.
    this.configureMqtt();

    // Start state synchronization loop.
    void this.updateStateLoop();
  }

  // Configure MQTT services.
  private configureMqtt(): boolean {


    // Return our irrigation controller state.
    this.platform.mqtt?.subscribeGet(this.controller.serial_number, "controller", "Irrigation controller", () => {


      return this.statusJson;
    }, this.log);

    // Set the state of a given irrigation zone.
    this.platform.mqtt?.subscribeSet(this.controller.serial_number, "controller", "Irrigiation controller", async (value: string) => {


      const action = value.split(" ");
      const zoneValue = parseInt(action[1]);
      const zone = this.status.relays.find(x => x.relay === zoneValue);

      if(!zone) {


        this.log.error("MQTT: Invalid zone specified.");

        return;
      }

      switch(action[0]) {
        case "start":
          await this.handleOpen(`zone-${zone.relay_id}`, parseInt(action[2]));

          return;
        case "stop":
          await this.handleClose(`zone-${zone.relay_id}`);

          return;
        default:
          this.log.error("Invalid command.");

          return;
      }
    }, this.log);

    return true;
  }

  // Handle command to open (start watering) a zone.
  private async handleOpen(partId: string, duration?: number): Promise<void> {


    const relayId = this.getRelayId(partId);
    const zone = this.status.relays.find(x => x.relay_id === relayId);

    if(!zone) {


      this.log.error("Unable to find zone for part ID: %s", partId);

      return;
    }

    // Default open duration if not provided.
    const runDuration = duration ?? 300;

    this.log.info("Requesting start watering for zone %s [Zone %s] for %s seconds.", zone.name, zone.relay, runDuration);

    const response = await this.sendCommand(zone, "run", runDuration);

    if(!response) {


      this.log.error("Failed to send run command for zone %s.", zone.name);

      return;
    }

    // Optimistically update Matter state.
    await this.api.matter!.updateAccessoryState(
      this.uuid,
      "valveConfigurationAndControl",
      {


        currentState: 1,
        targetState: 1,
        remainingDuration: runDuration,
        openDuration: runDuration
      },
      partId
    );
  }

  // Handle command to close (stop watering) a zone.
  private async handleClose(partId: string): Promise<void> {


    const relayId = this.getRelayId(partId);
    const zone = this.status.relays.find(x => x.relay_id === relayId);

    if(!zone) {


      this.log.error("Unable to find zone for part ID: %s", partId);

      return;
    }

    this.log.info("Requesting stop watering for zone %s [Zone %s].", zone.name, zone.relay);

    const response = await this.sendCommand(zone, "stop");

    if(!response) {


      this.log.error("Failed to send stop command for zone %s.", zone.name);

      return;
    }

    // Optimistically update Matter state.
    await this.api.matter!.updateAccessoryState(
      this.uuid,
      "valveConfigurationAndControl",
      {


        currentState: 0,
        targetState: 0,
        remainingDuration: null,
        openDuration: null
      },
      partId
    );
  }

  // Handle command to suspend/resume watering for all zones.
  private async handleSuspend(suspend: boolean): Promise<void> {


    this.log.info("%s scheduled watering for all zones.", suspend ? "Suspending" : "Resuming");

    // Year from now to suspend, or 0 (current time) to resume.
    const timestamp = suspend ? (Date.now() / 1000) + 31556926 : 0;
    const response = await this.sendCommand("suspendall", timestamp);

    let status;

    try {


      status = await response?.body.json() as SetZoneResponse;
    } catch(error) {


      this.log.error("Unable to retrieve the result of the suspend/resume request.");
    }

    if(!status || status.message_type === "error") {


      this.log.error("Unable to complete the suspend/resume request.");

      return;
    }

    // Update Matter state.
    if(this.hasFeature("Device.Suspend")) {


      await this.api.matter!.updateAccessoryState(
        this.uuid,
        "onOff",
        { onOff: suspend },
        "suspend"
      );
    }
  }

  // Synchronization loop.
  private async updateStateLoop(): Promise<void> {


    for(;;) {


      const isFirstRun = this.status.nextpoll === -1;

      await retry(async () => this.getStatus(),
        (isFirstRun ? HYDRAWISE_API_RETRY_INTERVAL : Math.min(this.status.nextpoll + HYDRAWISE_API_JITTER, HYDRAWISE_API_RETRY_INTERVAL * 2)) * 1000);

      // Synchronize each valve (relay) state.
      for(const zone of this.status.relays) {


        const partId = `zone-${zone.relay_id}`;
        const isOn = zone.time === 1;

        const currentState = isOn ? 1 : 0;
        const targetState = isOn ? 1 : 0;
        const remainingDuration = isOn ? parseInt(zone.run) : null;
        const openDuration = isOn ? parseInt(zone.run) : null;

        await this.api.matter!.updateAccessoryState(
          this.uuid,
          "valveConfigurationAndControl",
          {


            currentState,
            targetState,
            remainingDuration,
            openDuration
          },
          partId
        );
      }

      // Synchronize suspend state.
      if(this.hasFeature("Device.Suspend")) {


        await this.api.matter!.updateAccessoryState(
          this.uuid,
          "onOff",
          { onOff: this.isAllSuspended },
          "suspend"
        );
      }

      // Publish status JSON to MQTT.
      this.platform.mqtt?.publish(this.controller.serial_number, "controller", this.statusJson);

      // Sleep until next check.
      await sleep((this.status.nextpoll + HYDRAWISE_API_JITTER) * 1000);
    }
  }

  // Retrieve current status from Hydrawise.
  private async getStatus(): Promise<boolean> {


    const response = await this.platform.retrieve("statusschedule.php", {


      controller_id: this.controller.controller_id.toString()
    });

    if(!response) {


      return false;
    }

    try {


      this.status = await response.body.json() as StatusScheduleResponse;
      this.log.debug("Status updated.");
    } catch(error) {


      this.log.error("Unable to retrieve status: %s", util.inspect(error, { colors: true, depth: null, sorted: true }));

      return false;
    }

    return true;
  }

  // Send setzone request to Hydrawise.
  private async sendCommand(zone: HydrawiseZoneConfig, command: "run", duration: number): Promise<Nullable<any>>;
  private async sendCommand(zone: HydrawiseZoneConfig, command: "stop"): Promise<Nullable<any>>;
  private async sendCommand(command: "suspendall", duration: number): Promise<Nullable<any>>;
  private async sendCommand(zoneOrCmd: HydrawiseZoneConfig | "suspendall", cmdOrDur: (number | "run" | "stop"), duration?: number): Promise<Nullable<any>> {


    let command;
    let zone;

    if(typeof zoneOrCmd === "string") {


      command = zoneOrCmd;
      duration = cmdOrDur as number;
    } else {


      zone = zoneOrCmd;
      command = cmdOrDur as "run" | "stop";
    }

    const params: Record<string, string> = { controller_id: this.controller.controller_id.toString() };

    if(zone?.relay_id) {


      params.relay_id = zone.relay_id.toString();
    }

    switch(command) {
      case "run":
        params.action = "run";

        if(duration === undefined || duration <= 0) {


          return null;
        }
        params.custom = duration.toString();
        params.period_id = "999";

        break;

      case "stop":
        params.action = "stop";

        break;

      case "suspendall":
        params.action = "suspendall";

        if(duration === undefined || duration <= 0) {


          return null;
        }
        params.custom = duration.toString();
        params.period_id = "999";
        delete params.relay_id;

        break;

      default:
        return null;
    }

    return this.platform.retrieve("setzone.php", params);
  }

  // Parse numeric relay ID from part ID string (e.g. "zone-12345" -> 12345).
  private getRelayId(partId: string): number {


    const match = partId.match(/zone-(\d+)/);

    return match ? parseInt(match[1], 10) : 0;
  }

  private isStoppedBySensor(zone: HydrawiseZoneConfig): boolean {


    return !zone.run && !zone.timestr && (zone.time === 1576800000) &&
      this.status.sensors.filter(sensor => sensor.type === 1).some(sensor => sensor.relays.some(relay => relay.id === zone.relay_id));
  }

  private get isAllSuspended(): boolean {


    return !this.status.relays.some(zone => zone.run || zone.timestr || (zone.time !== 1576800000) || this.isStoppedBySensor(zone));
  }

  private get statusJson(): string {


    return JSON.stringify(this.status.relays.map(x => ({ name: x.name, relay: x.relay, run: x.run, time: x.time, timestr: x.timestr })));
  }

  private hasFeature(option: string): boolean {


    return this.platform.featureOptions.test(option, this.controller.serial_number);
  }
}
