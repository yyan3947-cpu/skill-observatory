import assert from "node:assert/strict";
import test from "node:test";

import {
  createGitHubStatusService,
  inspectGitHubTokenEnvelope,
} from "../lib/github-token-status.mjs";

const FINE_GRAINED_PREFIX = ["github", "pat", ""].join("_");
const CLASSIC_PREFIX = ["ghp", ""].join("_");
const TOKEN = `${FINE_GRAINED_PREFIX}${"A".repeat(70)}`;
const START = Date.UTC(2026, 7, 19, 1, 2, 3);

function rateLimitBucket(resource, remaining, reset) {
  return {
    remaining,
    reset,
    retryAt: new Date(reset * 1000).toISOString(),
    resource,
  };
}

function rateLimitStatus(searchRemaining = 29, codeRemaining = 8) {
  return {
    search: rateLimitBucket("search", searchRemaining, 1_780_000_000),
    codeSearch: rateLimitBucket("code_search", codeRemaining, 1_780_000_060),
  };
}

function publicRateLimits(searchRemaining = 29, codeRemaining = 8) {
  return {
    search: {
      remaining: searchRemaining,
      reset: 1_780_000_000,
      retryAt: new Date(1_780_000_000 * 1000).toISOString(),
    },
    codeSearch: {
      remaining: codeRemaining,
      reset: 1_780_000_060,
      retryAt: new Date(1_780_000_060 * 1000).toISOString(),
    },
  };
}

function codedError(code, properties = {}) {
  const error = new Error(`${code} ${TOKEN} remote-body-secret`);
  Object.defineProperty(error, "code", { value: code, enumerable: true });
  for (const [key, value] of Object.entries(properties)) {
    Object.defineProperty(error, key, { value, enumerable: true });
  }
  return error;
}

test("token envelope inspects the raw value without trimming or rewriting", () => {
  assert.deepEqual(inspectGitHubTokenEnvelope(undefined), { state: "missing-token", token: "" });
  assert.deepEqual(inspectGitHubTokenEnvelope(null), { state: "missing-token", token: "" });
  assert.deepEqual(inspectGitHubTokenEnvelope(""), { state: "missing-token", token: "" });
  assert.deepEqual(inspectGitHubTokenEnvelope(TOKEN), { state: "candidate", token: TOKEN });

  for (const value of [
    ` ${TOKEN}`,
    `${TOKEN} `,
    `${TOKEN}\n`,
    `${TOKEN}\t`,
    `${TOKEN}${String.fromCharCode(0)}`,
    `${TOKEN}${String.fromCharCode(127)}`,
    `${TOKEN}${String.fromCodePoint(0x80)}`,
    `${TOKEN}${String.fromCodePoint(0x9f)}`,
    "x".repeat(513),
    42,
    {},
  ]) {
    assert.deepEqual(inspectGitHubTokenEnvelope(value), { state: "invalid-token", token: "" });
  }
});

test("rejects recognized malformed and doubled tokens", () => {
  for (const token of [
    FINE_GRAINED_PREFIX,
    `${FINE_GRAINED_PREFIX}short`,
    CLASSIC_PREFIX,
    `${CLASSIC_PREFIX}short`,
    TOKEN + TOKEN,
    `${CLASSIC_PREFIX}${"A".repeat(36)}`.repeat(2),
  ]) {
    assert.deepEqual(inspectGitHubTokenEnvelope(token), {
      state: "invalid-token",
      token: "",
    });
  }
});

test("accepts a bounded opaque future token without rewriting it", () => {
  const token = `ghx_${"aB9".repeat(25)}`;
  assert.deepEqual(inspectGitHubTokenEnvelope(token), { state: "candidate", token });
});

test("missing and invalid envelopes never create a GitHub client", async () => {
  let clientCalls = 0;
  const createClient = () => {
    clientCalls += 1;
    throw new Error("must-not-create-client");
  };
  const missing = createGitHubStatusService({
    token: "",
    tokenState: "missing-token",
    createClient,
    now: () => START,
  });
  const invalid = createGitHubStatusService({
    token: "",
    tokenState: "invalid-token",
    createClient,
    now: () => START,
  });

  assert.deepEqual(await missing.getStatus(), {
    state: "missing-token",
    checkedAt: new Date(START).toISOString(),
    rateLimits: { search: null, codeSearch: null },
  });
  assert.deepEqual(await invalid.getStatus(), {
    state: "invalid-token",
    checkedAt: new Date(START).toISOString(),
    rateLimits: { search: null, codeSearch: null },
  });
  assert.equal(clientCalls, 0);
});

test("reports exact ready and repository-rate-limited states", async () => {
  let response = rateLimitStatus();
  const service = createGitHubStatusService({
    token: TOKEN,
    createClient: ({ token }) => {
      assert.equal(token, TOKEN);
      return { getRateLimitStatus: async () => response };
    },
    now: () => START,
  });
  assert.deepEqual(Object.keys(service), ["getStatus"]);

  assert.deepEqual(await service.getStatus(), {
    state: "ready",
    checkedAt: new Date(START).toISOString(),
    rateLimits: publicRateLimits(),
  });

  response = rateLimitStatus(0, 8);
  assert.deepEqual(await service.getStatus({ force: true }), {
    state: "rate-limited",
    checkedAt: new Date(START).toISOString(),
    rateLimits: publicRateLimits(0, 8),
  });
});

test("code-search exhaustion alone leaves repository discovery ready", async () => {
  const service = createGitHubStatusService({
    token: TOKEN,
    createClient: () => ({ getRateLimitStatus: async () => rateLimitStatus(17, 0) }),
    now: () => START,
  });
  assert.deepEqual(await service.getStatus(), {
    state: "ready",
    checkedAt: new Date(START).toISOString(),
    rateLimits: publicRateLimits(17, 0),
  });
});

test("maps 401, 403, network, timeout, and limit failures to safe status objects", async () => {
  const cases = [
    [codedError("github-token-invalid"), "invalid-token", { search: null, codeSearch: null }],
    [codedError("github-access-denied"), "github-unavailable", { search: null, codeSearch: null }],
    [codedError("github-network-failed"), "github-unavailable", { search: null, codeSearch: null }],
    [codedError("github-request-timeout"), "github-unavailable", { search: null, codeSearch: null }],
    [
      codedError("github-rate-limited", {
        rateLimit: rateLimitBucket("search", 0, 1_780_000_000),
      }),
      "rate-limited",
      { search: publicRateLimits(0, 8).search, codeSearch: null },
    ],
  ];

  for (const [error, state, rateLimits] of cases) {
    const service = createGitHubStatusService({
      token: TOKEN,
      createClient: () => ({ getRateLimitStatus: async () => { throw error; } }),
      now: () => START,
    });
    const status = await service.getStatus();
    assert.deepEqual(status, {
      state,
      checkedAt: new Date(START).toISOString(),
      rateLimits,
    });
    const serialized = JSON.stringify({ service, status });
    assert.doesNotMatch(serialized, new RegExp(`${TOKEN}|remote-body-secret`, "u"));
  }
});

test("uses a 60-second TTL, supports force, and returns fresh safe clones", async () => {
  let now = START;
  let calls = 0;
  const service = createGitHubStatusService({
    token: TOKEN,
    createClient: () => ({
      async getRateLimitStatus() {
        calls += 1;
        return rateLimitStatus(30 - calls, 10 - calls);
      },
    }),
    now: () => now,
  });

  const first = await service.getStatus();
  first.rateLimits.search.remaining = 999;
  now += 59_999;
  const cached = await service.getStatus();
  assert.equal(calls, 1);
  assert.equal(cached.rateLimits.search.remaining, 29);
  assert.notEqual(cached, first);

  await service.getStatus({ force: true });
  assert.equal(calls, 2);
  now += 60_000;
  await service.getStatus();
  assert.equal(calls, 3);
});

test("a wall-clock rollback invalidates the cached status", async () => {
  let now = START;
  let calls = 0;
  const service = createGitHubStatusService({
    token: TOKEN,
    createClient: () => ({
      async getRateLimitStatus() {
        calls += 1;
        return rateLimitStatus();
      },
    }),
    now: () => now,
  });
  await service.getStatus();
  now -= 1;
  await service.getStatus();
  assert.equal(calls, 2);
});

test("coalesces concurrent refreshes including forced refreshes", async () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const service = createGitHubStatusService({
    token: TOKEN,
    createClient: () => ({
      async getRateLimitStatus() {
        calls += 1;
        await pending;
        return rateLimitStatus();
      },
    }),
    now: () => START,
  });

  const requests = [
    service.getStatus(),
    service.getStatus(),
    service.getStatus({ force: true }),
  ];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  const statuses = await Promise.all(requests);
  assert.equal(calls, 1);
  assert.deepEqual(statuses[0], statuses[1]);
  assert.notEqual(statuses[0], statuses[1]);
});

test("a forced refresh supersedes a primed cache for concurrent normal callers", async () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const service = createGitHubStatusService({
    token: TOKEN,
    createClient: () => ({
      async getRateLimitStatus() {
        calls += 1;
        if (calls === 1) return rateLimitStatus();
        await pending;
        return rateLimitStatus(0, 8);
      },
    }),
    now: () => START,
  });

  assert.equal((await service.getStatus()).state, "ready");
  const forced = service.getStatus({ force: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  const normal = Array.from({ length: 8 }, () => service.getStatus());
  release();
  const statuses = await Promise.all([forced, ...normal]);

  assert.equal(calls, 2);
  assert.ok(statuses.every((status) => status.state === "rate-limited"));
  assert.ok(statuses.every((status) => status.rateLimits.search.remaining === 0));
  assert.equal(new Set(statuses).size, statuses.length);
});

test("failed forced and expired-TTL refreshes coalesce with normal callers", async () => {
  for (const mode of ["force", "expired-ttl"]) {
    let now = START;
    let calls = 0;
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const service = createGitHubStatusService({
      token: TOKEN,
      createClient: () => ({
        async getRateLimitStatus() {
          calls += 1;
          if (calls === 1) return rateLimitStatus();
          await pending;
          throw codedError("github-network-failed");
        },
      }),
      now: () => now,
    });

    assert.equal((await service.getStatus()).state, "ready");
    if (mode === "expired-ttl") now += 60_000;
    const leader = service.getStatus(mode === "force" ? { force: true } : undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
    const followers = [service.getStatus(), service.getStatus({ force: true })];
    release();
    const statuses = await Promise.all([leader, ...followers]);

    assert.equal(calls, 2);
    assert.ok(statuses.every((status) => status.state === "github-unavailable"));
  }
});

test("fails closed on unsafe options and dependency payloads without invoking traps", async () => {
  let optionTrapCalls = 0;
  let optionGetterCalls = 0;
  let getterCalls = 0;
  const unsafeStatus = { codeSearch: rateLimitStatus().codeSearch };
  Object.defineProperty(unsafeStatus, "search", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return rateLimitStatus().search;
    },
  });
  const service = createGitHubStatusService({
    token: TOKEN,
    createClient: () => ({ getRateLimitStatus: async () => unsafeStatus }),
    now: () => START,
  });

  const accessorOptions = {};
  Object.defineProperty(accessorOptions, "force", {
    enumerable: true,
    get() {
      optionGetterCalls += 1;
      return true;
    },
  });
  for (const options of [
    { force: false, extra: true },
    Object.create({ force: true }),
    accessorOptions,
    new Proxy({ force: true }, {
      getOwnPropertyDescriptor() {
        optionTrapCalls += 1;
        throw new Error("proxy-secret");
      },
    }),
  ]) {
    await assert.rejects(() => service.getStatus(options), /invalid-github-status-options/u);
  }
  assert.equal(optionTrapCalls, 0);
  assert.equal(optionGetterCalls, 0);

  assert.deepEqual(await service.getStatus(), {
    state: "github-unavailable",
    checkedAt: new Date(START).toISOString(),
    rateLimits: { search: null, codeSearch: null },
  });
  assert.equal(getterCalls, 0);
});
