import { createServer } from "node:http";
import { types } from "node:util";
import {
  DEFAULT_API_HOST,
  DEFAULT_API_PORT,
  isValidConsentToken,
  MAX_QUERY_BYTES,
  MAX_REQUEST_BODY_BYTES,
} from "./contracts.mjs";
import { createRawSearchConsentStore } from "./raw-search-consent.mjs";

const LOOPBACK_ORIGIN_RE = /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/;
const MAX_SAFE_JSON_DEPTH = 16;
const MAX_SAFE_JSON_ARRAY_ITEMS = 256;
const MAX_SAFE_JSON_OBJECT_PROPERTIES = 128;
const LOCAL_TRANSPORT_ERROR = Symbol("local-transport-error");
const MISSING_BODY_FIELD = Symbol("missing-body-field");

function localApiError(code, status, transport = false) {
  const error = new Error(code);
  Object.defineProperty(error, "code", {
    value: code,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  if (status !== undefined) {
    Object.defineProperty(error, "status", {
      value: status,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  if (transport) {
    Object.defineProperty(error, LOCAL_TRANSPORT_ERROR, {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }
  return error;
}

function sendJson(response, status, value, origin) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  if (origin && LOOPBACK_ORIGIN_RE.test(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "Origin";
  }
  response.writeHead(status, headers);
  response.end(`${JSON.stringify(value)}\n`);
}

function sendNoContent(response, origin) {
  const headers = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  if (origin && LOOPBACK_ORIGIN_RE.test(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "Origin";
  }
  response.writeHead(204, headers);
  response.end();
}

async function readJsonBody(request) {
  let total = 0;
  const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_REQUEST_BODY_BYTES) {
      throw localApiError("request-too-large", 413, true);
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw localApiError("invalid-json", 400, true);
  }
}

function isValidQuery(value) {
  return typeof value === "string" && value.trim() && Buffer.byteLength(value) <= MAX_QUERY_BYTES;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function snapshotRequestBody(value, requiredFields, { exact = false } = {}) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    types.isProxy(value)
  ) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;

  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (exact) {
    const allowedFields = new Set(requiredFields);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== requiredFields.length ||
      keys.some((key) => typeof key !== "string" || !allowedFields.has(key))
    ) {
      return null;
    }
  }
  const snapshot = Object.create(null);
  for (const field of requiredFields) {
    const descriptor = Object.hasOwn(descriptors, field) ? descriptors[field] : null;
    snapshot[field] = descriptor && Object.hasOwn(descriptor, "value")
      ? descriptor.value
      : MISSING_BODY_FIELD;
  }
  return snapshot;
}

function trackClientConnection(request, response) {
  const socket = request.socket;
  let disconnected = request.aborted || response.destroyed || socket.destroyed;
  const markDisconnected = () => {
    disconnected = true;
  };
  request.once("aborted", markDisconnected);
  response.once("close", markDisconnected);
  socket.once("close", markDisconnected);
  return {
    canRespond() {
      return (
        !disconnected &&
        !request.aborted &&
        !response.destroyed &&
        !socket.destroyed &&
        !response.writableEnded
      );
    },
    dispose() {
      request.off("aborted", markDisconnected);
      response.off("close", markDisconnected);
      socket.off("close", markDisconnected);
    },
  };
}

function safeRetryAt(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function ownDataProperty(value, key) {
  if (
    !value ||
    (typeof value !== "object" && typeof value !== "function") ||
    types.isProxy(value)
  ) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safeGitHubError(error) {
  const code = ownDataProperty(error, "code");
  if (code === "github-rate-limited") {
    return {
      status: 429,
      body: {
        error: "github-rate-limited",
        retryAt: safeRetryAt(ownDataProperty(error, "retryAt")),
      },
    };
  }
  if (code === "github-query-rejected") {
    return { status: 422, body: { error: "github-query-rejected" } };
  }
  if (code === "github-request-timeout") {
    return { status: 504, body: { error: "github-request-timeout" } };
  }
  if (code === "github-network-failed") {
    return { status: 502, body: { error: "github-network-failed" } };
  }
  return { status: 502, body: { error: "github-request-failed" } };
}

function safeGitHubLogError(code) {
  const error = new Error(code);
  delete error.stack;
  Object.defineProperty(error, "code", {
    value: code,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return error;
}

function reportError(onError, error) {
  try {
    onError(error);
  } catch {
    // Reporting must not change the API response or expose the original failure.
  }
}

function cloneSafeJsonValue(value, seen = new WeakSet(), depth = 0) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    seen.has(value) ||
    depth >= MAX_SAFE_JSON_DEPTH
  ) {
    throw localApiError("github-request-failed");
  }

  seen.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      const length = Object.hasOwn(descriptors, "length")
        ? descriptors.length.value
        : undefined;
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_SAFE_JSON_ARRAY_ITEMS
      ) {
        throw localApiError("github-request-failed");
      }
      const output = [];
      for (let index = 0; index < length; index += 1) {
        const key = String(index);
        const descriptor = Object.hasOwn(descriptors, key) ? descriptors[key] : undefined;
        if (!descriptor || !Object.hasOwn(descriptor, "value")) {
          throw localApiError("github-request-failed");
        }
        output.push(cloneSafeJsonValue(descriptor.value, seen, depth + 1));
      }
      const allowedKeys = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
      if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowedKeys.has(key))) {
        throw localApiError("github-request-failed");
      }
      return output;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw localApiError("github-request-failed");
    }
    const output = Object.create(null);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > MAX_SAFE_JSON_OBJECT_PROPERTIES) {
      throw localApiError("github-request-failed");
    }
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        typeof key !== "string" ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")
      ) {
        throw localApiError("github-request-failed");
      }
      output[key] = cloneSafeJsonValue(descriptor.value, seen, depth + 1);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function normalizeGitHubSuggestions(value, preview) {
  const safe = cloneSafeJsonValue(value);
  if (
    !isPlainObject(safe) ||
    !Array.isArray(safe.results) ||
    safe.results.length > 3 ||
    typeof safe.cached !== "boolean" ||
    typeof safe.incomplete !== "boolean" ||
    (safe.rateLimit !== null && !isPlainObject(safe.rateLimit))
  ) {
    throw localApiError("github-request-failed");
  }
  return {
    preview: cloneSafeJsonValue(preview),
    results: safe.results,
    cached: safe.cached,
    incomplete: safe.incomplete,
    rateLimit: safe.rateLimit,
  };
}

function resolveConsentStore(store) {
  if (
    !store ||
    typeof store !== "object" ||
    Array.isArray(store) ||
    types.isProxy(store)
  ) {
    throw new Error("invalid-consent-store");
  }
  const descriptors = Object.getOwnPropertyDescriptors(store);
  const issueDescriptor = Object.hasOwn(descriptors, "issue") ? descriptors.issue : null;
  const consumeDescriptor = Object.hasOwn(descriptors, "consume") ? descriptors.consume : null;
  const revokeDescriptor = Object.hasOwn(descriptors, "revoke") ? descriptors.revoke : null;
  const issue = issueDescriptor && Object.hasOwn(issueDescriptor, "value")
    ? issueDescriptor.value
    : undefined;
  const consume = consumeDescriptor && Object.hasOwn(consumeDescriptor, "value")
    ? consumeDescriptor.value
    : undefined;
  const revoke = revokeDescriptor && Object.hasOwn(revokeDescriptor, "value")
    ? revokeDescriptor.value
    : undefined;
  if (
    typeof issue !== "function" ||
    typeof consume !== "function" ||
    typeof revoke !== "function"
  ) {
    throw new Error("invalid-consent-store");
  }
  return {
    issue(query) {
      const consent = cloneSafeJsonValue(issue.call(store, query));
      if (
        !isPlainObject(consent) ||
        !isValidConsentToken(consent.token) ||
        safeRetryAt(consent.expiresAt) !== consent.expiresAt
      ) {
        throw localApiError("invalid-consent-store");
      }
      return { token: consent.token, expiresAt: consent.expiresAt };
    },
    consume: (input) => consume.call(store, input) === true,
    revoke: (token) => revoke.call(store, token) === true,
  };
}

export function createLocalApi({
  host = DEFAULT_API_HOST,
  port = DEFAULT_API_PORT,
  syncCatalog,
  getCatalog,
  recommend,
  previewGitHubSearch,
  findGitHubSuggestions,
  findOriginalGitHubSuggestions,
  rawSearchConsentStore = createRawSearchConsentStore(),
  onError = console.error,
}) {
  if (host !== DEFAULT_API_HOST) throw new Error("loopback-host-required");
  const previewSearch = typeof previewGitHubSearch === "function" ? previewGitHubSearch : () => null;
  const suggestionFinder = typeof findGitHubSuggestions === "function" ? findGitHubSuggestions : null;
  const originalSuggestionFinder = typeof findOriginalGitHubSuggestions === "function"
    ? findOriginalGitHubSuggestions
    : null;
  const consentStore = resolveConsentStore(rawSearchConsentStore);
  let syncing = null;

  const server = createServer(async (request, response) => {
    const origin = request.headers.origin ?? "";
    if (origin && !LOOPBACK_ORIGIN_RE.test(origin)) {
      sendJson(response, 403, { error: "origin-forbidden" });
      return;
    }
    if (request.method === "OPTIONS") {
      if (!origin) {
        sendJson(response, 400, { error: "origin-required" });
        return;
      }
      response.writeHead(204, {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "600",
        vary: "Origin",
      });
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    try {
      if (url.pathname === "/api/catalog") {
        if (request.method !== "GET") {
          sendJson(response, 405, { error: "method-not-allowed" }, origin);
          return;
        }
        sendJson(response, 200, await getCatalog(), origin);
        return;
      }
      if (url.pathname === "/api/sync") {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "method-not-allowed" }, origin);
          return;
        }
        syncing ??= Promise.resolve(syncCatalog()).finally(() => { syncing = null; });
        sendJson(response, 200, await syncing, origin);
        return;
      }
      if (url.pathname === "/api/recommend") {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "method-not-allowed" }, origin);
          return;
        }
        const connection = trackClientConnection(request, response);
        try {
          const body = await readJsonBody(request);
          const fields = snapshotRequestBody(body, ["query"]);
          if (!fields || !isValidQuery(fields.query)) {
            sendJson(response, 400, { error: "invalid-query" }, origin);
            return;
          }
          const canonicalQuery = fields.query.trim();
          const results = recommend(canonicalQuery, await getCatalog());
          const githubSearch = results.length ? null : previewSearch(canonicalQuery);
          if (!connection.canRespond()) return;
          const rawConsent = !results.length && !githubSearch
            ? consentStore.issue(canonicalQuery)
            : null;
          if (!connection.canRespond()) {
            if (rawConsent) consentStore.revoke(rawConsent.token);
            return;
          }
          sendJson(response, 200, { results, githubSearch, rawConsent }, origin);
          return;
        } finally {
          connection.dispose();
        }
      }
      if (url.pathname === "/api/github-suggestions") {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "method-not-allowed" }, origin);
          return;
        }
        const connection = trackClientConnection(request, response);
        try {
          const body = await readJsonBody(request);
          const fields = snapshotRequestBody(body, ["query"]);
          if (!fields || !isValidQuery(fields.query)) {
            sendJson(response, 400, { error: "invalid-query" }, origin);
            return;
          }
          const canonicalQuery = fields.query.trim();
          const localResults = recommend(canonicalQuery, await getCatalog());
          if (localResults.length) {
            sendJson(response, 409, { error: "local-match-available" }, origin);
            return;
          }
          const githubSearch = previewSearch(canonicalQuery);
          if (!githubSearch) {
            sendJson(response, 409, { error: "sanitized-query-unavailable" }, origin);
            return;
          }
          if (!suggestionFinder) {
            sendJson(response, 503, { error: "github-suggestions-unavailable" }, origin);
            return;
          }
          const suggestions = normalizeGitHubSuggestions(
            await suggestionFinder({ query: canonicalQuery }),
            githubSearch,
          );
          if (!connection.canRespond()) return;
          const rawConsent = suggestions.results.length === 0 && suggestions.incomplete === false
            ? consentStore.issue(canonicalQuery)
            : null;
          if (!connection.canRespond()) {
            if (rawConsent) consentStore.revoke(rawConsent.token);
            return;
          }
          sendJson(response, 200, { ...suggestions, rawConsent }, origin);
          return;
        } finally {
          connection.dispose();
        }
      }
      if (url.pathname === "/api/github-suggestions/revoke") {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "method-not-allowed" }, origin);
          return;
        }
        const body = await readJsonBody(request);
        const fields = snapshotRequestBody(body, ["consentToken"], { exact: true });
        if (!fields || !isValidConsentToken(fields.consentToken)) {
          sendJson(response, 400, { error: "invalid-consent" }, origin);
          return;
        }
        consentStore.revoke(fields.consentToken);
        sendNoContent(response, origin);
        return;
      }
      if (url.pathname === "/api/github-suggestions/original") {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "method-not-allowed" }, origin);
          return;
        }
        const body = await readJsonBody(request);
        const fields = snapshotRequestBody(body, ["query", "consentToken"]);
        if (!fields || !isValidQuery(fields.query)) {
          sendJson(response, 400, { error: "invalid-query" }, origin);
          return;
        }
        if (!isValidConsentToken(fields.consentToken)) {
          sendJson(response, 400, { error: "invalid-consent" }, origin);
          return;
        }
        const canonicalQuery = fields.query.trim();
        const localResults = recommend(canonicalQuery, await getCatalog());
        if (localResults.length) {
          sendJson(response, 409, { error: "local-match-available" }, origin);
          return;
        }
        if (!originalSuggestionFinder) {
          sendJson(response, 503, { error: "github-suggestions-unavailable" }, origin);
          return;
        }
        if (!consentStore.consume({ token: fields.consentToken, query: canonicalQuery })) {
          sendJson(response, 403, { error: "raw-consent-required" }, origin);
          return;
        }
        const suggestions = normalizeGitHubSuggestions(
          await originalSuggestionFinder({ query: canonicalQuery }),
          null,
        );
        sendJson(response, 200, {
          ...suggestions,
          preview: null,
          rawConsent: null,
        }, origin);
        return;
      }
      sendJson(response, 404, { error: "not-found" }, origin);
    } catch (error) {
      const errorCode = ownDataProperty(error, "code");
      if (
        ownDataProperty(error, LOCAL_TRANSPORT_ERROR) === true &&
        ["invalid-json", "request-too-large"].includes(errorCode)
      ) {
        sendJson(response, ownDataProperty(error, "status"), { error: errorCode }, origin);
        return;
      }
      if ([
        "/api/github-suggestions",
        "/api/github-suggestions/original",
        "/api/github-suggestions/revoke",
      ].includes(url.pathname)) {
        const safe = safeGitHubError(error);
        reportError(onError, safeGitHubLogError(safe.body.error));
        sendJson(response, safe.status, safe.body, origin);
        return;
      }
      reportError(onError, error);
      const status = ownDataProperty(error, "status") ?? 500;
      const safeCode = status < 500
        ? ownDataProperty(error, "message")
        : url.pathname === "/api/sync"
          ? "sync-failed"
          : "request-failed";
      sendJson(response, status, { error: safeCode }, origin);
    }
  });

  return {
    host,
    port,
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve(server.address());
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
