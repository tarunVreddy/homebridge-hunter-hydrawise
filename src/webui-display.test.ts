/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui-display.test.ts: The webUI's pure schedule-display derivations, exercised against the very module ui.mjs renders from. Covers the zone classification
 * and the imminent-run window it splits on, the zone and controller row folds with their staleness verdicts and the status precedence, and the two formatters.
 *
 * Two disciplines bind every pin here. Every instant is derived from one fixed anchor rather than a live clock, so a run of this suite means the same thing at
 * any hour. And every expected string a formatter produces is computed through the identical Intl call the formatter itself makes, so a host whose locale or
 * timezone differs moves both sides together rather than reddening a correct implementation.
 */
import type { HydrawiseScheduleMeta, HydrawiseScheduleProjection, HydrawiseZoneScheduleEntry } from "../homebridge-ui/public/hydrawise-display.mjs";
import { STALE_GRACE, ZONE_STATE_LABELS, deriveControllerDisplay, deriveZoneDisplay, formatMinutes, formatRunTime, zoneScheduleState }
  from "../homebridge-ui/public/hydrawise-display.mjs";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

/* The instant every scenario answers to: noon on a fixed calendar day, composed from LOCAL date components. The composition is what carries the day
 * relationships below onto every host - an epoch constant fixes an instant, not a calendar day, and noon UTC is already late evening in a UTC+11 host, where an
 * hour later is tomorrow. Nothing here reads a live clock.
 */
const NOW = Math.floor(new Date(2026, 0, 15, 12, 0, 0, 0).getTime() / 1000);

// An hour past the anchor, which is 13:00 on the anchor's own calendar day. The relationship is derived by hand here rather than recomputed by the test.
const SAME_DAY = NOW + 3600;

// Twenty-six hours past the anchor, which is 14:00 the following calendar day. No daylight-saving shift is large enough to pull it back onto the anchor's day.
const NEXT_DAY = NOW + (26 * 3600);

// The active window a projection declares, half an hour wide so a run inside it and a run beyond it are both easy to place.
const WINDOW = 1800;

// The projection's scalar facts. No derivation under test reads asOf, so it simply carries the anchor.
function meta(activeWindowSeconds: number = WINDOW): HydrawiseScheduleMeta {

  return { activeWindowSeconds, asOf: NOW };
}

function runningEntry(relayId: number, endsAt: number): HydrawiseZoneScheduleEntry {

  return { endsAt, relayId, state: "running" };
}

function scheduledEntry(relayId: number, nextRunAt: number, durationSeconds = 480): HydrawiseZoneScheduleEntry {

  return { durationSeconds, nextRunAt, relayId, state: "scheduled" };
}

function projection(zones: HydrawiseZoneScheduleEntry[], activeWindowSeconds: number = WINDOW): HydrawiseScheduleProjection {

  return { activeWindowSeconds, asOf: NOW, zones };
}

// The status word a projection folds to, which is always the first row of the controller rendering.
function statusOf(zones: HydrawiseZoneScheduleEntry[]): string | undefined {

  return deriveControllerDisplay(projection(zones), {}, NOW).rows[0]?.[1];
}

// The clock form of an instant, computed through the same Intl call formatRunTime makes.
function clockOf(epochSeconds: number): string {

  return new Date(epochSeconds * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// The short weekday of an instant, computed through the same Intl call formatRunTime makes.
function weekdayOf(epochSeconds: number): string {

  return new Date(epochSeconds * 1000).toLocaleDateString(undefined, { weekday: "short" });
}

describe("hydrawise webUI schedule display derivations", () => {

  test("zoneScheduleState answers null for a zone the projection does not name", () => {

    assert.equal(zoneScheduleState(undefined, meta(), NOW), null, "a zone with no entry has no state to show");
  });

  test("zoneScheduleState reads each persisted state as its own display state", () => {

    assert.equal(zoneScheduleState(runningEntry(1, NOW + 600), meta(), NOW), "running", "a running zone reads as running");
    assert.equal(zoneScheduleState(scheduledEntry(1, NOW + WINDOW + 1), meta(), NOW), "scheduled", "a run beyond the window reads as scheduled");
    assert.equal(zoneScheduleState({ relayId: 1, state: "sensor-stopped" }, meta(), NOW), "sensor-stopped", "a rain-stopped zone reads as sensor-stopped");
    assert.equal(zoneScheduleState({ relayId: 1, state: "unscheduled" }, meta(), NOW), "unscheduled", "a zone with no upcoming run reads as unscheduled");
  });

  test("zoneScheduleState splits the scheduled state at the window the projection declares", () => {

    assert.equal(zoneScheduleState(scheduledEntry(1, NOW + WINDOW), meta(), NOW), "starting-soon", "a run exactly at the window is imminent");
    assert.equal(zoneScheduleState(scheduledEntry(1, NOW + WINDOW + 1), meta(), NOW), "scheduled", "a run one second beyond the window is merely scheduled");

    // The same entry against a wider window, which is what proves the threshold is read from the projection rather than fixed in the derivation.
    assert.equal(zoneScheduleState(scheduledEntry(1, NOW + WINDOW + 1), meta(WINDOW * 2), NOW), "starting-soon", "a wider declared window makes the same run imminent");
  });

  test("zoneScheduleState treats a missing projection as a zero-width window", () => {

    assert.equal(zoneScheduleState(scheduledEntry(1, NOW), undefined, NOW), "starting-soon", "a run due this very second is imminent under the zero default");
    assert.equal(zoneScheduleState(scheduledEntry(1, NOW + 1), undefined, NOW), "scheduled", "any run still ahead is merely scheduled under the zero default");
  });

  test("deriveZoneDisplay renders no rows for a zone with no state", () => {

    assert.deepEqual(deriveZoneDisplay(undefined, meta(), NOW), { rows: [], stale: false }, "a zone the projection does not name renders nothing at all");
  });

  test("deriveZoneDisplay renders a running zone as its word and what is left of the run", () => {

    const derived = deriveZoneDisplay(runningEntry(1, NOW + 600), meta(), NOW);

    assert.deepEqual(derived.rows, [ [ "Status", ZONE_STATE_LABELS.running ], [ "Time Remaining", "10 minutes" ] ], "a running zone shows its status and countdown");
    assert.equal(derived.stale, false, "a run whose end instant is still ahead is not stale");
  });

  test("deriveZoneDisplay calls a running zone stale only once its end instant passes the grace", () => {

    assert.equal(deriveZoneDisplay(runningEntry(1, NOW - STALE_GRACE), meta(), NOW).stale, false, "an end instant exactly at the grace is not yet stale");
    assert.equal(deriveZoneDisplay(runningEntry(1, (NOW - STALE_GRACE) - 1), meta(), NOW).stale, true, "an end instant one second past the grace is stale");
  });

  test("deriveZoneDisplay renders a scheduled zone's next run and duration under either scheduled word", () => {

    const derived = deriveZoneDisplay(scheduledEntry(1, SAME_DAY), meta(), NOW);

    assert.deepEqual(derived.rows, [ [ "Status", ZONE_STATE_LABELS.scheduled ], [ "Next Run", clockOf(SAME_DAY) ], [ "Duration", "8 minutes" ] ],
      "a scheduled zone shows its status, its next run, and how long that run lasts");
    assert.equal(derived.stale, false, "a next run still ahead of the render is not stale");

    // The imminent arm renders the same three rows and differs only in the word above them.
    const soon = deriveZoneDisplay(scheduledEntry(1, NOW + WINDOW), meta(), NOW);

    assert.deepEqual(soon.rows, [ [ "Status", ZONE_STATE_LABELS["starting-soon"] ], [ "Next Run", clockOf(NOW + WINDOW) ], [ "Duration", "8 minutes" ] ],
      "an imminent run renders the same rows under the imminent word");
  });

  test("deriveZoneDisplay calls a scheduled zone stale only once its next run passes the grace", () => {

    assert.equal(deriveZoneDisplay(scheduledEntry(1, NOW - STALE_GRACE), meta(), NOW).stale, false, "a next run exactly at the grace is not yet stale");
    assert.equal(deriveZoneDisplay(scheduledEntry(1, (NOW - STALE_GRACE) - 1), meta(), NOW).stale, true, "a next run one second past the grace is stale");
  });

  test("deriveZoneDisplay renders the fact-free states as their status row alone", () => {

    assert.deepEqual(deriveZoneDisplay({ relayId: 1, state: "sensor-stopped" }, meta(), NOW), { rows: [[ "Status", ZONE_STATE_LABELS["sensor-stopped"] ]],
      stale: false }, "a rain-stopped zone carries no instant to age against");
    assert.deepEqual(deriveZoneDisplay({ relayId: 1, state: "unscheduled" }, meta(), NOW), { rows: [[ "Status", ZONE_STATE_LABELS.unscheduled ]], stale: false },
      "an unscheduled zone carries no instant to age against");
  });

  test("deriveControllerDisplay renders no rows without a projection or without zones", () => {

    assert.deepEqual(deriveControllerDisplay(undefined, {}, NOW), { rows: [], stale: false }, "a controller with no projection renders nothing");
    assert.deepEqual(deriveControllerDisplay(projection([]), {}, NOW), { rows: [], stale: false }, "an account naming no zone is not an account with nothing scheduled");
  });

  test("deriveControllerDisplay walks the status precedence from water flowing down to nothing scheduled", () => {

    const running = runningEntry(1, NOW + 600);
    const soon = scheduledEntry(2, NOW + WINDOW);
    const later = scheduledEntry(3, NOW + WINDOW + 1);
    const stopped: HydrawiseZoneScheduleEntry = { relayId: 4, state: "sensor-stopped" };
    const idle: HydrawiseZoneScheduleEntry = { relayId: 5, state: "unscheduled" };

    assert.equal(statusOf([ running, soon, later, stopped, idle ]), "Watering", "water actually flowing outranks every other state");
    assert.equal(statusOf([ soon, later, stopped, idle ]), ZONE_STATE_LABELS["starting-soon"], "an imminent run outranks a later one");
    assert.equal(statusOf([ later, stopped, idle ]), ZONE_STATE_LABELS.scheduled, "a scheduled run outranks a rain stop");
    assert.equal(statusOf([ stopped, idle ]), ZONE_STATE_LABELS["sensor-stopped"], "a rain stop outranks a zone with nothing coming");
    assert.equal(statusOf([idle]), ZONE_STATE_LABELS.unscheduled, "an account with nothing coming reads as not scheduled");
  });

  test("deriveControllerDisplay names every running zone in relay order with its own countdown", () => {

    const zones = [ runningEntry(3, NOW + 300), runningEntry(1, NOW + 600) ];
    const derived = deriveControllerDisplay(projection(zones), { "1": "Front Lawn", "3": "Back Beds" }, NOW);

    assert.deepEqual(derived.rows, [ [ "Status", "Watering" ], [ "Now Running", "Front Lawn (10 minutes), Back Beds (5 minutes)" ] ],
      "both running zones are named in relay order, each with its own countdown");
  });

  test("deriveControllerDisplay names the earliest scheduled zone as the next zone", () => {

    const zones = [ scheduledEntry(1, NEXT_DAY), scheduledEntry(2, SAME_DAY) ];
    const derived = deriveControllerDisplay(projection(zones), { "1": "Front Lawn", "2": "Side Strip" }, NOW);

    assert.deepEqual(derived.rows[1], [ "Next Zone", "Side Strip at " + clockOf(SAME_DAY) ], "the earliest next run wins, whatever order the zones arrive in");
  });

  test("deriveControllerDisplay falls back to the relay id for a zone the names do not carry", () => {

    assert.deepEqual(deriveControllerDisplay(projection([runningEntry(7, NOW + 60)]), {}, NOW).rows[1], [ "Now Running", "7 (1 minute)" ],
      "a zone the names object has no entry for renders as its relay id");
    assert.deepEqual(deriveControllerDisplay(projection([runningEntry(7, NOW + 60)]), undefined, NOW).rows[1], [ "Now Running", "7 (1 minute)" ],
      "a controller carrying no names at all renders the same way");
  });

  test("deriveControllerDisplay calls a controller stale only once a zone's own instant passes the grace", () => {

    assert.equal(deriveControllerDisplay(projection([runningEntry(1, NOW - STALE_GRACE)]), {}, NOW).stale, false,
      "an end instant exactly at the grace is not yet stale");
    assert.equal(deriveControllerDisplay(projection([runningEntry(1, (NOW - STALE_GRACE) - 1)]), {}, NOW).stale, true,
      "a run that should have ended well before now is stale");
    assert.equal(deriveControllerDisplay(projection([scheduledEntry(1, (NOW - STALE_GRACE) - 1)]), {}, NOW).stale, true,
      "a run that should have started well before now is stale");
    assert.equal(deriveControllerDisplay(projection([ runningEntry(1, NOW + 600), scheduledEntry(2, SAME_DAY) ]), {}, NOW).stale, false,
      "instants that are all still ahead leave the controller fresh");
  });

  test("formatMinutes rounds to whole minutes and floors an elapsed span at zero", () => {

    assert.equal(formatMinutes(90), "2 minutes", "ninety seconds rounds up to two minutes");
    assert.equal(formatMinutes(89), "1 minute", "eighty-nine seconds rounds down to one minute");
    assert.equal(formatMinutes(29), "0 minutes", "a span under half a minute rounds down to zero");
    assert.equal(formatMinutes(-300), "0 minutes", "a span that has already elapsed floors at zero rather than counting backwards");
  });

  test("formatMinutes marks the plural everywhere but exactly one minute", () => {

    assert.equal(formatMinutes(60), "1 minute", "exactly one minute is singular");
    assert.equal(formatMinutes(120), "2 minutes", "more than one minute is plural");
    assert.equal(formatMinutes(0), "0 minutes", "zero minutes is plural");
  });

  test("formatRunTime renders a same-day instant as the clock time alone", () => {

    assert.equal(formatRunTime(SAME_DAY, NOW), clockOf(SAME_DAY), "an instant on the render's own calendar day needs no date");
    assert.notEqual(formatRunTime(SAME_DAY, NOW), weekdayOf(SAME_DAY) + " " + clockOf(SAME_DAY), "the same-day form carries no weekday");
  });

  test("formatRunTime prefixes a cross-day instant with its short weekday", () => {

    assert.equal(formatRunTime(NEXT_DAY, NOW), weekdayOf(NEXT_DAY) + " " + clockOf(NEXT_DAY), "an instant on another calendar day names its day");
    assert.notEqual(formatRunTime(NEXT_DAY, NOW), clockOf(NEXT_DAY), "the cross-day form is never the bare clock time");
  });
});
