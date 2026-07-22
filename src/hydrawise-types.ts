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

/* The typed HomeKit accessory context this plugin persists on every controller accessory. Homebridge round-trips this object verbatim through its on-disk cache, so
 * it holds only plain, JSON-serializable identity data the webUI can read back with zero cloud calls: the owning controller's own identity (the self-identity the
 * webUI's zone lookup keys on), the denormalized account roster (every account controller, enabled or not, so any one accessory knows all its siblings), and the
 * owning controller's zone roster. Every field is optional because this is the honest boundary type: an accessory restored from a pre-roster cache carries none of
 * them, and the runtime seeds them on the first configure pass before any reader relies on them.
 */
export interface HydrawiseAccessoryContext {

  controller?: HydrawiseControllerIdentity;
  controllers?: HydrawiseControllerIdentity[];
  zones?: HydrawiseZoneIdentity[];
}

// A Hydrawise controller accessory: a Homebridge PlatformAccessory whose context is our typed HydrawiseAccessoryContext. This alias is the single name threaded
// through every accessory field, parameter, and creation site, so the context contract lives in exactly one place. Because every context field is optional the alias
// stays assignable both ways with the platform's bare PlatformAccessory (the wide UnknownContext) without a cast at the construction and configure boundaries.
export type HydrawiseAccessory = PlatformAccessory<HydrawiseAccessoryContext>;
