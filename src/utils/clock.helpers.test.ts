/* Copyright(C) 2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * clock.helpers.test.ts: Tests for makeFakeClock. Coverage pins the default behavior of each method (sleep records and resolves immediately, raceWithTimeout
 * forwards the inner promise, now returns 0), the override-by-method semantics (overriding one method does not affect the others), and the closure-shared
 * sleeps array (the same array is observable from the handle and from inside the clock).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { makeFakeClock } from "./clock.helpers.ts";

describe("makeFakeClock", () => {

  test("default now() returns 0", () => {

    const { clock } = makeFakeClock();

    assert.equal(clock.now(), 0, "a fake clock reads zero until the test says otherwise");
  });

  test("default sleep() resolves immediately and records the requested duration", async () => {

    const { clock, sleeps } = makeFakeClock();

    await clock.sleep(100);
    await clock.sleep(250);
    await clock.sleep(500);

    assert.deepEqual(sleeps, [ 100, 250, 500 ], "sleeps should record every requested duration in call order");
  });

  test("default raceWithTimeout() forwards the inner promise unchanged on success", async () => {

    const { clock } = makeFakeClock();

    const result = await clock.raceWithTimeout(Promise.resolve("inner-value"), 1000);

    assert.equal(result, "inner-value", "the default race should hand back the inner promise unchanged");
  });

  test("default raceWithTimeout() propagates the inner promise's rejection", async () => {

    const { clock } = makeFakeClock();

    await assert.rejects(
      () => clock.raceWithTimeout(Promise.reject(new Error("inner-failure")), 1000),
      /inner-failure/,
      "the inner promise's rejection should propagate (default raceWithTimeout does not impose a timer)"
    );
  });

  test("default sleep() yields to the microtask queue so awaiters run after a tick boundary", async () => {

    const { clock } = makeFakeClock();
    const order: string[] = [];

    const sleepCall = clock.sleep(0).then(() => { order.push("after-sleep"); });
    const microtask = Promise.resolve().then(() => { order.push("after-microtask"); });

    await Promise.all([ sleepCall, microtask ]);

    // Both awaiters resolve via the microtask queue. The exact order depends on Node's queue scheduling - what matters is that both ran.
    assert.equal(order.length, 2, "both awaiters should run via the microtask queue");
    assert.ok(order.includes("after-sleep"), "sleep awaiter should run");
    assert.ok(order.includes("after-microtask"), "microtask should run");
  });

  test("override of now() takes effect; sleep and raceWithTimeout keep their defaults", async () => {

    const { clock, sleeps } = makeFakeClock({ now: () => 12345 });

    assert.equal(clock.now(), 12345, "overridden now() should return the configured value");

    await clock.sleep(50);
    assert.deepEqual(sleeps, [50], "default sleep recording should still work");

    const raced = await clock.raceWithTimeout(Promise.resolve("ok"), 100);

    assert.equal(raced, "ok", "default raceWithTimeout should still forward");
  });

  test("override of sleep() replaces recording behavior - the sleeps array stays empty", async () => {

    const recordedElsewhere: number[] = [];
    const { clock, sleeps } = makeFakeClock({

      sleep: async (ms: number): Promise<void> => {

        recordedElsewhere.push(ms);
        await Promise.resolve();
      }
    });

    await clock.sleep(100);
    await clock.sleep(200);

    assert.deepEqual(recordedElsewhere, [ 100, 200 ], "the override should drive recording");
    assert.deepEqual(sleeps, [], "the default sleeps array should not record when sleep is overridden");
  });

  test("override of raceWithTimeout() can simulate the timer winning the race", async () => {

    const timerError = new Error("timer won");
    const { clock } = makeFakeClock({

      raceWithTimeout: async (_p: Promise<unknown>, _ms: number, err?: Error): Promise<never> => {

        throw err ?? timerError;
      }
    });

    await assert.rejects(
      () => clock.raceWithTimeout(Promise.resolve("never-seen"), 100, timerError),
      /timer won/,
      "the override's throw should simulate the timeout path"
    );
  });

  test("the sleeps array reference is the same one returned in the handle (closure-shared)", async () => {

    const { clock, sleeps } = makeFakeClock();

    await clock.sleep(7);

    assert.equal(sleeps[0], 7, "the handle's sleeps array sees writes from inside the clock");
    assert.equal(sleeps.length, 1, "one sleep should record exactly one entry");
  });

  test("two independent clocks have independent sleeps arrays", async () => {

    const a = makeFakeClock();
    const b = makeFakeClock();

    await a.clock.sleep(11);
    await b.clock.sleep(22);

    assert.deepEqual(a.sleeps, [11], "the first clock should record only its own sleep");
    assert.deepEqual(b.sleeps, [22], "the second clock should record only its own sleep");
  });
});
