/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * config.test.ts: The webUI's pure platform-configuration interpreters, exercised against the REAL feature-option engine and the REAL option catalog
 * so the pins bind to the same grammar the plugin's runtime resolves against. Covers the effective-key precedence, every arm of the legacy-settings migration -
 * what migrates, what deletes without migrating, and what declines entirely - the first-run write, the degraded-mode interpreter, and a round trip proving a
 * migrated configuration runs the platform on the same effective values the legacy one did.
 *
 * One discipline binds every claim about a deleted property: a patch carries a deletion as a PRESENT key whose value is undefined, and carries a non-deletion by
 * omitting the key. An equality read cannot tell those apart, and the session's shallow-merge commit treats them oppositely, so presence is asserted with
 * Object.hasOwn and absence with its negation - never with a comparison against undefined.
 */
import { API_KEY_LENGTH, makeHydrawiseConfig, makeLegacyHydrawiseConfig } from "../homebridge-ui/public/hydrawise-config.mjs";
import { describe, test } from "node:test";
import { featureOptionCategories, featureOptions } from "./options.ts";
import { FeatureOptions } from "homebridge-plugin-utils";
import assert from "node:assert/strict";
import { buildPlatform } from "./testing/platform.helpers.ts";

// APIEvent.SHUTDOWN's string value, fired to tear down a platform the round-trip pin builds.
const SHUTDOWN = "shutdown";

// The two API keys the precedence pins tell apart: one carried by a legacy property, one carried by a configured option.
const LEGACY_KEY = "AAAA-BBBB-CCCC-DDD";
const OPTION_KEY = "EEEE-FFFF-GGGG-HHH";

// The interpreter under test, built the way the webUI builds it: the real engine class and the real served catalog.
const config = makeHydrawiseConfig({ FeatureOptions, catalog: { categories: featureOptionCategories, options: featureOptions } });

// Whether an options array carries an entry addressing a given option, case-insensitively, in either the enabled or the disabled form.
function entriesFor(options: string[] | undefined, option: string): string[] {

  const prefix = option.toLowerCase();

  return (options ?? []).filter((entry) => [ "enable." + prefix, "disable." + prefix ].some((form) => entry.toLowerCase().startsWith(form)));
}

describe("hydrawise webUI config interpreters", () => {

  test("exports the API key length the first-run screen validates against", () => {

    assert.equal(API_KEY_LENGTH, 19, "a Hydrawise API key is always nineteen characters");
  });

  test("migrate declines when there is nothing to migrate", () => {

    assert.equal(config.migrate(undefined), null, "an absent config has nothing to migrate");
    assert.equal(config.migrate({}), null, "a config carrying none of the legacy properties has nothing to migrate");
    assert.equal(config.migrate({ options: [ "Enable.Account.ApiKey=" + OPTION_KEY, "Disable.Device.ABC123" ] }), null,
      "an already-migrated config finds nothing to do on a second pass");
  });

  test("each legacy property migrates into its option and leaves the property for deletion", () => {

    for(const [ property, option, value ] of [ [ "apiKey", "Account.ApiKey", LEGACY_KEY ], [ "mqttUrl", "Mqtt.Url", "mqtt://127.0.0.1:1883" ],
      [ "mqttTopic", "Mqtt.Topic", "garden" ] ] as [ string, string, string ][]) {

      const patch = config.migrate({ [property]: value });

      assert.ok(patch, "a config carrying " + property + " should produce a patch");
      assert.deepEqual(entriesFor(patch.options, option), ["Enable." + option + "=" + value], option + " should compose one entry carrying the exact value");
      assert.ok(Object.hasOwn(patch, property), property + " should ride the patch as a present key so the commit deletes it");
      assert.equal(patch[property as keyof typeof patch], undefined, property + " should be carried as undefined");
    }
  });

  test("an empty or non-string legacy value deletes without migrating", () => {

    const empty = config.migrate({ mqttTopic: "" });

    assert.ok(empty, "an empty legacy value still produces a deletion patch");
    assert.ok(Object.hasOwn(empty, "mqttTopic"), "the empty property should still be deleted");
    assert.ok(!Object.hasOwn(empty, "options"), "an empty value composes no entry, so the patch carries no options array");

    const numeric = config.migrate({ mqttTopic: 42 });

    assert.ok(numeric, "a hand-edited non-string value still produces a deletion patch");
    assert.ok(Object.hasOwn(numeric, "mqttTopic"), "the non-string property should still be deleted");
    assert.ok(!Object.hasOwn(numeric, "options"), "a non-string value composes no entry, so the patch carries no options array");
  });

  test("an already-configured option outranks the legacy property", () => {

    const patch = config.migrate({ mqttUrl: "mqtt://127.0.0.2:1883", options: ["Enable.Mqtt.Url=mqtt://127.0.0.1:1883"] });

    assert.ok(patch, "the legacy property should still be deleted");
    assert.ok(Object.hasOwn(patch, "mqttUrl"), "the superseded property rides the patch for deletion");
    assert.ok(!Object.hasOwn(patch, "options"), "an existing entry is the user's own choice, so nothing is composed over it");
  });

  test("an explicitly disabled option counts as configured", () => {

    const patch = config.migrate({ mqttUrl: "mqtt://127.0.0.1:1883", options: ["Disable.Mqtt.Url"] });

    assert.ok(patch, "the legacy property should still be deleted");
    assert.ok(Object.hasOwn(patch, "mqttUrl"), "the property rides the patch for deletion");
    assert.ok(!Object.hasOwn(patch, "options"), "a disable is a configured entry, so the legacy value does not overwrite it");
  });

  test("a legacy value equal to the option's registered default deletes without composing", () => {

    const patch = config.migrate({ mqttTopic: "hydrawise" });

    assert.ok(patch, "the property should still be deleted");
    assert.ok(Object.hasOwn(patch, "mqttTopic"), "the property rides the patch for deletion");
    assert.ok(!Object.hasOwn(patch, "options"), "a value that only restates the catalog default manufactures no configuration");
  });

  test("a multi-property config migrates every setting in one patch and preserves unrelated entries", () => {

    const patch = config.migrate({ apiKey: LEGACY_KEY, mqttTopic: "garden", mqttUrl: "mqtt://127.0.0.1:1883",
      options: [ "Disable.Device.ABC123", "Enable.Log.Zone.DEF456" ] });

    assert.ok(patch, "a config carrying all three properties should produce a patch");

    for(const property of [ "apiKey", "mqttTopic", "mqttUrl" ]) {

      assert.ok(Object.hasOwn(patch, property), property + " should ride the patch for deletion");
    }

    assert.deepEqual(entriesFor(patch.options, "Account.ApiKey"), ["Enable.Account.ApiKey=" + LEGACY_KEY], "the key should compose one entry");
    assert.deepEqual(entriesFor(patch.options, "Mqtt.Topic"), ["Enable.Mqtt.Topic=garden"], "the topic should compose one entry");
    assert.deepEqual(entriesFor(patch.options, "Mqtt.Url"), ["Enable.Mqtt.Url=mqtt://127.0.0.1:1883"], "the broker URL should compose one entry");

    for(const preserved of [ "Disable.Device.ABC123", "Enable.Log.Zone.DEF456" ]) {

      assert.ok(patch.options?.includes(preserved), preserved + " should survive the migration untouched");
    }
  });

  test("withApiKey composes the key option, replacing any entry already addressing it", () => {

    const fresh = config.withApiKey({}, OPTION_KEY);

    assert.deepEqual(entriesFor(fresh.options, "Account.ApiKey"), ["Enable.Account.ApiKey=" + OPTION_KEY], "a fresh config composes the entry");
    assert.ok(Object.hasOwn(fresh, "apiKey"), "the write always carries the legacy property for deletion");
    assert.equal(fresh.apiKey, undefined, "the legacy property is carried as undefined");

    const replaced = config.withApiKey({ options: [ "Enable.Account.ApiKey=" + LEGACY_KEY, "Disable.Device.ABC123" ] }, OPTION_KEY);

    assert.deepEqual(entriesFor(replaced.options, "Account.ApiKey"), ["Enable.Account.ApiKey=" + OPTION_KEY],
      "an existing key entry is replaced rather than duplicated");
    assert.ok(replaced.options?.includes("Disable.Device.ABC123"), "unrelated entries survive the write");
  });

  test("the effective API key reads the option first and the property second", () => {

    assert.equal(config.apiKey({ apiKey: LEGACY_KEY, options: ["Enable.Account.ApiKey=" + OPTION_KEY] }), OPTION_KEY,
      "a configured option outranks the legacy property");
    assert.equal(config.apiKey({ apiKey: LEGACY_KEY }), LEGACY_KEY, "the legacy property answers when no entry exists");
    assert.equal(config.apiKey({}), "", "a config carrying neither reads as no key");
    assert.equal(config.apiKey({ options: ["Enable.Account.ApiKey"] }), "", "an entry carrying no value reads as no key");
    assert.equal(config.apiKey({ apiKey: LEGACY_KEY, options: ["Disable.Account.ApiKey"] }), "",
      "an explicitly disabled key is no key, and the legacy property does not override it");
  });

  test("a legacy debug flag set on migrates to a valueless enable entry", () => {

    const patch = config.migrate({ debug: true });

    assert.ok(patch, "a config carrying debug should produce a patch");
    assert.deepEqual(entriesFor(patch.options, "Log.Debug"), ["Enable.Log.Debug"], "a flag composes the valueless enable form, carrying no value");
    assert.ok(Object.hasOwn(patch, "debug"), "the legacy property rides the patch for deletion");
  });

  test("a legacy debug flag set off deletes without composing", () => {

    const patch = config.migrate({ debug: false });

    assert.ok(patch, "the property should still be deleted");
    assert.ok(Object.hasOwn(patch, "debug"), "the property rides the patch for deletion");
    assert.ok(!Object.hasOwn(patch, "options"), "off is what the catalog already declares, so no entry is manufactured for it");
  });

  test("a non-boolean debug value deletes without composing", () => {

    const patch = config.migrate({ debug: "yes" });

    assert.ok(patch, "a hand-edited non-boolean still produces a deletion patch");
    assert.ok(Object.hasOwn(patch, "debug"), "the property rides the patch for deletion");
    assert.ok(!Object.hasOwn(patch, "options"), "a value we decline to interpret composes nothing");
  });

  test("an explicitly disabled debug option outranks the legacy flag", () => {

    const patch = config.migrate({ debug: true, options: ["Disable.Log.Debug"] });

    assert.ok(patch, "the legacy property should still be deleted");
    assert.ok(Object.hasOwn(patch, "debug"), "the property rides the patch for deletion");
    assert.ok(!Object.hasOwn(patch, "options"), "a disable is a configured entry, so the legacy flag does not overwrite it");
  });

  test("an already-enabled debug option is not composed a second time", () => {

    const patch = config.migrate({ debug: true, options: [ "Enable.Log.Debug", "Disable.Device.ABC123" ] });

    assert.ok(patch, "the legacy property should still be deleted");
    assert.ok(Object.hasOwn(patch, "debug"), "the property rides the patch for deletion");
    assert.ok(!Object.hasOwn(patch, "options"), "an existing entry already says what the property says, so nothing is composed over it");
  });

  test("a migrated configuration runs the platform on the same effective values as the legacy one", (t) => {

    // debug is seeded true deliberately. Seeded false it would compare the catalog default against itself on both sides and prove nothing about the flag arm.
    const legacy = { apiKey: LEGACY_KEY, debug: true, mqttTopic: "garden", mqttUrl: "mqtt://127.0.0.1:1" };
    const patch = config.migrate(legacy);

    // The identity comparison below would pass vacuously against a migration that did nothing, so the patch is proven non-empty before it is applied.
    assert.ok(patch, "the migration should produce a patch");
    assert.ok(patch.options?.length, "the patch should carry composed entries");

    for(const property of [ "apiKey", "debug", "mqttTopic", "mqttUrl" ]) {

      assert.ok(Object.hasOwn(patch, property), property + " should ride the patch for deletion");
    }

    // Apply the patch the way the webUI stages it, then build a real platform on each configuration and compare what each resolves.
    const migrated = { ...legacy, ...patch };
    const before = buildPlatform(legacy);
    const after = buildPlatform({ apiKey: migrated.apiKey, debug: migrated.debug, mqttTopic: migrated.mqttTopic, mqttUrl: migrated.mqttUrl,
      options: migrated.options });

    t.after(() => {

      before.emit(SHUTDOWN);
      after.emit(SHUTDOWN);
    });

    assert.equal(after.platform.config.apiKey, before.platform.config.apiKey, "the migrated config resolves the same effective API key");
    assert.equal(after.platform.config.mqttUrl, before.platform.config.mqttUrl, "the migrated config resolves the same effective broker URL");
    assert.equal(after.platform.config.mqttTopic, before.platform.config.mqttTopic, "the migrated config resolves the same effective topic prefix");
    assert.equal(before.platform.config.debug, true, "the legacy configuration resolves debug on, so the comparison below is not two defaults agreeing");
    assert.equal(after.platform.config.debug, before.platform.config.debug, "the migrated config resolves the same effective debug flag");
  });

  test("a whitespace-padded legacy value migrates trimmed", () => {

    const patch = config.migrate({ mqttTopic: " garden " });

    assert.ok(patch, "the padded value should produce a patch");
    assert.deepEqual(entriesFor(patch.options, "Mqtt.Topic"), ["Enable.Mqtt.Topic=garden"], "the engine trims the value it stores");
    assert.ok(Object.hasOwn(patch, "mqttTopic"), "the property is still deleted");
  });

  test("a legacy key present with the value undefined counts as absent on its own", () => {

    assert.equal(config.migrate({ apiKey: undefined }), null, "a key staged to undefined is the terminal shape, so a second pass stages nothing");
  });

  test("a legacy key present with the value undefined is left out of a patch a defined sibling drives", () => {

    const patch = config.migrate({ apiKey: undefined, mqttTopic: "garden" });

    assert.ok(patch, "a genuinely defined sibling still migrates");
    assert.ok(!Object.hasOwn(patch, "apiKey"), "the already-staged key is not re-included, which would be churn");
    assert.ok(Object.hasOwn(patch, "mqttTopic"), "the defined sibling still rides the patch for deletion");
  });

  test("an options substrate that is not an array declines rather than guessing", () => {

    assert.equal(config.migrate({ apiKey: LEGACY_KEY, options: {} }), null, "an unparseable options substrate leaves the whole config alone");
  });

  test("the degraded-mode interpreter reads what the real interpreter writes", () => {

    const legacy = makeLegacyHydrawiseConfig();

    assert.equal(legacy.apiKey({ apiKey: LEGACY_KEY }), LEGACY_KEY, "the legacy property answers directly");
    assert.equal(legacy.migrate({ apiKey: LEGACY_KEY }), null, "degraded mode never migrates blind");
    assert.deepEqual(legacy.withApiKey({}, OPTION_KEY), { apiKey: OPTION_KEY }, "the degraded write is the legacy-shaped one");
    assert.equal(legacy.apiKey({}), "", "a config carrying neither reads as no key");

    /* The scan is cross-checked end to end against what the real interpreter actually produces, never against a hand-typed entry, so a drifted prefix fails
     * here rather than silently sending a migrated install back through first run.
     */
    const written = { ...{}, ...config.withApiKey({}, OPTION_KEY) };

    assert.equal(legacy.apiKey(written), OPTION_KEY, "a first-run write is readable in a later degraded session");

    const source = { apiKey: LEGACY_KEY };
    const patch = config.migrate(source);

    assert.ok(patch, "the migration should produce a patch");
    assert.equal(legacy.apiKey({ ...source, ...patch }), LEGACY_KEY, "a migrated config is readable in a later degraded session");
  });
});
