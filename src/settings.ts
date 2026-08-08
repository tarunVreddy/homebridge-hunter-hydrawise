/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * settings.ts: Settings and constants for homebridge-hunter-hydrawise.
 */
import type { Categories } from "homebridge";
import type { HydrawiseEndpoint } from "./types.ts";

// Hydrawise API response timeout, in seconds.
export const HYDRAWISE_API_TIMEOUT = 7;

// How often, in seconds, should we retry Hydrawise API calls when they fail.
export const HYDRAWISE_API_RETRY_INTERVAL = 60;

// How much, in seconds, jitter should we inject into the API polling interval. This helps ensure we stay clear of the Hydrawise API rate limits.
export const HYDRAWISE_API_JITTER = 0.2;

// The account-wide Hydrawise API ceiling, as a COUNT OF CALLS rather than a duration: Hydrawise documents at most this many API calls of any kind against an
// account inside the trailing window below.
export const HYDRAWISE_API_BUDGET_CALLS = 30;

// The trailing window, in seconds, the account-wide call ceiling above is measured over.
export const HYDRAWISE_API_BUDGET_WINDOW = 300;

// The zone-command ceiling, as a COUNT OF CALLS rather than a duration: Hydrawise documents at most this many zone commands inside the trailing window below,
// which is far stricter than the account-wide ceiling and applies on top of it.
export const HYDRAWISE_COMMAND_BUDGET_CALLS = 3;

// The trailing window, in seconds, the zone-command ceiling above is measured over.
export const HYDRAWISE_COMMAND_BUDGET_WINDOW = 30;

// The one Hydrawise endpoint that carries a zone command, and therefore the one that draws against the stricter command ceiling as well as the account-wide one.
// The platform's draw branch and the controller's command dispatch both read this constant, so the endpoint identity has a single home.
export const HYDRAWISE_COMMAND_ENDPOINT: HydrawiseEndpoint = "setzone.php";

// Time until the next zone valve runtime, in seconds, that we should use to indicate that a zone should be marked as active.
export const HYDRAWISE_ACTIVE_ZONE_INDICATOR = 3600;

// The suspend-all duration, in seconds. Hydrawise's suspend-all convention pushes the resume boundary one year into the future; a resume sends the current time.
export const HYDRAWISE_SUSPEND_DURATION = 31556926;

/* The HAP accessory category a standalone zone accessory declares - Apple's sprinkler category, so the Home app renders a lone irrigation valve as sprinkler rather
 * than as a generic accessory. The value is the Apple-defined protocol number, carried here as a typed numeric constant rather than read off the `Categories` enum:
 * HAP declares that enum as an AMBIENT const enum, and this repo compiles under `verbatimModuleSyntax`, where any value access to an ambient const enum's members
 * is a compile error. The cast keeps the number type-checked against the constructor parameter it feeds while never touching the enum as a value.
 */
export const HYDRAWISE_ZONE_ACCESSORY_CATEGORY = 28 as Categories;

/* How many consecutive polls a standalone zone accessory survives its zone's absence from the wire report before it is treated as genuinely gone. The rule this
 * encodes: a transient wire flake must never destroy a HomeKit identity the user placed in a room, so only SUSTAINED absence - or explicit configuration, which the
 * reconcile tells apart and acts on at once - may remove one.
 */
export const HYDRAWISE_ZONE_ACCESSORY_GRACE_POLLS = 3;

// Default MQTT topic to use when publishing events. This is in the form of: hydrawise/device/event
export const HYDRAWISE_MQTT_TOPIC = "hydrawise";

// The platform the plugin creates.
export const PLATFORM_NAME = "Hydrawise";

// The name of our plugin.
export const PLUGIN_NAME = "homebridge-hunter-hydrawise";
