import assert from "node:assert/strict";
import { connect } from "node:net";
import test from "node:test";
import { createLocalApi } from "../lib/local-api.mjs";
import { createRawSearchConsentStore } from "../lib/raw-search-consent.mjs";

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
    recommend: () => [],
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
    recommend: () => [],
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
    recommend: () => [],
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
    recommend: () => [],
    previewGitHubSearch: () => null,
    findOriginalGitHubSuggestions: async () => {
      originalCalls += 1;
      return {
        preview: null,
        results: [],
        cached: false,
        incomplete: false,
        rateLimit: null,
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
      recommend: () => [],
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
    recommend: () => [],
    previewGitHubSearch: () => ({ terms: ["news"], label: "news" }),
    findGitHubSuggestions: async () => {
      sanitizedCalls += 1;
      return {
        preview: null,
        results: [],
        cached: false,
        incomplete: false,
        rateLimit: null,
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
      recommend() {},
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
        recommend() {},
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
    recommend: () => [],
    findOriginalGitHubSuggestions: async () => {
      originalCalls += 1;
      return {
        preview: null,
        results: [],
        cached: false,
        incomplete: false,
        rateLimit: null,
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
    recommend: () => [],
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
    recommend: () => [],
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
      recommend() {},
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
      recommend() {},
      rawSearchConsentStore: store,
    }),
    /invalid-consent-store/u,
  );
  assert.equal(getterCalls, 0);
});
