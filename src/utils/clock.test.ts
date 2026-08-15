/* Copyright(C) 2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * clock.test.ts: Tests for the production Clock implementation. A project that only ever type-imports clock.ts never loads the module at runtime, and under
 * --strip-types the erased import leaves V8 coverage nothing to score - the file drops out of the coverage table rather than appearing with zero percent. This
 * file is the value load that puts it back: it imports realClock as a value and exercises every member of Clock against real time.
 *
 * The assertions are margin-generous but still tell a real clock from a stub. Reading the clock either side of a real sleep proves now() advances, which a
 * constant-returning stub would fail, and both outcomes of the race are exercised so neither the forwarding path nor the timeout path can rot unnoticed. The
 * whole file runs in well under a second.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { realClock } from "./clock.ts";

// The sleep the advancing check brackets, and the floor the elapsed reading is held to. The floor sits below the requested duration because a timer may fire a
// fraction early, and well above zero because a clock that did not move at all is the failure this check exists to catch.
const ADVANCE_FLOOR_MS = 8;
const ADVANCE_SLEEP_MS = 10;

describe("realClock", () => {

  test("now() reads real time - finite, never backwards, and advancing across a sleep", async () => {

    const before = realClock.now();

    assert.ok(Number.isFinite(before), "the first reading should be a finite timestamp");

    await realClock.sleep(ADVANCE_SLEEP_MS);

    const after = realClock.now();

    assert.ok(Number.isFinite(after), "the second reading should be finite too");
    assert.ok(after >= before, "the clock should never run backwards");
    assert.ok((after - before) >= ADVANCE_FLOOR_MS, "the clock should advance by roughly the slept duration");
  });

  test("sleep() resolves with no value", async () => {

    // The resolved value is read through a then-callback rather than bound from the await, because assigning a Promise<void> result to a binding trips this
    // project's no-confusing-void-expression rule.
    let sawUndefined = false;

    await realClock.sleep(1).then((value) => { sawUndefined = value === undefined; });

    assert.equal(sawUndefined, true, "sleep should resolve with undefined");
  });

  test("raceWithTimeout() forwards the promise's value when the promise wins", async () => {

    const result = await realClock.raceWithTimeout(Promise.resolve("the value"), 1000);

    assert.equal(result, "the value", "the winning promise's value should come back unchanged");
  });

  test("raceWithTimeout() throws the default error when the timer wins", async () => {

    // The inner promise is structured never to settle, so the timer is the only branch that can win.
    const { promise: never } = Promise.withResolvers<never>();

    await assert.rejects(() => realClock.raceWithTimeout(never, 1), /Operation timed out after 1ms/,
      "the default timeout error should name the duration");
  });

  test("raceWithTimeout() throws the caller's own error when one is supplied", async () => {

    const { promise: never } = Promise.withResolvers<never>();
    const custom = new Error("the caller's own timeout");

    await assert.rejects(() => realClock.raceWithTimeout(never, 1, custom), /the caller's own timeout/,
      "a supplied error should be the one thrown");
  });
});
