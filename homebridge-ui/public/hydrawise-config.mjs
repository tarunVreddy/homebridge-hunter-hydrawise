/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hydrawise-config.mjs: Pure interpreters over the injected Hydrawise platform configuration.
 */
"use strict";

/* The single home for our plugin-config shape. Every function here is a pure interpreter of the primary platform-config entry the webUI framework injects into
 * our hooks - no I/O, no global reach, and no imports, so the whole module is testable against the real feature-option engine by handing that engine in.
 * The framework owns reading and writing the persisted config through its session; this module owns the Hydrawise-specific knowledge of where a setting lives.
 *
 * Two settings substrates meet here. A feature option is where a setting lives, and a handful of configuration properties are a second home the plugin honors
 * so that a configuration nobody has opened the webUI on keeps working. Reconciling the two is this module's whole job: the interpreters read them in
 * precedence order, and the migration moves a property's value into its option and marks the property for deletion.
 */

// The number of characters in a Hydrawise API key, which is always nineteen. This is the VALIDATION fact the first-run screen gates on and stamps onto its
// input. The catalog's matching inputSize is a render-width hint that happens to share the number; neither is derived from the other.
export const API_KEY_LENGTH = 19;

/* Every consolidated setting, as the legacy configuration property that carries it paired with the feature option that supersedes it. This pairing is this
 * module's policy knowledge and the one address book both factories below read, so the migration's writes, the interpreters' reads, and the degraded-mode scan
 * can never disagree about where a setting lives. The plugin's runtime names the same option keys independently in TypeScript; the two meet at the wire.
 */
const CONSOLIDATED_SETTINGS = {

  apiKey: "Account.ApiKey",
  debug: "Log.Debug",
  mqttTopic: "Mqtt.Topic",
  mqttUrl: "Mqtt.Url"
};

/* Build the interpreter over an injected feature-option engine class and the option catalog the plugin's own UI server publishes. Injecting both is what keeps
 * this module import-free and testable under node against the real engine and the real catalog, rather than against a stand-in that could drift from either.
 *
 * @param injected.FeatureOptions - The feature-option engine class.
 * @param injected.catalog        - The served catalog, carrying its categories and its options record.
 *
 * @returns The interpreter: the effective API key, the legacy-settings migration, and the first-run key write.
 */
export const makeHydrawiseConfig = ({ FeatureOptions, catalog }) => {

  // A feature-option engine over the served catalog and the config's own entries. The array is handed in directly rather than copied: the engine's set-option
  // path is a pure transform that composes a fresh array and reassigns its own field, so the array it was given is never written to.
  const engineFor = (config) => new FeatureOptions(catalog.categories, catalog.options, Array.isArray(config?.options) ? config.options : []);

  /* The value the catalog registers as an option's default, read from the served entry's own defaultValue field. The engine exposes a same-named method that
   * answers a different question - the boolean enabled-state default - so this walks the catalog data instead. The migration needs this to tell a value the
   * user chose from a value that merely restates what the option already does, and only the first is worth writing an entry for.
   */
  const registeredDefault = (option) => {

    for(const [ category, entries ] of Object.entries(catalog?.options ?? {})) {

      for(const entry of entries) {

        if((entry.name ? category + "." + entry.name : category) === option) {

          return entry.defaultValue;
        }
      }
    }

    return undefined;
  };

  return {

    /* The effective API key, as the string the plugin would run on. An explicitly configured option rules in every one of its states, its empty ones included:
     * an option enabled with no value, and an option explicitly disabled, both mean the user has told us there is no key. Only when no entry exists at all does
     * the legacy property answer.
     *
     * @param config - The platform configuration entry.
     *
     * @returns The effective key, or an empty string when there is none.
     */
    apiKey: (config) => {

      const engine = engineFor(config);
      const option = CONSOLIDATED_SETTINGS.apiKey;

      if(engine.exists(option)) {

        return engine.value(option) ?? "";
      }

      return (typeof config?.apiKey === "string") ? config.apiKey : "";
    },

    /* Move any legacy configuration properties into their feature options, as a patch for the session to stage. This is transitional work with a planned end:
     * once a configuration has been through it, there is nothing left to find and every later pass answers null.
     *
     * A property that is present with a defined value always leaves, carried on the patch as an explicitly undefined key so the shallow-merge commit deletes
     * it rather than skipping it. Whether its value additionally becomes an option entry depends on which kind of option it addresses, and the kind is read
     * from the catalog rather than declared here: the engine treats an entry that declares a defaultValue as value-centric, so an option whose registered
     * default comes back undefined is a flag. That keeps the address table a plain map of names and leaves the catalog the single authority on kind.
     *
     * A value migrates when all of the following hold: it is a non-empty string, its option is not already configured (an existing entry is the user's own
     * choice and outranks a property, whether that entry enables or disables the option), and it is not byte-equal to the option's registered default
     * (migrating a value that only restates the default would manufacture configuration out of nothing).
     *
     * A flag composes a valueless enable entry on exactly one input: the boolean true, with its option not already configured. False needs no entry, because
     * off is what the catalog already declares, and writing one would manufacture configuration for no gain - the same minimal-config rule the value arm
     * follows. Anything that is not a boolean is a hand-edit we decline to interpret, and it leaves without composing.
     *
     * Two shapes decline entirely. A legacy key present with the value undefined is the terminal shape this very patch produces, so it reads as absent and a
     * second pass over an already-staged config stages nothing. And an options array that is not an array at all is a substrate we cannot parse, so the
     * migration leaves the whole config alone rather than guessing at it.
     *
     * @param config - The platform configuration entry.
     *
     * @returns The patch to commit, or null when there is nothing to do.
     */
    migrate: (config) => {

      if(!config || ((config.options !== undefined) && !Array.isArray(config.options))) {

        return null;
      }

      const carried = Object.entries(CONSOLIDATED_SETTINGS).filter(([property]) => config[property] !== undefined);

      if(!carried.length) {

        return null;
      }

      const engine = engineFor(config);
      const patch = {};
      let composed = false;

      for(const [ property, option ] of carried) {

        const value = config[property];
        const catalogDefault = registeredDefault(option);

        patch[property] = undefined;

        // An option the catalog gives no registered default is a flag, and a flag's whole payload is the entry's existence.
        if(catalogDefault === undefined) {

          if((value !== true) || engine.exists(option)) {

            continue;
          }

          engine.setOption({ enabled: true, option });
          composed = true;

          continue;
        }

        if((typeof value !== "string") || !value.length || engine.exists(option) || (value === catalogDefault)) {

          continue;
        }

        engine.setOption({ enabled: true, option, value });
        composed = true;
      }

      // The entries ride the patch only when this pass actually composed one, so a config whose properties all decline stages a pure deletion.
      if(composed) {

        patch.options = engine.configuredOptions;
      }

      return patch;
    },

    /* The first-run write: compose the validated key as its feature option, replacing any entry already addressing it. The legacy property rides along as an
     * explicitly undefined key, so a configuration that carried one is left with exactly one home for the key once the patch is written.
     *
     * @param config - The platform configuration entry.
     * @param apiKey - The validated API key to write.
     *
     * @returns The patch to commit.
     */
    withApiKey: (config, apiKey) => {

      const engine = engineFor(config);

      engine.setOption({ enabled: true, option: CONSOLIDATED_SETTINGS.apiKey, value: apiKey });

      return { apiKey: undefined, options: engine.configuredOptions };
    }
  };
};

/* Build the degraded-mode interpreter, which is what the webUI falls back to when the option catalog cannot be fetched. It answers the same three questions
 * without an engine, so the settings page still loads and first-run still works in a session whose local requests are failing.
 *
 * Its write shape is deliberately the legacy one. Composing an option entry by hand, with no catalog to validate it against, is how a webUI corrupts a config;
 * writing the property instead is always safe, and the next healthy session migrates it forward on its own.
 *
 * @returns The degraded-mode interpreter.
 */
export const makeLegacyHydrawiseConfig = () => {

  // The canonical entry prefix the engine composes for an enabled API key option, lowercased because entry matching is case-insensitive. The engine writes
  // only this one form, so scanning for it is honest for every entry the migration or a first-run write could have produced.
  const apiKeyPrefix = "enable." + CONSOLIDATED_SETTINGS.apiKey.toLowerCase() + "=";

  return {

    /* The effective API key, read without an engine. The legacy property answers first, and when it is gone - which is exactly what a completed migration
     * leaves behind - the raw options array is scanned for the canonical entry. Without that scan a degraded session would read a fully migrated install as
     * having no key at all and send the user back through first-run.
     *
     * @param config - The platform configuration entry.
     *
     * @returns The effective key, or an empty string when there is none.
     */
    apiKey: (config) => {

      if(typeof config?.apiKey === "string") {

        return config.apiKey;
      }

      for(const entry of Array.isArray(config?.options) ? config.options : []) {

        if((typeof entry === "string") && entry.toLowerCase().startsWith(apiKeyPrefix)) {

          return entry.slice(apiKeyPrefix.length);
        }
      }

      return "";
    },

    // Never migrate without a catalog. A migration decides what to write by consulting the catalog's registered defaults and the entries already configured,
    // and neither question can be answered here.
    migrate: () => null,

    /* The first-run write in degraded mode: the legacy property, which needs no catalog to be correct.
     *
     * @param config - The platform configuration entry.
     * @param apiKey - The validated API key to write.
     *
     * @returns The patch to commit.
     */
    withApiKey: (config, apiKey) => ({ apiKey })
  };
};
