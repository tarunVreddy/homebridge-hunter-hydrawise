/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hydrawise-display.mjs: Pure derivations of the Hydrawise schedule display.
 */
"use strict";

/* The pure schedule-display tier: every export derives presentation from the persisted schedule facts and an instant the caller supplies, with no I/O, no DOM,
 * no global reach, and no imports. That is what lets a plain test import this module directly, while ui.mjs renders every schedule surface from these same
 * derivations rather than deriving anything of its own.
 */

/* The word each zone schedule state is shown as, in one place. The sidebar dot's tooltip, the zone panel's Status row, and the controller fold's own status all read
 * from here, so no two of those surfaces can describe the same state with different words.
 *
 * The unscheduled word claims exactly what the wire supports - no upcoming run - because a zone between schedule computations and a zone the owner suspended carry
 * identical bodies, and labeling either one "Suspended" would routinely misreport a healthy zone.
 */
export const ZONE_STATE_LABELS = { running: "Running", scheduled: "Scheduled", "sensor-stopped": "Rain delay", "starting-soon": "Starting soon",
  unscheduled: "Not scheduled" };

/* How far in seconds a schedule instant may sit in the past before the display says so. A live runtime would have transitioned a zone whose next run or whose end
 * instant has passed, so an instant still standing well after it is evidence that nothing is polling. Ten nominal poll intervals is generous enough that a
 * nextpoll excursion or a few minutes of clock skew never false-alarms, and tight enough that a dead runtime surfaces within minutes.
 *
 * This threshold is presentation policy - how patient the display chooses to be - which is why it lives here, while the active-zone window, which is runtime policy
 * the Home app enforces too, travels with the data instead.
 */
export const STALE_GRACE = 600;

// Render a span in whole minutes with its plural marker, matching the runtime's own duration wording so the Homebridge log and this panel describe the same span
// the same way. A span that has already elapsed floors at zero rather than reading as a negative countdown.
export const formatMinutes = (seconds) => {

  const minutes = Math.max(Math.round(seconds / 60), 0);

  return minutes.toString() + " minute" + ((minutes !== 1) ? "s" : "");
};

/* Render an absolute instant for a reader in THIS BROWSER's timezone: the clock time alone when it falls on the same calendar day as the render, and a short
 * weekday ahead of it otherwise, so a run later in the week reads unambiguously without spelling out a full date. The runtime's own log line renders the wire's
 * controller-local start string instead, so the two surfaces can legitimately differ for a user viewing from another timezone - the epoch is the truth and each
 * surface renders it honestly for its own reader.
 */
export const formatRunTime = (epochSeconds, nowSeconds) => {

  const when = new Date(epochSeconds * 1000);
  const clock = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  if(when.toDateString() === new Date(nowSeconds * 1000).toDateString()) {

    return clock;
  }

  return when.toLocaleDateString(undefined, { weekday: "short" }) + " " + clock;
};

/* Classify one zone's persisted schedule entry into the display state it reads as - the one answer the sidebar dot and the zone panel both branch on, so a dot and
 * the panel beside it can never disagree about what a zone is doing. A zone the projection does not name has no state to show, which is what a legacy cache and a
 * zone the runtime has not yet reported both look like, so those answer null.
 *
 * The wire's scheduled state splits in two here: a run inside the window the runtime marks a valve active on reads as imminent, and one beyond it as merely
 * scheduled. That window travels with the projection rather than being hardcoded here, so this and the Home app agree on when a zone counts as imminent.
 */
export const zoneScheduleState = (entry, meta, nowSeconds) => {

  if(!entry) {

    return null;
  }

  switch(entry.state) {

    case "running":

      return "running";

    case "scheduled":

      return ((entry.nextRunAt - nowSeconds) <= (meta?.activeWindowSeconds ?? 0)) ? "starting-soon" : "scheduled";

    case "sensor-stopped":

      return "sensor-stopped";

    default:

      return "unscheduled";
  }
};

/* Derive one zone's schedule rows and its staleness verdict from its persisted entry, at the render pass's shared instant so every row of a pass answers to the
 * same "now". Every presentation decision lives here and nothing derived is ever persisted, which is what keeps a panel from disagreeing with its own inputs: the
 * running countdown, the next-run instant, and the staleness verdict are all computed from stored facts at the moment they are shown, and the status word itself
 * comes from the shared vocabulary rather than being spelled out again here.
 *
 * A zone with no state at all renders no schedule rows.
 */
export const deriveZoneDisplay = (entry, meta, nowSeconds) => {

  const state = zoneScheduleState(entry, meta, nowSeconds);

  if(state === null) {

    return { rows: [], stale: false };
  }

  const status = [ "Status", ZONE_STATE_LABELS[state] ];

  switch(state) {

    case "running":

      // A running zone whose end instant has passed by more than the grace is evidence of a dead runtime: a live one would have reported the zone stopped.
      return { rows: [ status, [ "Time Remaining", formatMinutes(entry.endsAt - nowSeconds) ] ], stale: (nowSeconds - entry.endsAt) > STALE_GRACE };

    case "scheduled":
    case "starting-soon":

      // The two scheduled states describe the same upcoming run and differ only in the word above it, so one arm renders both.
      return { rows: [ status, [ "Next Run", formatRunTime(entry.nextRunAt, nowSeconds) ], [ "Duration", formatMinutes(entry.durationSeconds) ] ],
        stale: (nowSeconds - entry.nextRunAt) > STALE_GRACE };

    default:

      // Rain delay and the unscheduled state carry no facts beyond the word itself, so the status row is the whole display and there is no instant to age against.
      return { rows: [status], stale: false };
  }
};

/* Fold a controller's whole projection into its account-level rows: one word for what the controller is doing, the zones actually watering, and the next zone due.
 * This is a pure read of the same persisted entries the zone panels read, at the same shared instant, so the controller panel and its zones can never tell
 * different stories.
 *
 * A projection that is absent OR names no zone at all renders no schedule rows, deliberately: an account with no zones is not an account with nothing scheduled,
 * and folding an empty set to "Not scheduled" would say exactly that.
 */
export const deriveControllerDisplay = (schedule, zoneNames, nowSeconds) => {

  if(!schedule?.zones.length) {

    return { rows: [], stale: false };
  }

  const running = schedule.zones.filter((zone) => zone.state === "running").toSorted((a, b) => a.relayId - b.relayId);
  const scheduled = schedule.zones.filter((zone) => zone.state === "scheduled");
  const soon = scheduled.filter((zone) => (zone.nextRunAt - nowSeconds) <= schedule.activeWindowSeconds);
  const nextUp = scheduled.reduce((earliest, zone) => (!earliest || (zone.nextRunAt < earliest.nextRunAt)) ? zone : earliest, null);
  const nameOf = (zone) => zoneNames?.[zone.relayId.toString()] ?? zone.relayId.toString();
  const rows = [];

  /* The fold's own status word. Every arm but the first names a zone state and reads its word from the shared vocabulary, so a controller and the zones beneath it
   * always use the same words; "Watering" is the fold's own summary of an account with water flowing, which no single zone state means, so it stays a word of its
   * own.
   */
  if(running.length) {

    rows.push([ "Status", "Watering" ]);
  } else if(soon.length) {

    rows.push([ "Status", ZONE_STATE_LABELS["starting-soon"] ]);
  } else if(scheduled.length) {

    rows.push([ "Status", ZONE_STATE_LABELS.scheduled ]);
  } else if(schedule.zones.some((zone) => zone.state === "sensor-stopped")) {

    rows.push([ "Status", ZONE_STATE_LABELS["sensor-stopped"] ]);
  } else {

    rows.push([ "Status", ZONE_STATE_LABELS.unscheduled ]);
  }

  // Every running zone is named, not just the first: the runtime genuinely runs zones concurrently, so a single-zone row would hide water that is flowing.
  if(running.length) {

    rows.push([ "Now Running", running.map((zone) => nameOf(zone) + " (" + formatMinutes(zone.endsAt - nowSeconds) + ")").join(", ") ]);
  }

  if(nextUp) {

    rows.push([ "Next Zone", nameOf(nextUp) + " at " + formatRunTime(nextUp.nextRunAt, nowSeconds) ]);
  }

  return { rows, stale: schedule.zones.some((zone) => ((zone.state === "running") && ((nowSeconds - zone.endsAt) > STALE_GRACE)) ||
    ((zone.state === "scheduled") && ((nowSeconds - zone.nextRunAt) > STALE_GRACE))) };
};
