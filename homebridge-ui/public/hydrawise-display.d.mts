/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hydrawise-display.d.mts: Type declarations for the pure Hydrawise schedule-display derivations.
 */

/**
 * One zone's persisted schedule state, as the display tier consumes it. The arms mirror exactly what the runtime writes into the accessory cache: a running zone
 * carries the instant its run ends, a scheduled zone carries the instant its next run starts and how long that run lasts, a suspended zone carries the instant its
 * suspension lifts, and the two fact-free states carry nothing beyond their own word. A zone the projection does not name has no entry at all, which is why every
 * consuming position below accepts `undefined`.
 */
export type HydrawiseZoneScheduleEntry =
  { endsAt: number; relayId: number; state: "running" } |
  { durationSeconds: number; nextRunAt: number; relayId: number; state: "scheduled" } |
  { relayId: number; state: "sensor-stopped" } |
  { relayId: number; state: "suspended"; until: number } |
  { relayId: number; state: "unscheduled" };

/**
 * The display vocabulary: every persisted state, plus the imminent-run split the display alone makes. A scheduled run falling inside the projection's active
 * window reads as starting soon and one beyond it as merely scheduled, so the display carries one more word than the wire does.
 */
export type HydrawiseZoneDisplayState = HydrawiseZoneScheduleEntry["state"] | "starting-soon";

/**
 * The projection's own scalar facts, which a zone row carries beside its single entry: the window the runtime marks a valve active within, and the wire instant
 * the facts were last changed at.
 */
export interface HydrawiseScheduleMeta {

  activeWindowSeconds: number;
  asOf: number;
}

/**
 * Whether Hydrawise could reach the controller when the facts were last refreshed. It is present only on an account-credentialed install, because that is the only
 * place the fact can be learned at all, so every reader treats its absence as "unknown" rather than as "reachable".
 */
export type HydrawiseControllerAvailability = boolean | undefined;

/**
 * A whole controller's persisted schedule projection: those same scalar facts, the controller's availability where it is known, and every reported zone's entry.
 */
export interface HydrawiseScheduleProjection extends HydrawiseScheduleMeta {

  online?: HydrawiseControllerAvailability;
  zones: HydrawiseZoneScheduleEntry[];
}

/**
 * One rendered row, as its label and the value shown beside it.
 */
export type HydrawiseDisplayRow = [ label: string, value: string ];

/**
 * What one derivation renders: the rows to show, and whether the facts behind them are old enough that the display says so.
 */
export interface HydrawiseDisplayRendering {

  rows: HydrawiseDisplayRow[];
  stale: boolean;
}

/**
 * What a controller's fold renders: its one status word, the detail rows beneath it, and whether the facts behind them are old enough that the display says so.
 *
 * The word travels apart from the rows because the two are drawn in different places - the word in the panel's stat strip beside the controller's identity, the
 * rows in the detail below it - and composing that layout is the renderer's job. A controller with no projection, or one naming no zone at all, has no status to
 * report and answers `null`.
 */
export interface HydrawiseControllerRendering {

  detail: HydrawiseDisplayRow[];
  stale: boolean;
  status: string | null;
}

/** The word each schedule state is shown as, shared by every surface that describes a zone. */
export declare const ZONE_STATE_LABELS: Record<HydrawiseZoneDisplayState, string>;

/** How far in seconds a schedule instant may sit in the past before the display calls it out. */
export declare const STALE_GRACE: number;

/**
 * Render a span in whole minutes with its plural marker.
 *
 * @param seconds - The span to render, which floors at zero when it has already elapsed.
 *
 * @returns The rendered span.
 */
export declare const formatMinutes: (seconds: number) => string;

/**
 * Render an absolute instant for a reader in this browser's timezone, as a clock time today, a weekday and clock within the coming week, and a locale date beyond
 * that.
 *
 * @param epochSeconds - The instant to render.
 * @param nowSeconds   - The instant the render answers to, which decides which of the three tiers applies.
 *
 * @returns The rendered instant.
 */
export declare const formatRunTime: (epochSeconds: number, nowSeconds: number) => string;

/**
 * Classify one zone's persisted entry into the display state it reads as.
 *
 * @param entry      - The zone's persisted entry, or `undefined` when the projection does not name it.
 * @param meta       - The projection's scalar facts, or `undefined` when none travel with the entry.
 * @param nowSeconds - The instant the classification answers to.
 *
 * @returns The display state, or `null` for a zone with no state to show.
 */
export declare const zoneScheduleState: (entry: HydrawiseZoneScheduleEntry | undefined, meta: HydrawiseScheduleMeta | undefined, nowSeconds: number) =>
  HydrawiseZoneDisplayState | null;

/**
 * Derive one zone's schedule rows and its staleness verdict.
 *
 * @param entry      - The zone's persisted entry, or `undefined` when the projection does not name it.
 * @param meta       - The projection's scalar facts, or `undefined` when none travel with the entry.
 * @param nowSeconds - The instant every row of the pass answers to.
 *
 * @returns The zone's rendering.
 */
export declare const deriveZoneDisplay: (entry: HydrawiseZoneScheduleEntry | undefined, meta: HydrawiseScheduleMeta | undefined, nowSeconds: number) =>
  HydrawiseDisplayRendering;

/**
 * Fold a controller's whole projection into its status word and its account-level detail rows.
 *
 * @param schedule   - The controller's persisted projection, or `undefined` when it has none.
 * @param zoneNames  - The display name of each zone, keyed by relay id, for the zones that have one.
 * @param nowSeconds - The instant every row of the pass answers to.
 *
 * @returns The controller's rendering.
 */
export declare const deriveControllerDisplay: (schedule: HydrawiseScheduleProjection | undefined, zoneNames: Record<string, string> | undefined,
  nowSeconds: number) => HydrawiseControllerRendering;
