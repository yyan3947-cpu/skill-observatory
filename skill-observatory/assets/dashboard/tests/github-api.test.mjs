import assert from "node:assert/strict";
import test from "node:test";

import { createLocalApi } from "../lib/local-api.mjs";

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
  };
}

test("remote suggestions require an empty local result and an explicit request", async (context) => {
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
      return query.includes("本机可用") ? [{ name: "local-skill" }] : [];
    },
    previewGitHubSearch: () => preview,
    findGitHubSuggestions: async ({ query }) => {
      remoteCalls += 1;
      assert.equal(query, "画架构图");
      return suggestionResponse(preview);
    },
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;

  const local = await post(base, "/api/recommend", { query: "本机可用" });
  assert.equal(local.githubSearch, null);
  assert.equal(recommendCalls, 1);

  const missing = await post(base, "/api/recommend", { query: "画架构图" });
  assert.equal(missing.githubSearch.label, "diagram · skill");
  assert.equal(recommendCalls, 2);
  assert.equal(remoteCalls, 0);

  const blocked = await postResponse(base, "/api/github-suggestions", { query: "本机可用" });
  assert.equal(blocked.status, 409);
  assert.deepEqual(await blocked.json(), { error: "local-match-available" });
  assert.equal(remoteCalls, 0);

  assert.deepEqual(
    await post(base, "/api/github-suggestions", { query: "画架构图" }),
    suggestionResponse(preview),
  );
  assert.equal(remoteCalls, 1);
});

test("rechecks the live local catalog before a remote call", async (context) => {
  const catalog = { localAvailable: false, skills: [] };
  let remoteCalls = 0;
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => catalog,
    getCatalog: async () => catalog,
    recommend: (_query, currentCatalog) => currentCatalog.localAvailable ? [{ name: "new-local-skill" }] : [],
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

test("preserves an unknown preview without making /api/recommend remote", async (context) => {
  let remoteCalls = 0;
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => [],
    previewGitHubSearch: () => null,
    findGitHubSuggestions: async () => {
      remoteCalls += 1;
      return suggestionResponse(null);
    },
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;

  assert.deepEqual(await post(base, "/api/recommend", { query: "unknown" }), {
    results: [],
    githubSearch: null,
  });
  assert.equal(remoteCalls, 0);
  assert.deepEqual(
    await post(base, "/api/github-suggestions", { query: "unknown" }),
    suggestionResponse(null),
  );
  assert.equal(remoteCalls, 1);
});

test("returns a minimal safe rate-limit response", async (context) => {
  const retryAt = "2026-08-15T01:02:03.000Z";
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => [],
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
    recommend: () => [],
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
    recommend: () => [],
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

test("defaults preview safely and reports a missing GitHub finder as unavailable", async (context) => {
  let reportedErrors = 0;
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => [],
    onError() { reportedErrors += 1; },
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;

  assert.deepEqual(await post(base, "/api/recommend", { query: "news" }), {
    results: [],
    githubSearch: null,
  });
  const response = await postResponse(base, "/api/github-suggestions", { query: "news" });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "github-suggestions-unavailable" });
  assert.equal(reportedErrors, 0);
});
