/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller.ts: Base class for all Hydrawise irrigation controllers.
 */
import type { API, CharacteristicValue, HAP, Service } from "homebridge";
import { HYDRAWISE_ACTIVE_ZONE_INDICATOR, HYDRAWISE_API_JITTER, HYDRAWISE_API_RETRY_INTERVAL, HYDRAWISE_COMMAND_ENDPOINT, HYDRAWISE_REVERT_DELAY,
  HYDRAWISE_SUSPEND_DURATION } from "./settings.ts";
import { HYDRAWISE_UNSCHEDULED_SENTINEL, HydrawiseReservedNames, controllerIdentity, isScheduleStatus, isZoneIdentity, isZoneStoppedBySensor, sameEntries,
  sameScheduleStatus, sameZoneIdentity, scheduleStatus, zoneIdentity, zoneScheduleStatus } from "./types.ts";
import type { HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import type { HydrawiseAccessory, HydrawiseControllerAccessory, HydrawiseControllerConfig, HydrawiseControllerIdentity, HydrawiseZoneConfig,
  HydrawiseZoneIdentity, SetZoneResponse, StatusScheduleResponse } from "./types.ts";
import type { HydrawiseControllerOption, HydrawiseZoneOption, HydrawiseZoneValueOption } from "./options.ts";
import { acquireService, getServiceName, guardedDispatch, loopFaultReporter, prefixedLog, retry, sanitizeName, setServiceName, superviseLoop,
  validService } from "homebridge-plugin-utils";
import type { Dispatcher } from "undici";
import type { HydrawisePlatform } from "./platform.ts";
import { setTimeout as setTimeoutAsync } from "node:timers/promises";
import util from "node:util";

// Device-specific options and settings.
interface HydrawiseHints {

  suspendAll: boolean;
}

/* One completed poll, as it crosses from the wire half of the polling loop to the HomeKit half: whether this is the controller's first completed poll, and the
 * status body that poll fetched.
 *
 * isFirstRun travels here because it cannot be recovered on the far side. It is read from the pre-fetch nextpoll sentinel, before the fetch overwrites the status
 * it describes, and the zone walk reads it to decide whether to attach a valve's set handler - the warm-restart case, where the valve service comes back from the
 * accessory cache but this process has never bound a handler to it.
 *
 * The status field is deliberately the same object the controller holds, not a defensive copy. The projection reads instance state directly throughout, and it is
 * the only consumer in the process, so a copy would hand it one object while every other read in the same pass saw another.
 */
interface HydrawisePollUpdate {

  readonly isFirstRun: boolean;
  readonly status: StatusScheduleResponse;
}

// Per-zone state we track across polling cycles so we can detect and report start, stop, and rain-sensor transitions.
interface HydrawiseZoneHints {

  isManual: boolean;
  isOn: boolean;
  isStopped: boolean;
}

/* The one owner of the zone hints a controller keeps. The map is private to this class, and every change to it arrives as a named intent - seed, mark, clear,
 * observe, refresh, prune - rather than as a field write somewhere out in the poll walk or a set handler.
 *
 * Single ownership is what lets the relationships between those hints be enforced here instead of resting on the order call sites happen to run in. A zone the
 * wire reports as not running is not manually activated, so the observation clears the manual flag itself, and an entry exists only for a zone the current
 * poll's enabled projection names, so a zone that vanishes and reappears starts fresh rather than resurrecting stale flags.
 *
 * The views handed back are the LIVE stored entries, never defensive copies. The poll walk holds one for the rest of its pass and has to observe the writes
 * that same pass makes through the ledger; a copy would hand it pre-write reads and quietly break the start, stop, and rain-sensor comparisons that follow.
 */
class HydrawiseZoneHintLedger {

  private readonly hints = new Map<number, HydrawiseZoneHints>();

  /* Resolve a zone's entry, seeding one on first sighting from the live rain-sensor reading alongside the falsy manual and running defaults. Seeding from the
   * live reading rather than a static default is what keeps a zone first sighted during a rain delay from reporting a transition it never made. An existing
   * entry comes back untouched, so its manual and running flags survive a valve rediscovery.
   */
  public ensure(relayId: number, isStopped: boolean): Readonly<HydrawiseZoneHints> {

    let hint = this.hints.get(relayId);

    if(!hint) {

      hint = { isManual: false, isOn: false, isStopped };
      this.hints.set(relayId, hint);
    }

    return hint;
  }

  // Mark a zone as manually activated. A zone with no entry is a silent no-op: the walk seeds an entry for every zone it projects, so a missing one means the
  // zone is outside the current poll's enabled projection and has nothing to record.
  public markManual(relayId: number): void {

    const hint = this.hints.get(relayId);

    if(hint) {

      hint.isManual = true;
    }
  }

  // Clear a zone's manual activation, on the same missing-entry terms markManual states.
  public clearManual(relayId: number): void {

    const hint = this.hints.get(relayId);

    if(hint) {

      hint.isManual = false;
    }
  }

  /* Record what the wire says about a zone running, and take the consequence of it in the same step: a zone the wire reports as not running cannot still be
   * manually activated, so the observation clears the manual flag rather than leaving a separate call site to remember to.
   */
  public observeRunning(relayId: number, isOn: boolean): void {

    const hint = this.hints.get(relayId);

    if(!hint) {

      return;
    }

    hint.isOn = isOn;

    if(!isOn) {

      hint.isManual = false;
    }
  }

  // Store a zone's rain-sensor state - the value the next transition check compares the live reading against.
  public refreshStopped(relayId: number, isStopped: boolean): void {

    const hint = this.hints.get(relayId);

    if(hint) {

      hint.isStopped = isStopped;
    }
  }

  // Drop every entry the current poll's enabled projection does not name. Hosting never enters into it: a hint belongs to a zone, wherever that zone's valve
  // lives.
  public prune(liveRelayIds: Set<number>): void {

    for(const relayId of this.hints.keys()) {

      if(!liveRelayIds.has(relayId)) {

        this.hints.delete(relayId);
      }
    }
  }

  // Read a zone's entry without seeding one, the view being the live stored entry on the same terms ensure states.
  public get(relayId: number): Readonly<HydrawiseZoneHints> | undefined {

    return this.hints.get(relayId);
  }
}

export class HydrawiseController {

  private readonly accessory: HydrawiseControllerAccessory;
  private readonly api: API;
  public readonly controller: HydrawiseControllerConfig;
  private enabledZones: HydrawiseZoneConfig[];
  private readonly hap: HAP;
  private readonly hints: HydrawiseHints;
  public readonly log: HomebridgePluginLogging;
  private readonly platform: HydrawisePlatform;
  private status: StatusScheduleResponse;
  private readonly zoneHints: HydrawiseZoneHintLedger;

  // The constructor initializes key variables and calls configureDevice(). The platform passes the denormalized account roster - every account controller's identity,
  // enabled or not - so this controller can seed it into its own accessory context, giving any one accessory knowledge of all its siblings.
  constructor(platform: HydrawisePlatform, accessory: HydrawiseControllerAccessory, controller: HydrawiseControllerConfig, roster: HydrawiseControllerIdentity[]) {

    this.accessory = accessory;
    this.api = platform.api;
    this.status = { nextpoll: -1, relays: [] as HydrawiseZoneConfig[] } as StatusScheduleResponse;
    this.enabledZones = [];
    this.hap = this.api.hap;
    this.hints = {} as HydrawiseHints;
    this.controller = controller;
    this.platform = platform;
    this.zoneHints = new HydrawiseZoneHintLedger();

    // Prefix every log line with this controller's live name. The platform's log.debug is already rebound to the platform's debug gate, so debug routing stays intact.
    this.log = prefixedLog(platform.log, (): string => this.name);

    this.configureDevice(roster);
  }

  // Configure an irrigation system accessory for HomeKit.
  private configureDevice(roster: HydrawiseControllerIdentity[]): void {

    // Capture the prior persisted zone roster and schedule projection before we wipe the context. We restore both below so a restart does not blank the zone list or
    // the schedule panel during the window between this configure pass and the first completed poll, when the runtime has not yet rebuilt either from a fresh status
    // body.
    const priorSchedule = this.accessory.context.schedule;
    const priorZones = this.accessory.context.zones;

    // Clean out the context object, then reseed the identity rosters this controller owns. The controller is the single writer of accessory context: it seeds its own
    // identity (the self-identity the webUI's zone lookup keys on) and the denormalized account roster here, and rewrites the zone roster on change from each poll. We
    // restore the prior zone roster when it is a well-formed array and degrade a malformed prior value to empty, so a corrupt cache entry never crashes the reader.
    this.accessory.context = {};
    this.accessory.context.controller = controllerIdentity(this.controller);
    this.accessory.context.controllers = roster;
    this.accessory.context.zones = this.isZoneRoster(priorZones) ? priorZones : [];

    /* Restore the prior schedule projection on the same terms as the roster above: a well-formed prior value carries over, and a malformed one degrades to absent so
     * the panel renders identity alone rather than a corrupt entry. A restored projection keeps the asOf it was written with, which is deliberately conservative -
     * if the first poll's facts still match it, those facts held then and hold now, and the only surface that reads asOf is the display's staleness notice.
     */
    if(isScheduleStatus(priorSchedule)) {

      this.accessory.context.schedule = priorSchedule;
    }

    // Configure ourselves.
    this.configureHints();
    this.configureInfo();
    this.configureIrrigationSystem();
    this.configureSuspendSwitches();
    this.configureMqtt();

    /* Kick off our state updates under supervision so a genuine fault in the polling loop surfaces once through the reporter, while a shutdown abort unwinds the
     * loop silently. The wire half and the HomeKit half sit inside this ONE envelope because they are one fault domain: a throw from either ends the same loop and
     * owes the operator the same single report, so the generator needs no supervision of its own - its throws land here.
     */
    void superviseLoop({ loop: async (signal): Promise<void> => {

      for await (const update of this.pollStatus(signal)) {

        this.applyStatus(update);
      }
    }, onError: loopFaultReporter(this.log, "zone status"), signal: this.platform.signal });
  }

  // Configure controller-specific settings.
  private configureHints(): boolean {

    this.hints.suspendAll = this.hasFeature("Device.Suspend");

    // Surface a name-synchronization opt-out at startup. Synchronization is read live on each poll rather than cached in a hint, since a zone can opt out
    // independently of its controller; this line reports the controller-scope answer, which is the one that governs when no zone says otherwise.
    this.platform.featureOptions.logFeature("Device.SyncName", "Zone name synchronization", this.log, undefined, this.controller.serial_number);

    return true;
  }

  /* Configure the accessory information for one of the accessories this controller projects onto. The parameter pairs an accessory with the serial number that
   * belongs to it as a single correlated value, so an accessory can never be stamped with another accessory's serial, and it defaults to the controller's own
   * accessory and its wire serial. A standalone zone accessory has no wire serial of its own, so its caller synthesizes one.
   */
  private configureInfo({ accessory, serialNumber }: { accessory: HydrawiseAccessory; serialNumber: string } = { accessory: this.accessory,
    serialNumber: this.controller.serial_number }): boolean {

    const informationService = accessory.getService(this.hap.Service.AccessoryInformation);

    // Update the manufacturer information.
    informationService?.updateCharacteristic(this.hap.Characteristic.Manufacturer, "Hunter");

    // Update the model information.
    informationService?.updateCharacteristic(this.hap.Characteristic.Model, "Hydrawise");

    // Update the serial number.
    informationService?.updateCharacteristic(this.hap.Characteristic.SerialNumber, serialNumber);

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

        // Put the switch back where it was after a brief beat. The write is scheduled through the platform's registry, which ties it to the plugin's lifetime: a
        // revert still pending when Homebridge shuts down drains with the registry, and one scheduled after shutdown never fires.
        this.platform.timers.schedule(() => service.updateCharacteristic(this.hap.Characteristic.On, !value), HYDRAWISE_REVERT_DELAY);

        return;
      }

      this.log.info("%s scheduled watering for all zones.", value ? "Suspending" : "Resuming");
    });

    service.updateCharacteristic(this.hap.Characteristic.On, this.isAllSuspended);

    this.platform.featureOptions.logFeature("Device.Suspend", "Suspend all zones switch", this.log, undefined, this.controller.serial_number);

    return true;
  }

  // Poll the Hydrawise API forever, yielding one update per completed poll. This is the wire half of the loop: it owns the fetch, the retry policy that rides
  // out a failed poll, and the pacing the API asks for, and it touches no HomeKit service. A shutdown abort unwinds it through the signal, which superviseLoop
  // treats as the expected exit; a throw that outlives the retry policy propagates out of the generator into the same envelope, ending the loop as a terminal
  // fault.
  private async *pollStatus(signal: AbortSignal): AsyncGenerator<HydrawisePollUpdate, void, undefined> {

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

      // Hand the completed poll to whoever is consuming this generator. isFirstRun rides along because it was read from the pre-fetch sentinel above and can no
      // longer be derived from the status now in hand.
      yield { isFirstRun, status: this.status };

      // Sleep until our next polling interval due to the Hydrawise API being rate-limited. A shutdown abort interrupts the wait and unwinds the loop.
      // eslint-disable-next-line no-await-in-loop
      await setTimeoutAsync((this.status.nextpoll + HYDRAWISE_API_JITTER) * 1000, undefined, { signal });
    }
  }

  // Project one completed poll onto HomeKit. This is the HomeKit half of the loop and the only half that touches a service: the persisted zone roster, the
  // enabled-zone projection and the prunes it drives, the per-zone valve state, the irrigation-system aggregates, the MQTT publish, and the suspend-all switch.
  // It is synchronous by design - the MQTT publish is dispatched fire-and-forget through guardedDispatch - so one poll's projection lands in a single frame with
  // nothing awaited partway through it.
  private applyStatus(update: HydrawisePollUpdate): void {

    const { isFirstRun, status } = update;

    /* Persist the identity roster and the schedule projection, each on change, through one flush: whichever moved this poll rides a single updatePlatformAccessories
     * call, so a poll costs at most one cache write no matter how many projections it advanced. Both run before the enablement projection below, so what is persisted
     * covers every reported zone, feature-disabled or not - the complete listing and schedule the webUI reads back from cache with no cloud call.
     */
    const rosterChanged = this.persistZoneRoster();
    const scheduleChanged = this.persistScheduleStatus();

    if(rosterChanged || scheduleChanged) {

      this.api.updatePlatformAccessories([this.accessory]);
    }

    // Project the reported zones onto the set the user has enabled. Every HomeKit surface in this pass - valves, aggregates, logging - works from this
    // projection, and long-lived handlers read it through the instance field so they always act on the current poll's truth.
    this.enabledZones = status.relays.filter(zone => this.hasZoneFeature("Device", zone.relay_id.toString()));

    // Resolve each enabled zone's effective name once, ahead of everything that reads it: the user's Name option when set, otherwise the name Hydrawise reports.
    // The standalone request below and the per-zone walk answer to the same name, so it is derived in a single pre-pass rather than twice.
    const effectiveNames = new Map(this.enabledZones.map(zone => [ zone.relay_id, this.zoneNameOverride("Device.Name", zone.relay_id.toString()) ?? zone.name ]));

    // The enabled zones the user has asked to expose as HomeKit accessories of their own.
    const standaloneZones = this.enabledZones.filter(zone => this.hasZoneFeature("Device.Standalone", zone.relay_id.toString()));

    /* Hand the platform this poll's standalone request and take back the hosting map, which every hosting decision below reads so the prune and the walk cannot
     * disagree. The present-relay set carries EVERY zone the report named, before the enablement filter above, because that pre-filter population is what lets
     * the platform tell a configuration change from a zone that fell off the wire. The wire name rides the identity while the effective name rides the display
     * name: the accessory's label and its persisted identity are different jobs.
     */
    const zoneAccessories = this.platform.reconcileZoneAccessories({ controller: this.controller,
      presentRelayIds: new Set(status.relays.map(zone => zone.relay_id)),
      zones: standaloneZones.map(zone => ({ displayName: effectiveNames.get(zone.relay_id) ?? zone.name, identity: zoneIdentity(zone) })) });

    // Project one live-id set from the enabled zones - reported by the API and enabled by feature option - and drive the hint prune from it, so a zone that
    // vanishes and later reappears starts fresh instead of resurrecting its old manual and rain-stopped flags.
    this.zoneHints.prune(new Set(this.enabledZones.map(zone => zone.relay_id)));

    /* Remove the controller accessory's valves for zones that no longer exist, that the user has disabled, or that live on a standalone accessory of their own.
     * The keep-set is derived from the hosting map rather than from the enablement projection, so pruning and hosting read one source of truth: a promoted zone's
     * controller-side valve is pruned by exactly this line, while a zone whose promotion failed keeps its valve here - which is where the walk below will host
     * it. The map's number keys are bridged to the string subtypes each valve service carries.
     */
    const hostedZoneIds = new Set(this.enabledZones.filter(zone => !zoneAccessories.has(zone.relay_id)).map(zone => zone.relay_id.toString()));

    this.accessory.services.filter(x => (x.UUID === this.hap.Service.Valve.UUID) && !hostedZoneIds.has(x.subtype ?? ""))
      .map(x => this.accessory.removeService(x));

    let irrigationRemaining = 0;

    // Find the irrigation system service.
    const irrigationSystemService = this.accessory.getService(this.hap.Service.IrrigationSystem);

    // Discover any new zones and update our zone state.
    for(const zone of this.enabledZones) {

      // The name this zone's valve carries, read from the pre-pass above. The fallback is the same wire name that pre-pass would itself have stored, which keeps
      // the read total.
      const effectiveName = effectiveNames.get(zone.relay_id) ?? zone.name;

      // Where this zone's valve lives: the standalone accessory the reconcile established for it, or the controller accessory. One derived answer, read by every
      // decision below that depends on which it is.
      const host = zoneAccessories.get(zone.relay_id) ?? this.accessory;
      const isStandaloneHost = host !== this.accessory;

      // Whether this zone's names track the configured truth. Resolved once per zone, because the valve service and the standalone accessory answer to the same
      // gate at the same cadence.
      const syncName = this.hasZoneFeature("Device.SyncName", zone.relay_id.toString());

      // Acquire the valve service.
      let isNewValve = false;
      const valveService = acquireService(host, this.hap.Service.Valve, effectiveName, zone.relay_id.toString(), (newService: Service) => {

        // Enumerate the valve service to align with the irrigation controller's zone numbering. A standalone accessory hosts no ServiceLabel service for the
        // index to enumerate against, so the characteristic has no referent there and is left unwritten.
        if(!isStandaloneHost) {

          newService.updateCharacteristic(this.hap.Characteristic.ServiceLabelIndex, zone.relay);
        }

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
      if(!isNewValve && syncName && (getServiceName(valveService) !== sanitizeName(effectiveName))) {

        setServiceName(valveService, effectiveName);
      }

      // A standalone zone accessory carries its own information service, established the first time this process binds the zone's valve on it - the controller's
      // first poll, or a valve this pass created. The zone carries no wire serial, so we synthesize one from the controller's serial and the relay id: stable,
      // unique, and purely presentational.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if(isStandaloneHost && (isFirstRun || isNewValve)) {

        this.configureInfo({ accessory: host, serialNumber: this.controller.serial_number + "-" + zone.relay_id.toString() });
      }

      /* Keep the standalone accessory's own top-level name tracking the effective name, on every poll and under the same gate the valve service answers to, so a
       * Hydrawise rename or a changed Name option lands on the accessory exactly when it lands on the valve. This sits outside the establishment gate above
       * deliberately: a rename arriving on a later poll must still land. The flush is what persists the new name to Homebridge's cache, and it only runs when the
       * name actually moved.
       */
      if(isStandaloneHost && syncName && (host.displayName !== sanitizeName(effectiveName))) {

        this.setAccessoryName(host, effectiveName);
        this.api.updatePlatformAccessories([host]);
      }

      // See if the zone has been stopped due to a rain sensor event. We compute this before resolving the hint entry so a first-sighted zone seeds its stored rain
      // state with the live sensor value rather than a static default, which would otherwise fire a spurious rain-sensor transition on the zone's first appearance
      // during a rain delay.
      const isStopped = this.isStoppedBySensor(zone);

      // Resolve this zone's hint entry, seeded on first sighting with the live sensor state. The view is the ledger's own entry, so the reads below see every
      // write the rest of this pass makes to it.
      const hints = this.zoneHints.ensure(zone.relay_id, isStopped);

      // Inform the user.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if(isFirstRun || isNewValve) {

        // Refresh our stopped state unconditionally on a first sighting or valve rediscovery, seeding the stored value with the live sensor reading so the
        // transition check below does not fire on the zone's first appearance.
        this.zoneHints.refreshStopped(zone.relay_id, isStopped);

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

            // Revert our state for this zone. The write is scheduled through the platform's registry, which ties it to the plugin's lifetime: a revert still
            // pending when Homebridge shuts down drains with the registry, and one scheduled after shutdown never fires.
            this.platform.timers.schedule(() => valveService.updateCharacteristic(this.hap.Characteristic.Active,
              setOn ? this.hap.Characteristic.Active.INACTIVE : this.hap.Characteristic.Active.ACTIVE), HYDRAWISE_REVERT_DELAY);

            return;
          }

          // Update our valve state accordingly.
          if(setOn) {

            valveService.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.IN_USE);
            valveService.updateCharacteristic(this.hap.Characteristic.RemainingDuration, duration);
            irrigationSystemService?.updateCharacteristic(this.hap.Characteristic.ProgramMode, this.hap.Characteristic.ProgramMode.PROGRAM_SCHEDULED_MANUAL_MODE);
            irrigationSystemService?.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.IN_USE);

            // Mark this zone as manually activated. The ledger is addressed by relay id at invocation time rather than through an entry captured when this
            // handler was registered, so it always acts on the current entry, and a zone with no entry is the no-op the ledger states.
            this.zoneHints.markManual(zone.relay_id);
          } else {

            valveService.updateCharacteristic(this.hap.Characteristic.RemainingDuration, 0);
            valveService.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE);

            // Clear out the manual activation for this zone, addressed by relay id at invocation time for the same reason the mark above is.
            this.zoneHints.clearManual(zone.relay_id);

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

      // Record what the Hydrawise API says about this zone running. The ledger takes the not-running consequence with it: a zone the wire reports as stopped
      // cannot still be manually activated.
      this.zoneHints.observeRunning(zone.relay_id, zone.time === 1);

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
      this.zoneHints.refreshStopped(zone.relay_id, isStopped);
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
    return this.platform.retrieve(HYDRAWISE_COMMAND_ENDPOINT, params);
  }

  /* Utility to return the status of a zone to a user. The sentence comes from the schedule classifier's own reading of this poll, which is the same reading the
   * persisted projection and the webUI display are built from, so a zone's log line and its displayed status can never tell different stories. Each arm then
   * composes its sentence from the wire fields the classifier already weighed.
   *
   * Every state the union declares is named here with no default arm, so a state added to the union surfaces as a compile error - a return path the analysis can
   * see falling off the end - rather than as a zone silently rendering someone else's sentence.
   */
  private zoneStatus(zone: HydrawiseZoneConfig): string {

    switch(zoneScheduleStatus(zone, this.status).state) {

      case "running":

        return "Currently running with " + this.getMinutes(zone.run) + " remaining.";

      case "scheduled":

        return "Next run will be " + (zone.timestr.includes(":") ? "at " + this.formatStartTime(zone.timestr) : "on " + zone.timestr) + " for " +
          this.getMinutes(zone.run) + ".";

      case "sensor-stopped":

        return "Rain sensor is preventing irrigation.";

      case "unscheduled":

        // The wire reports no upcoming run, and that is the whole claim: a zone between schedule computations and a zone the owner suspended read identically, so
        // the sentence states the absence rather than guessing at its cause.
        return "No runs are currently scheduled.";
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
      // and crash applyStatus outside every try/catch, tripping superviseLoop's terminal fault and stopping this controller's polling until a restart.
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

  // Guard that a parsed status body carries the shape applyStatus relies on: relays and sensors arrays and a numeric nextpoll. A body that fails this check is
  // treated as a failed poll rather than being adopted as our status.
  private isStatusSchedule(value: unknown): value is StatusScheduleResponse {

    if((typeof value !== "object") || (value === null)) {

      return false;
    }

    const candidate = value as Partial<StatusScheduleResponse>;

    return Array.isArray(candidate.relays) && Array.isArray(candidate.sensors) && (typeof candidate.nextpoll === "number");
  }

  /* Write the reported zone roster to the accessory context when it changed since the last poll, and report whether it wrote. We project every reported zone to the
   * identity-only shape, naming each field explicitly rather than spreading the wire zone, ordered by relay for a stable comparison. The comparison is field-wise
   * because the projection is a fresh array every poll, so a reference check would differ every time and write on every poll. A rare single-poll flap that flips a
   * field and back across two polls costs two writes, which we accept - roster changes are rare and a write is cheap.
   *
   * The return value is the change signal the applyStatus chokepoint reads: this method persists to the context but never flushes, because the chokepoint is the one
   * consumer that turns any projection's change into the poll's single cache write. A future caller that discards the signal forfeits that write, and the fresh-seed
   * cadence pin reds when it does, since the seed's flush would never land.
   */
  private persistZoneRoster(): boolean {

    const zones = this.status.relays.map(zone => zoneIdentity(zone)).sort((a, b) => a.relay - b.relay);

    // After configureDevice's seed the context always carries a zones array, so the nullish fallback is a defensive floor for a context that predates the seed rather
    // than an expected path.
    if(sameEntries(this.accessory.context.zones ?? [], zones, sameZoneIdentity)) {

      return false;
    }

    this.accessory.context.zones = zones;

    return true;
  }

  /* Write the schedule projection to the accessory context when it changed since the last poll, and report whether it wrote - the roster's discipline above applied
   * to the volatile half of what this accessory persists. The projection stores absolute instants, so an unchanged schedule projects byte-identically poll after
   * poll and the comparison takes the no-change return; a projection compared before any has been persisted is a change by definition and seeds the context.
   *
   * Like the roster it never flushes, and the applyStatus chokepoint is the single consumer of the signal it returns.
   */
  private persistScheduleStatus(): boolean {

    const schedule = scheduleStatus(this.status, HYDRAWISE_ACTIVE_ZONE_INDICATOR);
    const previous = this.accessory.context.schedule;

    if(previous && sameScheduleStatus(previous, schedule)) {

      return false;
    }

    this.accessory.context.schedule = schedule;

    return true;
  }

  // Guard that a persisted context value is a well-formed zone roster: an array whose every entry passes the shared zone-identity shape check. A malformed prior
  // value - a non-array, or an entry missing a field - fails this check and degrades to an empty roster, so a corrupt cache entry never crashes the webUI reader.
  private isZoneRoster(value: unknown): value is HydrawiseZoneIdentity[] {

    return Array.isArray(value) && value.every(entry => isZoneIdentity(entry));
  }

  // Utility to test for whether a zone has been stopped due to a rain sensor, delegating to the shared predicate in the types module against this poll's whole
  // status body - the sensor block and the zones those sensors cover alike - so the operator's log and the persisted schedule projection answer from one rule.
  private isStoppedBySensor(zone: HydrawiseZoneConfig): boolean {

    return isZoneStoppedBySensor(zone, this.status);
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

  /* Utility to return whether the account reads as fully suspended, which is what drives the suspend-all switch's state. Every zone carrying the unscheduled
   * sentinel with no sensor stop is the strongest evidence the v1 wire offers for a suspend-all, and it is what the API itself normalizes a suspend-all command to.
   * The wire cannot distinguish that from an account whose every zone merely sits between runs, so the switch can read on without a suspension having been
   * commanded - the standing v1 ambiguity, resolved here in favor of reflecting the commanded state whenever one was issued.
   */
  private get isAllSuspended(): boolean {

    return !this.status.relays.some(zone => zone.run || zone.timestr || (zone.time !== HYDRAWISE_UNSCHEDULED_SENTINEL) || this.isStoppedBySensor(zone));
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

  /* Set the user-visible name of an accessory this controller owns, composed entirely of library surface. Homebridge's own updateDisplayName writes the pair of
   * internally managed display names it maintains, and the HBPU service helper owns which name characteristics a service type takes - AccessoryInformation takes
   * both ConfiguredName and Name - so neither write is hand-rolled here. Both apply HomeKit's sanitization rules, so they agree on the resulting name by
   * construction; the explicit call below serves the display-name write, which takes the sanitized form directly.
   */
  private setAccessoryName(accessory: HydrawiseAccessory, name: string): void {

    accessory.updateDisplayName(sanitizeName(name));

    const informationService = accessory.getService(this.hap.Service.AccessoryInformation);

    if(informationService) {

      setServiceName(informationService, name);
    }
  }
}
