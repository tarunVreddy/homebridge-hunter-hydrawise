/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hydrawise-options.ts: Feature option and type definitions for Hydrawise.
 */
import type { FeatureOptionEntry, FeatureOptionScope } from "homebridge-plugin-utils";

// Plugin configuration options.
export interface HydrawiseOptions {

  apiKey: string;
  debug?: boolean;
  mqttTopic: string;
  mqttUrl?: string;
  options?: string[];
}

/* A feature option entry for this plugin's catalog. Scope levels are the framework's own vocabulary: "controller" addresses a whole controller and every zone beneath
 * it, "device" addresses a single zone's valve, and "global" addresses every controller on the account. The framework enforces the declaration at every surface it
 * owns - which views an option renders on, and which levels it resolves at - and the runtime narrows its lookups against the option-name unions below.
 *
 * We close the base type's optional-scopes hole so every catalog entry must declare its levels: an entry that forgets them fails to compile rather than silently
 * becoming valid everywhere. An intersection with the base type does not work here - TypeScript resolves an intersected mutable-plus-readonly property as writable -
 * so we Omit the base declaration and redeclare it both required and readonly. The tuple is non-empty by construction, since an option declaring no level at all would
 * render nowhere and resolve nowhere.
 */
export interface HydrawiseFeatureOption extends Omit<FeatureOptionEntry, "scopes"> {

  readonly scopes: readonly [ FeatureOptionScope, ...FeatureOptionScope[] ];
}

// The controller-scopable option names, mirroring at compile time the entries whose scopes declaration includes "controller". This is the runtime's narrowed lookup
// key: a call to hasFeature must name one of these, so passing a zone-only option to the controller-level lookup is a type error. A catalog this small makes a derived
// mapping overkill, so we keep this compile-time mirror explicit and bind it by convention to the entries' scopes declarations below.
export type HydrawiseControllerOption = "Device" | "Device.Standalone" | "Device.Suspend" | "Device.SyncName" | "Log.Zone";

// The zone-scopable option names, mirroring at compile time the entries whose scopes declaration includes "device" - the level this plugin projects as a zone. A call
// to hasZoneFeature must name one of these, so passing Device.Suspend (controller-only) with a zone id is a type error rather than a latent scope violation.
export type HydrawiseZoneOption = "Device" | "Device.Standalone" | "Device.SyncName" | "Log.Zone";

// The zone-scopable value-centric option names, mirroring at compile time the value-bearing entries the zone level admits. The value accessor narrows against this,
// so asking for a boolean option's value, or for a value option the zone level does not admit, is a type error.
export type HydrawiseZoneValueOption = "Device.Name";

// Feature option categories.
export const featureOptionCategories = [

  { description: "Device feature options.", name: "Device" },
  { description: "Logging feature options.", name: "Log" }
];

/* eslint-disable @stylistic/max-len */

// Individual feature options, broken out by category. Each entry declares the scope levels it may be configured at; the framework gates row visibility and scope
// resolution on those, and the runtime narrows its lookups through the option-name unions above.
export const featureOptions: Record<string, HydrawiseFeatureOption[]> = {

  // Device options.
  "Device": [

    { default: true, description: "Make this device available in HomeKit.", name: "", scopes: [ "controller", "device", "global" ] },
    { default: true, defaultValue: "", description: "Set a custom HomeKit name for this zone's valve. When empty, the zone name reported by Hydrawise is used.", name: "Name", scopes: ["device"] },
    { default: false, description: "Expose a zone as its own standalone HomeKit accessory that can be assigned to any room. Enabling or disabling this option gives the zone a new HomeKit identity, so automations, scenes, and room assignments referencing its previous accessory must be set up again in the Home app.", name: "Standalone", scopes: [ "controller", "device", "global" ] },
    { default: false, description: "Enable a switch accessory to control suspending all zones.", name: "Suspend", scopes: [ "controller", "global" ] },
    { default: true, description: "Synchronize zone names with HomeKit. Synchronization is one-way only, syncing the effective zone name - the Name option when set, otherwise the name reported by Hydrawise - to HomeKit.", name: "SyncName", scopes: [ "controller", "device", "global" ] }
  ],

  // Logging options.
  "Log": [

    { default: true, description: "Log zone start and stop events in Homebridge.", name: "Zone", scopes: [ "controller", "device", "global" ] }
  ]
};

/* eslint-enable @stylistic/max-len */

// Human-readable expansion of each scope level, consulted by the documentation hook when rendering an option's scope prose. The framework's level names are generic
// across plugins, so this is where they become the Hydrawise hierarchy the user actually sees.
const scopeDescriptions: Record<FeatureOptionScope, string> = {

  "controller": "the whole controller",
  "device": "each zone",
  "global": "globally, across every controller"
};

// Module-scope list formatter for the option scope sentence. It renders "X" and "X and Y" uniformly.
const scopeListFormatter = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/**
 * Documentation hook: returns the scope suffix appended to an option's description cell, naming the levels the option can be configured at, or `undefined` when the
 * option declares no scope. The parameter is typed to the renderer's own generic signature, whose entry keeps `scopes` optional; the required-scopes guarantee lives
 * at the catalog declaration above, so we guard `option.scopes` here rather than relying on the entry type.
 *
 * @param option - The option entry whose `scopes` to describe.
 *
 * @returns The full " <BR>*Configurable at ...*" suffix, or `undefined` to omit it.
 */
export const describeOptionScope = (option: FeatureOptionEntry): string | undefined => {

  const scopes = option.scopes;

  if(!scopes) {

    return undefined;
  }

  return " <BR>*Configurable at " + scopeListFormatter.format(scopes.map(scope => scopeDescriptions[scope])) + ".*";
};
