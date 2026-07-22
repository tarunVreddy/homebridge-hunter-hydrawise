/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * smoke.test.ts: The rig proof. This file proves only that the native test rig itself works - TypeScript type-stripping runs the suite directly against .ts
 * source, the runner discovers a co-located *.test.ts file, and node:assert/strict is wired. It deliberately touches neither the harness nor the production code;
 * the harness has its own self-tests, and the production behavior is pinned by the concern-partitioned suites. If this file fails, the problem is the rig, not
 * any test.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

describe("test rig", () => {

  test("strips TypeScript syntax and runs against source", () => {

    // A typed local plus an explicit return type exercises the type-stripping path; the value survives erasure at runtime.
    const double = (value: number): number => value * 2;

    assert.equal(double(21), 42, "type-stripped arithmetic should run at runtime");
  });

  test("resolves and awaits async assertions", async () => {

    const resolved = await Promise.resolve("ready");

    assert.equal(resolved, "ready", "an awaited promise should resolve through the runner");
  });

  test("uses strict equality semantics from node:assert/strict", () => {

    // node:assert/strict distinguishes types where the loose assert would coerce; the rig must be wired to the strict variant.
    assert.throws(() => assert.equal(1, "1"), "strict equality must not coerce a number to a string");
  });
});
