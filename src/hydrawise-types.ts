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

// Hydrawise API: the far-future `time` value Hydrawise reports for a zone whose watering is suspended. The value is fixed by the upstream API, so it is named once
// here and read by everything that classifies a zone's schedule state. A zone carrying this sentinel that a rain-class sensor's relay list also names is stopped by
// that sensor rather than suspended, and the sensor check takes precedence wherever both could apply.
export const HYDRAWISE_SUSPENDED_SENTINEL = 1576800000;

// Hydrawise API: the `type` value Hydrawise assigns a rain or freeze sensor. A status body can carry sensors of several classes, and only one of this class can stop
// a zone's irrigation, so this is the value every sensor walk filters on.
export const HYDRAWISE_RAIN_SENSOR_TYPE = 1;

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

// Project a wire zone onto its persisted identity shape, naming each field explicitly rather than spreading the wire zone so the identity carries identity alone.
// The zone's volatile schedule facts have a persisted home of their own below, under their own type and their own flush discipline; keeping the two derivations
// apart is what lets each carry the cadence it deserves. Like the controller projection above, this is the one home for the derivation.
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

/* The persisted schedule state of a single irrigation zone, as a discriminated union on `state`: each arm carries exactly the facts that exist in that state, so a
 * combination the wire cannot produce - a running zone with a next run time, a suspended zone with a duration - cannot be written at all rather than merely being
 * left unwritten by convention.
 *
 * The running arm deliberately carries no duration. The wire's `run` field counts the remaining seconds down while a zone runs, so persisting it would move the
 * projection on every poll and defeat the change gate the flush discipline rests on. The stable fact is the instant the run ends; the remaining time is derived
 * from it at render.
 */
export type HydrawiseZoneScheduleStatus =
  { endsAt: number; relayId: number; state: "running" } |
  { durationSeconds: number; nextRunAt: number; relayId: number; state: "scheduled" } |
  { relayId: number; state: "sensor-stopped" } |
  { relayId: number; state: "suspended" };

// The schedule-state vocabulary, derived from the union's own arms rather than written out a second time, so the two can never disagree about which states exist.
export type HydrawiseZoneScheduleState = HydrawiseZoneScheduleStatus["state"];

/* The persisted schedule projection of a whole controller: every reported zone's schedule state ordered by relay, alongside the two facts a consumer needs to read
 * them honestly. It is self-describing - activeWindowSeconds travels with the data, so no consumer has to hardcode the threshold the runtime classifies against -
 * and it is wire truth only: asOf is the WIRE's own root time from the poll that last CHANGED these facts, never a local clock read, so a consumer can tell how old
 * the facts are rather than how recently they were re-confirmed.
 */
export interface HydrawiseScheduleStatus {

  activeWindowSeconds: number;
  asOf: number;
  zones: HydrawiseZoneScheduleStatus[];
}

// Whether a zone is stopped by a rain sensor: no run time, no schedule string, the suspend sentinel on `time`, and a rain-class sensor whose relay list names this
// zone. All four conditions together are what tells a sensor stop from a plain suspension, since both carry the sentinel. This is the one home for that rule - the
// controller's own check and the schedule projection below both resolve here, so the log the operator reads and the projection the webUI reads cannot disagree.
export function isZoneStoppedBySensor(zone: HydrawiseZoneConfig, sensors: StatusScheduleResponse["sensors"]): boolean {

  return !zone.run && !zone.timestr && (zone.time === HYDRAWISE_SUSPENDED_SENTINEL) &&
    sensors.filter(sensor => sensor.type === HYDRAWISE_RAIN_SENSOR_TYPE).some(sensor => sensor.relays.some(relay => relay.id === zone.relay_id));
}

/* Project a wire zone onto its persisted schedule state. The precedence is what makes the classification total and unambiguous: a rain-sensor stop is tested first,
 * because it and a suspension carry the same sentinel and only the sensor block tells them apart; then a running zone, whose `time` of 1 is the wire's running
 * marker and whose end instant is the root time plus the seconds of run remaining; then a suspension; and everything else is scheduled, its next run being the root
 * time plus the seconds the wire reports until it.
 *
 * Both time-bearing arms store ABSOLUTE epoch seconds, and that is what makes the projection stable across polls: the wire's countdowns fall as the poll clock
 * rises, so each sum holds still until the schedule genuinely moves. Storing the countdowns themselves would move every field on every poll and turn each poll into
 * a cache write.
 */
export function zoneScheduleStatus(zone: HydrawiseZoneConfig, status: StatusScheduleResponse): HydrawiseZoneScheduleStatus {

  if(isZoneStoppedBySensor(zone, status.sensors)) {

    return { relayId: zone.relay_id, state: "sensor-stopped" };
  }

  if(zone.time === 1) {

    return { endsAt: status.time + zone.run, relayId: zone.relay_id, state: "running" };
  }

  if(zone.time === HYDRAWISE_SUSPENDED_SENTINEL) {

    return { relayId: zone.relay_id, state: "suspended" };
  }

  return { durationSeconds: zone.run, nextRunAt: status.time + zone.time, relayId: zone.relay_id, state: "scheduled" };
}

// Project a whole status body onto the persisted schedule shape, ordering the zones by relay exactly as the identity roster orders its own, so a field-wise
// comparison never reports a difference that the wire's own ordering alone produced. The active window is passed in rather than read here, keeping this module free
// of any dependency inside the repo, and it rides along in the result so every consumer classifies against the same threshold the runtime used.
export function scheduleStatus(status: StatusScheduleResponse, activeWindowSeconds: number): HydrawiseScheduleStatus {

  return { activeWindowSeconds, asOf: status.time, zones: status.relays.toSorted((a, b) => a.relay - b.relay).map(zone => zoneScheduleStatus(zone, status)) };
}

// Validate a persisted zone schedule status read back from the accessory cache, with the identity guards' rigor: the state must be one of the states the union
// declares, and the arm that state names must carry its own numeric fields. Checking the arm fields rather than the state alone is what keeps a truncated cache
// entry - a "running" entry that lost its endsAt - from passing as well-formed and rendering as a blank countdown.
export function isZoneScheduleStatus(value: unknown): value is HydrawiseZoneScheduleStatus {

  if((typeof value !== "object") || (value === null) || (typeof (value as HydrawiseZoneScheduleStatus).relayId !== "number")) {

    return false;
  }

  const candidate = value as { durationSeconds?: unknown; endsAt?: unknown; nextRunAt?: unknown; state?: unknown };

  switch(candidate.state) {

    case "running":

      return typeof candidate.endsAt === "number";

    case "scheduled":

      return (typeof candidate.durationSeconds === "number") && (typeof candidate.nextRunAt === "number");

    case "sensor-stopped":
    case "suspended":

      // These states carry no facts beyond the state itself, so a well-formed relay id and a known state are the whole shape.
      return true;

    default:

      return false;
  }
}

// Validate a persisted controller schedule projection, for the same reason and with the same rigor as the identity guards: a malformed value counts as absent, so a
// corrupt cache entry is classified rather than trusted. Every zone entry is checked, because one bad entry is enough to make a rendered panel lie.
export function isScheduleStatus(value: unknown): value is HydrawiseScheduleStatus {

  return (typeof value === "object") && (value !== null) && (typeof (value as HydrawiseScheduleStatus).activeWindowSeconds === "number") &&
    (typeof (value as HydrawiseScheduleStatus).asOf === "number") && Array.isArray((value as HydrawiseScheduleStatus).zones) &&
    (value as HydrawiseScheduleStatus).zones.every(entry => isZoneScheduleStatus(entry));
}

// Compare two arrays entry by entry, delegating each pair to a caller-supplied field-wise comparison. Both persisted projections are relay-ordered arrays compared
// on change, so the walk itself lives once here and each caller supplies only what it means for two entries to match. The paired entry is tested against undefined
// rather than for truthiness, so the walk stays correct for an element type whose legitimate values include falsy ones.
export function sameEntries<T>(a: T[], b: T[], same: (x: T, y: T) => boolean): boolean {

  if(a.length !== b.length) {

    return false;
  }

  // The equal-length check above guarantees a paired entry exists; the guard narrows the strict indexed access so the comparison reads the entry directly, and a
  // defensively-absent entry simply reports the arrays as differing.
  return a.every((entry, index) => {

    const other = b[index];

    if(other === undefined) {

      return false;
    }

    return same(entry, other);
  });
}

// The schedule fields a change comparison reads. Naming the excluded field at the type level is what makes reintroducing it a deliberate edit rather than an
// accident: asOf is the facts' own timestamp and moves whenever the wire's clock does, so including it would report every poll as a change and flush the accessory
// cache on every poll - the exact cost this projection's absolute-time shape exists to avoid.
type ComparedScheduleFields = Omit<HydrawiseScheduleStatus, "asOf">;

// Compare two zone schedule statuses: the state first, since two entries in different states never match, and then the facts that state's arm carries. The switch
// narrows each arm, so each comparison names exactly the fields that exist in it.
export function sameZoneScheduleStatus(a: HydrawiseZoneScheduleStatus, b: HydrawiseZoneScheduleStatus): boolean {

  if(a.relayId !== b.relayId) {

    return false;
  }

  switch(a.state) {

    case "running":

      return (b.state === "running") && (a.endsAt === b.endsAt);

    case "scheduled":

      return (b.state === "scheduled") && (a.durationSeconds === b.durationSeconds) && (a.nextRunAt === b.nextRunAt);

    default:

      // The remaining states carry no facts of their own, so agreeing on the state is the whole comparison.
      return a.state === b.state;
  }
}

// Compare two schedule projections over the compared surface named above: the self-describing window, and the zone entries through the shared walk. Never by
// reference, for the same reason the identity comparisons are field-wise - the projection is rebuilt fresh every poll, so a reference check would report every poll
// as a change.
export function sameScheduleStatus(a: ComparedScheduleFields, b: ComparedScheduleFields): boolean {

  return (a.activeWindowSeconds === b.activeWindowSeconds) && sameEntries(a.zones, b.zones, sameZoneScheduleStatus);
}

/* The typed HomeKit accessory context this plugin persists on every accessory it owns. Homebridge round-trips this object verbatim through its on-disk cache, so it
 * holds only plain, JSON-serializable data the webUI can read back with zero cloud calls.
 *
 * The context carries two distinct persisted kinds side by side, each with its own types, its own guards, and its own flush discipline. Stable identity - the
 * self-identity, the denormalized account roster, the zone roster, and the zone-accessory pair - answers who a thing is, and its types never carry volatile fields.
 * The schedule projection answers what a controller's zones are doing; it is volatile by subject but change-shaped by construction, storing absolute instants that
 * hold still between polls, so it is written on the same compare-then-write terms identity is. Both are read straight off the accessory cache, which is what keeps
 * the webUI's listing and its schedule display free of any cloud call.
 *
 * The accessory KINDS remain mutually exclusive. A controller accessory carries its own identity (the self-identity the webUI's zone lookup keys on), the
 * denormalized account roster (every account controller, enabled or not, so any one accessory knows all its siblings), its own zone roster, and its schedule
 * projection; it never carries the zone-accessory pair. A standalone zone accessory carries exactly that pair - the owning controller's identity and the zone's own
 * - and never any controller-accessory field. That split is what the webUI's controller match rests on: it finds a controller by reading `controller`, so a zone
 * accessory carrying that field would shadow the real controller accessory and blank the zone listing. isZoneAccessoryContext below is the one place the split is
 * asserted.
 *
 * Every field is optional, and the interface is deliberately flat rather than a union of the kinds. This shape round-trips the on-disk cache and is field-written by
 * paths whose flush cadence is pinned (the roster and the schedule are each written alone), which a union would force into whole-object writes. Exclusivity is
 * therefore enforced by the predicate below and re-asserted by every zone-context write, which assigns a complete fresh object rather than a field.
 */
export interface HydrawiseAccessoryContext {

  controller?: HydrawiseControllerIdentity;
  controllers?: HydrawiseControllerIdentity[];
  ownerController?: HydrawiseControllerIdentity;
  schedule?: HydrawiseScheduleStatus;
  zone?: HydrawiseZoneIdentity;
  zones?: HydrawiseZoneIdentity[];
}

/* Whether a persisted accessory context belongs to a standalone zone accessory. Exclusivity is checked in BOTH directions - the zone-accessory pair present and
 * well-formed, and every controller-accessory field absent - so an ambiguous context carrying both shapes at once classifies as NOT a zone accessory and takes the
 * non-zone arm wherever it is read, which is the self-healing direction. This predicate is the single vocabulary every consumer branches on, so the exclusivity rule
 * is asserted in exactly one place instead of being re-derived at each read site.
 *
 * The narrowed type states the absences as well as the presences, so the compiler carries the rule the runtime just checked. A bare read of a controller-side field
 * off a narrowed context stays legal and types as undefined; what the compiler rejects is CONSUMING such a read as a value, since the field's type has intersected
 * away to undefined. That is protection the write-site convention alone could never give, because a convention is only as good as the next writer.
 */
export function isZoneAccessoryContext(context: HydrawiseAccessoryContext):
  context is HydrawiseAccessoryContext & { controller?: undefined; controllers?: undefined; ownerController: HydrawiseControllerIdentity; schedule?: undefined;
    zone: HydrawiseZoneIdentity; zones?: undefined; } {

  return isControllerIdentity(context.ownerController) && isZoneIdentity(context.zone) && (context.controller === undefined) &&
    (context.controllers === undefined) && (context.schedule === undefined) && (context.zones === undefined);
}

// A Hydrawise accessory of either kind: a Homebridge PlatformAccessory whose context is our typed HydrawiseAccessoryContext. This alias is the single name threaded
// through every accessory field, parameter, and creation site, so the context contract lives in exactly one place. Because every context field is optional the alias
// stays assignable both ways with the platform's bare PlatformAccessory (the wide UnknownContext) without a cast at the construction and configure boundaries.
export type HydrawiseAccessory = PlatformAccessory<HydrawiseAccessoryContext>;
