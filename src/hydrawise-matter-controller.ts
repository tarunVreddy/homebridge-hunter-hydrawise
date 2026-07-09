/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hydrawise-matter-controller.ts: Matter controller class for Hydrawise.
 */
import type { API, MatterAccessory } from "homebridge";
import type { HydrawisePlatform } from "./hydrawise-platform.js";
import type { HydrawiseControllerConfig, HydrawiseZoneConfig, SetZoneResponse, StatusScheduleResponse } from "./hydrawise-types.js";
import { HYDRAWISE_API_RETRY_INTERVAL } from "./settings.js";
import { type HomebridgePluginLogging, type Nullable, retry } from "homebridge-plugin-utils";
import util from "node:util";

export class HydrawiseMatterController {

  private readonly platform: HydrawisePlatform;
  private readonly api: API;
  private readonly controller: HydrawiseControllerConfig;
  private readonly uuid: string;
  private status: StatusScheduleResponse;
  public readonly log: HomebridgePluginLogging;

  // Collection of accessories managed by this controller device
  private readonly accessories: Map<string, MatterAccessory> = new Map();
  private readonly zoneUuids: Map<number, string> = new Map();
  private suspendUuid?: string;

  private readonly allAccessories: MatterAccessory[] = [];

  private registrationReady = false;

  constructor(platform: HydrawisePlatform, controller: HydrawiseControllerConfig, uuid: string) {

    this.platform = platform;
    this.api = platform.api;
    this.controller = controller;
    this.uuid = uuid;
    this.status = { nextpoll: -1, relays: [] as HydrawiseZoneConfig[] } as StatusScheduleResponse;

    this.log = {

      debug: (message: string, ...parameters: unknown[]): void => platform.debug(util.format(this.controller.name + ": " + message, ...parameters)),
      error: (message: string, ...parameters: unknown[]): void => platform.log.error(util.format(this.controller.name + ": " + message, ...parameters)),
      info: (message: string, ...parameters: unknown[]): void => platform.log.info(util.format(this.controller.name + ": " + message, ...parameters)),
      warn: (message: string, ...parameters: unknown[]): void => platform.log.warn(util.format(this.controller.name + ": " + message, ...parameters))
    };
  }

  // Retrieve the list of all accessories to register.
  public getAllAccessories(): MatterAccessory[] {


    return this.allAccessories;
  }

  // Wait for Homebridge to finish registering all accessories in the Matter server.
  // Since registerPlatformAccessories is fire-and-forget for bridged accessories,
  // we use a timer-based approach as getAccessoryInfo is not exposed on the MatterAPI.
  public async waitForRegistration(accessoryCount: number, maxWaitMs: number = 15000): Promise<void> {

    // Scale the wait time based on the number of accessories (each takes ~50ms to register).
    const estimatedMs = Math.min(Math.max(accessoryCount * 100, 2000), maxWaitMs);

    this.log.debug("Waiting %sms for %s Matter accessories to register.", estimatedMs, accessoryCount);

    await new Promise(resolve => setTimeout(resolve, estimatedMs));

    this.registrationReady = true;
  }

  // Initialization: Fetches status, registers accessories, and starts loop.
  public async init(initialStatus?: StatusScheduleResponse): Promise<boolean> {

    let initialized = false;

    // Use pre-fetched status if available, otherwise fetch it ourselves.
    if(initialStatus) {

      this.status = initialStatus;
      initialized = true;
    } else {

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
    }

    if(!initialized) {

      this.log.error("Failed to fetch initial Hydrawise status during Matter initialization.");

      return false;
    }

    const matter = this.api.matter!;
    const useSwitch = this.hasFeature("Matter.Valve.AsSwitch");

    this.allAccessories.length = 0;

    // Configure each discovered relay (zone) as a separate accessory.
    for(const zone of this.status.relays) {


      const zoneUuid = this.api.matter!.uuid.generate(this.controller.serial_number + "-zone-" + zone.relay_id);

      this.zoneUuids.set(zone.relay_id, zoneUuid);

      // We must always construct the full MatterAccessory object because cached accessories
      // lose their object prototypes (like deviceType.with) during serialization.
      const zoneAccessory: MatterAccessory = {

        UUID: zoneUuid,
        displayName: zone.name,
        deviceType: useSwitch ? matter.deviceTypes.OnOffOutlet : matter.deviceTypes.WaterValve,
        serialNumber: `${this.controller.serial_number}-${zone.relay_id}`,
        manufacturer: "Hunter",
        model: "Hydrawise Zone",
        firmwareRevision: "2.0.0",
        hardwareRevision: "1.0.0",
        context: { serialNumber: this.controller.serial_number, relayId: zone.relay_id, controllerId: this.controller.controller_id, type: "zone" },
        clusters: useSwitch ? {

          onOff: { onOff: zone.time === 1 }
        } : {

          valveConfigurationAndControl: {

            currentState: 0,
            targetState: 0,
            defaultOpenDuration: 300
          }
        }
      };

      // Bind callback handlers to the zone accessory.
      if(useSwitch) {


        zoneAccessory.handlers = {


          onOff: {


            on: async () => this.handleOpen(zone.relay_id.toString(), undefined, true),
            off: async () => this.handleClose(zone.relay_id.toString(), true)
          }
        };
      } else {


        zoneAccessory.handlers = {


          valveConfigurationAndControl: {


            open: async (args: any) => this.handleOpen(zone.relay_id.toString(), args?.openDuration, true),
            close: async () => this.handleClose(zone.relay_id.toString(), true)
          }
        };
      }

      this.accessories.set(zoneUuid, zoneAccessory);
      this.allAccessories.push(zoneAccessory);
    }

    // We must always construct the full MatterAccessory object for the suspend switch as well.
    if(this.hasFeature("Device.Suspend")) {

      const suspendUuid = this.api.matter!.uuid.generate(this.controller.serial_number + "-suspend");

      this.suspendUuid = suspendUuid;

      const suspendAccessory: MatterAccessory = {

        UUID: suspendUuid,
        displayName: this.controller.name + " Suspend All Zones",
        deviceType: matter.deviceTypes.OnOffOutlet,
        serialNumber: `${this.controller.serial_number}-suspend`,
        manufacturer: "Hunter",
        model: "Hydrawise Suspend Switch",
        firmwareRevision: "2.0.0",
        hardwareRevision: "1.0.0",
        context: { serialNumber: this.controller.serial_number, controllerId: this.controller.controller_id, type: "suspend" },
        clusters: {

          onOff: { onOff: this.isAllSuspended }
        }
      };

      suspendAccessory.handlers = {


        onOff: {


          on: async () => this.handleSuspend(true, true),
          off: async () => this.handleSuspend(false, true)
        }
      };

      this.accessories.set(suspendUuid, suspendAccessory);
      this.allAccessories.push(suspendAccessory);
    }

    // Configure MQTT.
    this.configureMqtt();

    // Register for state updates from the platform's central polling loop.
    this.platform.onStatusUpdate(this.controller.controller_id, (status) => { void this.updateState(status); });

    return true;
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
  private async handleOpen(id: string, duration?: number, isMatterCommand: boolean = false): Promise<void> {

    const relayId = this.getRelayId(id);
    const zone = this.status.relays.find(x => x.relay_id === relayId);

    if(!zone) {

      this.log.error("Unable to find zone for ID: %s", id);

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

    // Update Matter state only for non-Matter triggers (e.g., MQTT).
    if(!isMatterCommand) {


      const useSwitch = this.hasFeature("Matter.Valve.AsSwitch");
      const zoneUuid = this.zoneUuids.get(relayId);

      if(zoneUuid) {


        if(useSwitch) {


          await this.api.matter!.updateAccessoryState(
            zoneUuid,
            "onOff",
            { onOff: true }
          );
        } else {


          await this.api.matter!.updateAccessoryState(
            zoneUuid,
            "valveConfigurationAndControl",
            {


              currentState: 1,
              targetState: 1,
              remainingDuration: runDuration,
              openDuration: runDuration
            }
          );
        }
      }
    }
  }

  // Handle command to close (stop watering) a zone.
  private async handleClose(id: string, isMatterCommand: boolean = false): Promise<void> {

    const relayId = this.getRelayId(id);
    const zone = this.status.relays.find(x => x.relay_id === relayId);

    if(!zone) {

      this.log.error("Unable to find zone for ID: %s", id);

      return;
    }

    this.log.info("Requesting stop watering for zone %s [Zone %s].", zone.name, zone.relay);

    const response = await this.sendCommand(zone, "stop");

    if(!response) {

      this.log.error("Failed to send stop command for zone %s.", zone.name);

      return;
    }

    // Update Matter state only for non-Matter triggers (e.g., MQTT).
    if(!isMatterCommand) {


      const useSwitch = this.hasFeature("Matter.Valve.AsSwitch");
      const zoneUuid = this.zoneUuids.get(relayId);

      if(zoneUuid) {


        if(useSwitch) {


          await this.api.matter!.updateAccessoryState(
            zoneUuid,
            "onOff",
            { onOff: false }
          );
        } else {


          await this.api.matter!.updateAccessoryState(
            zoneUuid,
            "valveConfigurationAndControl",
            {


              currentState: 0,
              targetState: 0,
              remainingDuration: null,
              openDuration: null
            }
          );
        }
      }
    }
  }

  // Handle command to suspend/resume watering for all zones.
  private async handleSuspend(suspend: boolean, isMatterCommand: boolean = false): Promise<void> {

    this.log.info("%s scheduled watering for all zones.", suspend ? "Suspending" : "Resuming");

    // Year from now to suspend, or 0 (current time) to resume.
    const timestamp = (Date.now() / 1000) + (suspend ? 31556926 : 0);
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

    // Update Matter state only for non-Matter triggers.
    if(!isMatterCommand && this.hasFeature("Device.Suspend") && this.suspendUuid) {

      await this.api.matter!.updateAccessoryState(
        this.suspendUuid,
        "onOff",
        { onOff: suspend }
      );
    }
  }

  // Synchronization update.
  private async updateState(status: StatusScheduleResponse): Promise<void> {

    if(!this.registrationReady) {
      
      this.log.debug("Skipping state update - Matter accessories not yet registered.");
      return;
    }

    this.status = status;

    // Synchronize each valve (relay) state.
      for(const zone of this.status.relays) {


        const zoneUuid = this.zoneUuids.get(zone.relay_id);

        if(!zoneUuid) {


          continue;
        }

        const isOn = zone.time === 1;

        const currentState = isOn ? 1 : 0;
        const targetState = isOn ? 1 : 0;
        const remainingDuration = isOn ? parseInt(zone.run) : null;
        const openDuration = isOn ? parseInt(zone.run) : null;

        const useSwitch = this.hasFeature("Matter.Valve.AsSwitch");

        try {
          if(useSwitch) {
            await this.api.matter!.updateAccessoryState(
              zoneUuid,
              "onOff",
              { onOff: isOn }
            );
          } else {
            await this.api.matter!.updateAccessoryState(
              zoneUuid,
              "valveConfigurationAndControl",
              {
                currentState,
                openDuration,
                remainingDuration,
                targetState
              }
            );
          }
        } catch (error: any) {
          this.log.debug(`Failed to update Matter accessory state for ${zone.name}: ${error.message}`);
        }
      }

      // Synchronize suspend state.
      if(this.hasFeature("Device.Suspend") && this.suspendUuid && this.api.matter) {

        await this.api.matter.updateAccessoryState(
          this.suspendUuid,
          "onOff",
          { onOff: this.isAllSuspended }
        );
      }

      // Publish status JSON to MQTT.
      this.platform.mqtt?.publish(this.controller.serial_number, "controller", this.statusJson);
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

  // Parse numeric relay ID from ID string (e.g. "zone-12345" -> 12345 or "12345" -> 12345).
  private getRelayId(id: string): number {

    const match = id.match(/zone-(\d+)/);

    if(match) {


      return parseInt(match[1], 10);
    }
    const numeric = parseInt(id, 10);

    return isNaN(numeric) ? 0 : numeric;
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
