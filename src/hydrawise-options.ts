/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hydrawise-options.ts: Feature option and type definitions for Hydrawise.
 */
import type { FeatureOptionEntry } from "homebridge-plugin-utils";

// Plugin configuration options.
export interface HydrawiseOptions {

  apiKey: string;
  debug?: boolean;
  mqttTopic: string;
  mqttUrl?: string;
  options?: string[];
}

// The scope levels at which a feature option can be configured. A controller-scoped option addresses the whole controller and every zone beneath it; a zone-scoped
// option addresses a single zone's valve. The webUI reads these to decide which options render under the controller pseudo-entry versus a zone, and the runtime
// narrows its lookups against the option-name unions below.
export type HydrawiseOptionScope = "controller" | "zone";

// The plugin-private meta channel carried on every option entry. HBPU treats this as opaque and forwards it verbatim to the documentation renderer; this plugin uses
// it to declare the scope levels an option is valid at. The scopes tuple is non-empty by construction: an empty scopes array would make an option silently
// UI-unreachable at every level, so the type forbids it.
export interface HydrawiseOptionMeta {

  readonly scopes: readonly [ HydrawiseOptionScope, ...HydrawiseOptionScope[] ];
}

// A feature option entry for this plugin's catalog. We close the base type's optional-meta hole so every catalog entry must declare its scopes: an entry that forgets
// meta fails to compile rather than silently vanishing from the zone view. An intersection with the base type does not work here - TypeScript resolves an intersected
// mutable-plus-readonly property as writable - so we Omit the base meta and redeclare it both required and readonly.
export interface HydrawiseFeatureOption extends Omit<FeatureOptionEntry<HydrawiseOptionMeta>, "meta"> {

  readonly meta: HydrawiseOptionMeta;
}

// The controller-scopable option names, mirroring at compile time the entries whose meta.scopes includes "controller". This is the runtime's narrowed lookup key: a
// call to hasFeature must name one of these, so passing a zone-only option to the controller-level lookup is a type error. A catalog this small makes a derived
// mapping overkill, so we keep this compile-time mirror explicit and bind it by convention to the entries' scopes declarations below.
export type HydrawiseControllerOption = "Device" | "Device.Suspend" | "Log.Zone";

// The zone-scopable option names, mirroring at compile time the entries whose meta.scopes includes "zone". A call to hasZoneFeature must name one of these, so passing
// Device.Suspend (controller-only) with a zone id is a type error rather than a latent scope violation.
export type HydrawiseZoneOption = "Device" | "Log.Zone";

// Feature option categories.
export const featureOptionCategories = [

  { description: "Device feature options.", name: "Device" },
  { description: "Logging feature options.", name: "Log" }
];

/* eslint-disable @stylistic/max-len */

// Individual feature options, broken out by category. Each entry declares its valid scopes through the plugin-private meta channel; the webUI gates row visibility on
// these and the runtime narrows its lookups through the option-name unions above.
export const featureOptions: Record<string, HydrawiseFeatureOption[]> = {

  // Device options.
  "Device": [

    { default: true, description: "Make this device available in HomeKit. At the controller scope, this makes the whole controller and all its zones available; at the zone scope, it makes this zone's valve available.", meta: { scopes: [ "controller", "zone" ] }, name: "" },
    { default: false, description: "Enable a switch accessory to control suspending all zones.", meta: { scopes: ["controller"] }, name: "Suspend" }
  ],

  // Logging options.
  "Log": [

    { default: true, description: "Log zone start and stop events in Homebridge.", meta: { scopes: [ "controller", "zone" ] }, name: "Zone" }
  ]
};

/* eslint-enable @stylistic/max-len */

// Human-readable expansion of each scope level, consulted by the documentation hook when rendering an option's scope prose.
const scopeDescriptions: Record<HydrawiseOptionScope, string> = {

  "controller": "the whole controller",
  "zone": "each zone"
};

// Module-scope list formatter for the option scope sentence. It renders "X" and "X and Y" uniformly.
const scopeListFormatter = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/**
 * Documentation hook: returns the scope suffix appended to an option's description cell, naming the levels the option can be configured at, or `undefined` when the
 * option declares no scope. The parameter is typed to the renderer's own generic signature, whose entry keeps `meta` optional; the required-meta guarantee lives at
 * the catalog declaration above, so we guard `option.meta?.scopes` here rather than relying on the entry type.
 *
 * @param option - The option entry whose `meta.scopes` to describe.
 *
 * @returns The full " <BR>*Configurable at ...*" suffix, or `undefined` to omit it.
 */
export const describeOptionScope = (option: FeatureOptionEntry<HydrawiseOptionMeta>): string | undefined => {

  const scopes = option.meta?.scopes;

  if(!scopes) {

    return undefined;
  }

  return " <BR>*Configurable at " + scopeListFormatter.format(scopes.map(scope => scopeDescriptions[scope])) + ".*";
};
