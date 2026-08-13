/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * v2.test.ts: The Hydrawise v2 client, driven through an injected dispatcher so the token grant, the query, and every failure classification run the real
 * production code against recorded wire traffic and never touch the live account API. Covers token acquisition, lazy renewal, the reset a failed grant performs,
 * the single-flight guarantee two concurrent callers rest on, the hardware selection rules, the rate-budget draws, and the failure classifications - including the
 * one that matters most for a GraphQL endpoint, an HTTP 200 whose body carries an errors array.
 *
 * Every fixture body below is taken from the live probe captures under the arc's own capture set, so a wrong field mapping fails here rather than in the field.
 */
// The OAuth and GraphQL wire shapes use snake_case keys such as access_token, so camelcase is disabled here to let the fixtures mirror the captured bodies verbatim.
/* eslint-disable camelcase */
import { HYDRAWISE_V2_BUDGET_CALLS, HYDRAWISE_V2_BUDGET_WINDOW, HYDRAWISE_V2_CLIENT_ID, HYDRAWISE_V2_CLIENT_SECRET, HYDRAWISE_V2_GRAPH_ENDPOINT,
  HYDRAWISE_V2_TOKEN_ENDPOINT } from "./settings.ts";
import { describe, test } from "node:test";
import type { CapturedLogLine } from "./testing.helpers.ts";
import { HydrawiseV2Client } from "./v2.ts";
import { MockAgent } from "undici";
import { RateBudget } from "homebridge-plugin-utils";
import assert from "node:assert/strict";
import { capturingLog } from "./testing.helpers.ts";

// The origin every v2 request targets, derived from the endpoint constant exactly as the client derives its own pool origin.
const V2_ORIGIN = new URL(HYDRAWISE_V2_GRAPH_ENDPOINT).origin;

// The two paths the client posts to, likewise derived so a changed endpoint constant moves the intercepts with it rather than silently matching nothing.
const GRAPH_PATH = new URL(HYDRAWISE_V2_GRAPH_ENDPOINT).pathname;
const TOKEN_PATH = new URL(HYDRAWISE_V2_TOKEN_ENDPOINT).pathname;

// A successful token grant, shaped as the live capture recorded it.
const TOKEN_BODY = { access_token: "access-one", expires_in: 3600, refresh_token: "refresh-one" };

// The second grant a renewal receives, distinguishable from the first so a test can tell a renewed token from a reused one.
const RENEWED_TOKEN_BODY = { access_token: "access-two", expires_in: 3600, refresh_token: "refresh-two" };

/* The controller hardware block exactly as the live capture recorded it, including the fields the client does NOT read. Keeping the unread fields is what makes the
 * selection rules genuinely tested: the model name sits beside the description, so a mapping that reached for the wrong one would produce the wrong string here
 * rather than passing against a fixture trimmed to only the right answer.
 */
const CAPTURED_CONTROLLER = {

  deviceId: 1058556,
  hardware: {

    firmware: [{ type: "controller", version: "4.76" }],
    model: { description: "HCC 38 Zones", family: { id: 6, name: "HCC Controller" }, id: "hydrawise938", maxZones: 38, name: "38 Zones" },
    status: "Linked",
    version: "hydrawise938"
  },
  id: 1058515,
  name: "Home"
};

// The whole-account hardware answer, carrying the captured controller.
const HARDWARE_BODY = { data: { me: { controllers: [CAPTURED_CONTROLLER] } } };

/* An HTTP 200 carrying a GraphQL errors array, taken from the live status-query capture. This is the failure shape a status-code check alone cannot see: the
 * transport succeeded, and the query did not.
 */
const GRAPH_ERRORS_BODY = { data: { me: { controllers: [] } },
  errors: [{ extensions: { category: "internal" }, locations: [{ column: 231, line: 1 }], message: "Internal server error",
    path: [ "me", "controllers", 0, "sensors", 0, "model", "mode" ] }] };

// One recorded request the injected dispatcher served, in the order it was served. The path is what tells a token grant from a query, and the order is what a
// budget-before-dispatch pin reads.
interface RecordedCall {

  budgetAvailableAtDispatch: number;
  path: string;
}

// The handles a harness hands back: the client under test, the recorded call log, the budget it draws against, and the captured log lines.
interface V2Harness {

  budget: RateBudget;
  calls: RecordedCall[];
  client: HydrawiseV2Client;
  lines: () => CapturedLogLine[];
}

/* Build a client over a MockAgent handed in through the constructor's dispatcher factory - the SAME parameter production leaves unset, so nothing here is a path
 * production does not have. The factory answers one agent for the life of the harness; a test that wants to observe the timeout self-heal would supply its own.
 *
 * Each intercept records the call before it replies, capturing the budget's free slots AT DISPATCH. That single number is what proves the draw is awaited rather
 * than merely present: a call that reached the wire without waiting would be recorded with the budget untouched.
 */
function makeV2Harness(program: (agent: MockAgent, record: (path: string) => void) => void,
  options: { capacity?: number; signal?: AbortSignal } = {}): V2Harness {

  const { lines, logger } = capturingLog();
  const signal = options.signal ?? new AbortController().signal;
  const budget = new RateBudget({ capacity: options.capacity ?? HYDRAWISE_V2_BUDGET_CALLS, signal, window: HYDRAWISE_V2_BUDGET_WINDOW * 1000 });
  const calls: RecordedCall[] = [];
  const agent = new MockAgent();

  agent.disableNetConnect();

  program(agent, (path: string): void => { calls.push({ budgetAvailableAtDispatch: budget.available, path }); });

  const client = new HydrawiseV2Client({ budget, dispatcherFactory: (): MockAgent => agent, log: logger, password: "test-password", signal,
    username: "test-user" });

  return { budget, calls, client, lines };
}

/* A MockAgent whose destroy tears it down for real. undici's MockAgent implements close but inherits the base dispatcher's unimplemented destroy, and the client
 * calls destroy because that is what fails a wedged pool's in-flight requests fast; mapping one onto the other is the double's business, not production's.
 */
function destroyable(agent: MockAgent): MockAgent {

  return Object.assign(agent, { destroy: async (): Promise<void> => { await agent.close(); } });
}

// Program one JSON reply for a path on the agent, recording each request it serves. Persisted, so a test that expects two calls to the same path gets the same
// answer twice unless it programs otherwise.
function programReply(agent: MockAgent, record: (path: string) => void, path: string, body: object, statusCode = 200): void {

  agent.get(V2_ORIGIN).intercept({ method: "POST", path }).reply(statusCode, (): object => {

    record(path);

    return body;
  }).persist();
}

describe("HydrawiseV2Client tokens", () => {

  test("acquires an access token on first use and reuses it on the next call", async () => {

    const harness = makeV2Harness((agent, record) => programReply(agent, record, TOKEN_PATH, TOKEN_BODY));

    assert.equal(await harness.client.ensureToken(), "access-one", "the password grant should answer the captured access token");
    assert.equal(await harness.client.ensureToken(), "access-one", "a token comfortably inside its lifetime answers again without a second grant");
    assert.equal(harness.calls.length, 1, "the second call should have spent no grant");
  });

  test("renews a token that is inside its proactive-refresh window", async () => {

    // A grant whose lifetime is shorter than the proactive-refresh threshold is inside that window the instant it lands, so the next call renews rather than
    // reusing it. That is the same arithmetic a long-lived token reaches near its expiry, without a test having to wait an hour to observe it.
    const harness = makeV2Harness((agent, record) => {

      agent.get(V2_ORIGIN).intercept({ method: "POST", path: TOKEN_PATH }).reply(200, (): object => {

        record(TOKEN_PATH);

        return { access_token: "access-one", expires_in: 30, refresh_token: "refresh-one" };
      });

      programReply(agent, record, TOKEN_PATH, RENEWED_TOKEN_BODY);
    });

    assert.equal(await harness.client.ensureToken(), "access-one", "the first grant answers the short-lived token");
    assert.equal(await harness.client.ensureToken(), "access-two", "a token inside the refresh window is renewed rather than reused");
    assert.equal(harness.calls.length, 2, "the renewal should have spent a second grant");
  });

  test("a failed grant resets the token state so the next call retries from scratch", async () => {

    const harness = makeV2Harness((agent, record) => {

      agent.get(V2_ORIGIN).intercept({ method: "POST", path: TOKEN_PATH }).reply(401, (): object => {

        record(TOKEN_PATH);

        return { error: "invalid_grant" };
      });

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
    });

    assert.equal(await harness.client.ensureToken(), null, "a rejected grant answers null");

    // The recovery is the point of the reset: a client left holding a failed state would answer null forever, where one returned to holding nothing simply tries
    // again and succeeds the moment the account is reachable.
    assert.equal(await harness.client.ensureToken(), "access-one", "the next call runs a fresh password grant and recovers");
    assert.equal(harness.calls.length, 2, "each attempt spent exactly one grant");
  });

  test("a grant carrying no access token is treated as a failure", async () => {

    const harness = makeV2Harness((agent, record) => programReply(agent, record, TOKEN_PATH, { expires_in: 3600, token_type: "Bearer" }));

    assert.equal(await harness.client.ensureToken(), null, "a 200 with no access token is not a usable grant");
  });

  test("two concurrent callers resolve from exactly ONE grant", async () => {

    const harness = makeV2Harness((agent, record) => programReply(agent, record, TOKEN_PATH, TOKEN_BODY));

    /* Both calls are started before either is awaited, which is the only arrangement that can observe the single-flight mechanism at all. The transition to the
     * in-flight state happens synchronously, in the same frame that read the prior state, so the second caller finds a grant already running and joins it. Drop
     * that synchronous transition and both callers observe "no token" and each fire a grant of their own, which this call count catches.
     */
    const [ first, second ] = await Promise.all([ harness.client.ensureToken(), harness.client.ensureToken() ]);

    assert.equal(first, "access-one", "the first caller resolves the token");
    assert.equal(second, "access-one", "the second caller resolves the same token");
    assert.equal(harness.calls.length, 1, "two concurrent callers should share ONE grant, not fire one each");
    assert.equal(harness.budget.available, HYDRAWISE_V2_BUDGET_CALLS - 1, "sharing the grant means sharing its budget slot too");
  });

  test("a token grant draws the rate budget BEFORE it reaches the wire", async () => {

    const harness = makeV2Harness((agent, record) => programReply(agent, record, TOKEN_PATH, TOKEN_BODY));

    await harness.client.ensureToken();

    // The slot count sampled at dispatch is the witness. A draw that was dispatched instead of awaited would let the request through with the budget still whole.
    assert.equal(harness.calls.length, 1, "the grant reached the wire");
    assert.equal(harness.calls[0]?.budgetAvailableAtDispatch, HYDRAWISE_V2_BUDGET_CALLS - 1, "the grant's slot was already spent by the time it dispatched");
  });
});

describe("HydrawiseV2Client grant body", () => {

  /* These pin what actually goes ON THE WIRE, which every other test in this file is blind to: the intercepts elsewhere match on path and method alone, so a grant
   * that swapped the client id and secret, or one that never sent the renewal grant type at all, would satisfy the entire suite. The account would simply fail to
   * authenticate in the field with nothing red anywhere.
   *
   * The matcher is undici's own body predicate, so the assertion runs against the serialized form the server would receive rather than against anything the client
   * hands back. A request whose body does not satisfy the predicate matches no intercept and the call fails, which is what turns a wrong body into a red test.
   */
  test("the password grant sends exactly the six parameters the account API expects", async () => {

    const harness = makeV2Harness((agent, record) => {

      agent.get(V2_ORIGIN).intercept({ body: (body) => {

        const params = new URLSearchParams(body);

        return (params.get("client_id") === HYDRAWISE_V2_CLIENT_ID) && (params.get("client_secret") === HYDRAWISE_V2_CLIENT_SECRET) &&
          (params.get("grant_type") === "password") && (params.get("scope") === "all") && (params.get("username") === "test-user") &&
          (params.get("password") === "test-password") && ([...params.keys()].length === 6);
      }, method: "POST", path: TOKEN_PATH }).reply(200, (): object => {

        record(TOKEN_PATH);

        return TOKEN_BODY;
      }).persist();
    });

    // The grant resolving at all is the assertion: only a body satisfying every clause above matches the intercept, so the id and the secret cannot be swapped and
    // no parameter can be dropped, added, or renamed.
    assert.equal(await harness.client.ensureToken(), "access-one", "the password grant reaches the wire carrying exactly its six documented parameters");
    assert.equal(harness.calls.length, 1, "and it spent exactly one grant doing it");
  });

  test("the renewal sends the refresh_token grant, not another password grant", async () => {

    const harness = makeV2Harness((agent, record) => {

      // The first grant is a password grant answering a token already inside the proactive-refresh window, so the very next call must renew.
      agent.get(V2_ORIGIN).intercept({ body: (body) => new URLSearchParams(body).get("grant_type") === "password", method: "POST", path: TOKEN_PATH })
        .reply(200, (): object => {

          record(TOKEN_PATH);

          return { access_token: "access-one", expires_in: 30, refresh_token: "refresh-one" };
        });

      /* The renewal's own intercept accepts ONLY a refresh_token grant presenting the token the first answer carried, and carrying neither of the account
       * credentials - a renewal that fell back to re-sending the username and password would match nothing here and fail.
       */
      agent.get(V2_ORIGIN).intercept({ body: (body) => {

        const params = new URLSearchParams(body);

        return (params.get("grant_type") === "refresh_token") && (params.get("refresh_token") === "refresh-one") &&
          (params.get("client_id") === HYDRAWISE_V2_CLIENT_ID) && (params.get("client_secret") === HYDRAWISE_V2_CLIENT_SECRET) &&
          (params.get("scope") === "all") && (params.get("username") === null) && (params.get("password") === null);
      }, method: "POST", path: TOKEN_PATH }).reply(200, (): object => {

        record(TOKEN_PATH);

        return RENEWED_TOKEN_BODY;
      });
    });

    assert.equal(await harness.client.ensureToken(), "access-one", "the first call runs the password grant");
    assert.equal(await harness.client.ensureToken(), "access-two", "the renewal presents the refresh token rather than the account credentials");
    assert.equal(harness.calls.length, 2, "exactly two grants, one of each kind");
  });
});

describe("HydrawiseV2Client hardware", () => {

  test("parses the captured whole-account hardware into the persisted shape", async () => {

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, HARDWARE_BODY);
    });

    const hardware = await harness.client.fetchHardware();

    assert.ok(hardware, "a successful query should answer a map");
    assert.deepEqual([...hardware.keys()], [1058515], "the map is keyed on the id that matches the v1 controller, never on the sibling device id");

    // The model is pinned to the DESCRIPTION, which is the full name a user recognizes. The capture carries the shorter name field beside it, so a mapping that
    // reached for that instead would answer "38 Zones" here.
    assert.deepEqual(hardware.get(1058515), { firmware: "4.76", model: "HCC 38 Zones" }, "the captured controller composes its captured model and firmware");
  });

  test("selects the controller's own firmware entry rather than the first one in the list", async () => {

    /* The synthetic module entry is ordered FIRST deliberately. A naive implementation that took the head of the list would answer with the adapter's version, so
     * this ordering is what makes the by-type selection rule genuinely proven rather than incidentally satisfied.
     */
    const multiEntry = { ...CAPTURED_CONTROLLER,
      hardware: { ...CAPTURED_CONTROLLER.hardware, firmware: [ { type: "adapter", version: "1.40" }, { type: "controller", version: "4.76" } ] } };

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { me: { controllers: [multiEntry] } } });
    });

    assert.equal((await harness.client.fetchHardware())?.get(1058515)?.firmware, "4.76", "the entry whose type names the controller is the one selected");
  });

  test("a controller with no controller-firmware entry is left unenriched", async () => {

    const noController = { ...CAPTURED_CONTROLLER, hardware: { ...CAPTURED_CONTROLLER.hardware, firmware: [{ type: "adapter", version: "1.40" }] } };

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { me: { controllers: [noController] } } });
    });

    const hardware = await harness.client.fetchHardware();

    // A successful query that composed nothing is an EMPTY map rather than a null, so the caller can still tell it apart from a query that failed.
    assert.deepEqual(hardware && [...hardware.keys()], [], "a partial hardware block composes nothing rather than half a shape");
  });

  test("a controller with no model description is left unenriched", async () => {

    const noModel = { ...CAPTURED_CONTROLLER, hardware: { ...CAPTURED_CONTROLLER.hardware, model: { name: "38 Zones" } } };

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { me: { controllers: [noModel] } } });
    });

    const hardware = await harness.client.fetchHardware();

    assert.deepEqual(hardware && [...hardware.keys()], [], "a hardware block carrying no description composes nothing");
  });

  test("a query draws the rate budget BEFORE it reaches the wire, on top of the grant's own draw", async () => {

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, HARDWARE_BODY);
    });

    await harness.client.fetchHardware();

    /* Two calls, two slots, and the ORDER is what the paths record: the query draws its slot first, then the token grant it triggers draws a second, and only then
     * does the grant reach the wire. Reading the slot count at each dispatch is what catches a draw that was dispatched instead of awaited.
     */
    assert.deepEqual(harness.calls.map(call => call.path), [ TOKEN_PATH, GRAPH_PATH ], "the grant dispatches before the query it authenticates");
    assert.equal(harness.calls[0]?.budgetAvailableAtDispatch, HYDRAWISE_V2_BUDGET_CALLS - 2, "the query's slot and the grant's slot are both spent before the " +
      "grant dispatches");
    assert.equal(harness.calls[1]?.budgetAvailableAtDispatch, HYDRAWISE_V2_BUDGET_CALLS - 2, "the query dispatches against the same two spent slots");
    assert.equal(harness.budget.available, HYDRAWISE_V2_BUDGET_CALLS - 2, "one enrichment costs exactly two slots on a cold client");
  });
});

describe("HydrawiseV2Client failure classification", () => {

  test("an HTTP 200 carrying a GraphQL errors array is a failure, not a success", async () => {

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, GRAPH_ERRORS_BODY);
    });

    // The transport succeeded and the query did not. A classification that read the status alone would hand the caller the body's empty controller list as though
    // it were an answer, and every controller would be quietly left unenriched with nothing reported.
    assert.equal(await harness.client.fetchHardware(), null, "a body-level errors array classifies as a failed query");
    assert.ok(harness.lines().some(line => (line.level === "error") && String(line.args[0]).includes("Internal server error")),
      "the reported failure names what the API said was wrong");
  });

  test("a non-2xx query status is a failure", async () => {

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { message: "Too Many Requests" }, 429);
    });

    assert.equal(await harness.client.fetchHardware(), null, "a throttled query answers null rather than a partial result");
  });

  test("a failed grant leaves the query unattempted", async () => {

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, { error: "invalid_grant" }, 401);
      programReply(agent, record, GRAPH_PATH, HARDWARE_BODY);
    });

    assert.equal(await harness.client.fetchHardware(), null, "a query with no token to present answers null");
    assert.deepEqual(harness.calls.map(call => call.path), [TOKEN_PATH], "the query never reached the wire without a token");
  });

  test("a generic transport failure is reported and answers null", async () => {

    /* The classification's final arm, which every other failure test routes around: not a shutdown, not a timeout, just a transport that threw. Without this case
     * the timeout branch could silently absorb the general one - a mis-scoped condition catching everything - and no test would notice, because the caller sees the
     * same null either way. What tells them apart is what reaches the user, so that is what this asserts.
     */
    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      agent.get(V2_ORIGIN).intercept({ method: "POST", path: GRAPH_PATH }).replyWithError(new Error("socket hang up"));
    });

    assert.equal(await harness.client.fetchHardware(), null, "a thrown transport failure answers the same null every recoverable failure does");

    const reported = harness.lines().filter(line => line.level === "error");

    assert.equal(reported.length, 1, "it is reported exactly once");
    assert.ok(reported.some(line => line.args.some(arg => String(arg).includes("socket hang up"))), "and the report carries what actually went wrong");
    assert.ok(!reported.some(line => line.message.includes("too long to respond")), "a generic failure is not narrated as a timeout");
  });

  test("a shutdown in flight reports nothing", async () => {

    const controller = new AbortController();

    const harness = makeV2Harness((agent, record) => {

      agent.get(V2_ORIGIN).intercept({ method: "POST", path: TOKEN_PATH }).reply(200, (): object => {

        record(TOKEN_PATH);
        controller.abort("shutdown");

        return TOKEN_BODY;
      }).persist();

      programReply(agent, record, GRAPH_PATH, HARDWARE_BODY);
    }, { signal: controller.signal });

    // Aborting mid-flight is orderly teardown rather than a fault, so it answers the same quiet null every other recoverable failure does and logs nothing at all.
    const result = await harness.client.fetchHardware();

    assert.equal(result, null, "a shutdown reached mid-request answers null");
    assert.equal(harness.lines().filter(line => line.level === "error").length, 0, "a shutdown is not an error and reports nothing");
  });
});

describe("HydrawiseV2Client dispatcher", () => {

  test("a timed-out request re-arms the connection pool, and the dispatcher getter answers the replacement", async () => {

    const first = destroyable(new MockAgent());
    const second = new MockAgent();
    const built = [ first, second ];
    const { lines, logger } = capturingLog();
    const signal = new AbortController().signal;

    first.disableNetConnect();
    second.disableNetConnect();

    // The timeout is driven through the request itself rather than by reaching past the class: undici surfaces a request timeout as exactly this DOMException, so
    // rejecting with it puts the client on the same code path a genuinely slow account would.
    first.get(V2_ORIGIN).intercept({ method: "POST", path: TOKEN_PATH })
      .replyWithError(new DOMException("The operation was aborted due to timeout", "TimeoutError")).persist();

    const client = new HydrawiseV2Client({ budget: new RateBudget({ capacity: HYDRAWISE_V2_BUDGET_CALLS, signal, window: HYDRAWISE_V2_BUDGET_WINDOW * 1000 }),
      dispatcherFactory: (): MockAgent => built.shift() ?? second, log: logger, password: "test-password", signal, username: "test-user" });

    assert.equal(client.dispatcher, first, "the client starts on the dispatcher its factory built");
    assert.equal(await client.ensureToken(), null, "a timed-out grant answers null");

    /* A wedged pool carries every request on its single connection, so it is replaced rather than waited out. The getter answering the REPLACEMENT is what makes
     * the platform's teardown correct across this: that registration reads the dispatcher at disposal time, and a captured reference would destroy the pool that
     * was already abandoned while leaving the live one open.
     */
    assert.equal(client.dispatcher, second, "the timeout re-armed the pool, and the getter answers the live one");
    assert.ok(lines().some(line => (line.level === "error") && line.message.includes("too long to respond")), "the timeout is reported to the user");
  });
});
