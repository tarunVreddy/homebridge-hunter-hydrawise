/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * matter.ts: Matter transport for Hydrawise irrigation zones.
 */
import type { HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import type { MatterAPI, MatterAccessory } from "homebridge";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.ts";
import type { HydrawiseMatterAccessoryContext } from "./types.ts";
import { isMatterAccessoryContext } from "./types.ts";
import { sanitizeName } from "homebridge-plugin-utils";

/* Matter's own spelling of a valve's two settled positions, from the ValveConfigurationAndControl cluster's ValveState enum. They are named here rather than
 * written as bare zero and one at each of the several places a zone's state is composed, because a cluster attribute holding an unexplained integer is exactly
 * the kind of thing that gets "fixed" into the wrong polarity by a later reader.
 *
 * The enum's third value, Transitioning, is deliberately never published: Hydrawise reports a zone as running or not running with nothing in between, so claiming
 * a transition would be inventing a state the wire cannot support.
 */
const MATTER_VALVE_CLOSED = 0;
const MATTER_VALVE_OPEN = 1;

// The cluster-state and cluster-handler shapes a Matter accessory declares, named here so the two device-type arms below can each be built as one typed value.
// Without the annotation TypeScript infers a union whose absent arm is `undefined`, which the accessory type's own string index signature then rejects.
type MatterAccessoryClusters = NonNullable<MatterAccessory["clusters"]>;
type MatterAccessoryHandlers = NonNullable<MatterAccessory["handlers"]>;

/* The device types a zone endpoint can be built on, named by the keys Homebridge publishes them under. OnOffOutlet is Matter's OnOffPlugInUnit, which every
 * ecosystem in wide use handles; WaterValve is the semantically correct irrigation type that, as of this writing, none of Alexa, Google Home, or Apple Home
 * accepts. The Matter.Valve feature option chooses between them, and its catalog entry carries that explanation for the user.
 */
export type HydrawiseMatterDeviceType = "OnOffOutlet" | "WaterValve";

/* The command surface a Matter endpoint reaches the Hydrawise API through, resolved by the caller at the moment a command arrives rather than captured when the
 * endpoint was built.
 *
 * Late binding is the whole point. Cached endpoints are registered at boot, BEFORE discovery has run and therefore before any controller object exists - that
 * ordering is what keeps the Matter bridge from advertising an empty endpoint list and making every zone look new to a commissioned ecosystem on each restart.
 * A handler that had closed over a controller could not be built at that moment; one that resolves a controller when it fires can, and a command that arrives in
 * the seconds before discovery finishes simply reports that the controller is not ready yet.
 */
export type HydrawiseMatterCommand = (context: HydrawiseMatterAccessoryContext, action: "run" | "stop", duration?: number) => Promise<void>;

/* One zone as the Matter transport needs it for a single publish: its identity, its name, whether it is running right now, and the two durations a valve
 * endpoint reports.
 *
 * This shape is the whole of what this module knows about a Hydrawise zone, and that is deliberate. The controller already owns the reading of a poll - the
 * hint ledger's settled view of what is running, the schedule classifier's view of when a run ends, the effective name a zone is displayed under - so it
 * projects that reading once, here, rather than exporting its internals for a second transport to re-derive them and drift. Nothing in this file imports from
 * controller.ts, which is what keeps the HomeKit half free to change without this half noticing.
 */
export interface HydrawiseMatterZone {

  isOpen: boolean;
  name: string;
  relayId: number;
  remainingSeconds: number;
  runSeconds: number;
}

// The full set of inputs an endpoint is built from, gathered into one object so the boot-time cache rebuild and the discovery-time registration below can each
// call the single builder with everything it needs and no second construction path can quietly diverge from the first.
interface HydrawiseMatterAccessoryOptions {

  command: HydrawiseMatterCommand;
  context: HydrawiseMatterAccessoryContext;
  deviceType: HydrawiseMatterDeviceType;
  displayName: string;
  matter: MatterAPI;
  runSeconds: number;
  state: { isOpen: boolean; remainingSeconds: number };
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

/* The single construction path for every zone endpoint this plugin registers, called both by the boot-time cache rebuild and by discovery.
 *
 * One builder is a correctness requirement, not tidiness. Homebridge persists Matter accessories and restores them as plain JSON, which arrives with its
 * prototypes gone and matter.js's own internal fields attached - an object that is the right shape to read and the wrong object to hand back to the Matter
 * server, because the device type it carries is no longer the live device type and the internals confuse the server's state hashing. So a cache entry is never
 * re-registered as it was found; its identity is read out and a wholly fresh accessory is built here from the same code discovery uses. A cached endpoint and a
 * freshly discovered one are therefore byte-identical in shape, which is what makes a restart invisible to a commissioned ecosystem.
 */
function buildMatterZoneAccessory(options: HydrawiseMatterAccessoryOptions): MatterAccessory<HydrawiseMatterAccessoryContext> {

  const { command, context, deviceType, displayName, matter, runSeconds, state } = options;

  /* The two device types answer the same two user intentions in their own vocabularies, so both handler sets are written here side by side rather than in
   * separate builders. An outlet has no notion of duration at all, which is why turning one on runs the zone for the duration Hydrawise itself would have run
   * it - the zone's own configured run time - and a valve passes through whatever duration the controller asked for, falling back to that same run time when it
   * asks for none.
   *
   * Every handler throws on failure rather than returning quietly. Homebridge turns a throw into a Matter status code, so a command the Hydrawise API refused
   * surfaces to the user as a failed command instead of a silent no-op the ecosystem then displays as success.
   */
  const clusters: MatterAccessoryClusters = (deviceType === "WaterValve") ? {

    valveConfigurationAndControl: {

      currentState: state.isOpen ? MATTER_VALVE_OPEN : MATTER_VALVE_CLOSED,
      defaultOpenDuration: runSeconds,
      openDuration: state.isOpen ? runSeconds : null,
      remainingDuration: state.isOpen ? state.remainingSeconds : null,
      targetState: state.isOpen ? MATTER_VALVE_OPEN : MATTER_VALVE_CLOSED
    }
  } : { onOff: { onOff: state.isOpen } };

  const handlers: MatterAccessoryHandlers = (deviceType === "WaterValve") ? {

    valveConfigurationAndControl: {

      close: async (): Promise<void> => command(context, "stop"),
      open: async (request?: { openDuration?: Nullable<number> }): Promise<void> => command(context, "run", request?.openDuration ?? undefined)
    }
  } : {

    onOff: {

      off: async (): Promise<void> => command(context, "stop"),
      on: async (): Promise<void> => command(context, "run")
    }
  };

  return {

    UUID: matterZoneUuid(matter, context.serialNumber, context.relayId),
    clusters,
    context,
    deviceType: matter.deviceTypes[deviceType],
    displayName: sanitizeName(displayName),
    handlers,
    manufacturer: "Hunter",
    model: "Hydrawise",

    // The endpoint's own serial, distinct from the controller's: an ecosystem expects each bridged device to identify itself uniquely, and a whole controller's
    // worth of zones all reporting the controller's serial is the kind of collision that shows up later as merged or missing devices.
    serialNumber: context.serialNumber + "-" + context.relayId.toString()
  };
}

/**
 * Rebuild one cached Matter accessory into a live, registerable accessory, or decline it.
 *
 * Declining is a real outcome and not an error. A cache entry whose context this plugin can no longer read is not a zone we can safely stand behind - the
 * endpoint would be addressed by a UUID we could not re-derive - and a cache entry whose device type no longer matches what the feature options now ask for is
 * an endpoint that genuinely must be rebuilt from scratch, because its clusters are changing. Both cases are answered the same way: decline here, let discovery
 * register the zone fresh, and let the orphan sweep retire whatever the cache was holding.
 *
 * @param options              - The rebuild inputs.
 * @param options.cached       - The accessory as Homebridge restored it from disk.
 * @param options.command      - The late-bound command surface the rebuilt endpoint routes through.
 * @param options.deviceTypeFor - Resolves the device type currently configured for a controller serial.
 * @param options.matter       - The Matter API.
 *
 * @returns A freshly built accessory carrying the cached identity, or null to decline the entry.
 */
export function rebuildCachedMatterAccessory(options: { cached: MatterAccessory; command: HydrawiseMatterCommand;
  deviceTypeFor: (serialNumber: string) => HydrawiseMatterDeviceType; matter: MatterAPI; }): Nullable<MatterAccessory<HydrawiseMatterAccessoryContext>> {

  const { cached, command, deviceTypeFor, matter } = options;
  const context = cached.context;

  if(!isMatterAccessoryContext(context)) {

    return null;
  }

  const deviceType = deviceTypeFor(context.serialNumber);

  // The cached device type is read as the plain string JSON preserved it as, never as a live device type - the object it came back on has no prototype and none
  // of the behavior the name implies. It is evidence about what shape the endpoint was last registered in, and that is all it is used for.
  if((cached.deviceType as { name?: string } | undefined)?.name !== deviceType) {

    return null;
  }

  /* A rebuilt endpoint is registered CLOSED, carrying no run in progress, whatever the cache remembered.
   *
   * That is the honest reading rather than a lossy one. What the cache holds is the state at the moment the process last stopped, and a zone that was running
   * then has since been running unobserved for however long the restart took - so re-asserting it would be publishing a fact nobody has checked. The first poll
   * lands within seconds and republishes the truth, and closed is the safe direction to be briefly wrong in: it under-reports water running, never over-reports
   * it, and it never leaves an ecosystem showing a zone as open that has long since finished.
   */
  return buildMatterZoneAccessory({ command, context, deviceType, displayName: cached.displayName, matter, runSeconds: 0,
    state: { isOpen: false, remainingSeconds: 0 } });
}

/* One Hydrawise controller's zones as Matter sees them.
 *
 * This class is a TRANSPORT, not a second controller. It holds no polling loop, issues no Hydrawise request of its own, and models no state the HomeKit half
 * does not already model - it is handed a settled reading of each poll and publishes the parts of it Matter can express. That is what lets it sit beside the
 * HomeKit projection without the two ever needing to agree about anything except the shape of the projection they are both handed.
 */
export class HydrawiseMatterController {

  private readonly command: HydrawiseMatterCommand;
  private readonly controllerId: number;
  private readonly deviceType: HydrawiseMatterDeviceType;
  private readonly log: HomebridgePluginLogging;
  private readonly matter: MatterAPI;

  /* Every zone endpoint this transport has registered in THIS session, keyed by relay id.
   *
   * Session scope is what makes it correct. Homebridge's Matter server accepts a state update only for an accessory registered during the current session, so
   * this map answers the one question each publish has to ask first - has this endpoint been registered yet, by us, since the process started - which a cache
   * cannot answer and an assumption gets wrong exactly once per restart.
   */
  private readonly registered = new Map<number, MatterAccessory<HydrawiseMatterAccessoryContext>>();

  /* The last cluster state successfully published for each zone, serialized, so an unchanged zone costs nothing.
   *
   * Without this, a controller with two dozen zones republishes two dozen unchanged endpoints on every poll for the life of the process. Matter treats an
   * attribute write as a change to be reported to every subscribed fabric, so that is not merely wasted work - it is a steady stream of spurious change
   * notifications to every commissioned ecosystem.
   *
   * A failed publish DELETES its entry rather than leaving the previous one, so the next poll retries. Recording the value we tried to write would let one
   * transient failure suppress that zone's updates permanently.
   */
  private readonly published = new Map<number, string>();

  private readonly serialNumber: string;

  constructor(options: { command: HydrawiseMatterCommand; controllerId: number; deviceType: HydrawiseMatterDeviceType; log: HomebridgePluginLogging;
    matter: MatterAPI; serialNumber: string; }) {

    this.command = options.command;
    this.controllerId = options.controllerId;
    this.deviceType = options.deviceType;
    this.log = options.log;
    this.matter = options.matter;
    this.serialNumber = options.serialNumber;
  }

  // The UUID a given zone's endpoint is addressed by. The orphan sweep asks this so the set of UUIDs this controller still claims is derived from the same
  // function that registers them, rather than being spelled a second time somewhere a change could miss.
  public zoneUuid(relayId: number): string {

    return matterZoneUuid(this.matter, this.serialNumber, relayId);
  }

  // Adopt an endpoint the platform registered from cache at boot, so this transport knows it is already live and publishes updates to it instead of registering
  // it a second time. This is the seam between the boot path, which runs before any controller exists, and the poll path, which runs after.
  public adopt(accessory: MatterAccessory<HydrawiseMatterAccessoryContext>): void {

    this.registered.set(accessory.context.relayId, accessory);
  }

  /**
   * Publish one poll's settled reading of every enabled zone, registering any endpoint that does not exist yet.
   *
   * Registration is folded in here rather than done once up front because the zone roster is not known until a poll returns it - discovery reports controllers,
   * not zones - and because zones legitimately come and go as the user enables and disables them. An endpoint is registered on the first poll that names its
   * zone and then only ever updated.
   *
   * @param zones - Every enabled zone, as the controller's own reading of this poll projects it.
   */
  public async publish(zones: HydrawiseMatterZone[]): Promise<void> {

    const pending = zones.filter(zone => !this.registered.has(zone.relayId));

    if(pending.length) {

      await this.register(pending);
    }

    for(const zone of zones) {

      if(!this.registered.has(zone.relayId)) {

        continue;
      }

      const state = (this.deviceType === "WaterValve") ? {

        currentState: zone.isOpen ? MATTER_VALVE_OPEN : MATTER_VALVE_CLOSED,
        defaultOpenDuration: zone.runSeconds,
        openDuration: zone.isOpen ? zone.runSeconds : null,
        remainingDuration: zone.isOpen ? zone.remainingSeconds : null,
        targetState: zone.isOpen ? MATTER_VALVE_OPEN : MATTER_VALVE_CLOSED
      } : { onOff: zone.isOpen };

      const serialized = JSON.stringify(state);

      if(this.published.get(zone.relayId) === serialized) {

        continue;
      }

      try {

        // The awaits in this loop are sequential on purpose. These are writes into one Matter server's state for one bridged device, and issuing a controller's
        // whole zone roster at once buys nothing while making the failure that follows harder to attribute to a zone.
        // eslint-disable-next-line no-await-in-loop
        await ((this.deviceType === "WaterValve") ?
          this.matter.updateAccessoryState(this.zoneUuid(zone.relayId), "valveConfigurationAndControl", state) :
          this.matter.updateAccessoryState(this.zoneUuid(zone.relayId), "onOff", state));

        this.published.set(zone.relayId, serialized);
      } catch(error) {

        this.published.delete(zone.relayId);

        this.log.error("%s: Unable to publish Matter state: %s", zone.name, error);
      }
    }
  }

  /* Register the endpoints for zones this transport has not seen before.
   *
   * Registration, never update. Homebridge's Matter server restores a known UUID's persisted state when it is REGISTERED, and rejects an update for a UUID that
   * was not registered in the current session - so registering is what makes a returning endpoint whole, and reaching for update instead is the mistake that
   * leaves the server's roster empty, saves an empty cache at shutdown, and makes every zone look new on the boot after that.
   */
  private async register(zones: HydrawiseMatterZone[]): Promise<void> {

    const accessories = zones.map(zone => buildMatterZoneAccessory({

      command: this.command,
      context: { controllerId: this.controllerId, relayId: zone.relayId, serialNumber: this.serialNumber },
      deviceType: this.deviceType,
      displayName: zone.name,
      matter: this.matter,
      runSeconds: zone.runSeconds,
      state: { isOpen: zone.isOpen, remainingSeconds: zone.remainingSeconds }
    }));

    try {

      await this.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessories);

      for(const accessory of accessories) {

        this.registered.set(accessory.context.relayId, accessory);
      }

      this.log.info("Exposed %s zone%s over Matter as %s.", accessories.length.toString(), (accessories.length === 1) ? "" : "s",
        (this.deviceType === "WaterValve") ? "water valves" : "outlets");
    } catch(error) {

      // Nothing is recorded as registered on failure, so the next poll simply tries again. A Matter server that is not ready yet is a transient condition, and
      // treating it as one is what keeps a slow start from permanently costing this controller its endpoints.
      this.log.error("Unable to register Matter accessories: %s", error);
    }
  }
}
