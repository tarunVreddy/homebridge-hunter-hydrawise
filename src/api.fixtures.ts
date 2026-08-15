/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * api.fixtures.ts: Synthetic Hydrawise API response data for the unit suite. Data only - the factories that compose these constants into whole
 * responses live in api.helpers.ts.
 *
 * Provenance: the wire shapes mirror captured Hydrawise cloud API v1 responses (customerdetails.php and statusschedule.php) recorded in May 2024 and retained
 * as development reference material. Every identifier here is synthesized - the controller and customer ids, the serial number, the relay ids, and every
 * zone display name are invented values that appear nowhere in those captures - so no real account data reaches the tracked test tree. The numeric field types
 * are wire-accurate: ids and timestamps are numbers, the sentinel far-future timestamp is the literal Hydrawise uses to mark a zone with no upcoming run.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id and controller_id, so camelcase is disabled here to let these literals mirror the wire verbatim.
/* eslint-disable camelcase */
import type { CustomerDetailsResponse, HydrawiseControllerConfig, HydrawiseZoneConfig, StatusScheduleResponse } from "./types.ts";

// The far-future timestamp Hydrawise stamps on a zone's `time` field when it reports no upcoming run. Fixed by the upstream API, so it is a named constant rather
// than a magic literal scattered through the sentinel matrix below.
export const UNSCHEDULED_SENTINEL = 1576800000;

// The synthetic controller identity every fixture shares. Distinct from the captured account's real controller id and serial number.
export const syntheticController: HydrawiseControllerConfig = {

  controller_id: 500001,
  last_contact: 1716811760,
  name: "Test Controller",
  serial_number: "SN0A1B2C3D4",
  status: "Unknown"
};

// The customerdetails.php response body, carrying the single synthetic controller.
export const syntheticCustomerDetails: CustomerDetailsResponse = {

  controller_id: 500001,
  controllers: [syntheticController],
  current_controller: "Test Controller",
  customer_id: 900001
};

/* The steady-state zone matrix, mirroring the captured NORMAL response's zone shape with synthetic relay ids and names. The `time` field is seconds until the
 * next scheduled run (or the running sentinel `1`): relay 1 is running now (time 1), relays 2 and 3 are queued within the active-zone window (time <= 3600, with
 * relay 3 sitting exactly on the 3600 boundary), and relay 4 sits one second past the window (time 3601). Every other zone is scheduled well beyond the window.
 */
export const normalZoneMatrix: readonly HydrawiseZoneConfig[] = [

  { name: "Front Lawn North", relay: 1, relay_id: 700001, run: 600, time: 1, timestr: "" },
  { name: "Front Lawn South", relay: 2, relay_id: 700002, run: 480, time: 1800, timestr: "16:00" },
  { name: "Driveway Border", relay: 3, relay_id: 700003, run: 300, time: 3600, timestr: "16:08" },
  { name: "Walkway Edge", relay: 4, relay_id: 700004, run: 300, time: 3601, timestr: "16:16" },
  { name: "Rear Lawn North", relay: 9, relay_id: 700005, run: 480, time: 67591, timestr: "16:24" },
  { name: "Rear Lawn South", relay: 10, relay_id: 700006, run: 480, time: 68071, timestr: "16:32" },
  { name: "Rear Planter Bed", relay: 11, relay_id: 700007, run: 1740, time: 120151, timestr: "Mon" },
  { name: "Rear Center Bed", relay: 12, relay_id: 700008, run: 600, time: 121891, timestr: "Mon" },
  { name: "Rose Garden", relay: 13, relay_id: 700009, run: 600, time: 114391, timestr: "Mon" },
  { name: "East Path A", relay: 17, relay_id: 700010, run: 480, time: 69511, timestr: "16:40" },
  { name: "East Path B", relay: 18, relay_id: 700011, run: 480, time: 69991, timestr: "16:48" },
  { name: "East Border", relay: 22, relay_id: 700012, run: 2340, time: 115471, timestr: "Mon" },
  { name: "West Border", relay: 23, relay_id: 700013, run: 2340, time: 117811, timestr: "Mon" },
  { name: "East Drip Line", relay: 27, relay_id: 700014, run: 420, time: 70471, timestr: "16:55" },
  { name: "West Drip Line", relay: 28, relay_id: 700015, run: 480, time: 70891, timestr: "17:03" },
  { name: "North Strip", relay: 29, relay_id: 700016, run: 480, time: 71371, timestr: "17:11" },
  { name: "South Strip", relay: 30, relay_id: 700017, run: 420, time: 71851, timestr: "17:19" },
  { name: "South Planter", relay: 31, relay_id: 700018, run: 600, time: 122491, timestr: "Mon" },
  { name: "Vegetable Garden", relay: 34, relay_id: 700019, run: 840, time: 114991, timestr: "Mon" }
];

/* The all-sentinel zone matrix: the same synthetic identities, each stamped with the unscheduled sentinel `time` and an empty run and schedule string. Combined
 * with a sensor block that does or does not reference the relay ids, this shape distinguishes a controller with nothing scheduled - a suspend-all included, since
 * the wire normalizes one to this exact shape (bare sensors) - from a rain-sensor stop (relay-referencing sensors).
 */
export const sentinelZoneMatrix: readonly HydrawiseZoneConfig[] = [

  { name: "Front Lawn North", relay: 1, relay_id: 700001, run: 0, time: UNSCHEDULED_SENTINEL, timestr: "" },
  { name: "Front Lawn South", relay: 2, relay_id: 700002, run: 0, time: UNSCHEDULED_SENTINEL, timestr: "" },
  { name: "Driveway Border", relay: 3, relay_id: 700003, run: 0, time: UNSCHEDULED_SENTINEL, timestr: "" },
  { name: "Walkway Edge", relay: 4, relay_id: 700004, run: 0, time: UNSCHEDULED_SENTINEL, timestr: "" },
  { name: "Rear Lawn North", relay: 9, relay_id: 700005, run: 0, time: UNSCHEDULED_SENTINEL, timestr: "" },
  { name: "Rear Lawn South", relay: 10, relay_id: 700006, run: 0, time: UNSCHEDULED_SENTINEL, timestr: "" },
  { name: "Rear Planter Bed", relay: 11, relay_id: 700007, run: 0, time: UNSCHEDULED_SENTINEL, timestr: "" },
  { name: "Rear Center Bed", relay: 12, relay_id: 700008, run: 0, time: UNSCHEDULED_SENTINEL, timestr: "" },
  { name: "Rose Garden", relay: 13, relay_id: 700009, run: 0, time: UNSCHEDULED_SENTINEL, timestr: "" },
  { name: "East Path A", relay: 17, relay_id: 700010, run: 0, time: UNSCHEDULED_SENTINEL, timestr: "" },
  { name: "East Path B", relay: 18, relay_id: 700011, run: 0, time: UNSCHEDULED_SENTINEL, timestr: "" },
  { name: "East Border", relay: 22, relay_id: 700012, run: 0, time: UNSCHEDULED_SENTINEL, timestr: "" },
  { name: "West Border", relay: 23, relay_id: 700013, run: 0, time: UNSCHEDULED_SENTINEL, timestr: "" },
  { name: "East Drip Line", relay: 27, relay_id: 700014, run: 0, time: UNSCHEDULED_SENTINEL, timestr: "" },
  { name: "West Drip Line", relay: 28, relay_id: 700015, run: 0, time: UNSCHEDULED_SENTINEL, timestr: "" },
  { name: "North Strip", relay: 29, relay_id: 700016, run: 0, time: UNSCHEDULED_SENTINEL, timestr: "" },
  { name: "South Strip", relay: 30, relay_id: 700017, run: 0, time: UNSCHEDULED_SENTINEL, timestr: "" },
  { name: "South Planter", relay: 31, relay_id: 700018, run: 0, time: UNSCHEDULED_SENTINEL, timestr: "" },
  { name: "Vegetable Garden", relay: 34, relay_id: 700019, run: 0, time: UNSCHEDULED_SENTINEL, timestr: "" }
];

// The full set of synthetic relay ids, in matrix order. The rain-sensor block references these so isZoneStoppedBySensor resolves true for the sentinel matrix.
export const allRelayIds: readonly number[] = normalZoneMatrix.map(zone => zone.relay_id);

// A type-1 (rain) sensor whose relay list references every zone. On the sentinel matrix this drives isZoneStoppedBySensor true, the rain-stop state.
export const rainSensors: StatusScheduleResponse["sensors"] = [

  { input: 0, mode: 1, relays: allRelayIds.map(id => ({ id })), type: 1 }
];

// A type-1 sensor whose relay list references no zone. On the sentinel matrix this leaves isZoneStoppedBySensor false, keeping all-unscheduled distinct from a rain stop.
export const bareSensors: StatusScheduleResponse["sensors"] = [

  { input: 0, mode: 1, relays: [], type: 1 }
];
