/* Copyright(C) 2020-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hydrawise-types.ts: Interface and type definitions for Hydrawise.
 */
import type { PlatformAccessory } from "homebridge";

// HBHH reserved names.
export const HydrawiseReservedNames = {

  // Manage our switch types.
  SWITCH_SUSPEND_ALL: "All"
} as const;

export type HydrawiseReservedNames = typeof HydrawiseReservedNames[keyof typeof HydrawiseReservedNames];

// Hydrawise API: the endpoints this plugin calls. Naming them as a union rather than a bare string keeps the platform's rate-ceiling classification total: a call
// site can only name an endpoint the platform has already decided which budgets to draw against, so a typo or a newly added endpoint is a compile error rather
// than a call that quietly slips past the stricter command ceiling.
export type HydrawiseEndpoint = "customerdetails.php" | "setzone.php" | "statusschedule.php";

// Hydrawise API: Hydrawise irrigation controller configuration.
export interface HydrawiseControllerConfig {

  controller_id: number;
  last_contact: number;
  name: string;
  serial_number: string;
  status: string;
}

// Hydrawise API: Hydrawise zone configuration.
export interface HydrawiseZoneConfig {

  master_timer?: number;
  master?: number;
  name: string;
  relay: number;
  relay_id: number;
  run: number;
  time: number;
  timestr: string;
}

// Hydrawise API: customer details endpoint response JSON. This endpoint returns all the controllers associated with a given customer's account.
export interface CustomerDetailsResponse {

  controller_id: number;
  current_controller: string;
  customer_id: number;
  controllers: HydrawiseControllerConfig[];
}

// Hydrawise API: status schedule endpoint response JSON. This endpoint returns watering schedules for controllers.
export interface StatusScheduleResponse {

  message: string;
  nextpoll: number;
  relays: HydrawiseZoneConfig[];
  sensors: {

    input: number;
    mode: number;
    relays: {

      id: number;
    }[];

    type: number;
  }[];

  time: number;
}

// Hydrawise API: set zone endpoint request JSON. This endpoint is used to manually change the zone status (e.g. run, stop, and suspend).
export interface SetZoneRequest {

  action?: "stop" | "run" | "suspend" | "stopall" | "runall" | "suspendall";
  api_key?: string;
  controller_id?: number;
  custom?: number;
  period_id?: number;
  relay_id?: number;
}

// Hydrawise API: set zone endpoint response JSON. This endpoint is used to manually change the zone status (e.g. run, stop, and suspend).
export interface SetZoneResponse {

  message: string;
  message_type: "error" | "info";
}

// The persisted identity of a single irrigation controller. This is the denormalized, wire-independent shape the runtime writes into the accessory context and the
// webUI reads back from the accessory cache and the /refreshControllers response, so a stopped plugin's controller list stays answerable without any cloud call. It
// carries only the three identity fields the webUI needs to list, scope, and refresh a controller - never any volatile status.
export interface HydrawiseControllerIdentity {

  controllerId: number;
  name: string;
  serialNumber: string;
}

// The persisted identity of a single irrigation zone, written into the accessory context on change and read back by the webUI's zone list. Like the controller
// identity above it carries only the stable fields a zone listing needs - the relay display index, the relay id the runtime scopes zone options against, and the
// display name - and never the volatile schedule state the wire zone also carries.
export interface HydrawiseZoneIdentity {

  name: string;
  relay: number;
  relayId: number;
}

// The protocol and persistence infix joining a controller id to a relay id to form a standalone zone accessory's unique device id. This value is persistence-critical
// identity: it seeds the cached HomeKit UUID of every standalone zone accessory, so any drift here orphans every cached zone accessory on every install in the field.
// Treat it as immutable.
export const HYDRAWISE_ZONE_ACCESSORY_ID_INFIX = ".Zone.";

// Compose the unique device identifier of a zone's standalone accessory from its owning controller's id and its own relay id. Every consumer that mints or matches a
// zone accessory's UUID derives it here, so the seed has exactly one home. The compound controller-plus-relay seed is also what makes relay-id uniqueness ACROSS
// controllers irrelevant: two controllers reporting the same relay id still compose to different device ids.
export function zoneAccessoryId(controllerId: number, relayId: number): string {

  return controllerId.toString() + HYDRAWISE_ZONE_ACCESSORY_ID_INFIX + relayId.toString();
}

// Project a wire controller onto its persisted identity shape. This is the single derivation every writer of a controller identity - the platform's account roster,
// the controller's own context seed, the zone accessory's owner stamp - goes through, so the persisted shape cannot drift between the sites that write it.
export function controllerIdentity(controller: HydrawiseControllerConfig): HydrawiseControllerIdentity {

  return { controllerId: controller.controller_id, name: controller.name, serialNumber: controller.serial_number };
}

// Project a wire zone onto its persisted identity shape, naming each field explicitly rather than spreading the wire zone so no volatile schedule field leaks into
// persisted context. Like the controller projection above, this is the one home for the derivation.
export function zoneIdentity(zone: HydrawiseZoneConfig): HydrawiseZoneIdentity {

  return { name: zone.name, relay: zone.relay, relayId: zone.relay_id };
}

// Validate a persisted controller identity read back from the accessory cache: an object carrying every identity field with the right type. A malformed value counts
// as absent, so a corrupt cache entry is classified rather than trusted.
export function isControllerIdentity(value: unknown): value is HydrawiseControllerIdentity {

  return (typeof value === "object") && (value !== null) && (typeof (value as HydrawiseControllerIdentity).controllerId === "number") &&
    (typeof (value as HydrawiseControllerIdentity).name === "string") && (typeof (value as HydrawiseControllerIdentity).serialNumber === "string");
}

// Validate a persisted zone identity, with the same rigor and for the same reason as the controller guard above.
export function isZoneIdentity(value: unknown): value is HydrawiseZoneIdentity {

  return (typeof value === "object") && (value !== null) && (typeof (value as HydrawiseZoneIdentity).name === "string") &&
    (typeof (value as HydrawiseZoneIdentity).relay === "number") && (typeof (value as HydrawiseZoneIdentity).relayId === "number");
}

// Compare two controller identities field-wise. Never by reference: every writer builds a fresh projection through controllerIdentity above, so a reference check
// would report every comparison as differing and drive a write the values do not justify.
export function sameControllerIdentity(a: HydrawiseControllerIdentity, b: HydrawiseControllerIdentity): boolean {

  return (a.controllerId === b.controllerId) && (a.name === b.name) && (a.serialNumber === b.serialNumber);
}

// Compare two zone identities field-wise, for the same reason as the controller comparison above.
export function sameZoneIdentity(a: HydrawiseZoneIdentity, b: HydrawiseZoneIdentity): boolean {

  return (a.relayId === b.relayId) && (a.relay === b.relay) && (a.name === b.name);
}

/* The typed HomeKit accessory context this plugin persists on every accessory it owns. Homebridge round-trips this object verbatim through its on-disk cache, so it
 * holds only plain, JSON-serializable identity data the webUI can read back with zero cloud calls.
 *
 * The fields divide by accessory KIND, and the kinds are mutually exclusive. A controller accessory carries its own identity (the self-identity the webUI's zone
 * lookup keys on), the denormalized account roster (every account controller, enabled or not, so any one accessory knows all its siblings), and its own zone roster;
 * it never carries the zone-accessory pair. A standalone zone accessory carries exactly that pair - the owning controller's identity and the zone's own - and never
 * any controller-accessory field. That split is what the webUI's controller match rests on: it finds a controller by reading `controller`, so a zone accessory
 * carrying that field would shadow the real controller accessory and blank the zone listing. isZoneAccessoryContext below is the one place the split is asserted.
 *
 * Every field is optional, and the interface is deliberately flat rather than a union of the kinds. This shape round-trips the on-disk cache and is field-written by
 * paths whose flush cadence is pinned (persistZoneRoster writes the zones field alone), which a union would force into whole-object writes. Exclusivity is therefore
 * enforced by the predicate below and re-asserted by every zone-context write, which assigns a complete fresh object rather than a field.
 */
export interface HydrawiseAccessoryContext {

  controller?: HydrawiseControllerIdentity;
  controllers?: HydrawiseControllerIdentity[];
  ownerController?: HydrawiseControllerIdentity;
  zone?: HydrawiseZoneIdentity;
  zones?: HydrawiseZoneIdentity[];
}

// Whether a persisted accessory context belongs to a standalone zone accessory. Exclusivity is checked in BOTH directions - the zone-accessory pair present and
// well-formed, and every controller-accessory field absent - so an ambiguous context carrying both shapes at once classifies as NOT a zone accessory and takes the
// non-zone arm wherever it is read, which is the self-healing direction. This predicate is the single vocabulary every consumer branches on, so the exclusivity rule
// is asserted in exactly one place instead of being re-derived at each read site.
export function isZoneAccessoryContext(context: HydrawiseAccessoryContext):
  context is HydrawiseAccessoryContext & { ownerController: HydrawiseControllerIdentity; zone: HydrawiseZoneIdentity } {

  return isControllerIdentity(context.ownerController) && isZoneIdentity(context.zone) && (context.controller === undefined) &&
    (context.controllers === undefined) && (context.zones === undefined);
}

// A Hydrawise accessory of either kind: a Homebridge PlatformAccessory whose context is our typed HydrawiseAccessoryContext. This alias is the single name threaded
// through every accessory field, parameter, and creation site, so the context contract lives in exactly one place. Because every context field is optional the alias
// stays assignable both ways with the platform's bare PlatformAccessory (the wide UnknownContext) without a cast at the construction and configure boundaries.
export type HydrawiseAccessory = PlatformAccessory<HydrawiseAccessoryContext>;
