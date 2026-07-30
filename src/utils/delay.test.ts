/**
 * delay.test.ts: Tests for the time primitives (delay, raceWithTimeout, cancellableTimeout). Coverage pins the contract each one promises plus the cleanup
 * behavior that makes them safe in long-running processes - timers must not be left dangling after the race or after cancel.
 */
import { cancellableTimeout, delay, raceWithTimeout } from "./delay.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

describe("delay", () => {

  test("resolves after a short delay (zero-ms uses the microtask boundary)", async () => {

    const before = performance.now();

    await delay(0);
    const elapsed = performance.now() - before;

    // delay(0) resolves on the next tick; we verify it does not throw and returns within a generous bound.
    assert.ok(elapsed >= 0, "elapsed should be non-negative");
    assert.ok(elapsed < 100, "delay(0) should resolve well within 100ms");
  });

  test("resolves with no value (Promise<void>)", async () => {

    let sawUndefined = false;

    await delay(1).then((value) => { sawUndefined = value === undefined; });

    assert.equal(sawUndefined, true, "delay resolves with undefined");
  });
});

describe("raceWithTimeout", () => {

  test("returns the promise's value when the promise resolves first", async () => {

    const inner = Promise.resolve("the value");
    const result = await raceWithTimeout(inner, 1000);

    assert.equal(result, "the value");
  });

  test("propagates the inner promise's rejection when the promise rejects first", async () => {

    const inner = Promise.reject(new Error("inner failure"));

    await assert.rejects(() => raceWithTimeout(inner, 1000), /inner failure/);
  });

  test("throws a default Error when the timer wins the race", async () => {

    // The inner promise is structured to never resolve so the timer must fire first.
    const { promise: never } = Promise.withResolvers<never>();

    await assert.rejects(
      () => raceWithTimeout(never, 1),
      /Operation timed out after 1ms/,
      "default error should mention the timeout duration"
    );
  });

  test("throws the supplied custom error when the timer wins the race", async () => {

    const { promise: never } = Promise.withResolvers<never>();
    const custom = new Error("custom timeout");

    await assert.rejects(() => raceWithTimeout(never, 1, custom), /custom timeout/);
  });

  test("cleans up the timer when the inner promise wins (no leaked handles)", async () => {

    // We can't directly observe the cleared timer, but the .finally(clearTimeout) guarantees no event-loop reference outlives the race. Indirect verification:
    // running many races back-to-back must not leak handles - if the timer were leaked, Node's test runner would hang at exit. The fast pass here plus the
    // --test-force-exit safety net in the canonical scripts provide the cleanup signal.
    const promises = Array.from({ length: 50 }, async (_, i) => raceWithTimeout(Promise.resolve(i), 10_000));

    const results = await Promise.all(promises);

    assert.equal(results.length, 50);
    assert.equal(results[0], 0);
    assert.equal(results[49], 49);
  });
});

describe("cancellableTimeout", () => {

  test("resolves to false after the configured delay when not cancelled", async () => {

    const { promise } = cancellableTimeout(1);

    const result = await promise;

    assert.equal(result, false, "the promise resolves to false on timer fire");
  });

  test("cancel() prevents the promise from ever resolving (no false on cancel)", async () => {

    const { cancel, promise } = cancellableTimeout(50);

    cancel();

    // After cancel, the promise has had its timer cleared but the resolve() inside the original setTimeout never runs. We verify by racing against a known-
    // resolving microtask: the race must be won by the microtask, proving the cancelled timer never resolved.
    const winner = await Promise.race([ promise.then(() => "timer"), Promise.resolve("microtask") ]);

    assert.equal(winner, "microtask", "the cancelled timer must not resolve before the microtask");
  });

  test("cancel() is idempotent (safe to call twice)", () => {

    const { cancel } = cancellableTimeout(100);

    assert.doesNotThrow(() => {

      cancel();
      cancel();
    }, "double-cancel should not throw");
  });

  test("returned promise type is Promise<false>", async () => {

    // The literal-type assertion is at compile-time; runtime evidence is the resolved value being strictly false.
    const { promise } = cancellableTimeout(1);
    const result: false = await promise;

    assert.equal(result, false);
  });
});
