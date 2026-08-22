import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
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

async function postResponse(base, path, body, origin = "http://127.0.0.1:3000") {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

async function post(base, path, body, origin) {
  const response = await postResponse(base, path, body, origin);
  assert.equal(response.status, 200);
  return response.json();
}

function suggestionResponse(preview) {
  return {
    preview,
    results: [],
    cached: false,
    incomplete: false,
    rateLimit: null,
    diagnostics: githubDiagnostics(),
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

function githubCard(name = "example", overrides = {}) {
  return {
    repository: "owner/repo",
    repositoryUrl: "https://github.com/owner/repo",
    skillDirectory: `skills/${name}`,
    name,
    summary: "GitHub Skill summary",
    reasonZh: "任务能力匹配",
    stars: 42,
    pushedAt: "2026-08-16T00:00:00.000Z",
    license: null,
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test("remote suggestions require no strong local result and an explicit request", async (context) => {
  const catalog = { skills: [] };
  const preview = { terms: ["diagram", "skill"], label: "diagram · skill", cacheKey: "hash" };
  let remoteCalls = 0;
  let recommendCalls = 0;
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => catalog,
    getCatalog: async () => catalog,
    recommend: (query) => {
      recommendCalls += 1;
      return query.includes("本机可用")
        ? localRecommendation("strong", [localCard()])
        : localRecommendation();
    },
    previewGitHubSearch: () => preview,
    findGitHubSuggestions: async ({ query }) => {
      remoteCalls += 1;
      assert.equal(query, "画架构图");
      return suggestionResponse(preview);
    },
    rawSearchConsentStore: createRawSearchConsentStore({
      createToken: () => "complete-zero-consent",
    }),
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;

  const local = await post(base, "/api/recommend", { query: "本机可用" });
  assert.deepEqual(local, {
    localMatchLevel: "strong",
    results: [localCard()],
    githubSearch: null,
    githubStatus: null,
    rawConsent: null,
  });
  assert.equal(recommendCalls, 1);

  const missing = await post(base, "/api/recommend", { query: "画架构图" });
  assert.equal(missing.localMatchLevel, "none");
  assert.deepEqual(missing.githubStatus, githubStatus());
  assert.deepEqual(missing.githubSearch, {
    terms: ["diagram", "skill"],
    label: "diagram · skill",
  });
  assert.equal(missing.rawConsent, null);
  assert.equal(recommendCalls, 2);
  assert.equal(remoteCalls, 0);

  const blocked = await postResponse(base, "/api/github-suggestions", { query: "本机可用" });
  assert.equal(blocked.status, 409);
  assert.deepEqual(await blocked.json(), { error: "local-match-available" });
  assert.equal(remoteCalls, 0);

  const remote = await post(base, "/api/github-suggestions", { query: "画架构图" });
  assert.deepEqual(
    { ...remote, rawConsent: null },
    {
      ...suggestionResponse({ terms: preview.terms, label: preview.label }),
      rawConsent: null,
    },
  );
  assert.equal(remote.rawConsent.token, "complete-zero-consent");
  assert.equal(remoteCalls, 1);
});

test("rechecks the live local catalog before a remote call", async (context) => {
  const catalog = { localAvailable: false, skills: [] };
  let remoteCalls = 0;
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => catalog,
    getCatalog: async () => catalog,
    recommend: (_query, currentCatalog) => currentCatalog.localAvailable
      ? localRecommendation("strong", [localCard("new-local-skill")])
      : localRecommendation(),
    previewGitHubSearch: () => ({ terms: ["diagram", "skill"], label: "diagram · skill" }),
    findGitHubSuggestions: async () => {
      remoteCalls += 1;
      return suggestionResponse(null);
    },
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;

  const initial = await post(base, "/api/recommend", { query: "画架构图" });
  assert.equal(initial.results.length, 0);
  assert.ok(initial.githubSearch);

  catalog.localAvailable = true;
  const response = await postResponse(base, "/api/github-suggestions", { query: "画架构图" });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "local-match-available" });
  assert.equal(remoteCalls, 0);
});

test("issues consent for an unknown preview without making /api/recommend remote", async (context) => {
  let remoteCalls = 0;
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => localRecommendation(),
    previewGitHubSearch: () => null,
    findGitHubSuggestions: async () => {
      remoteCalls += 1;
      return suggestionResponse(null);
    },
    rawSearchConsentStore: createRawSearchConsentStore({
      createToken: () => "unknown-preview-consent",
    }),
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;

  const recommendation = await post(base, "/api/recommend", { query: "unknown" });
  assert.deepEqual(recommendation.results, []);
  assert.equal(recommendation.githubSearch, null);
  assert.equal(recommendation.rawConsent.token, "unknown-preview-consent");
  assert.match(recommendation.rawConsent.expiresAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(remoteCalls, 0);
  const response = await postResponse(base, "/api/github-suggestions", { query: "unknown" });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "sanitized-query-unavailable" });
  assert.equal(remoteCalls, 0);
});

test("returns a minimal safe rate-limit response", async (context) => {
  const retryAt = "2026-08-15T01:02:03.000Z";
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => localRecommendation(),
    previewGitHubSearch: () => ({ terms: ["news"], label: "news" }),
    findGitHubSuggestions: async () => {
      const error = new Error("github-rate-limited token=secret response-body-secret");
      error.code = "github-rate-limited";
      error.status = 429;
      error.retryAt = retryAt;
      throw error;
    },
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;

  const response = await postResponse(base, "/api/github-suggestions", { query: "news" });
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: "github-rate-limited", retryAt });
});

test("does not expose GitHub error messages, bodies, or tokens", async (context) => {
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => localRecommendation(),
    previewGitHubSearch: () => ({ terms: ["news"], label: "news" }),
    findGitHubSuggestions: async () => {
      const error = new Error(`response-body-secret ${["ghp", "token-secret"].join("_")}`);
      error.code = "github-request-failed";
      error.status = 418;
      throw error;
    },
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;

  const response = await postResponse(base, "/api/github-suggestions", { query: "news" });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.deepEqual(body, { error: "github-request-failed" });
  assert.doesNotMatch(JSON.stringify(body), /secret|token|body/i);
});

test("rejects non-loopback Origins before GitHub discovery", async (context) => {
  let remoteCalls = 0;
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => localRecommendation(),
    previewGitHubSearch: () => ({ terms: ["news"], label: "news" }),
    findGitHubSuggestions: async () => {
      remoteCalls += 1;
      return suggestionResponse(null);
    },
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;

  const response = await postResponse(base, "/api/github-suggestions", { query: "news" }, "https://evil.example");
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "origin-forbidden" });
  assert.equal(remoteCalls, 0);
});

test("reports a missing sanitized GitHub finder as unavailable", async (context) => {
  let reportedErrors = 0;
  const preview = { terms: ["news"], label: "news", cacheKey: "hash" };
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => localRecommendation(),
    previewGitHubSearch: () => preview,
    onError() { reportedErrors += 1; },
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;

  const recommendation = await post(base, "/api/recommend", { query: "news" });
  assert.deepEqual(recommendation.results, []);
  assert.deepEqual(recommendation.githubSearch, {
    terms: preview.terms,
    label: preview.label,
  });
  assert.equal(recommendation.rawConsent, null);
  const response = await postResponse(base, "/api/github-suggestions", { query: "news" });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "github-suggestions-unavailable" });
  assert.equal(reportedErrors, 0);
});

test("issues consent only after a complete sanitized zero-result and consumes it once", async (context) => {
  const catalog = { skills: [] };
  const preview = {
    terms: ["data validation", "testing", "skill"],
    label: "data validation · testing · skill",
    cacheKey: "hash",
  };
  let sanitizedCalls = 0;
  let originalCalls = 0;
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => catalog,
    getCatalog: async () => catalog,
    recommend: () => localRecommendation(),
    previewGitHubSearch: () => preview,
    findGitHubSuggestions: async () => {
      sanitizedCalls += 1;
      return suggestionResponse(preview);
    },
    findOriginalGitHubSuggestions: async ({ query }) => {
      originalCalls += 1;
      assert.equal(query, "检测数据");
      return suggestionResponse(null);
    },
    rawSearchConsentStore: createRawSearchConsentStore({
      createToken: () => "opaque-consent-token",
    }),
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;

  const local = await post(base, "/api/recommend", { query: "  检测数据  " });
  assert.equal(local.rawConsent, null);
  assert.equal(sanitizedCalls, 0);

  const sanitized = await post(base, "/api/github-suggestions", { query: "  检测数据  " });
  assert.equal(sanitizedCalls, 1);
  assert.equal(sanitized.rawConsent.token, "opaque-consent-token");

  const original = await post(base, "/api/github-suggestions/original", {
    query: "  检测数据  ",
    consentToken: sanitized.rawConsent.token,
  });
  assert.equal(original.preview, null);
  assert.equal(original.rawConsent, null);
  assert.equal(originalCalls, 1);

  const replay = await postResponse(base, "/api/github-suggestions/original", {
    query: "检测数据",
    consentToken: sanitized.rawConsent.token,
  });
  assert.equal(replay.status, 403);
  assert.deepEqual(await replay.json(), { error: "raw-consent-required" });
  assert.equal(originalCalls, 1);
});

test("recommend with no safe preview issues consent without remote I/O", async (context) => {
  let remoteCalls = 0;
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => localRecommendation(),
    previewGitHubSearch: () => null,
    findGitHubSuggestions: async () => { remoteCalls += 1; },
    findOriginalGitHubSuggestions: async () => { remoteCalls += 1; },
    rawSearchConsentStore: createRawSearchConsentStore({
      createToken: () => "no-preview-consent",
    }),
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const response = await post(
    `http://127.0.0.1:${address.port}`,
    "/api/recommend",
    { query: "未知任务" },
  );
  assert.equal(response.githubSearch, null);
  assert.equal(response.rawConsent.token, "no-preview-consent");
  assert.equal(remoteCalls, 0);
});

test("sanitized results or incomplete validation never issue original consent", async (context) => {
  const preview = { terms: ["news"], label: "news", cacheKey: "hash" };
  const fixtures = [
    { results: [githubCard("news-skill")], incomplete: false },
    { results: [], incomplete: true },
  ];
  for (const [index, fixture] of fixtures.entries()) {
    const api = createLocalApi({
      port: 0,
      syncCatalog: async () => ({ skills: [] }),
      getCatalog: async () => ({ skills: [] }),
      recommend: () => localRecommendation(),
      previewGitHubSearch: () => preview,
      findGitHubSuggestions: async () => ({
        preview,
        results: fixture.results,
        cached: false,
        incomplete: fixture.incomplete,
        rateLimit: null,
        diagnostics: githubDiagnostics({
          stageReached: fixture.incomplete ? "code-search" : "complete",
          incomplete: fixture.incomplete,
        }),
      }),
      rawSearchConsentStore: createRawSearchConsentStore({
        createToken: () => `unused-consent-${index}`,
      }),
      onError() {},
    });
    const address = await api.listen();
    context.after(() => api.close());
    const response = await post(
      `http://127.0.0.1:${address.port}`,
      "/api/github-suggestions",
      { query: "news" },
    );
    assert.equal(response.rawConsent, null);
  }
});

test("a new local match blocks both remote stages", async (context) => {
  let sanitizedCalls = 0;
  let originalCalls = 0;
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => localRecommendation("strong", [localCard("new-local-skill")]),
    previewGitHubSearch: () => ({ terms: ["news"], label: "news" }),
    findGitHubSuggestions: async () => { sanitizedCalls += 1; },
    findOriginalGitHubSuggestions: async () => { originalCalls += 1; },
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;
  for (const [path, body] of [
    ["/api/github-suggestions", { query: "news" }],
    ["/api/github-suggestions/original", { query: "news", consentToken: "unused-consent-token" }],
  ]) {
    const response = await postResponse(base, path, body);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "local-match-available" });
  }
  assert.equal(sanitizedCalls, 0);
  assert.equal(originalCalls, 0);
});

test("a weak local match permits both sanitized and consented original searches", async (context) => {
  const store = createRawSearchConsentStore({ createToken: () => "weak-local-consent" });
  const consent = store.issue("news");
  let sanitizedCalls = 0;
  let originalCalls = 0;
  const preview = { terms: ["news", "skill"], label: "news · skill" };
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => localRecommendation("weak", [localCard("possible-local-skill")]),
    previewGitHubSearch: () => preview,
    findGitHubSuggestions: async () => {
      sanitizedCalls += 1;
      return { ...suggestionResponse(preview), results: [githubCard("remote-skill")] };
    },
    findOriginalGitHubSuggestions: async () => {
      originalCalls += 1;
      return suggestionResponse(null);
    },
    rawSearchConsentStore: store,
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;

  const sanitized = await postResponse(base, "/api/github-suggestions", { query: "news" });
  assert.equal(sanitized.status, 200);
  const original = await postResponse(base, "/api/github-suggestions/original", {
    query: "news",
    consentToken: consent.token,
  });
  assert.equal(original.status, 200);
  assert.equal(sanitizedCalls, 1);
  assert.equal(originalCalls, 1);
});

test("a wrong-task token is rejected and consumed", async (context) => {
  const store = createRawSearchConsentStore({ createToken: () => "wrong-task-consent" });
  const consent = store.issue("任务甲");
  let originalCalls = 0;
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => localRecommendation(),
    findOriginalGitHubSuggestions: async () => { originalCalls += 1; },
    rawSearchConsentStore: store,
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;
  for (const query of ["任务乙", "任务甲"]) {
    const response = await postResponse(base, "/api/github-suggestions/original", {
      query,
      consentToken: consent.token,
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "raw-consent-required" });
  }
  assert.equal(originalCalls, 0);
});

test("GitHub errors use safe distinct status codes without issuing consent", async (context) => {
  for (const { code, status } of [
    { code: "github-token-missing", status: 503 },
    { code: "github-token-invalid", status: 401 },
    { code: "github-access-denied", status: 403 },
    { code: "github-query-rejected", status: 422 },
    { code: "github-request-timeout", status: 504 },
    { code: "github-network-failed", status: 502 },
    { code: "github-request-failed", status: 502 },
  ]) {
    const api = createLocalApi({
      port: 0,
      syncCatalog: async () => ({ skills: [] }),
      getCatalog: async () => ({ skills: [] }),
      recommend: () => localRecommendation(),
      previewGitHubSearch: () => ({ terms: ["news"], label: "news" }),
      findGitHubSuggestions: async () => {
        const error = new Error("remote-secret");
        Object.defineProperty(error, "code", { value: code, enumerable: true });
        throw error;
      },
      onError() {},
    });
    const address = await api.listen();
    context.after(() => api.close());
    const response = await postResponse(
      `http://127.0.0.1:${address.port}`,
      "/api/github-suggestions",
      { query: "news" },
    );
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: code });
  }
});

test("GitHub errors expose only validated retry and stage metadata", async (context) => {
  let stage = "code-search";
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => localRecommendation(),
    previewGitHubSearch: () => ({ terms: ["news"], label: "news" }),
    findGitHubSuggestions: async () => {
      const error = new Error("remote-stage-secret");
      Object.defineProperties(error, {
        code: { value: "github-network-failed", enumerable: true },
        stage: { value: stage, enumerable: true },
        retryAt: { value: "private-retry-sentinel", enumerable: true },
        responseBody: { value: "private-body-sentinel", enumerable: true },
      });
      throw error;
    },
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;

  const safe = await postResponse(base, "/api/github-suggestions", { query: "news" });
  assert.equal(safe.status, 502);
  assert.deepEqual(await safe.json(), {
    error: "github-network-failed",
    stage: "code-search",
  });

  stage = "private-stage-sentinel";
  const rejectedStage = await postResponse(base, "/api/github-suggestions", { query: "news" });
  const body = await rejectedStage.json();
  assert.deepEqual(body, { error: "github-network-failed" });
  assert.doesNotMatch(
    JSON.stringify(body),
    /private-stage-sentinel|private-retry-sentinel|private-body-sentinel/u,
  );
});

test("original query and remote error details never reach logs or responses", async (context) => {
  const sentinel = "private-original-query-sentinel";
  const logged = [];
  const store = createRawSearchConsentStore({ createToken: () => "logging-consent-token" });
  const consent = store.issue(sentinel);
  const originalError = new Error(`${sentinel} remote-body-secret`);
  Object.defineProperty(originalError, "code", {
    value: "github-request-failed",
    enumerable: true,
  });
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => localRecommendation(),
    findOriginalGitHubSuggestions: async () => { throw originalError; },
    rawSearchConsentStore: store,
    onError(error) {
      logged.push({
        sameObject: error === originalError,
        message: error.message,
        code: error.code,
        hasStack: Object.hasOwn(error, "stack"),
      });
    },
  });
  const address = await api.listen();
  context.after(() => api.close());
  const response = await postResponse(
    `http://127.0.0.1:${address.port}`,
    "/api/github-suggestions/original",
    { query: sentinel, consentToken: consent.token },
  );
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.deepEqual(body, { error: "github-request-failed" });
  assert.deepEqual(logged, [{
    sameObject: false,
    message: "github-request-failed",
    code: "github-request-failed",
    hasStack: false,
  }]);
  assert.doesNotMatch(
    JSON.stringify({ body, logged }),
    new RegExp(`${sentinel}|remote-body-secret`, "u"),
  );
});

test("malformed GitHub errors fail closed without invoking inherited accessors", async (context) => {
  let accessorCalls = 0;
  const inherited = {};
  Object.defineProperty(inherited, "code", {
    get() {
      accessorCalls += 1;
      throw new Error("accessor-secret");
    },
  });
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => localRecommendation(),
    previewGitHubSearch: () => ({ terms: ["news"], label: "news" }),
    findGitHubSuggestions: async () => { throw Object.create(inherited); },
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const response = await postResponse(
    `http://127.0.0.1:${address.port}`,
    "/api/github-suggestions",
    { query: "news" },
  );
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "github-request-failed" });
  assert.equal(accessorCalls, 0);
});

test("GitHub suggestion accessors are rejected before serialization", async (context) => {
  const sentinel = "suggestion-accessor-secret";
  let accessorCalls = 0;
  const result = {};
  Object.defineProperty(result, "name", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return sentinel;
    },
  });
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => localRecommendation(),
    previewGitHubSearch: () => ({ terms: ["news"], label: "news" }),
    findGitHubSuggestions: async () => ({
      preview: null,
      results: [result],
      cached: false,
      incomplete: false,
      rateLimit: null,
      diagnostics: githubDiagnostics(),
    }),
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const response = await postResponse(
    `http://127.0.0.1:${address.port}`,
    "/api/github-suggestions",
    { query: "news" },
  );
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.deepEqual(body, { error: "github-request-failed" });
  assert.equal(accessorCalls, 0);
  assert.doesNotMatch(JSON.stringify(body), new RegExp(sentinel, "u"));
});

test("GitHub dependency responses require exact public schemas before serialization", async (context) => {
  const sentinel = "private-github-response-sentinel";
  const preview = { terms: ["news"], label: "news", cacheKey: "hash" };
  let proxyTrapCalls = 0;
  const accessorCard = githubCard("accessor-card");
  Object.defineProperty(accessorCard, "summary", {
    enumerable: true,
    get() {
      throw new Error(sentinel);
    },
  });
  const proxiedCard = new Proxy(githubCard("proxy-card"), {
    getOwnPropertyDescriptor() {
      proxyTrapCalls += 1;
      throw new Error(sentinel);
    },
  });
  const accessorDiagnostics = githubDiagnostics();
  Object.defineProperty(accessorDiagnostics, "repositoryHits", {
    enumerable: true,
    get() {
      throw new Error(sentinel);
    },
  });
  const proxiedDiagnostics = new Proxy(githubDiagnostics(), {
    getOwnPropertyDescriptor() {
      proxyTrapCalls += 1;
      throw new Error(sentinel);
    },
  });
  const fixtures = [
    { ...suggestionResponse(preview), privatePath: sentinel },
    {
      ...suggestionResponse(preview),
      results: [githubCard("extra-card", { privatePath: sentinel })],
    },
    {
      ...suggestionResponse(preview),
      rateLimit: { remaining: 10, reset: 20, retryAt: null, privatePath: sentinel },
    },
    {
      ...suggestionResponse(preview),
      preview: { ...preview, privatePath: sentinel },
    },
    {
      ...suggestionResponse(preview),
      diagnostics: { ...githubDiagnostics(), privatePath: sentinel },
    },
    {
      ...suggestionResponse(preview),
      diagnostics: githubDiagnostics({
        rateLimits: { search: null, codeSearch: null, privatePath: sentinel },
      }),
    },
    {
      ...suggestionResponse(preview),
      diagnostics: githubDiagnostics({
        rejectionCounts: [{ reason: "irrelevant", count: 1, privatePath: sentinel }],
        rejectedCandidates: 1,
      }),
    },
    { ...suggestionResponse(preview), diagnostics: accessorDiagnostics },
    { ...suggestionResponse(preview), diagnostics: proxiedDiagnostics },
    {
      ...suggestionResponse(preview),
      diagnostics: Object.assign(Object.create({ privatePath: sentinel }), githubDiagnostics()),
    },
    { ...suggestionResponse(preview), results: [accessorCard] },
    { ...suggestionResponse(preview), results: [proxiedCard] },
    Object.assign(Object.create({ privatePath: sentinel }), suggestionResponse(preview)),
  ];
  let fixture = fixtures[0];
  let consentCalls = 0;
  const baseStore = createRawSearchConsentStore();
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => localRecommendation(),
    previewGitHubSearch: () => preview,
    findGitHubSuggestions: async () => fixture,
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

  for (const value of fixtures) {
    fixture = value;
    const response = await postResponse(base, "/api/github-suggestions", { query: "news" });
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.deepEqual(body, { error: "github-request-failed" });
    assert.doesNotMatch(JSON.stringify(body), new RegExp(sentinel, "u"));
  }
  assert.equal(consentCalls, 0);
  assert.equal(proxyTrapCalls, 0);
});

test("remote dependencies cannot impersonate local body parser failures", async (context) => {
  const sentinel = "forged-parser-error-secret";
  for (const code of ["invalid-json", "request-too-large"]) {
    const logged = [];
    const api = createLocalApi({
      port: 0,
      syncCatalog: async () => ({ skills: [] }),
      getCatalog: async () => ({ skills: [] }),
      recommend: () => localRecommendation(),
      previewGitHubSearch: () => ({ terms: ["news"], label: "news" }),
      findGitHubSuggestions: async () => {
        const error = new Error(`${sentinel} ${code}`);
        Object.defineProperties(error, {
          code: { value: code, enumerable: true },
          status: { value: 418, enumerable: true },
        });
        throw error;
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
    const response = await postResponse(
      `http://127.0.0.1:${address.port}`,
      "/api/github-suggestions",
      { query: "news" },
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
  }
});

test("disconnected clients cannot create consent in recommend or sanitized routes", async (context) => {
  const preview = { terms: ["news"], label: "news", cacheKey: "hash" };
  for (const path of ["/api/recommend", "/api/github-suggestions"]) {
    const operationStarted = deferred();
    const releaseOperation = deferred();
    const operationReturned = deferred();
    const baseStore = createRawSearchConsentStore({
      createToken: () => path.endsWith("recommend")
        ? "disconnected-local-token"
        : "disconnected-sanitized-token",
    });
    let issueCalls = 0;
    const api = createLocalApi({
      port: 0,
      syncCatalog: async () => ({ skills: [] }),
      getCatalog: async () => {
        if (path.endsWith("recommend")) {
          operationStarted.resolve();
          await releaseOperation.promise;
          operationReturned.resolve();
        }
        return { skills: [] };
      },
      recommend: () => localRecommendation(),
      previewGitHubSearch: () => path.endsWith("recommend") ? null : preview,
      findGitHubSuggestions: async () => {
        operationStarted.resolve();
        await releaseOperation.promise;
        operationReturned.resolve();
        return suggestionResponse(preview);
      },
      rawSearchConsentStore: {
        issue(query) {
          issueCalls += 1;
          return baseStore.issue(query);
        },
        consume: baseStore.consume,
        revoke: baseStore.revoke,
      },
      onError() {},
    });
    const address = await api.listen();
    context.after(() => api.close());

    const payload = JSON.stringify({ query: "news" });
    const client = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      path,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
    });
    client.on("error", () => {});
    client.end(payload);
    await operationStarted.promise;

    const closed = new Promise((resolve) => client.once("close", resolve));
    client.destroy();
    await closed;
    await new Promise((resolve) => setImmediate(resolve));
    releaseOperation.resolve();
    await operationReturned.promise;
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(issueCalls, 0, `${path} must not issue after disconnect`);
  }
});

test("a disconnect during consent issuance cannot leave a live token", async (context) => {
  const preview = { terms: ["news"], label: "news", cacheKey: "hash" };
  for (const path of ["/api/recommend", "/api/github-suggestions"]) {
    const token = path.endsWith("recommend")
      ? "issuance-race-local-token"
      : "issuance-race-sanitized-token";
    const baseStore = createRawSearchConsentStore({ createToken: () => token });
    const issued = deferred();
    let issuedConsent = null;
    let client;
    const api = createLocalApi({
      port: 0,
      syncCatalog: async () => ({ skills: [] }),
      getCatalog: async () => ({ skills: [] }),
      recommend: () => localRecommendation(),
      previewGitHubSearch: () => path.endsWith("recommend") ? null : preview,
      findGitHubSuggestions: async () => suggestionResponse(preview),
      rawSearchConsentStore: {
        issue(query) {
          issuedConsent = baseStore.issue(query);
          client.destroy();
          issued.resolve();
          return issuedConsent;
        },
        consume: baseStore.consume,
        revoke: baseStore.revoke,
      },
      onError() {},
    });
    const address = await api.listen();
    context.after(() => api.close());
    const payload = JSON.stringify({ query: "news" });
    client = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      path,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
    });
    client.on("error", () => {});
    const closed = new Promise((resolve) => client.once("close", resolve));
    client.end(payload);

    await issued.promise;
    await closed;
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(issuedConsent);
    assert.equal(
      baseStore.consume({ token: issuedConsent.token, query: "news" }),
      false,
      `${path} must revoke consent issued during a disconnect race`,
    );
  }
});
