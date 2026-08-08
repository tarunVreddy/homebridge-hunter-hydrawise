/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * options.ts: Feature option and type definitions for Hydrawise.
 */
import type { FeatureOptionEntry, FeatureOptionScope, Nullable } from "homebridge-plugin-utils";
import { HYDRAWISE_MQTT_TOPIC } from "./settings.ts";
import { mqttFeatureOptions } from "homebridge-plugin-utils";

/* The plugin's effective configuration, assembled once by the platform constructor. Each consolidated setting resolves there - the configured feature option
 * first, the legacy configuration property as its fallback - so this describes what the plugin actually runs on rather than mirroring the shape of config.json.
 *
 * The two MQTT fields carry the feature-option engine's own tri-state answer: a string when a value resolves, null when the option is explicitly disabled, and
 * undefined when an entry exists carrying no value. Both absences mean the same thing to the MQTT client factory, which is that MQTT is off.
 */
export interface HydrawiseOptions {

  apiKey: string;
  debug?: boolean;
  mqttTopic?: Nullable<string>;
  mqttUrl?: Nullable<string>;
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

// The globally-scoped value-centric option names - the account credential and the two MQTT settings the plugin resolves once at startup. The platform's
// consolidated resolver narrows against this, so asking it for an option that carries no global value is a type error. The two Mqtt members name the library
// factory's published entries and are bound to them by convention exactly as the unions above are bound to the catalog entries below; renaming either of those
// entries is a breaking change on the library's side.
export type HydrawiseGlobalValueOption = "Account.ApiKey" | "Mqtt.Topic" | "Mqtt.Url";

// The globally-scoped boolean option names - the settings the plugin resolves once at startup as a simple on or off. The platform's flag resolver narrows against
// this, so asking it for a value-bearing option, or for one no global lookup admits, is a type error. This is the boolean counterpart of the union above, and it is
// bound by convention to the catalog entries below in exactly the same way.
export type HydrawiseGlobalFlagOption = "Log.Debug";

/* The library's canonical MQTT option group, composed once at module scope and read by both the category list and the catalog below, so the two always describe
 * the same group. The factory's default scope is global, which is the only level that fits a plugin holding a single Hydrawise account, and this registration is
 * the runtime's only consumer of the default topic constant, so the prefix a user never overrides is answered by the catalog itself.
 */
const mqtt = mqttFeatureOptions({ defaultTopic: HYDRAWISE_MQTT_TOPIC });

// Feature option categories.
export const featureOptionCategories = [

  { description: "Account feature options.", name: "Account" },
  { description: "Device feature options.", name: "Device" },
  { description: "Logging feature options.", name: "Log" },
  mqtt.category
];

/* eslint-disable @stylistic/max-len */

// Account options. The API key is a value option rather than a schema property so that every setting this plugin has lives in one substrate, and it is global
// because one key addresses the whole Hydrawise account.
const accountOptions: HydrawiseFeatureOption[] = [

  { default: false, defaultValue: "", description: "The API key for your Hydrawise account, generated under Account Details → Account Settings on the Hydrawise website.", inputSize: 19, name: "ApiKey", scopes: ["global"] }
];

// Device options.
const deviceOptions: HydrawiseFeatureOption[] = [

  { default: true, description: "Make this device available in HomeKit.", name: "", scopes: [ "controller", "device", "global" ] },
  { default: false, defaultValue: "", description: "Custom HomeKit name for this zone. When unset, the name reported by Hydrawise is used.", inputSize: 30, name: "Name", scopes: ["device"] },
  { default: false, description: "Expose this zone as its own HomeKit accessory, assignable to any room. Toggling this changes the zone's HomeKit identity, so automations, scenes, and room assignments tied to it must be recreated.", name: "Standalone", scopes: [ "controller", "device", "global" ] },
  { default: false, description: "Enable a switch accessory to control suspending all zones.", name: "Suspend", scopes: [ "controller", "global" ] },
  { default: true, description: "Synchronize zone names one-way (Hydrawise → HomeKit), using the Name option when set, otherwise the name reported by Hydrawise.", name: "SyncName", scopes: [ "controller", "device", "global" ] }
];

// Logging options.
const logOptions: HydrawiseFeatureOption[] = [

  { default: false, description: "Enable debug logging.", name: "Debug", scopes: ["global"] },
  { default: true, description: "Log zone start and stop events in Homebridge.", name: "Zone", scopes: [ "controller", "device", "global" ] }
];

/* eslint-enable @stylistic/max-len */

/* The full option catalog, assembled from the categories this plugin authors and the group the library contributes. Each authored entry declares the scope
 * levels it may be configured at; the framework gates row visibility and scope resolution on those, and the runtime narrows its lookups through the
 * option-name unions above.
 *
 * Two types are at work here on purpose, and neither needs a cast. The authored arrays are typed as our own entry, which is what enforces the scopes
 * declaration at the site where an entry is written and a forgotten declaration is a compile error. The exported record speaks the framework's own entry
 * vocabulary, which is the wider type, so a library-composed group drops straight in beside the authored ones.
 */
export const featureOptions: Record<string, FeatureOptionEntry[]> = {

  "Account": accountOptions,
  "Device": deviceOptions,
  "Log": logOptions,
  [mqtt.category.name]: mqtt.options
};

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
