/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hydrawise-controller.ts: Base class for all Hydrawise irrigation controllers.
 */
import type { API, CharacteristicValue, HAP, Service } from "homebridge";
import { HYDRAWISE_ACTIVE_ZONE_INDICATOR, HYDRAWISE_API_JITTER, HYDRAWISE_API_RETRY_INTERVAL, HYDRAWISE_SUSPEND_DURATION } from "./settings.ts";
import type { HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import type { HydrawiseAccessory, HydrawiseControllerConfig, HydrawiseControllerIdentity, HydrawiseZoneConfig, HydrawiseZoneIdentity, SetZoneResponse,
  StatusScheduleResponse } from "./hydrawise-types.ts";
import type { HydrawiseControllerOption, HydrawiseOptions, HydrawiseZoneOption, HydrawiseZoneValueOption } from "./hydrawise-options.ts";
import { acquireService, getServiceName, guardedDispatch, loopFaultReporter, prefixedLog, retry, sanitizeName, setServiceName, superviseLoop,
  validService } from "homebridge-plugin-utils";
import type { Dispatcher } from "undici";
import type { HydrawisePlatform } from "./hydrawise-platform.ts";
import { HydrawiseReservedNames } from "./hydrawise-types.ts";
import { setTimeout as setTimeoutAsync } from "node:timers/promises";
import util from "node:util";

// Device-specific options and settings.
interface HydrawiseHints {

  suspendAll: boolean;
}

// Per-zone state we track across polling cycles so we can detect and report start, stop, and rain-sensor transitions.
interface HydrawiseZoneHints {

  isManual: boolean;
  isOn: boolean;
  isStopped: boolean;
}

export class HydrawiseController {

  private readonly accessory: HydrawiseAccessory;
  private readonly api: API;
  private readonly config: HydrawiseOptions;
  public readonly controller: HydrawiseControllerConfig;
  private enabledZones: HydrawiseZoneConfig[];
  private readonly hap: HAP;
  private readonly hints: HydrawiseHints;
  public readonly log: HomebridgePluginLogging;
  private readonly platform: HydrawisePlatform;
  private status: StatusScheduleResponse;
  private readonly zoneHints: Map<number, HydrawiseZoneHints>;

  // The constructor initializes key variables and calls configureDevice(). The platform passes the denormalized account roster - every account controller's identity,
  // enabled or not - so this controller can seed it into its own accessory context, giving any one accessory knowledge of all its siblings.
  constructor(platform: HydrawisePlatform, accessory: HydrawiseAccessory, controller: HydrawiseControllerConfig, roster: HydrawiseControllerIdentity[]) {

    this.accessory = accessory;
    this.api = platform.api;
    this.status = { nextpoll: -1, relays: [] as HydrawiseZoneConfig[] } as StatusScheduleResponse;
    this.enabledZones = [];
    this.config = platform.config;
    this.hap = this.api.hap;
    this.hints = {} as HydrawiseHints;
    this.controller = controller;
    this.platform = platform;
    this.zoneHints = new Map();

    // Prefix every log line with this controller's live name. The platform's log.debug is already rebound to the platform's debug gate, so debug routing stays intact.
    this.log = prefixedLog(platform.log, (): string => this.name);

    this.configureDevice(roster);
  }

  // Configure an irrigation system accessory for HomeKit.
  private configureDevice(roster: HydrawiseControllerIdentity[]): void {

    // Capture the prior persisted zone roster before we wipe the context. We restore it below so a restart does not blank the zone list during the window between this
    // configure pass and the first completed poll, when the runtime has not yet rebuilt the roster from a fresh status body.
    const priorZones = this.accessory.context.zones;

    // Clean out the context object, then reseed the identity rosters this controller owns. The controller is the single writer of accessory context: it seeds its own
    // identity (the self-identity the webUI's zone lookup keys on) and the denormalized account roster here, and rewrites the zone roster on change from each poll. We
    // restore the prior zone roster when it is a well-formed array and degrade a malformed prior value to empty, so a corrupt cache entry never crashes the reader.
    this.accessory.context = {};
    this.accessory.context.controller = { controllerId: this.controller.controller_id, name: this.controller.name, serialNumber: this.controller.serial_number };
    this.accessory.context.controllers = roster;
    this.accessory.context.zones = this.isZoneRoster(priorZones) ? priorZones : [];

    // Configure ourselves.
    this.configureHints();
    this.configureInfo();
    this.configureIrrigationSystem();
    this.configureSuspendSwitches();
    this.configureMqtt();

    // Kick off our state updates under supervision so a genuine fault in the polling loop surfaces once through the reporter, while a shutdown abort unwinds the loop
    // silently.
    void superviseLoop({ loop: (signal): Promise<void> => this.updateState(signal), onError: loopFaultReporter(this.log, "zone status"), signal: this.platform.signal });
  }

  // Configure controller-specific settings.
  private configureHints(): boolean {

    this.hints.suspendAll = this.hasFeature("Device.Suspend");

    // Surface a name-synchronization opt-out at startup. Synchronization is read live on each poll rather than cached in a hint, since a zone can opt out
    // independently of its controller; this line reports the controller-scope answer, which is the one that governs when no zone says otherwise.
    this.platform.featureOptions.logFeature("Device.SyncName", "Zone name synchronization", this.log, undefined, this.controller.serial_number);

    return true;
  }

  // Configure the controller information for HomeKit.
  private configureInfo(): boolean {

    // Update the manufacturer information for this controller.
    this.accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.Manufacturer, "Hunter");

    // Update the model information for this controller.
    this.accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.Model, "Hydrawise");

    // Update the serial number for this controller.
    this.accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.SerialNumber, this.controller.serial_number);

    return true;
  }

  // Compose the wire-level MQTT topic for this controller. Every publish and subscription routes through this helper so the per-controller prefix shape
  // ("<serial>/<suffix>") lives in exactly one place. The platform's MqttClient prepends its own configured topicPrefix on top of whatever we return here.
  private mqttTopic(suffix: string): string {

    return this.controller.serial_number + "/" + suffix;
  }

  // Configure MQTT services.
  private configureMqtt(): boolean {

    // Return our irrigation controller state.
    this.platform.mqtt?.subscribeGet(this.mqttTopic("controller"), "controller", (): string => this.statusJson);

    // Set the state of a given irrigation zone.
    this.platform.mqtt?.subscribeSet(this.mqttTopic("controller"), "controller", async (value: string): Promise<void> => {

      // Parse the command.
      const action = value.split(" ");

      // Parse the zone number.
      const zoneValue = parseInt(action[1] ?? "");

      // Let's find the zone, if it exists.
      const zone = this.status.relays.find(x => x.relay === zoneValue);

      // No zone. We throw so HBPU's subscribeSet convention logs the error, rather than logging locally and emitting a spurious success line alongside it.
      if(!zone) {

        throw new Error("MQTT: Invalid zone specified.");
      }

      switch(action[0]) {

        case "start":

          await this.sendCommand(zone, "run", parseInt(action[2] ?? ""));

          return;

        case "stop":

          await this.sendCommand(zone, "stop");

          return;

        default:

          throw new Error("Invalid command.");
      }
    });

    return true;
  }

  // Configure the irrigation system service for HomeKit.
  private configureIrrigationSystem(): boolean {

    // Acquire the service and if needed, add a service label service in order to be able to properly enumerate and name the individual zone valves.
    const service = acquireService(this.accessory, this.hap.Service.IrrigationSystem, this.name, undefined,
      () => acquireService(this.accessory, this.hap.Service.ServiceLabel, this.name)
        ?.updateCharacteristic(this.hap.Characteristic.ServiceLabelNamespace, this.hap.Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS));

    if(!service) {

      this.log.error("Unable to add the irrigation controller.");

      return false;
    }

    // Initialize the service.
    service.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.ACTIVE);
    service.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE);
    service.updateCharacteristic(this.hap.Characteristic.ProgramMode, this.hap.Characteristic.ProgramMode.PROGRAM_SCHEDULED);

    return true;
  }

  // Configure suspend switch services for HomeKit.
  private configureSuspendSwitches(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.Switch, this.hints.suspendAll, HydrawiseReservedNames.SWITCH_SUSPEND_ALL)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, this.hap.Service.Switch,
      getServiceName(this.accessory.getServiceById(this.hap.Service.Switch, HydrawiseReservedNames.SWITCH_SUSPEND_ALL)) ?? this.accessoryName + " Suspend All Zones",
      HydrawiseReservedNames.SWITCH_SUSPEND_ALL);

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add suspend all zones switch.");

      return false;
    }

    // Suspend or resume the irrigation schedule.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.isAllSuspended);

    service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue): Promise<void> => {

      // We either set the timestamp to the current time, to resume irrigation, or to a year from now to suspend irrigation. Both floor to a whole second so the
      // command carries the integer seconds the API expects rather than a fractional millisecond remainder.
      const timestamp = Math.floor(Date.now() / 1000) + (value ? HYDRAWISE_SUSPEND_DURATION : 0);

      const response = await this.sendCommand("suspendall", timestamp);

      let status;

      try {

        status = await response?.body.json() as SetZoneResponse;
      } catch {

        // A shutdown abort mid-read is orderly teardown, not a failure - exit the whole handler quietly, skipping both the error log and the revert timer.
        if(this.platform.signal.aborted) {

          return;
        }

        this.log.error("Unable to retrieve the result of the %s request.", value ? "suspend" : "resume");
      }

      if(status?.message_type === "error") {

        this.log.error("Unable to complete the %s request.", value ? "suspend" : "resume");
      }

      if(!status || (status.message_type === "error")) {

        setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.On, !value), 50);

        return;
      }

      this.log.info("%s scheduled watering for all zones.", value ? "Suspending" : "Resuming");
    });

    service.updateCharacteristic(this.hap.Characteristic.On, this.isAllSuspended);

    this.platform.featureOptions.logFeature("Device.Suspend", "Suspend all zones switch", this.log, undefined, this.controller.serial_number);

    return true;
  }

  // Update the irrigation system state from the Hydrawise API to HomeKit.
  private async updateState(signal: AbortSignal): Promise<void> {

    // We loop forever, updating our irrigation system state at regular intervals. A shutdown abort unwinds the loop through the signal, which superviseLoop treats as
    // the expected exit.
    for(;;) {

      const isFirstRun = this.status.nextpoll === -1;

      // Update our status, retrying forever on a network failure or a malformed or mis-shaped body at the polling cadence. On the first run we use the fixed retry
      // interval; afterwards we honor the API's nextpoll hint, clamped so a failure never waits longer than twice the retry interval. A shutdown abort ends the
      // retry through the signal.
      // eslint-disable-next-line no-await-in-loop
      await retry(() => this.getStatus(), { attempts: Infinity,
        backoff: (): number => (isFirstRun ? HYDRAWISE_API_RETRY_INTERVAL : Math.min(this.status.nextpoll + HYDRAWISE_API_JITTER, HYDRAWISE_API_RETRY_INTERVAL * 2)) *
          1000, signal });

      // Trim whitespace on zone names.
      this.status.relays = this.status.relays.map(x => ({ ...x, name: x.name.trim() }));

      // Persist the full reported zone roster to the accessory context when it changes. We run this before the enablement projection below so the persisted roster
      // carries every reported zone, feature-disabled or not - the complete listing the webUI reads back from cache with no cloud call.
      this.persistZoneRoster();

      // Project the reported zones onto the set the user has enabled. Every HomeKit surface in this pass - valves, aggregates, logging - works from this
      // projection, and long-lived handlers read it through the instance field so they always act on the current poll's truth.
      this.enabledZones = this.status.relays.filter(zone => this.hasZoneFeature("Device", zone.relay_id.toString()));

      // Project one live-id set from the enabled zones - reported by the API and enabled by feature option - and drive both prunes from it. The hints map tracks
      // only zones in the current poll's enabled projection, so a zone that vanishes and later reappears starts fresh instead of resurrecting its old manual and
      // rain-stopped flags.
      const liveZoneIds = new Set(this.enabledZones.map(zone => zone.relay_id.toString()));

      for(const relayId of this.zoneHints.keys()) {

        if(!liveZoneIds.has(relayId.toString())) {

          this.zoneHints.delete(relayId);
        }
      }

      // Remove valves for zones that no longer exist or that the user has disabled.
      this.accessory.services.filter(x => (x.UUID === this.hap.Service.Valve.UUID) && !liveZoneIds.has(x.subtype ?? ""))
        .map(x => this.accessory.removeService(x));

      let irrigationRemaining = 0;

      // Find the irrigation system service.
      const irrigationSystemService = this.accessory.getService(this.hap.Service.IrrigationSystem);

      // Discover any new zones and update our zone state.
      for(const zone of this.enabledZones) {

        // The name this zone's valve carries: the user's Name option when set, otherwise the name Hydrawise reports. Resolved once per zone iteration, because both
        // the acquisition below and the synchronization that follows it answer to the same name.
        const override = this.zoneNameOverride("Device.Name", zone.relay_id.toString());
        const effectiveName = override ?? zone.name;

        // Acquire the valve service.
        let isNewValve = false;
        const valveService = acquireService(this.accessory, this.hap.Service.Valve, effectiveName, zone.relay_id.toString(), (newService: Service) => {

          // Enumerate the valve service to align with the irrigation controller's zone numbering.
          newService.updateCharacteristic(this.hap.Characteristic.ServiceLabelIndex, zone.relay);

          // This allows users to enable or disable the zone from within HomeKit. We could exclude it, but the extra optionality for end users can be useful.
          newService.updateCharacteristic(this.hap.Characteristic.IsConfigured, this.hap.Characteristic.IsConfigured.CONFIGURED);

          // All valves attached to an irrigation system must have their type set accordingly.
          newService.updateCharacteristic(this.hap.Characteristic.ValveType, this.hap.Characteristic.ValveType.IRRIGATION);

          // Ensure that we inform the user of the new valve.
          isNewValve = true;
        });

        if(!valveService) {

          this.log.error("Unable to create a valve service for zone: %s (%s).", zone.name, zone.relay_id);

          continue;
        }

        // While name synchronization holds for this zone, the effective name - the user's Name option when set, otherwise the name Hydrawise reports - is
        // authoritative: it is applied whenever the service's name differs, so a Hydrawise rename lands on the next poll, a changed Name option lands at the
        // first poll after restart, and a rename made in the Home app yields to the configured truth. Synchronization is deliberately enabled by default,
        // because the names Hydrawise reports are the source of truth this integration projects into HomeKit and the Name option exists to correct them where
        // Hydrawise truncates. With synchronization disabled, names are established at creation and never touched again, and a Home app rename persists.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if(!isNewValve && this.hasZoneFeature("Device.SyncName", zone.relay_id.toString()) && (getServiceName(valveService) !== sanitizeName(effectiveName))) {

          setServiceName(valveService, effectiveName);
        }

        // See if the zone has been stopped due to a rain sensor event. We compute this before resolving the hint entry so a first-sighted zone seeds its stored rain
        // state with the live sensor value rather than a static default, which would otherwise fire a spurious rain-sensor transition on the zone's first appearance
        // during a rain delay.
        const isStopped = this.isStoppedBySensor(zone);

        // Resolve this zone's hint entry, creating it on first sighting seeded with the live sensor state and the falsy manual and on defaults. An existing entry is
        // left untouched here so its manual and on flags survive across refreshes.
        let hints = this.zoneHints.get(zone.relay_id);

        if(!hints) {

          hints = { isManual: false, isOn: false, isStopped };
          this.zoneHints.set(zone.relay_id, hints);
        }

        // Inform the user.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if(isFirstRun || isNewValve) {

          // Refresh our stopped state unconditionally on a first sighting or valve rediscovery, seeding the stored value with the live sensor reading so the
          // transition check below does not fire on the zone's first appearance.
          hints.isStopped = isStopped;

          this.log.info("%s: %s", this.getValveName(valveService, zone), this.zoneStatus(zone));

          // Manually control the zone valve.
          valveService.getCharacteristic(this.hap.Characteristic.Active).onSet(async (value: CharacteristicValue): Promise<void> => {

            const setOn = value === this.hap.Characteristic.Active.ACTIVE;
            const duration = Number(valveService.getCharacteristic(this.hap.Characteristic.SetDuration).value ?? 0);
            let response;

            // Request the change in zone state.
            if(setOn) {

              response = await this.sendCommand(zone, "run", duration);
            } else {

              response = await this.sendCommand(zone, "stop");
            }

            // Something went wrong in communicating with the Hydrawise API.
            if(!response) {

              // Revert our state for this zone.
              setTimeout(() => valveService.updateCharacteristic(this.hap.Characteristic.Active,
                setOn ? this.hap.Characteristic.Active.INACTIVE : this.hap.Characteristic.Active.ACTIVE), 50);

              return;
            }

            // Resolve this zone's hint entry live at invocation time rather than capturing a reference at registration time, so this handler always acts on the current
            // entry. A missing entry is a no-op we simply skip past.
            const hint = this.zoneHints.get(zone.relay_id);

            // Update our valve state accordingly.
            if(setOn) {

              valveService.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.IN_USE);
              valveService.updateCharacteristic(this.hap.Characteristic.RemainingDuration, duration);
              irrigationSystemService?.updateCharacteristic(this.hap.Characteristic.ProgramMode, this.hap.Characteristic.ProgramMode.PROGRAM_SCHEDULED_MANUAL_MODE);
              irrigationSystemService?.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.IN_USE);

              // Mark this zone as manually activated.
              if(hint) {

                hint.isManual = true;
              }
            } else {

              valveService.updateCharacteristic(this.hap.Characteristic.RemainingDuration, 0);
              valveService.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE);

              // Clear out the manual activation tracker for this zone.
              if(hint) {

                hint.isManual = false;
              }

              // No more manually activated zones among the enabled set, we can resume our schedule. We consult the instance state at invocation time so this
              // handler always acts on the current poll's enabled zones.
              if(!this.enabledZones.some(x => this.zoneHints.get(x.relay_id)?.isManual)) {

                irrigationSystemService?.updateCharacteristic(this.hap.Characteristic.ProgramMode, this.hap.Characteristic.ProgramMode.PROGRAM_SCHEDULED);
              }

              // If this was the only enabled zone currently running on the irrigation controller, let's set the system state to no longer in use.
              if(!this.enabledZones.some(x => (x.time === 1) && (x.relay_id !== zone.relay_id))) {

                irrigationSystemService?.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE);
              }
            }

            this.log.info("%s: Manually %s%s.", this.getValveName(valveService, zone), setOn ? "started" : "stopped",
              setOn ? " (duration: " + this.getMinutes(duration) + ")" : "");
          });
        }

        // Determine whether the zone is currently running from the Hydrawise API.
        hints.isOn = zone.time === 1;

        // Retrieve whether the valve service is in use from HomeKit's perspective.
        const isValveInUse = valveService.getCharacteristic(this.hap.Characteristic.InUse).value === this.hap.Characteristic.InUse.IN_USE;

        // Get the duration of the next run time (if we aren't running currently) or the time remaining in this run if we're running.
        const duration = zone.run;

        // If a zone is on, then our irrigation system is in use and we update the remaining runtime duration.
        if(hints.isOn) {

          irrigationRemaining += duration;

          // Update the duration of the remaining runtime of this valve, in seconds.
          valveService.updateCharacteristic(this.hap.Characteristic.RemainingDuration, Math.min(duration, 3600));
        } else {

          // Clear out the manual activation tracker for this zone.
          hints.isManual = false;

          // Set the duration of the next run of this valve, in seconds, in HomeKit based on the Hydrawise scheduled runtime.
          valveService.updateCharacteristic(this.hap.Characteristic.SetDuration, Math.min(duration, 3600));
        }

        // Active represents whether the zone is ready to be activated - meaning it's queued to turn on imminently or is currently on.
        if((zone.time > 0) && (zone.time <= HYDRAWISE_ACTIVE_ZONE_INDICATOR)) {

          valveService.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.ACTIVE);
          this.log.debug("Setting %s as active.", this.getValveName(valveService, zone));
        } else {

          valveService.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.INACTIVE);
        }

        // InUse represents whether there is water flowing through the valve currently.
        valveService.updateCharacteristic(this.hap.Characteristic.InUse, hints.isOn ?
          this.hap.Characteristic.InUse.IN_USE : this.hap.Characteristic.InUse.NOT_IN_USE);

        // Log our activity, if configured to do so.
        if(this.hasZoneFeature("Log.Zone", zone.relay_id.toString())) {

          // Inform the user if the zone has been started or stopped.
          if(isValveInUse !== hints.isOn) {

            this.log.info("%s: %s %s", this.getValveName(valveService, zone), hints.isOn ? "Started" : "Stopped.",
              hints.isOn ? "(duration: " + this.getMinutes(zone.run) + ")." : this.zoneStatus(zone));
          }

          // Inform the user if the zone has been stopped due to a rain sensor.
          if(isStopped !== hints.isStopped) {

            this.log.info("%s: Rain sensor is %s irrigation.", this.getValveName(valveService, zone), isStopped ? "stopping" : "allowing");
          }
        }

        // Save the new setting.
        hints.isStopped = isStopped;
      }

      // Update the irrigation system state.
      irrigationSystemService?.updateCharacteristic(this.hap.Characteristic.InUse,
        (irrigationRemaining > 0) ? this.hap.Characteristic.InUse.IN_USE : this.hap.Characteristic.InUse.NOT_IN_USE);
      irrigationSystemService?.updateCharacteristic(this.hap.Characteristic.RemainingDuration, Math.min(irrigationRemaining, 3600));

      // Update the irrigation system's program mode when no enabled zone is manually running: if every enabled zone is currently stopped by a rain sensor,
      // no program is scheduled; otherwise we're on our normal scheduled program.
      const enabledHints = this.enabledZones.map(zone => this.zoneHints.get(zone.relay_id)).filter(hints => hints !== undefined);

      if(!enabledHints.some(x => x.isManual)) {

        irrigationSystemService?.updateCharacteristic(this.hap.Characteristic.ProgramMode,
          (enabledHints.filter(x => x.isStopped).length === this.enabledZones.length) ?
            this.hap.Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED : this.hap.Characteristic.ProgramMode.PROGRAM_SCHEDULED);
      }

      // Publish our status to MQTT if configured to do so, routing through guardedDispatch so a rejected publish - the broker vanishing mid-write, a teardown race -
      // lands in the log instead of floating as an unhandled rejection.
      guardedDispatch({ handler: async (): Promise<void> => { await this.platform.mqtt?.publish(this.mqttTopic("controller"), this.statusJson); },
        label: "MQTT publish (controller)", log: this.log });

      // Update our suspend status.
      this.accessory.getServiceById(this.hap.Service.Switch, HydrawiseReservedNames.SWITCH_SUSPEND_ALL)?.updateCharacteristic(this.hap.Characteristic.On,
        this.isAllSuspended);

      // Sleep until our next polling interval due to the Hydrawise API being rate-limited. A shutdown abort interrupts the wait and unwinds the loop.
      // eslint-disable-next-line no-await-in-loop
      await setTimeoutAsync((this.status.nextpoll + HYDRAWISE_API_JITTER) * 1000, undefined, { signal });
    }
  }

  // Send a command to the Hydrawise API.
  private async sendCommand(zone: HydrawiseZoneConfig, command: "run", duration: number): Promise<Nullable<Dispatcher.ResponseData<unknown>>>;
  private async sendCommand(zone: HydrawiseZoneConfig, command: "stop"): Promise<Nullable<Dispatcher.ResponseData<unknown>>>;
  private async sendCommand(command: "suspendall", duration: number): Promise<Nullable<Dispatcher.ResponseData<unknown>>>;
  private async sendCommand(zoneOrCmd: HydrawiseZoneConfig | "suspendall", cmdOrDur: (number | "run" | "stop"), duration?: number):
  Promise<Nullable<Dispatcher.ResponseData<unknown>>> {

    let command, zone;

    // We've been called as sendCommand("suspendall", duration)
    if(typeof zoneOrCmd === "string") {

      command = zoneOrCmd;
      duration = cmdOrDur as number;
    } else {

      // We've been called as sendCommand(zone, "run" | "stop", [duration])
      zone = zoneOrCmd;
      command = cmdOrDur as "run" | "stop";
    }

    // User has queued us up...send the command to Hydrawise.
    const params: Record<string, string> = {};

    params["controller_id"] = this.controller.controller_id.toString();

    // If we've specified the zone, add it to our parameters.
    if(zone?.relay_id) {

      params["relay_id"] = zone.relay_id.toString();
    }

    switch(command) {

      case "run":

        params["action"] = "run";

        if((duration === undefined) || (duration <= 0)) {

          return null;
        }

        params["custom"] = duration.toString();
        params["period_id"] = "999";

        break;

      case "stop":

        params["action"] = "stop";

        break;

      case "suspendall":

        params["action"] = "suspendall";

        if((duration === undefined) || (duration <= 0)) {

          return null;
        }

        params["custom"] = duration.toString();
        params["period_id"] = "999";

        delete params["relay_id"];

        break;

      default:

        return null;
    }

    // Request the change in zone state.
    return this.platform.retrieve("setzone.php", params);
  }

  // Utility to return the status of a zone to a user.
  private zoneStatus(zone: HydrawiseZoneConfig): string {

    if(this.isStoppedBySensor(zone)) {

      return "Rain sensor is preventing irrigation.";
    }

    // If we're currently running, inform the user of the remaining duration. Otherwise, inform the user of the next runtime.
    if(zone.time === 1) {

      return "Currently running with " + this.getMinutes(zone.run) + " remaining.";
    } else {

      return "Next run will be " + (zone.timestr.includes(":") ? "at " + this.formatStartTime(zone.timestr) : "on " + zone.timestr) + " for " +
        this.getMinutes(zone.run) + ".";
    }
  }

  // Retrieve the current status from the Hydrawise API.
  private async getStatus(): Promise<void> {

    // Get our schedule for this controller.
    const params: Record<string, string> = {};

    params["controller_id"] = this.controller.controller_id.toString();

    const response = await this.platform.retrieve("statusschedule.php", params);

    // A null response is a recoverable API error (or a shutdown abort) that retrieve() already classified and logged. Throw so the retry loop waits and tries again;
    // on shutdown the loop unwinds through its own signal.
    if(!response) {

      throw new Error("Unable to retrieve the current status of the irrigation controller.");
    }

    try {

      // Parse the body into a local and validate its shape before adopting it as our status. A valid-JSON body with the wrong shape would otherwise pass the cast
      // and crash updateState outside every try/catch, tripping superviseLoop's terminal fault and stopping this controller's polling until a restart.
      const parsed = await response.body.json();

      if(!this.isStatusSchedule(parsed)) {

        throw new Error("The Hydrawise API returned a status body with an unexpected shape.");
      }

      this.status = parsed;

      this.log.debug("Status updated.");
      this.log.debug(util.inspect(this.status, { colors: true, depth: null, sorted: true }));
    } catch(error) {

      // A shutdown abort mid-read is orderly teardown - rethrow quietly so the retry loop unwinds without manufacturing a parse-failure error. A genuine parse or
      // shape failure throws so the retry loop waits and re-polls; the stale status is never republished as fresh.
      if(this.platform.signal.aborted) {

        throw error;
      }

      this.log.error("Unable to retrieve the current status of the irrigation controller: --%s--", util.inspect(error, { colors: true, depth: null, sorted: true }));

      throw new Error("Unable to retrieve the current status of the irrigation controller.");
    }
  }

  // Guard that a parsed status body carries the shape updateState relies on: relays and sensors arrays and a numeric nextpoll. A body that fails this check is
  // treated as a failed poll rather than being adopted as our status.
  private isStatusSchedule(value: unknown): value is StatusScheduleResponse {

    if((typeof value !== "object") || (value === null)) {

      return false;
    }

    const candidate = value as Partial<StatusScheduleResponse>;

    return Array.isArray(candidate.relays) && Array.isArray(candidate.sensors) && (typeof candidate.nextpoll === "number");
  }

  // Persist the reported zone roster to the accessory context, writing and flushing only when it changed since the last poll. We project every reported zone to the
  // identity-only shape, naming each field explicitly rather than spreading the wire zone so no volatile schedule field leaks into persisted context, ordered by relay
  // for a stable comparison. The comparison is field-wise because the projection is a fresh array every poll, so a reference check would differ every time and flush on
  // every poll; a single flush persists the change to Homebridge's cache so the roster survives an unclean shutdown. A rare single-poll flap that flips a field and
  // back across two polls costs two flushes, which we accept - roster changes are rare and a flush is cheap.
  private persistZoneRoster(): void {

    const zones = this.status.relays.map(zone => ({ name: zone.name, relay: zone.relay, relayId: zone.relay_id })).sort((a, b) => a.relay - b.relay);

    // After configureDevice's seed the context always carries a zones array, so the nullish fallback is a defensive floor for a context that predates the seed rather
    // than an expected path.
    if(this.sameZoneRoster(this.accessory.context.zones ?? [], zones)) {

      return;
    }

    this.accessory.context.zones = zones;
    this.api.updatePlatformAccessories([this.accessory]);
  }

  // Compare two zone rosters field-wise: equal length and, at every index, equal relay id, relay number, and name. We never compare by reference because the
  // projection persistZoneRoster builds is a fresh array every poll, so a reference check would always differ and flush needlessly.
  private sameZoneRoster(previous: HydrawiseZoneIdentity[], next: HydrawiseZoneIdentity[]): boolean {

    if(previous.length !== next.length) {

      return false;
    }

    // We capture the paired entry and guard it before the field comparison. The equal-length check above guarantees a paired entry exists; the guard narrows the
    // strict indexed-access `| undefined` so the comparison reads the fields directly, and a defensively-absent entry simply reports the rosters as differing.
    return previous.every((entry, index) => {

      const other = next[index];

      if(!other) {

        return false;
      }

      return (entry.relayId === other.relayId) && (entry.relay === other.relay) && (entry.name === other.name);
    });
  }

  // Guard that a persisted context value is a well-formed zone roster: an array whose every entry carries the three identity fields with the right types. A malformed
  // prior value - a non-array, or an entry missing a field - fails this check and degrades to an empty roster, so a corrupt cache entry never crashes the webUI reader.
  private isZoneRoster(value: unknown): value is HydrawiseZoneIdentity[] {

    return Array.isArray(value) && value.every(entry => (typeof entry === "object") && (entry !== null) && (typeof (entry as HydrawiseZoneIdentity).name === "string") &&
      (typeof (entry as HydrawiseZoneIdentity).relay === "number") && (typeof (entry as HydrawiseZoneIdentity).relayId === "number"));
  }

  // Utility to test for whether a zone has been stopped due to a rain sensor.
  private isStoppedBySensor(zone: HydrawiseZoneConfig): boolean {

    return !zone.run && !zone.timestr && (zone.time === 1576800000) &&
      this.status.sensors.filter(sensor => sensor.type === 1).some(sensor => sensor.relays.some(relay => relay.id === zone.relay_id));
  }

  // Utility to conver the duration from seconds to minutes, with the correct plural marker.
  private getMinutes(duration: number): string {

    const minutes = Math.round(duration / 60);

    return minutes.toString() + " minute" + (minutes !== 1 ? "s" : "");
  }

  // Utility to format the time strings returned by Hydrawise.
  private formatStartTime(time: string): string {

    // Split it into hours and minutes and ensure we convert it in the process. The defaults keep the arithmetic below total when the input is malformed.
    const [ hours = 0, minutes = 0 ] = time.split(":").map(Number);

    // Return our user-friendly time string.
    return ((hours % 12) || 12).toString() + ":" + minutes.toString().padStart(2, "0") + " " + (hours >= 12 ? "PM" : "AM");
  }

  // Utility for checking a controller-scoped feature option. The narrowed option-name union makes a scope-violating call a compile error: only controller-scopable
  // options can be named here. The serial rides the canonical controller position with the device slot left undefined; the resolved storage key is the flat
  // option-and-serial string regardless of which slot carries the serial, so controller-scope resolution is stable across that positioning.
  private hasFeature(option: HydrawiseControllerOption): boolean {

    return this.platform.featureOptions.test(option, undefined, this.controller.serial_number);
  }

  // Utility for checking a zone-scoped feature option. The zone id rides the device position and the serial the controller position, so resolution walks the zone
  // override, then the controller, then global, then the catalog default. Only zone-scopable options can be named here.
  private hasZoneFeature(option: HydrawiseZoneOption, zoneId: string): boolean {

    return this.platform.featureOptions.test(option, zoneId, this.controller.serial_number);
  }

  // Utility for reading a zone-scoped value option. The zone id rides the device position and the serial the controller position, exactly as hasZoneFeature
  // resolves, and an unset, empty, or whitespace-only value normalizes to undefined so callers can default with ??.
  private zoneNameOverride(option: HydrawiseZoneValueOption, zoneId: string): string | undefined {

    const name = this.platform.featureOptions.value(option, zoneId, this.controller.serial_number)?.trim();

    return name?.length ? name : undefined;
  }

  // Utility function to get the configured name of a valve, if set.
  private getValveName(service: Service, zone: HydrawiseZoneConfig): string {

    return ((service.getCharacteristic(this.hap.Characteristic.ConfiguredName).value as string | undefined) ?? zone.name) + " [Zone " + zone.relay.toString() + "]";
  }

  // Utility to return whether all zones are suspended or not.
  private get isAllSuspended(): boolean {

    return !this.status.relays.some(zone => zone.run || zone.timestr || (zone.time !== 1576800000) || this.isStoppedBySensor(zone));
  }

  // Utility to return our status as a JSON for MQTT.
  private get statusJson(): string {

    return JSON.stringify(this.status.relays.map(x => ({ name: x.name, relay: x.relay, run: x.run, time: x.time, timestr: x.timestr })));
  }

  // Utility function to return the name of this controller.
  private get name(): string {

    // We use the irrigation system service as the natural proxy for the name.
    const name = this.accessory.getService(this.hap.Service.IrrigationSystem)?.getCharacteristic(this.hap.Characteristic.Name).value as string | undefined;

    // If we don't have a name for the irrigation system service, return the controller name from Hydrawise.
    return name?.length ? name : this.controller.name;
  }

  // Utility function to return the current accessory name of this device.
  private get accessoryName(): string {

    return ((this.accessory.getService(this.hap.Service.AccessoryInformation)?.getCharacteristic(this.hap.Characteristic.Name).value as string | undefined) ??
      this.controller.name);
  }

  // Utility function to set the current accessory name of this device.
  private set accessoryName(name: string) {

    // Set all the internally managed names within Homebridge to the new accessory name.
    this.accessory.displayName = name;
    this.accessory._associatedHAPAccessory.displayName = name;

    // Set all the HomeKit-visible names.
    this.accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.Name, name);
  }
}
