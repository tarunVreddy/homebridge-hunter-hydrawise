/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hydrawise-config.d.mts: Type declarations for the pure Hydrawise platform-configuration interpreters.
 */
import type { FeatureCategoryEntry, FeatureOptionEntry, FeatureOptions } from "homebridge-plugin-utils";

/** The number of characters in a Hydrawise API key. */
export declare const API_KEY_LENGTH: number;

/**
 * The primary platform-configuration entry, as it actually arrives from the Homebridge UI. Every consolidated setting is declared as an unknown-valued optional
 * property because that is the honest shape of an object read back from a user's `config.json`: a setting may be absent, may carry a hand-edited value of any
 * type, and may have been staged to `undefined` by this module's own patch. Interpreting exactly that is what the module is for.
 */
export interface HydrawiseConfig {

  apiKey?: unknown;
  debug?: unknown;
  mqttTopic?: unknown;
  mqttUrl?: unknown;
  options?: unknown;
}

/**
 * The option catalog the plugin's UI server publishes, as the interpreter consumes it.
 */
export interface HydrawiseConfigCatalog {

  categories: FeatureCategoryEntry[];
  options: Record<string, FeatureOptionEntry[]>;
}

/**
 * The commit-shaped patch the interpreter produces. A consumed legacy property rides here as a PRESENT key whose value is `undefined`, never as an omitted key:
 * the session's shallow-merge commit treats those two shapes oppositely, deleting the first and leaving the second untouched, and the type system cannot state
 * that difference. Assertions about this patch must therefore read own-property presence rather than compare against `undefined`.
 */
export interface HydrawiseConfigPatch {

  apiKey?: undefined;
  debug?: undefined;
  mqttTopic?: undefined;
  mqttUrl?: undefined;
  options?: string[];
}

/**
 * The commit-shaped patch the degraded-mode interpreter produces for a first-run write. It writes the legacy property rather than an option entry, which is the
 * deliberate difference between the two interpreters' write shapes.
 */
export interface HydrawiseLegacyConfigPatch {

  apiKey: string;
}

/**
 * The interpreter over a fetched catalog: the effective API key, the legacy-settings migration, and the first-run key write.
 */
export interface HydrawiseConfigInterpreter {

  apiKey(config?: HydrawiseConfig): string;
  migrate(config?: HydrawiseConfig): HydrawiseConfigPatch | null;
  withApiKey(config: HydrawiseConfig | undefined, apiKey: string): HydrawiseConfigPatch;
}

/**
 * The degraded-mode interpreter, answering the same three questions with no catalog and no engine. Its migration is always `null` and its write is the legacy
 * property, so a session whose fetches are failing still loads and still completes first run.
 */
export interface HydrawiseLegacyConfigInterpreter {

  apiKey(config?: HydrawiseConfig): string;
  migrate(config?: HydrawiseConfig): null;
  withApiKey(config: HydrawiseConfig | undefined, apiKey: string): HydrawiseLegacyConfigPatch;
}

/**
 * Build the interpreter over an injected feature-option engine class and the served option catalog.
 *
 * @param injected.FeatureOptions - The feature-option engine class.
 * @param injected.catalog        - The served catalog.
 *
 * @returns The interpreter.
 */
export declare const makeHydrawiseConfig: ({ FeatureOptions, catalog }: { FeatureOptions: typeof FeatureOptions; catalog: HydrawiseConfigCatalog }) =>
  HydrawiseConfigInterpreter;

/**
 * Build the degraded-mode interpreter.
 *
 * @returns The degraded-mode interpreter.
 */
export declare const makeLegacyHydrawiseConfig: () => HydrawiseLegacyConfigInterpreter;
