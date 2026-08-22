import assert from "node:assert/strict";
import { connect } from "node:net";
import test from "node:test";
import { createLocalApi as createLocalApiBase } from "../lib/local-api.mjs";
import { createRawSearchConsentStore } from "../lib/raw-search-consent.mjs";

function githubStatus(state = "ready", overrides = {}) {
  return {
    state,
    checkedAt: "2026-08-19T01:02:03.000Z",
    rateLimits: { search: null, codeSearch: null },
    ...overrides,
  };
}

function createLocalApi(options) {
  return createLocalApiBase({
    getGitHubStatus: async () => githubStatus(),
    ...options,
  });
}

function githubDiagnostics(overrides = {}) {
  return {
    stageReached: "complete",
    repositoryHits: 0,
    codeHits: 0,
    validatedCandidates: 0,
    rejectedCandidates: 0,
    deduplicatedCandidates: 0,
    rejectionCounts: [],
    cached: false,
    incomplete: false,
    rateLimits: { search: null, codeSearch: null },
    ...overrides,
  };
}

function localRecommendation(level = "none", results = []) {
  return { level, results };
}

function localCard(skillId = "local-skill", overrides = {}) {
  return {
    skillId,
    name: skillId,
    summaryZh: "本地 Skill 摘要",
    status: "ready",
    score: 12,
    reasonCodes: ["name"],
    reasonZh: "任务名称匹配",
    ...overrides,
  };
}

function postResponse(base, path, body) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function decodeChunkedBody(value) {
  let offset = 0;
  let decoded = "";
  while (offset < value.length) {
    const sizeEnd = value.indexOf("\r\n", offset);
    if (sizeEnd < 0) {
      if (value.slice(offset).trim() === "0") return decoded;
      throw new Error("invalid-chunked-response");
    }
    const size = Number.parseInt(value.slice(offset, sizeEnd), 16);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid-chunked-response");
    if (size === 0) return decoded;
    const chunkStart = sizeEnd + 2;
    decoded += value.slice(chunkStart, chunkStart + size);
    offset = chunkStart + size + 2;
  }
  throw new Error("invalid-chunked-response");
}

function rawJsonRequest(port, path, body, { beforeSend = () => {}, afterReceive = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    let responseText = "";
    const socket = connect({ host: "127.0.0.1", port }, () => {
      beforeSend();
      socket.end([
        `POST ${path} HTTP/1.1`,
        "Host: 127.0.0.1",
        "Content-Type: application/json",
        `Content-Length: ${Buffer.byteLength(payload)}`,
        "Connection: close",
        "",
        payload,
      ].join("\r\n"));
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { responseText += chunk; });
    socket.on("error", (error) => {
      afterReceive();
      reject(error);
    });
    socket.on("end", () => {
      afterReceive();
      const [head, json = ""] = responseText.split("\r\n\r\n");
      const status = Number.parseInt(head.match(/^HTTP\/1\.1 (\d{3})/u)?.[1] ?? "0", 10);
      const payload = /transfer-encoding:\s*chunked/iu.test(head) ? decodeChunkedBody(json) : json;
      resolve({ status, body: JSON.parse(payload) });
    });
  });
}

test("serves only the private API contract", async (context) => {
  const catalog = { skills: [], metrics: { installed: 0 } };
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => catalog,
    getCatalog: async () => catalog,
    recommend: (query) => query.includes("A股")
      ? localRecommendation("strong", [localCard("a-share-analysis")])
      : localRecommendation(),
    previewGitHubSearch: () => null,
    findGitHubSuggestions: async () => ({
      preview: null,
      results: [],
      cached: false,
      incomplete: false,
      rateLimit: null,
      diagnostics: githubDiagnostics(),
    }),
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;

  assert.equal((await fetch(`${base}/api/catalog`)).status, 200);
  assert.equal((await fetch(`${base}/api/catalog`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${base}/api/sync`, { method: "POST" })).status, 200);

  const match = await fetch(`${base}/api/recommend`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
    body: JSON.stringify({ query: "分析A股" }),
  });
  assert.equal(match.status, 200);
  assert.deepEqual(await match.json(), {
    localMatchLevel: "strong",
    results: [localCard("a-share-analysis")],
    githubSearch: null,
    githubStatus: null,
    rawConsent: null,
  });

  assert.equal((await fetch(`${base}/api/recommend`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://example.com" },
    body: JSON.stringify({ query: "分析A股" }),
  })).status, 403);

  assert.equal((await fetch(`${base}/api/recommend`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "x".repeat(9000) }),
  })).status, 413);
});

test("GET /api/github-status returns one exact no-store CORS-safe status", async (context) => {
  const status = githubStatus("ready", {
    rateLimits: {
      search: { remaining: 29, reset: 1_780_000_000, retryAt: "2026-05-27T04:26:40.000Z" },
      codeSearch: { remaining: 8, reset: 1_780_000_060, retryAt: "2026-05-27T04:27:40.000Z" },
    },
  });
  let statusCalls = 0;
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => localRecommendation(),
    getGitHubStatus: async () => {
      statusCalls += 1;
      return status;
    },
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;
  const origin = "http://127.0.0.1:3000";

  const response = await fetch(`${base}/api/github-status`, { headers: { origin } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), status);
  assert.equal(statusCalls, 1);

  const method = await fetch(`${base}/api/github-status`, { method: "POST" });
  assert.equal(method.status, 405);
  assert.deepEqual(await method.json(), { error: "method-not-allowed" });
  assert.equal(statusCalls, 1);
});

test("GitHub status dependencies require exact own data schemas without traps or leaks", async (context) => {
  const sentinel = "private-status-sentinel";
  let accessorCalls = 0;
  let proxyTrapCalls = 0;
  const accessor = githubStatus();
  Object.defineProperty(accessor, "state", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return sentinel;
    },
  });
  const fixtures = [
    { ...githubStatus(), extra: sentinel },
    githubStatus("ready", { rateLimits: { search: null, codeSearch: null, extra: sentinel } }),
    githubStatus("ready", {
      rateLimits: {
        search: { remaining: 1, reset: 2, retryAt: null, extra: sentinel },
        codeSearch: null,
      },
    }),
    githubStatus("unknown"),
    githubStatus("ready", { checkedAt: "not-a-time" }),
    accessor,
    new Proxy(githubStatus(), {
      getOwnPropertyDescriptor() {
        proxyTrapCalls += 1;
        throw new Error(sentinel);
      },
    }),
    Object.assign(Object.create({ inherited: sentinel }), githubStatus()),
  ];
  let fixture = fixtures[0];
  const logged = [];
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => localRecommendation(),
    getGitHubStatus: async () => fixture,
    onError(error) {
      logged.push({ message: error.message, code: error.code });
    },
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;

  for (const value of fixtures) {
    fixture = value;
    const response = await fetch(`${base}/api/github-status`);
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.deepEqual(body, { error: "github-request-failed" });
    assert.doesNotMatch(JSON.stringify(body), new RegExp(sentinel, "u"));
  }
  assert.equal(accessorCalls, 0);
  assert.equal(proxyTrapCalls, 0);
  assert.ok(logged.every((item) => item.message === "github-request-failed"));
  assert.doesNotMatch(JSON.stringify(logged), new RegExp(sentinel, "u"));
});

test("recommend exposes status only for weak or none and suppresses consent when not ready", async (context) => {
  let level = "strong";
  let status = githubStatus("missing-token");
  let statusCalls = 0;
  let consentCalls = 0;
  const baseStore = createRawSearchConsentStore();
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => localRecommendation(
      level,
      level === "none" ? [] : [localCard(level)],
    ),
    previewGitHubSearch: () => null,
    getGitHubStatus: async () => {
      statusCalls += 1;
      return status;
    },
    rawSearchConsentStore: {
      issue(query) {
        consentCalls += 1;
        return baseStore.issue(query);
      },
      consume: baseStore.consume,
      revoke: baseStore.revoke,
    },
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;
  const recommend = () => fetch(`${base}/api/recommend`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "未知任务" }),
  }).then((response) => response.json());

  assert.deepEqual(await recommend(), {
    localMatchLevel: "strong",
    results: [localCard("strong")],
    githubSearch: null,
    githubStatus: null,
    rawConsent: null,
  });
  assert.equal(statusCalls, 0);

  level = "weak";
  assert.deepEqual((await recommend()).githubStatus, status);
  level = "none";
  assert.deepEqual((await recommend()).githubStatus, status);
  assert.equal(statusCalls, 2);
  assert.equal(consentCalls, 0);

  status = githubStatus("ready");
  const ready = await recommend();
  assert.equal(ready.githubStatus.state, "ready");
  assert.ok(ready.rawConsent);
  assert.equal(consentCalls, 1);
});

test("a missing status dependency fails closed without remote or consent side effects", async (context) => {
  let level = "strong";
  const calls = { finder: 0, original: 0, issue: 0, consume: 0 };
  const baseStore = createRawSearchConsentStore();
  const api = createLocalApiBase({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => localRecommendation(
      level,
      level === "none" ? [] : [localCard(level)],
    ),
    previewGitHubSearch: () => ({ terms: ["news"], label: "news" }),
    findGitHubSuggestions: async () => { calls.finder += 1; },
    findOriginalGitHubSuggestions: async () => { calls.original += 1; },
    rawSearchConsentStore: {
      issue(query) {
        calls.issue += 1;
        return baseStore.issue(query);
      },
      consume(input) {
        calls.consume += 1;
        return baseStore.consume(input);
      },
      revoke: baseStore.revoke,
    },
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;
  const expectedMissingStatus = (checkedAt) => ({
    state: "missing-token",
    checkedAt,
    rateLimits: { search: null, codeSearch: null },
  });

  const statusResponse = await fetch(`${base}/api/github-status`);
  const statusBody = await statusResponse.json();
  assert.equal(statusResponse.status, 200);
  assert.deepEqual(statusBody, expectedMissingStatus(statusBody.checkedAt));
  assert.equal(Number.isNaN(Date.parse(statusBody.checkedAt)), false);

  const recommendRequest = () => postResponse(base, "/api/recommend", { query: "news" });
  const strongResponse = await recommendRequest();
  assert.deepEqual(await strongResponse.json(), {
    localMatchLevel: "strong",
    results: [localCard("strong")],
    githubSearch: null,
    githubStatus: null,
    rawConsent: null,
  });

  for (const weakLevel of ["weak", "none"]) {
    level = weakLevel;
    const response = await recommendRequest();
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.githubStatus, expectedMissingStatus(body.githubStatus.checkedAt));
    assert.equal(body.rawConsent, null);
  }

  const sanitized = await postResponse(base, "/api/github-suggestions", { query: "news" });
  assert.equal(sanitized.status, 503);
  assert.deepEqual(await sanitized.json(), {
    error: "github-token-missing",
    stage: "repository-search",
  });
  const original = await postResponse(base, "/api/github-suggestions/original", {
    query: "news",
    consentToken: "apparently-valid-consent",
  });
  assert.equal(original.status, 503);
  assert.deepEqual(await original.json(), {
    error: "github-token-missing",
    stage: "repository-search",
  });
  assert.deepEqual(calls, { finder: 0, original: 0, issue: 0, consume: 0 });
});

test("recommend logs only fixed safe status and preview dependency failures", async (context) => {
  const sentinel = "private-recommend-token-sentinel";
  let accessorCalls = 0;
  let proxyTrapCalls = 0;
  const statusAccessor = githubStatus();
  Object.defineProperty(statusAccessor, "state", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      throw new Error(sentinel);
    },
  });
  const previewAccessor = { label: "news" };
  Object.defineProperty(previewAccessor, "terms", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      throw new Error(sentinel);
    },
  });
  const previewProxy = new Proxy({ terms: ["news"], label: "news" }, {
    getOwnPropertyDescriptor() {
      proxyTrapCalls += 1;
      throw new Error(sentinel);
    },
  });
  const cases = [
    {
      getGitHubStatus: async () => { throw new Error(`${sentinel} remote-body`); },
      previewGitHubSearch: () => null,
    },
    {
      getGitHubStatus: async () => statusAccessor,
      previewGitHubSearch: () => null,
    },
    {
      getGitHubStatus: async () => githubStatus(),
      previewGitHubSearch: () => { throw new Error(`${sentinel} remote-body`); },
    },
    {
      getGitHubStatus: async () => githubStatus(),
      previewGitHubSearch: () => previewAccessor,
    },
    {
      getGitHubStatus: async () => githubStatus(),
      previewGitHubSearch: () => previewProxy,
    },
  ];

  for (const fixture of cases) {
    const logged = [];
    const api = createLocalApiBase({
      port: 0,
      syncCatalog: async () => ({ skills: [] }),
      getCatalog: async () => ({ skills: [] }),
      recommend: () => localRecommendation(),
      ...fixture,
      onError(error) {
        const descriptors = Object.getOwnPropertyDescriptors(error);
        logged.push({
          message: descriptors.message?.value,
          code: descriptors.code?.value,
          stack: descriptors.stack,
        });
      },
    });
    const address = await api.listen();
    context.after(() => api.close());
    const response = await postResponse(
      `http://127.0.0.1:${address.port}`,
      "/api/recommend",
      { query: "news" },
    );
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.deepEqual(body, { error: "request-failed" });
    assert.deepEqual(logged, [{
      message: "github-request-failed",
      code: "github-request-failed",
      stack: undefined,
    }]);
    assert.doesNotMatch(JSON.stringify({ body, logged }), new RegExp(sentinel, "u"));
  }
  assert.equal(accessorCalls, 0);
  assert.equal(proxyTrapCalls, 0);
});

test("non-ready status makes zero finder, consent-issue, or consent-consume calls", async (context) => {
  for (const state of ["missing-token", "invalid-token", "rate-limited", "github-unavailable"]) {
    const calls = { finder: 0, original: 0, issue: 0, consume: 0 };
    const baseStore = createRawSearchConsentStore();
    const api = createLocalApi({
      port: 0,
      syncCatalog: async () => ({ skills: [] }),
      getCatalog: async () => ({ skills: [] }),
      recommend: () => localRecommendation("weak", [localCard("weak")]),
      previewGitHubSearch: () => ({ terms: ["news"], label: "news" }),
      getGitHubStatus: async () => githubStatus(state, state === "rate-limited" ? {
        rateLimits: {
          search: { remaining: 0, reset: 1_780_000_000, retryAt: "2026-05-27T04:26:40.000Z" },
          codeSearch: null,
        },
      } : {}),
      findGitHubSuggestions: async () => { calls.finder += 1; },
      findOriginalGitHubSuggestions: async () => { calls.original += 1; },
      rawSearchConsentStore: {
        issue(query) {
          calls.issue += 1;
          return baseStore.issue(query);
        },
        consume(input) {
          calls.consume += 1;
          return baseStore.consume(input);
        },
        revoke: baseStore.revoke,
      },
      onError() {},
    });
    const address = await api.listen();
    context.after(() => api.close());
    const base = `http://127.0.0.1:${address.port}`;

    const sanitized = await postResponse(base, "/api/github-suggestions", { query: "news" });
    assert.equal(sanitized.status, {
      "missing-token": 503,
      "invalid-token": 401,
      "rate-limited": 429,
      "github-unavailable": 502,
    }[state]);
    const body = await sanitized.json();
    assert.equal(body.error, {
      "missing-token": "github-token-missing",
      "invalid-token": "github-token-invalid",
      "rate-limited": "github-rate-limited",
      "github-unavailable": "github-unavailable",
    }[state]);
    assert.ok(Object.keys(body).every((key) => ["error", "retryAt", "stage"].includes(key)));

    const original = await fetch(`${base}/api/github-suggestions/original`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "news", consentToken: "apparently-valid-consent" }),
    });
    assert.equal(original.status, sanitized.status);
    assert.deepEqual(calls, { finder: 0, original: 0, issue: 0, consume: 0 });
  }
});

test("returns weak local matches with a sanitized preview and blocks GitHub only for strong matches", async (context) => {
  let level = "strong";
  let remoteCalls = 0;
  const catalog = { skills: [] };
  const preview = { terms: ["analysis", "skill"], label: "analysis · skill" };
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => catalog,
    getCatalog: async () => catalog,
    recommend: () => localRecommendation(
      level,
      level === "none" ? [] : [localCard(level)],
    ),
    previewGitHubSearch: () => preview,
    findGitHubSuggestions: async () => {
      remoteCalls += 1;
      return {
        preview,
        results: [],
        cached: false,
        incomplete: true,
        rateLimit: null,
        diagnostics: githubDiagnostics({ stageReached: "code-search", incomplete: true }),
      };
    },
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;

  const request = (path) => fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "分析任务" }),
  });

  assert.equal((await request("/api/github-suggestions")).status, 409);
  assert.equal(remoteCalls, 0);

  level = "weak";
  const weak = await request("/api/recommend");
  assert.equal(weak.status, 200);
  assert.deepEqual(await weak.json(), {
    localMatchLevel: "weak",
    results: [localCard("weak")],
    githubSearch: preview,
    githubStatus: githubStatus(),
    rawConsent: null,
  });
  assert.equal((await request("/api/github-suggestions")).status, 200);
  assert.equal(remoteCalls, 1);

  level = "none";
  const none = await request("/api/recommend");
  assert.equal(none.status, 200);
  assert.deepEqual(await none.json(), {
    localMatchLevel: "none",
    results: [],
    githubSearch: preview,
    githubStatus: githubStatus(),
    rawConsent: null,
  });
  assert.equal((await request("/api/github-suggestions")).status, 200);
  assert.equal(remoteCalls, 2);
});

test("rejects malformed local recommendation envelopes without exposing dependency data", async (context) => {
  const sentinel = "private-local-recommendation-sentinel";
  let accessorCalls = 0;
  let proxyTrapCalls = 0;
  const accessorEnvelope = { results: [] };
  Object.defineProperty(accessorEnvelope, "level", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return sentinel;
    },
  });
  const proxyEnvelope = new Proxy(
    { level: "none", results: [] },
    {
      getOwnPropertyDescriptor() {
        proxyTrapCalls += 1;
        throw new Error(sentinel);
      },
    },
  );
  const accessorItem = localCard("accessor-item");
  Object.defineProperty(accessorItem, "summaryZh", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return sentinel;
    },
  });
  const proxyItem = new Proxy(localCard("proxy-item"), {
    getOwnPropertyDescriptor() {
      proxyTrapCalls += 1;
      throw new Error(sentinel);
    },
  });
  const fixtures = [
    [],
    accessorEnvelope,
    proxyEnvelope,
    { level: "invalid", results: [] },
    { level: "none", results: [], extra: sentinel },
    { level: "strong", results: [localCard("private-item", { privatePath: sentinel })] },
    { level: "strong", results: [Object.create({ skillId: sentinel })] },
    { level: "strong", results: [accessorItem] },
    { level: "strong", results: [proxyItem] },
    { level: "weak", results: [] },
    { level: "strong", results: [] },
    { level: "none", results: new Array(4).fill({}) },
  ];

  for (const fixture of fixtures) {
    const api = createLocalApi({
      port: 0,
      syncCatalog: async () => ({ skills: [] }),
      getCatalog: async () => ({ skills: [] }),
      recommend: () => fixture,
      onError() {},
    });
    const address = await api.listen();
    context.after(() => api.close());
    const response = await fetch(`http://127.0.0.1:${address.port}/api/recommend`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "分析任务" }),
    });
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.deepEqual(body, { error: "request-failed" });
    assert.doesNotMatch(JSON.stringify(body), new RegExp(sentinel, "u"));
  }
  assert.equal(accessorCalls, 0);
  assert.equal(proxyTrapCalls, 0);
});

test("rejects extra matcher fields before preview, remote, or consent side effects", async (context) => {
  const sentinel = "private-extra-matcher-field";
  let previewCalls = 0;
  let remoteCalls = 0;
  let consentCalls = 0;
  const store = createRawSearchConsentStore();
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => ({ level: "none", results: [], extra: sentinel }),
    previewGitHubSearch: () => {
      previewCalls += 1;
      return { terms: ["analysis"], label: "analysis" };
    },
    findGitHubSuggestions: async () => {
      remoteCalls += 1;
      return {
        results: [],
        cached: false,
        incomplete: false,
        rateLimit: null,
        diagnostics: githubDiagnostics(),
      };
    },
    rawSearchConsentStore: {
      issue(query) {
        consentCalls += 1;
        return store.issue(query);
      },
      consume: store.consume,
      revoke: store.revoke,
    },
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;
  const request = (path) => fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "分析任务" }),
  });

  const recommendation = await request("/api/recommend");
  const recommendationBody = await recommendation.json();
  assert.equal(recommendation.status, 500);
  assert.deepEqual(recommendationBody, { error: "request-failed" });

  const remote = await request("/api/github-suggestions");
  const remoteBody = await remote.json();
  assert.equal(remote.status, 502);
  assert.deepEqual(remoteBody, { error: "github-request-failed" });
  assert.equal(previewCalls, 0);
  assert.equal(remoteCalls, 0);
  assert.equal(consentCalls, 0);
  assert.doesNotMatch(JSON.stringify({ recommendationBody, remoteBody }), new RegExp(sentinel, "u"));
});

test("rejects malformed internal previews before remote or consent side effects", async (context) => {
  const sentinel = "private-extra-preview-field";
  const fixtures = [
    { terms: ["analysis"], label: "analysis", cacheKey: "hash", extra: sentinel },
    { terms: ["analysis"], label: "analysis", cacheKey: 1 },
    { terms: "analysis", label: "analysis", cacheKey: "hash" },
  ];
  let fixture = fixtures[0];
  let remoteCalls = 0;
  let consentCalls = 0;
  const store = createRawSearchConsentStore();
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => localRecommendation(),
    previewGitHubSearch: () => fixture,
    findGitHubSuggestions: async () => {
      remoteCalls += 1;
      return {
        results: [],
        cached: false,
        incomplete: false,
        rateLimit: null,
        diagnostics: githubDiagnostics(),
      };
    },
    rawSearchConsentStore: {
      issue(query) {
        consentCalls += 1;
        return store.issue(query);
      },
      consume: store.consume,
      revoke: store.revoke,
    },
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;
  const request = (path) => fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "分析任务" }),
  });

  for (const value of fixtures) {
    fixture = value;
    const recommendation = await request("/api/recommend");
    const body = await recommendation.json();
    assert.equal(recommendation.status, 500);
    assert.deepEqual(body, { error: "request-failed" });
    assert.doesNotMatch(JSON.stringify(body), new RegExp(sentinel, "u"));
  }

  fixture = fixtures[0];
  const remote = await request("/api/github-suggestions");
  const remoteBody = await remote.json();
  assert.equal(remote.status, 502);
  assert.deepEqual(remoteBody, { error: "github-request-failed" });
  assert.equal(remoteCalls, 0);
  assert.equal(consentCalls, 0);
  assert.doesNotMatch(JSON.stringify(remoteBody), new RegExp(sentinel, "u"));
});

test("rejects unsupported methods, invalid queries, and oversized request bodies", async (context) => {
  const catalog = { skills: [] };
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => catalog,
    getCatalog: async () => catalog,
    recommend: () => localRecommendation(),
    previewGitHubSearch: () => null,
    findGitHubSuggestions: async () => ({
      preview: null,
      results: [],
      cached: false,
      incomplete: false,
      rateLimit: null,
      diagnostics: githubDiagnostics(),
    }),
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;

  for (const path of [
    "/api/recommend",
    "/api/github-suggestions",
    "/api/github-suggestions/original",
    "/api/github-suggestions/revoke",
  ]) {
    assert.equal((await fetch(`${base}${path}`)).status, 405);
    assert.equal((await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    })).status, 400);
    assert.equal((await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "x".repeat(4097) }),
    })).status, 400);
    assert.equal((await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "x", padding: "y".repeat(9000) }),
    })).status, 413);
  }
});

test("rejects parsed JSON values that are not plain request objects", async (context) => {
  const catalog = { skills: [] };
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => catalog,
    getCatalog: async () => catalog,
    recommend: () => localRecommendation(),
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;

  for (const path of [
    "/api/recommend",
    "/api/github-suggestions",
    "/api/github-suggestions/original",
    "/api/github-suggestions/revoke",
  ]) {
    for (const body of ["null", "[]", '"query"', "1", "true"]) {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      assert.equal(response.status, 400, `${path} must reject ${body}`);
      assert.deepEqual(await response.json(), {
        error: path.endsWith("/revoke") ? "invalid-consent" : "invalid-query",
      });
    }
  }
});

test("task routes reject extra request fields before local, remote, or consent side effects", async (context) => {
  const sentinel = "private-request-field-sentinel";
  const calls = {
    catalog: 0,
    recommend: 0,
    preview: 0,
    sanitized: 0,
    original: 0,
    issue: 0,
    consume: 0,
  };
  const store = createRawSearchConsentStore();
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => {
      calls.catalog += 1;
      return { skills: [] };
    },
    recommend: () => {
      calls.recommend += 1;
      return localRecommendation();
    },
    previewGitHubSearch: () => {
      calls.preview += 1;
      return { terms: ["news"], label: "news" };
    },
    findGitHubSuggestions: async () => {
      calls.sanitized += 1;
      return {
        preview: null,
        results: [],
        cached: false,
        incomplete: false,
        rateLimit: null,
        diagnostics: githubDiagnostics(),
      };
    },
    findOriginalGitHubSuggestions: async () => {
      calls.original += 1;
      return {
        preview: null,
        results: [],
        cached: false,
        incomplete: false,
        rateLimit: null,
        diagnostics: githubDiagnostics(),
      };
    },
    rawSearchConsentStore: {
      issue(query) {
        calls.issue += 1;
        return store.issue(query);
      },
      consume(options) {
        calls.consume += 1;
        return store.consume(options);
      },
      revoke: store.revoke,
    },
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;
  const fixtures = [
    ["/api/recommend", { query: "news", privatePath: sentinel }],
    ["/api/github-suggestions", { query: "news", privatePath: sentinel }],
    ["/api/github-suggestions/original", {
      query: "news",
      consentToken: "syntactically-valid-consent",
      privatePath: sentinel,
    }],
  ];

  for (const [path, body] of fixtures) {
    const response = await postResponse(base, path, body);
    const responseBody = await response.json();
    assert.equal(response.status, 400, path);
    assert.deepEqual(responseBody, { error: "invalid-query" });
    assert.doesNotMatch(JSON.stringify(responseBody), new RegExp(sentinel, "u"));
  }
  assert.deepEqual(calls, {
    catalog: 0,
    recommend: 0,
    preview: 0,
    sanitized: 0,
    original: 0,
    issue: 0,
    consume: 0,
  });
});

test("original search rejects missing, blank, or non-string consent", async (context) => {
  let catalogReads = 0;
  let originalCalls = 0;
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => {
      catalogReads += 1;
      return { skills: [] };
    },
    recommend: () => localRecommendation(),
    findOriginalGitHubSuggestions: async () => { originalCalls += 1; },
    rawSearchConsentStore: createRawSearchConsentStore(),
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;

  for (const consentToken of [
    undefined,
    "",
    "   ",
    "invalid:token:value",
    "x".repeat(513),
    null,
    [],
    {},
    1,
    true,
  ]) {
    const body = { query: "检测数据" };
    if (consentToken !== undefined) body.consentToken = consentToken;
    const response = await fetch(`${base}/api/github-suggestions/original`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid-consent" });
  }
  assert.equal(catalogReads, 0);
  assert.equal(originalCalls, 0);
});

test("original search reports a missing finder before consuming valid consent", async (context) => {
  const store = createRawSearchConsentStore({ createToken: () => "finder-missing-consent" });
  const consent = store.issue("检测数据");
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => localRecommendation(),
    rawSearchConsentStore: store,
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/github-suggestions/original`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "检测数据", consentToken: consent.token }),
    },
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "github-suggestions-unavailable" });
  assert.equal(store.consume({ token: consent.token, query: "检测数据" }), true);
});

test("malformed consent issuance and consumption fail closed", async (context) => {
  const sentinel = "consent-accessor-secret";
  let accessorCalls = 0;
  let originalCalls = 0;
  const malformedConsent = { expiresAt: "2026-08-16T00:05:00.000Z" };
  Object.defineProperty(malformedConsent, "token", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return sentinel;
    },
  });
  const store = {
    issue: () => malformedConsent,
    consume: () => ({}),
    revoke: () => false,
  };
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => localRecommendation(),
    previewGitHubSearch: () => null,
    findOriginalGitHubSuggestions: async () => {
      originalCalls += 1;
      return {
        preview: null,
        results: [],
        cached: false,
        incomplete: false,
        rateLimit: null,
        diagnostics: githubDiagnostics(),
      };
    },
    rawSearchConsentStore: store,
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;

  const recommendation = await fetch(`${base}/api/recommend`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "未知任务" }),
  });
  assert.equal(recommendation.status, 500);
  assert.deepEqual(await recommendation.json(), { error: "request-failed" });
  assert.equal(accessorCalls, 0);

  const original = await fetch(`${base}/api/github-suggestions/original`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "未知任务", consentToken: "apparently-valid-consent" }),
  });
  assert.equal(original.status, 403);
  assert.deepEqual(await original.json(), { error: "raw-consent-required" });
  assert.equal(originalCalls, 0);
});

test("consent issuance rejects tokens that cannot be revoked", async (context) => {
  for (const token of ["invalid:token:value", "x".repeat(513)]) {
    const api = createLocalApi({
      port: 0,
      syncCatalog: async () => ({ skills: [] }),
      getCatalog: async () => ({ skills: [] }),
      recommend: () => localRecommendation(),
      previewGitHubSearch: () => null,
      rawSearchConsentStore: {
        issue: () => ({ token, expiresAt: "2026-08-16T00:05:00.000Z" }),
        consume: () => false,
        revoke: () => false,
      },
      onError() {},
    });
    const address = await api.listen();
    context.after(() => api.close());
    const response = await fetch(`http://127.0.0.1:${address.port}/api/recommend`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "未知任务" }),
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "request-failed" });
  }
});

test("request routes reject inherited body fields without invoking prototype getters", async (context) => {
  let getterCalls = 0;
  let sanitizedCalls = 0;
  let originalCalls = 0;
  let consumeCalls = 0;
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => localRecommendation(),
    previewGitHubSearch: () => ({ terms: ["news"], label: "news" }),
    findGitHubSuggestions: async () => {
      sanitizedCalls += 1;
      return {
        preview: null,
        results: [],
        cached: false,
        incomplete: false,
        rateLimit: null,
        diagnostics: githubDiagnostics(),
      };
    },
    findOriginalGitHubSuggestions: async () => {
      originalCalls += 1;
      return {
        preview: null,
        results: [],
        cached: false,
        incomplete: false,
        rateLimit: null,
        diagnostics: githubDiagnostics(),
      };
    },
    rawSearchConsentStore: {
      issue: () => ({
        token: "prototype-pollution-consent",
        expiresAt: "2026-08-16T00:05:00.000Z",
      }),
      consume: () => {
        consumeCalls += 1;
        return true;
      },
      revoke: () => false,
    },
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;

  const inheritedQuery = await rawJsonRequest(
    address.port,
    "/api/github-suggestions",
    {},
    {
      beforeSend() {
        Object.defineProperty(Object.prototype, "query", {
          configurable: true,
          get() {
            getterCalls += 1;
            return "news";
          },
        });
      },
      afterReceive() { delete Object.prototype.query; },
    },
  );
  assert.equal(inheritedQuery.status, 400);
  assert.deepEqual(inheritedQuery.body, { error: "invalid-query" });
  assert.equal(getterCalls, 0);

  Object.defineProperty(Object.prototype, "consentToken", {
    configurable: true,
    value: "inherited-valid-consent",
    writable: true,
  });
  try {
    const inheritedConsent = await fetch(`${base}/api/github-suggestions/original`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "news" }),
    });
    assert.equal(inheritedConsent.status, 400);
    assert.deepEqual(await inheritedConsent.json(), { error: "invalid-consent" });
  } finally {
    delete Object.prototype.consentToken;
  }

  assert.equal(getterCalls, 0);
  assert.equal(sanitizedCalls, 0);
  assert.equal(originalCalls, 0);
  assert.equal(consumeCalls, 0);
});

test("consent store descriptors ignore inherited value accessors", () => {
  let inheritedValueReads = 0;
  const accessorStore = { consume() {}, revoke() {} };
  Object.defineProperty(accessorStore, "issue", {
    configurable: true,
    get() {
      throw new Error("store-accessor-secret");
    },
  });
  Object.defineProperty(Object.prototype, "value", {
    configurable: true,
    get() {
      inheritedValueReads += 1;
      throw new Error("inherited-value-secret");
    },
  });
  try {
    assert.doesNotThrow(() => createLocalApi({
      syncCatalog() {},
      getCatalog() {},
      recommend: () => localRecommendation(),
      rawSearchConsentStore: {
        issue() {},
        consume() {},
        revoke() {},
      },
    }));

    assert.throws(
      () => createLocalApi({
        syncCatalog() {},
        getCatalog() {},
        recommend: () => localRecommendation(),
        rawSearchConsentStore: accessorStore,
      }),
      /invalid-consent-store/u,
    );
  } finally {
    delete Object.prototype.value;
  }
  assert.equal(inheritedValueReads, 0);
});

test("revoke endpoint is idempotent and prevents later original search", async (context) => {
  const store = createRawSearchConsentStore({ createToken: () => "api-revocation-token" });
  const issued = store.issue("原始任务");
  let originalCalls = 0;
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => localRecommendation(),
    findOriginalGitHubSuggestions: async () => {
      originalCalls += 1;
      return {
        preview: null,
        results: [],
        cached: false,
        incomplete: false,
        rateLimit: null,
        diagnostics: githubDiagnostics(),
      };
    },
    rawSearchConsentStore: store,
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const revoked = await fetch(`${base}/api/github-suggestions/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ consentToken: issued.token }),
    });
    assert.equal(revoked.status, 204);
    assert.equal(await revoked.text(), "");
  }

  const original = await fetch(`${base}/api/github-suggestions/original`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "原始任务", consentToken: issued.token }),
  });
  assert.equal(original.status, 403);
  assert.deepEqual(await original.json(), { error: "raw-consent-required" });
  assert.equal(originalCalls, 0);
});

test("revoke endpoint accepts only one own data consent token", async (context) => {
  let revokeCalls = 0;
  const store = createRawSearchConsentStore();
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => localRecommendation(),
    rawSearchConsentStore: {
      issue: store.issue,
      consume: store.consume,
      revoke(token) {
        revokeCalls += 1;
        return store.revoke(token);
      },
    },
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;

  for (const body of [
    {},
    { consentToken: "" },
    { consentToken: "short" },
    { consentToken: null },
    { consentToken: [] },
    { consentToken: "valid-looking-token", extra: true },
  ]) {
    const response = await fetch(`${base}/api/github-suggestions/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid-consent" });
  }

  const inherited = await rawJsonRequest(
    address.port,
    "/api/github-suggestions/revoke",
    {},
    {
      beforeSend() {
        Object.defineProperty(Object.prototype, "consentToken", {
          configurable: true,
          get() { throw new Error("inherited-consent-secret"); },
        });
      },
      afterReceive() { delete Object.prototype.consentToken; },
    },
  );
  assert.equal(inherited.status, 400);
  assert.deepEqual(inherited.body, { error: "invalid-consent" });
  assert.equal(revokeCalls, 0);
});

test("revoke failures use a fixed safe response and log", async (context) => {
  const sentinel = "private-revoke-token-sentinel";
  const logged = [];
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => localRecommendation(),
    rawSearchConsentStore: {
      issue() {},
      consume() { return false; },
      revoke() { throw new Error(`${sentinel} remote-body stack`); },
    },
    onError(error) {
      logged.push({
        message: error.message,
        code: error.code,
        hasStack: Object.hasOwn(error, "stack"),
      });
    },
  });
  const address = await api.listen();
  context.after(() => api.close());
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/github-suggestions/revoke`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ consentToken: sentinel }),
    },
  );
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.deepEqual(body, { error: "github-request-failed" });
  assert.deepEqual(logged, [{
    message: "github-request-failed",
    code: "github-request-failed",
    hasStack: false,
  }]);
  assert.doesNotMatch(JSON.stringify({ body, logged }), new RegExp(sentinel, "u"));
});

test("missing or accessor revoke store methods fail at construction without getter calls", () => {
  assert.throws(
    () => createLocalApi({
      syncCatalog() {},
      getCatalog() {},
      recommend: () => localRecommendation(),
      rawSearchConsentStore: { issue() {}, consume() {} },
    }),
    /invalid-consent-store/u,
  );

  let getterCalls = 0;
  const store = { issue() {}, consume() {} };
  Object.defineProperty(store, "revoke", {
    get() {
      getterCalls += 1;
      throw new Error("revoke-getter-secret");
    },
  });
  assert.throws(
    () => createLocalApi({
      syncCatalog() {},
      getCatalog() {},
      recommend: () => localRecommendation(),
      rawSearchConsentStore: store,
    }),
    /invalid-consent-store/u,
  );
  assert.equal(getterCalls, 0);
});
