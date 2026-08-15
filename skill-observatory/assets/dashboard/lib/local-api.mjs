import { createServer } from "node:http";
import {
  DEFAULT_API_HOST,
  DEFAULT_API_PORT,
  MAX_QUERY_BYTES,
  MAX_REQUEST_BODY_BYTES,
} from "./contracts.mjs";

const LOOPBACK_ORIGIN_RE = /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/;

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

async function readJsonBody(request) {
  let total = 0;
  const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_REQUEST_BODY_BYTES) {
      const error = new Error("request-too-large");
      error.code = "request-too-large";
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("invalid-json");
    error.code = "invalid-json";
    error.status = 400;
    throw error;
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

function safeRetryAt(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function safeGitHubError(error) {
  if (error?.code === "github-rate-limited") {
    return {
      status: 429,
      body: { error: "github-rate-limited", retryAt: safeRetryAt(error.retryAt) },
    };
  }
  const errorCode = ["github-network-failed", "github-request-failed"].includes(error?.code)
    ? error.code
    : "github-request-failed";
  return { status: 502, body: { error: errorCode } };
}

export function createLocalApi({
  host = DEFAULT_API_HOST,
  port = DEFAULT_API_PORT,
  syncCatalog,
  getCatalog,
  recommend,
  previewGitHubSearch,
  findGitHubSuggestions,
  onError = console.error,
}) {
  if (host !== DEFAULT_API_HOST) throw new Error("loopback-host-required");
  const previewSearch = typeof previewGitHubSearch === "function" ? previewGitHubSearch : () => null;
  const suggestionFinder = typeof findGitHubSuggestions === "function" ? findGitHubSuggestions : null;
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
        const body = await readJsonBody(request);
        if (!isPlainObject(body) || !isValidQuery(body.query)) {
          sendJson(response, 400, { error: "invalid-query" }, origin);
          return;
        }
        const results = recommend(body.query, await getCatalog());
        sendJson(response, 200, {
          results,
          githubSearch: results.length ? null : previewSearch(body.query),
        }, origin);
        return;
      }
      if (url.pathname === "/api/github-suggestions") {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "method-not-allowed" }, origin);
          return;
        }
        const body = await readJsonBody(request);
        if (!isPlainObject(body) || !isValidQuery(body.query)) {
          sendJson(response, 400, { error: "invalid-query" }, origin);
          return;
        }
        const localResults = recommend(body.query, await getCatalog());
        if (localResults.length) {
          sendJson(response, 409, { error: "local-match-available" }, origin);
          return;
        }
        if (!suggestionFinder) {
          sendJson(response, 503, { error: "github-suggestions-unavailable" }, origin);
          return;
        }
        sendJson(response, 200, await suggestionFinder({ query: body.query }), origin);
        return;
      }
      sendJson(response, 404, { error: "not-found" }, origin);
    } catch (error) {
      onError(error);
      if (["invalid-json", "request-too-large"].includes(error?.code)) {
        sendJson(response, error.status, { error: error.code }, origin);
        return;
      }
      if (url.pathname === "/api/github-suggestions") {
        const safe = safeGitHubError(error);
        sendJson(response, safe.status, safe.body, origin);
        return;
      }
      const status = error.status ?? 500;
      const safeCode = status < 500
        ? error.message
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
