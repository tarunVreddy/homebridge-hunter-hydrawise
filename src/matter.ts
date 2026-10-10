/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * matter.ts: Matter transport for Hydrawise irrigation zones.
 */
import type { API, MatterAPI, MatterAccessory } from "homebridge";
import type { FeatureOptions, HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import { HYDRAWISE_ZONE_ACCESSORY_GRACE_POLLS, PLATFORM_NAME, PLUGIN_NAME } from "./settings.ts";
import type { HydrawiseControllerConfig, HydrawiseMatterAccessoryContext, HydrawiseMatterDeviceType } from "./types.ts";
import { isMatterAccessoryContext } from "./types.ts";
import { sanitizeName } from "homebridge-plugin-utils";

/* Matter's own spelling of a valve's two settled positions, from the ValveConfigurationAndControl cluster's ValveState enum. They are named here rather than
 * written as bare zero and one where a zone's state is composed, because a cluster attribute holding an unexplained integer is exactly the kind of thing that
 * gets "fixed" into the wrong polarity by a later reader.
 *
 * The enum's third value, Transitioning, is deliberately never published: Hydrawise reports a zone as running or not running with nothing in between, so claiming
 * a transition would be inventing a state the wire cannot support.
 */
const MATTER_VALVE_CLOSED = 0;
const MATTER_VALVE_OPEN = 1;

// The cluster-handler shape a Matter accessory declares, named here so the two device-type arms below can each be built as one typed value.
type MatterAccessoryHandlers = NonNullable<MatterAccessory["handlers"]>;

// A zone command as a Matter endpoint issues it: run or stop, with a duration in seconds only when the ecosystem supplied one.
type HydrawiseMatterZoneCommand = (action: "run" | "stop", duration?: number) => Promise<void>;

// The two facts about a controller this transport needs: the id its endpoints' contexts are keyed by, and the serial its feature options and UUIDs are keyed by.
export type HydrawiseMatterControllerIdentity = Pick<HydrawiseControllerConfig, "controller_id" | "serial_number">;

/* What a Matter endpoint commands its zone through: the controller that owns it, typed by the one method this file calls so that nothing here imports controller.ts.
 * It is resolved when a command fires rather than captured when the endpoint is built, because cached endpoints are registered at boot, before discovery has
 * created any controller - a command that arrives in that window is refused with a reason instead.
 */
export interface HydrawiseMatterTarget {

  commandZone: (relayId: number, action: "run" | "stop", duration?: number) => Promise<void>;
}

/* One zone as the Matter transport needs it for a single publish: its identity, its name, whether it is running right now, and the two durations a valve
 * endpoint reports.
 *
 * This shape is the whole of what this module knows about a Hydrawise zone, and that is deliberate. The controller already owns the reading of a poll - the
 * hint ledger's settled view of what is running, the schedule classifier's view of when a run ends, the effective name a zone is displayed under - so it
 * projects that reading once, here, rather than exporting its internals for a second transport to re-derive them and drift.
 */
export interface HydrawiseMatterZone {

  isOpen: boolean;
  name: string;
  relayId: number;
  remainingSeconds: number;
  runSeconds: number;
}

// The parts of a zone's reading its cluster state is composed from.
type HydrawiseMatterZoneState = Pick<HydrawiseMatterZone, "isOpen" | "remainingSeconds" | "runSeconds">;

// One endpoint registered in this session.
interface HydrawiseMatterEndpoint {

  // Consecutive polls of the owning controller that have not named this zone. Reset whenever one does.
  absences: number;
  accessory: MatterAccessory<HydrawiseMatterAccessoryContext>;

  // The last cluster state published, serialized, so an unchanged zone costs nothing. Undefined whenever what the server holds is not known to match it.
  published?: string;
}

/**
 * The UUID one zone's Matter endpoint is addressed by, derived from the controller's serial number and the zone's relay id and NOTHING else.
 *
 * What is excluded matters more than what is included. A zone's name, its enablement, its position in the account's zone list, and its device type all change
 * over the life of an install, and any of them in this seed would mean a rename or a toggle silently retiring one endpoint and creating another - which an
 * ecosystem reads as a device disappearing and an unrelated device arriving, taking every automation and room assignment with it. Serial and relay are the two
 * facts about a zone that do not change while it remains the same zone.
 *
 * @param matter       - The Matter API, whose UUID generator is shared with HAP's so derivations stay consistent across both transports.
 * @param serialNumber - The owning controller's serial number.
 * @param relayId      - The zone's relay id.
 *
 * @returns The stable Matter accessory UUID for that zone.
 */
export function matterZoneUuid(matter: MatterAPI, serialNumber: string, relayId: number): string {

  return matter.uuid.generate("hydrawise:matter:" + serialNumber + ":zone:" + relayId.toString());
}

/* The one cluster a zone's endpoint carries, and its attributes for a given reading. Registration and every later publish both compose state here, so the two
 * can never disagree about what a running or idle zone looks like.
 *
 * A valve reports both durations only while it is open: a zone that is not running has no run in progress to describe, so it reports their absence rather than
 * stale values.
 */
function zoneClusterState(deviceType: HydrawiseMatterDeviceType, zone: HydrawiseMatterZoneState): { attributes: Record<string, unknown>;
  cluster: "onOff" | "valveConfigurationAndControl"; } {

  if(deviceType === "OnOffOutlet") {

    return { attributes: { onOff: zone.isOpen }, cluster: "onOff" };
  }

  const valveState = zone.isOpen ? MATTER_VALVE_OPEN : MATTER_VALVE_CLOSED;

  return { attributes: { currentState: valveState, defaultOpenDuration: zone.runSeconds, openDuration: zone.isOpen ? zone.runSeconds : null,
    remainingDuration: zone.isOpen ? zone.remainingSeconds : null, targetState: valveState }, cluster: "valveConfigurationAndControl" };
}

/* The single construction path for every zone endpoint this plugin registers, called both by the boot-time cache rebuild and by a poll that names a new zone.
 *
 * Homebridge persists Matter accessories and restores them as plain JSON, which arrives with its prototypes gone and matter.js's own internal fields attached - an
 * object that is the right shape to read and the wrong object to hand back to the Matter server. So a cache entry is never re-registered as it was found; its
 * identity is read out and a wholly fresh accessory is built here, from the same code a new zone uses.
 *
 * The two device types answer the same two user intentions in their own vocabularies. An outlet has no notion of duration, so turning one on runs the zone for
 * its own configured run time; a valve passes through whatever duration the ecosystem asked for, falling back to that same run time when it asks for none. Every
 * handler throws on failure rather than returning quietly, so a command the Hydrawise API refused surfaces as a failed command rather than a silent success.
 */
function buildMatterZoneAccessory(options: { command: HydrawiseMatterZoneCommand; context: Required<HydrawiseMatterAccessoryContext>; displayName: string;
  matter: MatterAPI; uuid: string; zone: HydrawiseMatterZoneState; }): MatterAccessory<HydrawiseMatterAccessoryContext> {

  const { command, context, displayName, matter, uuid, zone } = options;
  const state = zoneClusterState(context.deviceType, zone);

  const handlers: MatterAccessoryHandlers = (context.deviceType === "WaterValve") ? {

    valveConfigurationAndControl: {

      close: async (): Promise<void> => command("stop"),
      open: async (request?: { openDuration?: Nullable<number> }): Promise<void> => command("run", request?.openDuration ?? undefined)
    }
  } : {

    onOff: {

      off: async (): Promise<void> => command("stop"),
      on: async (): Promise<void> => command("run")
    }
  };

  return {

    UUID: uuid,
    clusters: { [state.cluster]: state.attributes },
    context,
    deviceType: matter.deviceTypes[context.deviceType],
    displayName: sanitizeName(displayName),
    handlers,
    manufacturer: "Hunter",
    model: "Hydrawise",

    // The endpoint's own serial, distinct from the controller's: an ecosystem expects each bridged device to identify itself uniquely, and a whole controller's
    // worth of zones all reporting the controller's serial is the kind of collision that shows up later as merged or missing devices.
    serialNumber: context.serialNumber + "-" + context.relayId.toString()
  };
}

/* Every Hydrawise zone this plugin exposes over Matter, across every controller - the single owner of the Matter endpoint roster.
 *
 * This class is a TRANSPORT, not a second controller. It holds no polling loop, issues no Hydrawise request of its own, and models no state the HomeKit half does
 * not already model: each controller hands it a settled reading of each poll, and it publishes the parts Matter can express. What it does own is the lifecycle,
 * at three moments, and each moment decides everything it is able to:
 *
 *   - At boot, before any network call, it rebuilds the cached endpoints. Everything that can be decided from the cache and the feature options alone is decided
 *     here: an entry whose zone is no longer exposed, whose device type has changed, or whose context cannot be read is unregistered on the spot, and every other
 *     entry is registered again so the bridge comes up with the endpoints a commissioned ecosystem already knows.
 *   - After discovery, it retires the endpoints of any controller that discovery did not configure.
 *   - On each poll, it registers zones it has not seen, publishes state, and retires a zone the poll has stopped naming once that absence is sustained.
 *
 * Everything degrades to doing nothing on a bridge without Matter.
 */
export class HydrawiseMatter {

  private readonly api: API;

  // Every Matter accessory Homebridge restored from its own cache at startup, as found on disk, keyed by UUID. Consumed once, by the boot-time rebuild.
  private readonly cached = new Map<string, MatterAccessory>();

  private readonly controllerFor: (controllerId: number) => Nullable<HydrawiseMatterTarget> | undefined;

  /* Every endpoint registered in THIS session, keyed by UUID.
   *
   * Session scope is what makes it correct. Homebridge's Matter server accepts a state update only for an accessory registered during the current session, so
   * this map, and only this map, answers whether an endpoint can be published to. Nothing enters it except by a registration that succeeded.
   */
  private readonly endpoints = new Map<string, HydrawiseMatterEndpoint>();

  private readonly featureOptions: FeatureOptions;
  private readonly log: HomebridgePluginLogging;

  constructor(options: { api: API; controllerFor: (controllerId: number) => Nullable<HydrawiseMatterTarget> | undefined; featureOptions: FeatureOptions;
    log: HomebridgePluginLogging; }) {

    this.api = options.api;
    this.controllerFor = options.controllerFor;
    this.featureOptions = options.featureOptions;
    this.log = options.log;
  }

  /* The Matter API, when this bridge has one, and null otherwise - the single gate every Matter cadence passes through.
   *
   * Matter is a property of the BRIDGE, not of the plugin: a user enables it on the bridge or child bridge this platform runs in, and Homebridge answers here. Both
   * probes are called through a typeof guard because our engines floor admits Homebridge releases predating the Matter API, and a plugin that hard-crashes on a
   * method a host has not got is worse in every way than one that reads the absence as "no Matter here".
   */
  private get matter(): Nullable<MatterAPI> {

    const isAvailable = (typeof this.api.isMatterAvailable === "function") && this.api.isMatterAvailable();
    const isEnabled = (typeof this.api.isMatterEnabled === "function") && this.api.isMatterEnabled();

    return (isAvailable && isEnabled && this.api.matter) ? this.api.matter : null;
  }

  // Hold one cached Matter accessory until the boot-time rebuild decides what to do with it. Called by the platform's configureMatterAccessory.
  public configureCached(accessory: MatterAccessory): void {

    this.cached.set(accessory.UUID, accessory);
  }

  /**
   * Rebuild the cached endpoints at boot, before discovery makes its first call.
   *
   * The ordering is load-bearing. A Matter bridge advertises the endpoints it holds; if this waited for Hydrawise to answer, every zone would arrive afterwards
   * as an addition, which a commissioned ecosystem reads as a device appearing for the first time. Rebuilding from cache costs no network, so it goes first.
   *
   * Retirements are unregistered BEFORE anything is registered, and before discovery runs at all. A zone whose device type changed keeps its UUID, so its
   * endpoint is registered again in its new shape by the first poll; the old one must already be gone by then.
   */
  public async restore(): Promise<void> {

    const matter = this.matter;

    if(!matter || !this.cached.size) {

      return;
    }

    const restored: MatterAccessory<HydrawiseMatterAccessoryContext>[] = [];
    const retired: MatterAccessory[] = [];

    for(const cached of this.cached.values()) {

      const accessory = this.rebuild(matter, cached);

      if(accessory) {

        restored.push(accessory);
      } else {

        retired.push(cached);
      }
    }

    this.cached.clear();

    await this.unregister(matter, retired, "no longer exposed in this shape");

    if(await this.register(matter, restored)) {

      this.log.info("Restored %s Matter accessor%s from cache.", restored.length.toString(), (restored.length === 1) ? "y" : "ies");
    }
  }

  /**
   * Publish one poll's settled reading of a controller's zones: register zones not yet live, retire zones the poll has stopped naming, and publish state.
   *
   * Registration happens here rather than at discovery because the zone roster is not known until a poll returns it - discovery reports controllers, not zones.
   *
   * Retirement waits for sustained absence, on the same terms HAP's standalone zone accessories do: an endpoint is unregistered only on the
   * HYDRAWISE_ZONE_ACCESSORY_GRACE_POLLS-th consecutive poll that does not name its zone. Unregistering a Matter endpoint means re-adding it in the ecosystem and
   * losing whatever the user configured there, so one odd poll must never cost that. A poll that names no zones at all is not counted as evidence against any of
   * them, for the same reason. Configuration changes never reach this path: they take effect at the next restart, where the boot rebuild retires at once.
   *
   * @param controller - The controller whose zones these are.
   * @param zones      - Every enabled zone, as the controller's own reading of this poll projects it.
   */
  public async publish(controller: HydrawiseMatterControllerIdentity, zones: HydrawiseMatterZone[]): Promise<void> {

    const matter = this.matter;
    const serialNumber = controller.serial_number;

    if(!matter || !this.isExposed(serialNumber)) {

      return;
    }

    const deviceType = this.deviceTypeFor(serialNumber);
    const exposed = new Map(zones.filter(zone => this.isExposed(serialNumber, zone.relayId)).map(zone => [ matterZoneUuid(matter, serialNumber, zone.relayId),
      zone ]));

    if(exposed.size) {

      const gone: MatterAccessory<HydrawiseMatterAccessoryContext>[] = [];

      for(const [ uuid, endpoint ] of this.endpoints) {

        if(endpoint.accessory.context.controllerId !== controller.controller_id) {

          continue;
        }

        if(exposed.has(uuid)) {

          endpoint.absences = 0;

          continue;
        }

        if(++endpoint.absences >= HYDRAWISE_ZONE_ACCESSORY_GRACE_POLLS) {

          gone.push(endpoint.accessory);
        }
      }

      await this.unregister(matter, gone, "no longer reported by Hydrawise");
    }

    const added = [...exposed].filter(([uuid]) => !this.endpoints.has(uuid)).map(([ uuid, zone ]) => this.build(matter, uuid, { controllerId: controller.controller_id,
      deviceType, relayId: zone.relayId, serialNumber }, zone.name, zone));

    if(await this.register(matter, added) && added.length) {

      this.log.info("Exposed %s zone%s over Matter as %s.", added.length.toString(), (added.length === 1) ? "" : "s",
        (deviceType === "WaterValve") ? "water valves" : "outlets");
    }

    for(const [ uuid, zone ] of exposed) {

      const endpoint = this.endpoints.get(uuid);

      if(!endpoint) {

        continue;
      }

      const { attributes, cluster } = zoneClusterState(deviceType, zone);
      const serialized = JSON.stringify(attributes);

      // Matter reports every attribute write to every subscribed fabric, so republishing an unchanged zone on every poll would be a steady stream of spurious change
      // notifications to every commissioned ecosystem.
      if(endpoint.published === serialized) {

        continue;
      }

      try {

        // The awaits in this loop are sequential on purpose: these are writes into one Matter server's state, and issuing them all at once buys nothing while making
        // a failure harder to attribute to a zone.
        // eslint-disable-next-line no-await-in-loop
        await matter.updateAccessoryState(uuid, cluster, attributes);

        endpoint.published = serialized;
      } catch(error) {

        // A failed publish forgets its memo rather than keeping the previous one, so the next poll retries it.
        endpoint.published = undefined;

        this.log.error("%s: Unable to publish Matter state: %s", zone.name, error);
      }
    }
  }

  /* Retire the endpoints of every controller discovery did not configure: one that left the account, or one the Device option now hides. Called once, after
   * discovery has configured every controller it is going to. Endpoints of a controller whose Matter option is off never get this far - the boot rebuild already
   * retired them.
   */
  public async sweep(): Promise<void> {

    const matter = this.matter;

    if(!matter) {

      return;
    }

    await this.unregister(matter, [...this.endpoints.values()].filter(endpoint => !this.controllerFor(endpoint.accessory.context.controllerId)).
      map(endpoint => endpoint.accessory), "its controller is no longer configured");
  }

  // Build one endpoint with its commands bound to this transport, so a command always reaches whichever controller owns the zone when it fires.
  private build(matter: MatterAPI, uuid: string, context: Required<HydrawiseMatterAccessoryContext>, displayName: string,
    zone: HydrawiseMatterZoneState): MatterAccessory<HydrawiseMatterAccessoryContext> {

    return buildMatterZoneAccessory({ command: async (action, duration): Promise<void> => this.command(uuid, context, action, duration), context, displayName,
      matter, uuid, zone });
  }

  /* Carry out a command from a Matter endpoint.
   *
   * Homebridge writes the commanded state into the endpoint itself once a handler returns, so whatever the memo held no longer describes what the server holds. It
   * is forgotten here, whatever the outcome, so the next poll publishes the zone's actual state even when that matches what was last published - which is what
   * corrects an ecosystem showing a zone on that never started, or off when it is still running.
   */
  private async command(uuid: string, context: HydrawiseMatterAccessoryContext, action: "run" | "stop", duration?: number): Promise<void> {

    const controller = this.controllerFor(context.controllerId);

    if(!controller) {

      this.log.warn("Matter command for zone %s arrived before its controller was ready. Please try again in a moment.", context.relayId);

      throw new Error("The Hydrawise controller is not ready yet.");
    }

    try {

      await controller.commandZone(context.relayId, action, duration);
    } finally {

      const endpoint = this.endpoints.get(uuid);

      if(endpoint) {

        endpoint.published = undefined;
      }
    }
  }

  // The device type a controller's zones are configured to be exposed as. Resolved from the serial alone, so the boot rebuild can ask it before any controller exists.
  private deviceTypeFor(serialNumber: string): HydrawiseMatterDeviceType {

    return this.featureOptions.test("Matter.Valve", undefined, serialNumber) ? "WaterValve" : "OnOffOutlet";
  }

  /* Whether the feature options expose a controller over Matter, or one of its zones when a relay id is given. A zone needs its controller's Matter gate, its own
   * Matter option, and its Device option - a zone hidden from HomeKit is never projected, so it is never exposed here either. Resolved from the options alone, so
   * the boot rebuild and the poll ask the same question.
   */
  private isExposed(serialNumber: string, relayId?: number): boolean {

    if(!this.featureOptions.test("Matter", undefined, serialNumber)) {

      return false;
    }

    return (relayId === undefined) ||
      (this.featureOptions.test("Device", relayId.toString(), serialNumber) && this.featureOptions.test("Matter", relayId.toString(), serialNumber));
  }

  /* Rebuild one cached accessory into a live, registerable endpoint, or decline it - in which case the boot rebuild unregisters it.
   *
   * An entry is declined when its context cannot be read or does not derive its own UUID, when the options no longer expose its zone, or when its device type no
   * longer matches the option. A rebuilt endpoint registers CLOSED with no run in progress, whatever the cache remembered: the cache holds the state at the
   * moment the process last stopped, and the first poll lands within seconds and publishes the truth. Closed is the safe direction to be briefly wrong in.
   */
  private rebuild(matter: MatterAPI, cached: MatterAccessory): Nullable<MatterAccessory<HydrawiseMatterAccessoryContext>> {

    const context: unknown = cached.context;

    if(!isMatterAccessoryContext(context) || (cached.UUID !== matterZoneUuid(matter, context.serialNumber, context.relayId)) ||
      !this.isExposed(context.serialNumber, context.relayId)) {

      return null;
    }

    const deviceType = this.deviceTypeFor(context.serialNumber);

    /* Whether the cache holds the device type the options now ask for. A recorded key is compared against our key. An entry written before the key was recorded
     * is compared by matter.js type name instead - both sides as matter.js names, never a name against our key, because Homebridge publishes the plug-in-unit
     * type under the key "OnOffOutlet" while matter.js names it "OnOffPlugInUnit". The cached side is read as the plain string JSON preserved.
     */
    const isSameType = context.deviceType ? (context.deviceType === deviceType) :
      ((cached.deviceType as { name?: string } | undefined)?.name === (matter.deviceTypes[deviceType] as unknown as { name: string }).name);

    if(!isSameType) {

      return null;
    }

    return this.build(matter, cached.UUID, { controllerId: context.controllerId, deviceType, relayId: context.relayId, serialNumber: context.serialNumber },
      cached.displayName, { isOpen: false, remainingSeconds: 0, runSeconds: 0 });
  }

  /* Register endpoints and record them as live. Registration, never update: Homebridge's Matter server restores a known UUID's persisted state when it is
   * registered, and rejects an update for a UUID not registered in the current session.
   *
   * Nothing is recorded on failure, so a zone whose registration failed is registered again by the next poll that names it - a Matter server that is not ready yet
   * is a transient condition, and treating it as one keeps a slow start from permanently costing a controller its endpoints.
   */
  private async register(matter: MatterAPI, accessories: MatterAccessory<HydrawiseMatterAccessoryContext>[]): Promise<boolean> {

    if(!accessories.length) {

      return true;
    }

    try {

      await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessories);
    } catch(error) {

      this.log.error("Unable to register Matter accessories: %s", error);

      return false;
    }

    for(const accessory of accessories) {

      this.endpoints.set(accessory.UUID, { absences: 0, accessory });
    }

    return true;
  }

  // Unregister endpoints and forget them, naming each one and why. On failure nothing is forgotten, so a zone retirement is retried on the next poll.
  private async unregister(matter: MatterAPI, accessories: MatterAccessory[], reason: string): Promise<void> {

    if(!accessories.length) {

      return;
    }

    try {

      await matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessories);
    } catch(error) {

      this.log.error("Unable to remove Matter accessories: %s", error);

      return;
    }

    for(const accessory of accessories) {

      this.endpoints.delete(accessory.UUID);

      this.log.info("%s: Removed from Matter: %s.", accessory.displayName, reason);
    }
  }
}
