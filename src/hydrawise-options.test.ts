/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hydrawise-options.test.ts: The feature-option catalog and its documentation hook. Pins the catalog defaults, the scope-set drift between the catalog's declared
 * meta.scopes and the compile-time controller/zone option-name unions the runtime narrows against, and the describeOptionScope prose the docs renderer consumes.
 */
import { describe, test } from "node:test";
import { describeOptionScope, featureOptionCategories, featureOptions } from "./hydrawise-options.ts";
import type { HydrawiseFeatureOption } from "./hydrawise-options.ts";
import assert from "node:assert/strict";

// Compute the full option name for a catalog entry, joining the category with the entry name (an empty entry name is the category-level option).
function fullName(category: string, entry: HydrawiseFeatureOption): string {

  return entry.name ? category + "." + entry.name : category;
}

// Collect the option names whose declared scopes include the given scope level, sorted for a stable comparison.
function scopedOptions(scope: "controller" | "zone"): string[] {

  const names: string[] = [];

  for(const [ category, entries ] of Object.entries(featureOptions)) {

    for(const entry of entries) {

      if(entry.meta.scopes.includes(scope)) {

        names.push(fullName(category, entry));
      }
    }
  }

  return names.toSorted();
}

describe("hydrawise feature options", () => {

  test("declares the expected categories", () => {

    assert.deepEqual(featureOptionCategories.map(category => category.name).toSorted(), [ "Device", "Log" ], "the catalog should declare the Device and Log categories");
  });

  test("carries the catalog defaults for each option", () => {

    const device = featureOptions["Device"];
    const log = featureOptions["Log"];

    assert.ok(device && log, "the Device and Log categories should exist");
    assert.equal(device[0]?.default, true, "the base Device option defaults to enabled");
    assert.equal(device[1]?.default, false, "the suspend switch defaults to disabled");
    assert.equal(log[0]?.default, true, "zone logging defaults to enabled");
  });

  test("the controller-scopable options match the controller option-name union", () => {

    // This is the runtime half of the scope-union contract: the set derived from the catalog's meta.scopes must equal the compile-time HydrawiseControllerOption
    // union. A catalog scope change that is not mirrored in the union surfaces here.
    assert.deepEqual(scopedOptions("controller"), [ "Device", "Device.Suspend", "Log.Zone" ], "every controller-scoped option should be named in the controller union");
  });

  test("the zone-scopable options match the zone option-name union", () => {

    assert.deepEqual(scopedOptions("zone"), [ "Device", "Log.Zone" ], "the suspend option is controller-only, so only Device and Log.Zone are zone-scoped");
  });

  test("describeOptionScope renders the multi-scope prose", () => {

    const device = featureOptions["Device"]?.[0];

    assert.ok(device, "the base Device option should exist");
    assert.equal(describeOptionScope(device), " <BR>*Configurable at the whole controller and each zone.*", "a controller-and-zone option lists both levels");
  });

  test("describeOptionScope renders the single-scope prose", () => {

    const suspend = featureOptions["Device"]?.[1];

    assert.ok(suspend, "the suspend option should exist");
    assert.equal(describeOptionScope(suspend), " <BR>*Configurable at the whole controller.*", "a controller-only option lists just the controller level");
  });

  test("describeOptionScope omits the suffix when an option declares no scope", () => {

    // An entry that carries no meta (the base renderer's generic entry shape permits it) yields no scope suffix.
    assert.equal(describeOptionScope({ default: true, description: "No scope here.", name: "Bare" }), undefined, "a scopeless option should render no suffix");
  });
});
