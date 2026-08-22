import { types } from "node:util";

import { createGitHubClient } from "./github-client.mjs";

const DEFAULT_TTL_MILLISECONDS = 60_000;
const MAX_TOKEN_LENGTH = 512;
const STATUS_STATES = new Set([
  "ready",
  "missing-token",
  "invalid-token",
  "rate-limited",
  "github-unavailable",
]);
const KNOWN_TOKEN_PREFIXES = Object.freeze([
  ["github", "pat", ""].join("_"),
  ...["o", "p", "r", "s", "u"].map((kind) => ["gh" + kind, ""].join("_")),
]);

function plainDataDescriptors(value) {
  if (types.isProxy(value) || !value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => (
    typeof key !== "string" || !Object.hasOwn(descriptors[key], "value")
  ))) return null;
  return descriptors;
}

function descriptorValue(descriptors, key) {
  return descriptors && Object.hasOwn(descriptors, key) ? descriptors[key].value : undefined;
}

function snapshotExactObject(value, fields, errorCode) {
  const descriptors = plainDataDescriptors(value);
  if (
    !descriptors ||
    Reflect.ownKeys(descriptors).some((key) => !fields.includes(key))
  ) {
    throw new Error(errorCode);
  }
  return Object.fromEntries(fields
    .filter((field) => Object.hasOwn(descriptors, field))
    .map((field) => [field, descriptors[field].value]));
}

function resolveNow(now) {
  const value = now();
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw new Error("invalid-current-time");
  return milliseconds;
}

function canonicalIsoTimestamp(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const canonical = new Date(milliseconds).toISOString();
  return canonical === value ? canonical : null;
}

function normalizeRateLimitBucket(value, expectedResource) {
  const descriptors = plainDataDescriptors(value);
  if (
    !descriptors ||
    Reflect.ownKeys(descriptors).length !== 4 ||
    Reflect.ownKeys(descriptors).some((key) => (
      !["remaining", "reset", "retryAt", "resource"].includes(key)
    ))
  ) return null;
  const remaining = descriptorValue(descriptors, "remaining");
  const reset = descriptorValue(descriptors, "reset");
  const retryAt = descriptorValue(descriptors, "retryAt");
  const resource = descriptorValue(descriptors, "resource");
  if (
    !Number.isSafeInteger(remaining) ||
    remaining < 0 ||
    !Number.isSafeInteger(reset) ||
    reset < 0 ||
    resource !== expectedResource ||
    canonicalIsoTimestamp(retryAt) !== retryAt
  ) return null;
  return { remaining, reset, retryAt };
}

function normalizeRateLimitStatus(value) {
  const descriptors = plainDataDescriptors(value);
  if (
    !descriptors ||
    Reflect.ownKeys(descriptors).length !== 2 ||
    Reflect.ownKeys(descriptors).some((key) => !["search", "codeSearch"].includes(key))
  ) return null;
  const search = normalizeRateLimitBucket(descriptorValue(descriptors, "search"), "search");
  const codeSearch = normalizeRateLimitBucket(
    descriptorValue(descriptors, "codeSearch"),
    "code_search",
  );
  return search && codeSearch ? { search, codeSearch } : null;
}

function ownDataProperty(value, key) {
  if (
    !value ||
    (typeof value !== "object" && typeof value !== "function") ||
    types.isProxy(value)
  ) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function emptyRateLimits() {
  return { search: null, codeSearch: null };
}

function normalizeErrorRateLimits(error) {
  const raw = ownDataProperty(error, "rateLimit");
  const descriptors = plainDataDescriptors(raw);
  if (!descriptors) return emptyRateLimits();
  const resource = descriptorValue(descriptors, "resource");
  const normalized = normalizeRateLimitBucket(raw, resource);
  if (!normalized) return emptyRateLimits();
  if (resource === "search") return { search: normalized, codeSearch: null };
  if (resource === "code_search") return { search: null, codeSearch: normalized };
  return emptyRateLimits();
}

function cloneRateLimitBucket(value) {
  return value === null ? null : {
    remaining: value.remaining,
    reset: value.reset,
    retryAt: value.retryAt,
  };
}

function cloneStatus(value) {
  return {
    state: value.state,
    checkedAt: value.checkedAt,
    rateLimits: {
      search: cloneRateLimitBucket(value.rateLimits.search),
      codeSearch: cloneRateLimitBucket(value.rateLimits.codeSearch),
    },
  };
}

function hasWhitespaceOrControl(value) {
  return [...value].some((character) => {
    return /\s/u.test(character) || /\p{Cc}/u.test(character);
  });
}

function knownTokenPrefix(value) {
  return KNOWN_TOKEN_PREFIXES.find((prefix) => value.startsWith(prefix)) ?? "";
}

export function inspectGitHubTokenEnvelope(rawToken) {
  if (rawToken === undefined || rawToken === null || rawToken === "") {
    return { state: "missing-token", token: "" };
  }
  if (
    typeof rawToken !== "string" ||
    rawToken.length > MAX_TOKEN_LENGTH ||
    hasWhitespaceOrControl(rawToken)
  ) {
    return { state: "invalid-token", token: "" };
  }

  const halfLength = rawToken.length / 2;
  if (
    Number.isInteger(halfLength) &&
    rawToken.slice(0, halfLength) === rawToken.slice(halfLength) &&
    knownTokenPrefix(rawToken.slice(0, halfLength))
  ) {
    return { state: "invalid-token", token: "" };
  }
  const knownPrefix = knownTokenPrefix(rawToken);
  if (knownPrefix && rawToken.length < knownPrefix.length + 16) {
    return { state: "invalid-token", token: "" };
  }
  return { state: "candidate", token: rawToken };
}

export function createGitHubStatusService(options = {}) {
  const safe = snapshotExactObject(
    options,
    ["token", "tokenState", "createClient", "now", "ttlMilliseconds"],
    "invalid-github-status-service",
  );
  const envelope = inspectGitHubTokenEnvelope(safe.token ?? "");
  const tokenState = safe.tokenState ?? envelope.state;
  const token = safe.token ?? "";
  const createClient = safe.createClient ?? createGitHubClient;
  const now = safe.now ?? Date.now;
  const ttlMilliseconds = safe.ttlMilliseconds ?? DEFAULT_TTL_MILLISECONDS;
  if (
    !["candidate", "missing-token", "invalid-token"].includes(tokenState) ||
    typeof createClient !== "function" ||
    typeof now !== "function" ||
    !Number.isInteger(ttlMilliseconds) ||
    ttlMilliseconds < 1 ||
    ttlMilliseconds > 3_600_000 ||
    (tokenState === "candidate" && envelope.state !== "candidate") ||
    (tokenState !== "candidate" && token !== "")
  ) {
    throw new Error("invalid-github-status-service");
  }

  let cached = null;
  let cachedAt = Number.NEGATIVE_INFINITY;
  let inFlight = null;

  async function refresh() {
    const checkedMilliseconds = resolveNow(now);
    const checkedAt = new Date(checkedMilliseconds).toISOString();
    if (tokenState !== "candidate") {
      return {
        state: tokenState,
        checkedAt,
        rateLimits: emptyRateLimits(),
      };
    }

    try {
      const client = createClient({ token });
      if (
        !client ||
        typeof client !== "object" ||
        types.isProxy(client)
      ) throw new Error("invalid-github-client");
      const descriptors = Object.getOwnPropertyDescriptors(client);
      const method = descriptorValue(descriptors, "getRateLimitStatus");
      if (typeof method !== "function") throw new Error("invalid-github-client");
      const rateLimits = normalizeRateLimitStatus(await method.call(client));
      if (!rateLimits) throw new Error("github-request-failed");
      return {
        state: rateLimits.search.remaining === 0 ? "rate-limited" : "ready",
        checkedAt,
        rateLimits,
      };
    } catch (error) {
      const code = ownDataProperty(error, "code");
      const state = code === "github-token-invalid"
        ? "invalid-token"
        : code === "github-rate-limited"
          ? "rate-limited"
          : "github-unavailable";
      return {
        state,
        checkedAt,
        rateLimits: code === "github-rate-limited"
          ? normalizeErrorRateLimits(error)
          : emptyRateLimits(),
      };
    }
  }

  async function getStatus(getOptions = {}) {
    const safeOptions = snapshotExactObject(
      getOptions,
      ["force"],
      "invalid-github-status-options",
    );
    const force = safeOptions.force ?? false;
    if (typeof force !== "boolean") throw new Error("invalid-github-status-options");
    const currentTime = resolveNow(now);
    if (inFlight) return cloneStatus(await inFlight);
    if (
      !force &&
      cached &&
      currentTime >= cachedAt &&
      currentTime - cachedAt < ttlMilliseconds
    ) {
      return cloneStatus(cached);
    }

    const pending = refresh();
    inFlight = pending;
    try {
      const status = await pending;
      if (!STATUS_STATES.has(status.state)) throw new Error("invalid-github-status");
      cached = status;
      cachedAt = resolveNow(now);
      return cloneStatus(status);
    } finally {
      if (inFlight === pending) inFlight = null;
    }
  }

  return Object.freeze({ getStatus });
}
