import assert from "node:assert/strict";
import test from "node:test";
import { createLocalApi } from "../lib/local-api.mjs";

test("serves only the private API contract", async (context) => {
  const catalog = { skills: [], metrics: { installed: 0 } };
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => catalog,
    getCatalog: async () => catalog,
    recommend: (query) => query.includes("A股") ? [{ name: "a-share-analysis" }] : [],
    previewGitHubSearch: () => null,
    findGitHubSuggestions: async () => ({
      preview: null,
      results: [],
      cached: false,
      incomplete: false,
      rateLimit: null,
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
    results: [{ name: "a-share-analysis" }],
    githubSearch: null,
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

test("rejects unsupported methods, invalid queries, and oversized request bodies", async (context) => {
  const catalog = { skills: [] };
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => catalog,
    getCatalog: async () => catalog,
    recommend: () => [],
    previewGitHubSearch: () => null,
    findGitHubSuggestions: async () => ({
      preview: null,
      results: [],
      cached: false,
      incomplete: false,
      rateLimit: null,
    }),
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;

  for (const path of ["/api/recommend", "/api/github-suggestions"]) {
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
    recommend: () => [],
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;

  for (const path of ["/api/recommend", "/api/github-suggestions"]) {
    for (const body of ["null", "[]", '"query"', "1", "true"]) {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      assert.equal(response.status, 400, `${path} must reject ${body}`);
      assert.deepEqual(await response.json(), { error: "invalid-query" });
    }
  }
});
