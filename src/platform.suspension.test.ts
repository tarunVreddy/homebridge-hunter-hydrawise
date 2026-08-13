/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.suspension.test.ts: The platform's per-zone suspension surface, exercised against a REAL HydrawisePlatform. The client under it is a REAL
 * HydrawiseV2Client built over an injected MockAgent and sharing the platform's own rate budget, so the whole path - the platform's zero-cost pre-check, the
 * client's admission phase, the transport - runs production code with nothing ever reaching the account API.
 *
 * The pre-check and the admission bound are deliberately told apart here. The pre-check answers the COMMON saturated case for free and carries a check-then-act
 * race of its own; the client's admission window is what bounds the loser of that race. A suite that drove only the fast path would pass against an
 * implementation whose race loser blocked for the length of the budget's own half-hour window.
 */
// The OAuth wire shape uses snake_case keys such as access_token, so camelcase is disabled here to let the grant fixture mirror the captured body verbatim.
/* eslint-disable camelcase */
import { HYDRAWISE_V2_BUDGET_CALLS, HYDRAWISE_V2_BUDGET_WINDOW, HYDRAWISE_V2_GRAPH_ENDPOINT, HYDRAWISE_V2_TOKEN_ENDPOINT } from "./settings.ts";
import { buildPlatform, installV2Client, v2BudgetOf } from "./testing/platform.helpers.ts";
import { describe, test } from "node:test";
import type { HydrawisePlatform } from "./platform.ts";
import { HydrawiseV2Client } from "./v2.ts";
import { MockAgent } from "undici";
import assert from "node:assert/strict";
import { silentLog } from "./testing.helpers.ts";

const SHUTDOWN = "shutdown";

// The configured-option entries that carry an account login, which is the only home those credentials have and the whole of what the client gate reads.
const CREDENTIAL_OPTIONS = [ "Enable.Account.Password=test-password", "Enable.Account.Username=test-user" ];

// The v2 origin and the two paths every account-credentialed request targets, derived from the endpoint constants exactly as the client derives its own.
const V2_ORIGIN = new URL(HYDRAWISE_V2_GRAPH_ENDPOINT).origin;

const GRAPH_PATH = new URL(HYDRAWISE_V2_GRAPH_ENDPOINT).pathname;

const TOKEN_PATH = new URL(HYDRAWISE_V2_TOKEN_ENDPOINT).pathname;

// A successful token grant, shaped as the live capture recorded it.
const TOKEN_BODY = { access_token: "access-one", expires_in: 3600, refresh_token: "refresh-one" };

// The zone every command below names, taken from the live capture's own id space.
const ZONE_ID = 6940181;

// A far-future instant to suspend until, which is the shape a real command carries.
const SUSPEND_UNTIL = 1903928399;

/* Replace the platform's own client with a REAL one over a MockAgent, sharing the platform's rate budget so the pre-check and the admission phase are reading the
 * same ceiling production has them read. The agent refuses to connect out, so a request that escaped an intercept fails loudly rather than reaching the account.
 *
 * @returns A reader for the number of requests the agent served, which is what an absence pin reads.
 */
function installRealClient(platform: HydrawisePlatform, program: (agent: MockAgent, record: () => void) => void): () => number {

  /* undici's MockAgent implements close but inherits the base dispatcher's unimplemented destroy, and the platform's teardown calls destroy because that is what
   * fails a wedged pool's in-flight requests fast; mapping one onto the other is the double's business, not production's.
   */
  const agent = Object.assign(new MockAgent(), { destroy: async (): Promise<void> => { await agent.close(); } });
  let served = 0;

  agent.disableNetConnect();
  program(agent, (): void => { served++; });

  installV2Client(platform, new HydrawiseV2Client({ budget: v2BudgetOf(platform), dispatcherFactory: (): MockAgent => agent, log: silentLog(),
    password: "test-password", signal: platform.signal, username: "test-user" }));

  return (): number => served;
}

// Program one persisted JSON reply for a v2 path, counting the requests it serves.
function programReply(agent: MockAgent, record: () => void, path: string, body: object): void {

  agent.get(V2_ORIGIN).intercept({ method: "POST", path }).reply(200, (): object => {

    record();

    return body;
  }).persist();
}

// Spend budget slots until the stated number remain free, so a test states the ceiling it wants rather than the arithmetic that produces it.
async function drainTo(platform: HydrawisePlatform, remaining: number): Promise<void> {

  const budget = v2BudgetOf(platform);

  while(budget.available > remaining) {

    // eslint-disable-next-line no-await-in-loop
    await budget.acquire();
  }
}

describe("HydrawisePlatform zone suspension surface", () => {

  test("a platform with no account credentials answers unavailable", async (t) => {

    const { emit, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN));

    /* The honest answer for a caller that has no client to command through. It is structurally unreachable from a live switch - those exist only where a client
     * does, and that is fixed at construction - which is exactly why it is pinned HERE, at the surface that can actually produce it, rather than through a handler
     * that could never reach it.
     */
    assert.equal(platform.hasV2Client, false, "an install carrying only an API key builds no client at all");
    assert.deepEqual(await platform.setZoneSuspension({ until: SUSPEND_UNTIL, zoneId: ZONE_ID }), { status: "unavailable" },
      "and its suspension surface says so rather than pretending to command");
  });

  test("an accepted command answers done, and a refused one carries the account's own words back", async (t) => {

    const { emit, platform } = buildPlatform({ options: CREDENTIAL_OPTIONS });

    t.after(() => emit(SHUTDOWN));

    const served = installRealClient(platform, (agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { suspendZone: { status: "ERROR", summary: "Hydrawise says no." } } });
    });

    /* The refusal's summary reaching the platform's own answer is the point: the controller speaks one sentence about a failed command and names the reason in it,
     * which it can only do if the reason travels this far. A boolean surface would have lost it here.
     */
    assert.deepEqual(await platform.setZoneSuspension({ until: SUSPEND_UNTIL, zoneId: ZONE_ID }), { reason: "Hydrawise says no.", status: "failed" },
      "a command the account refused reports the account's own summary");
    assert.equal(served(), 2, "a genuinely attempted command spent its grant and its mutation");
  });

  test("a saturated ceiling is refused without a single call being spent", async (t) => {

    const { emit, platform } = buildPlatform({ options: CREDENTIAL_OPTIONS });

    t.after(() => emit(SHUTDOWN));

    const served = installRealClient(platform, (agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { suspendZone: { status: "OK" } } });
    });

    await drainTo(platform, 0);

    const started = Date.now();

    assert.deepEqual(await platform.setZoneSuspension({ until: SUSPEND_UNTIL, zoneId: ZONE_ID }), { status: "rejected" },
      "a ceiling with nothing to give refuses the command");

    /* Zero calls is the whole claim of the pre-check, and it is what makes a burst of taps free. It also has to be FAST: the pre-check answers without entering the
     * client at all, so this resolves in the same beat rather than after the admission window.
     */
    assert.equal(served(), 0, "the refusal touched no connection and spent no call");
    assert.ok((Date.now() - started) < (HYDRAWISE_V2_BUDGET_WINDOW * 1000), "and it answered at once rather than queueing for a slot");
  });

  test("the pre-check's race loser is bounded by the admission window, not by the budget's", async (t) => {

    const { emit, platform } = buildPlatform({ options: CREDENTIAL_OPTIONS });

    t.after(() => emit(SHUTDOWN));

    const served = installRealClient(platform, (agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { suspendZone: { status: "OK" } } });
    });

    // ONE slot left is the state the race needs. Both commands are started in the same frame, so both pre-checks read that slot as free before either has taken
    // it - which is precisely the check-then-act race the pre-check carries on its own, driven rather than reasoned about.
    await drainTo(platform, 1);

    const started = Date.now();
    const commands = await Promise.all([ platform.setZoneSuspension({ until: SUSPEND_UNTIL, zoneId: ZONE_ID }),
      platform.setZoneSuspension({ until: null, zoneId: ZONE_ID }) ]);
    const elapsed = Date.now() - started;

    /* Both answer rejected, by the two different bounds the fold puts in place: the loser of the race gives up on its bounded slot wait, and the winner - which
     * took the last slot and then found no slot left to pay for its token grant - gives up on the token race. Neither blocks toward the budget's own window, which
     * is what an unbounded acquire would have done to both.
     */
    assert.deepEqual(commands, [ { status: "rejected" }, { status: "rejected" } ], "neither command queues behind a ceiling it cannot be admitted through");
    assert.ok(elapsed < (HYDRAWISE_V2_BUDGET_WINDOW * 1000), "and both resolved on the admission window rather than the budget's half hour");
    assert.equal(served(), 0, "nothing reached the wire for either of them");
  });

  test("the surface draws against the platform's own account-credentialed ceiling", async (t) => {

    const { emit, platform } = buildPlatform({ options: CREDENTIAL_OPTIONS });

    t.after(() => emit(SHUTDOWN));

    installRealClient(platform, (agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { resumeZone: { status: "OK" } } });
    });

    assert.deepEqual(await platform.setZoneSuspension({ until: null, zoneId: ZONE_ID }), { status: "done" }, "the command was accepted");

    // A command is paced against the same ceiling the scheduled reads are, which is what keeps the two from ever exceeding it between them: its admission slot and
    // the grant it triggered are both drawn from the platform's own budget.
    assert.equal(v2BudgetOf(platform).available, HYDRAWISE_V2_BUDGET_CALLS - 2, "one command on a cold client costs the account exactly two slots");
  });
});
