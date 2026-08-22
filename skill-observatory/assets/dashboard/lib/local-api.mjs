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
const LOCAL_RECOMMENDATION_FIELDS = [
  "skillId",
  "name",
  "summaryZh",
  "status",
  "score",
  "reasonCodes",
  "reasonZh",
];
const GITHUB_SUGGESTION_FIELDS = [
  "repository",
  "repositoryUrl",
  "skillDirectory",
  "name",
  "summary",
  "reasonZh",
  "stars",
  "pushedAt",
  "license",
];
const GITHUB_SUGGESTION_RESPONSE_FIELDS = [
  "preview",
  "results",
  "cached",
  "incomplete",
  "rateLimit",
  "diagnostics",
];
const GITHUB_RATE_LIMIT_FIELDS = ["remaining", "reset", "retryAt"];
const GITHUB_STATUS_FIELDS = ["state", "checkedAt", "rateLimits"];
const GITHUB_RATE_LIMIT_BUCKET_FIELDS = ["search", "codeSearch"];
const GITHUB_DIAGNOSTIC_FIELDS = [
  "stageReached",
  "repositoryHits",
  "codeHits",
  "validatedCandidates",
  "rejectedCandidates",
  "deduplicatedCandidates",
  "rejectionCounts",
  "cached",
  "incomplete",
  "rateLimits",
];
const GITHUB_STATES = [
  "ready",
  "missing-token",
  "invalid-token",
  "rate-limited",
  "github-unavailable",
];
const GITHUB_STAGES = ["repository-search", "code-search", "candidate-validation", "complete"];
const GITHUB_REJECTION_REASONS = [
  "invalid-structure",
  "invalid-content",
  "irrelevant",
  "duplicate",
  "unavailable",
];
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

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

function revokeConsentSafely(revoke, token) {
  try {
    return revoke(token) === true;
  } catch {
    return false;
  }
}

function yieldToConnectionEvents() {
  return new Promise((resolve) => {
    // Resolve at the following check phase so Node must cross an I/O poll phase;
    // one immediate can resume in the same turn before a peer close is observed.
    setImmediate(() => setImmediate(resolve));
  });
}

async function sendJsonWithRevocableConsent({
  response,
  status,
  value,
  origin,
  connection,
  consent,
  revoke,
}) {
  if (consent) await yieldToConnectionEvents();
  if (!connection.canRespond()) {
    if (consent) revokeConsentSafely(revoke, consent.token);
    return false;
  }
  if (!consent) {
    sendJson(response, status, value, origin);
    return true;
  }

  let finished = false;
  let settled = false;
  const cleanup = () => {
    response.off("finish", onFinish);
    response.off("close", onClose);
  };
  const revokeOnce = () => {
    if (settled) return;
    settled = true;
    revokeConsentSafely(revoke, consent.token);
  };
  const onFinish = () => {
    finished = true;
    settled = true;
    cleanup();
  };
  const onClose = () => {
    if (!finished) revokeOnce();
    cleanup();
  };
  response.once("finish", onFinish);
  response.once("close", onClose);
  if (!connection.canRespond()) {
    cleanup();
    revokeOnce();
    return false;
  }
  try {
    sendJson(response, status, value, origin);
    return true;
  } catch (error) {
    cleanup();
    revokeOnce();
    throw error;
  }
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
  const stageValue = ownDataProperty(error, "stage");
  const stage = GITHUB_STAGES.includes(stageValue) ? stageValue : null;
  const withStage = (body) => stage === null ? body : { ...body, stage };
  if (code === "github-rate-limited") {
    return {
      status: 429,
      body: withStage({
        error: "github-rate-limited",
        retryAt: safeRetryAt(ownDataProperty(error, "retryAt")),
      }),
    };
  }
  if (code === "github-token-missing") {
    return { status: 503, body: withStage({ error: "github-token-missing" }) };
  }
  if (code === "github-token-invalid") {
    return { status: 401, body: withStage({ error: "github-token-invalid" }) };
  }
  if (code === "github-access-denied") {
    return { status: 403, body: withStage({ error: "github-access-denied" }) };
  }
  if (code === "github-unavailable") {
    return { status: 502, body: withStage({ error: "github-unavailable" }) };
  }
  if (code === "github-query-rejected") {
    return { status: 422, body: withStage({ error: "github-query-rejected" }) };
  }
  if (code === "github-request-timeout") {
    return { status: 504, body: withStage({ error: "github-request-timeout" }) };
  }
  if (code === "github-network-failed") {
    return { status: 502, body: withStage({ error: "github-network-failed" }) };
  }
  return { status: 502, body: withStage({ error: "github-request-failed" }) };
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

async function resolveSafeRecommendDependency(resolve) {
  try {
    return await resolve();
  } catch {
    throw safeGitHubLogError("github-request-failed");
  }
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

function hasExactOwnDataFields(value, fields) {
  if (!isPlainObject(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  ) return false;
  return fields.every((field) => {
    const descriptor = descriptors[field];
    return descriptor.enumerable && Object.hasOwn(descriptor, "value");
  });
}

function normalizeLocalRecommendations(value) {
  const safe = cloneSafeJsonValue(value);
  if (
    !hasExactOwnDataFields(safe, ["level", "results"]) ||
    !["strong", "weak", "none"].includes(safe.level) ||
    !Array.isArray(safe.results) ||
    safe.results.length > 3 ||
    (safe.level === "none" && safe.results.length !== 0) ||
    (safe.level !== "none" && safe.results.length === 0)
  ) {
    throw localApiError("local-recommendation-failed");
  }
  const results = safe.results.map((item) => {
    if (
      !hasExactOwnDataFields(item, LOCAL_RECOMMENDATION_FIELDS) ||
      typeof item.skillId !== "string" ||
      typeof item.name !== "string" ||
      typeof item.summaryZh !== "string" ||
      !["ready", "needs-config", "abnormal", "unchecked"].includes(item.status) ||
      typeof item.score !== "number" ||
      !Number.isFinite(item.score) ||
      !Array.isArray(item.reasonCodes) ||
      item.reasonCodes.length > MAX_SAFE_JSON_ARRAY_ITEMS ||
      !item.reasonCodes.every((code) => typeof code === "string") ||
      typeof item.reasonZh !== "string"
    ) {
      throw localApiError("local-recommendation-failed");
    }
    return {
      skillId: item.skillId,
      name: item.name,
      summaryZh: item.summaryZh,
      status: item.status,
      score: item.score,
      reasonCodes: item.reasonCodes,
      reasonZh: item.reasonZh,
    };
  });
  return { level: safe.level, results };
}

function normalizePublicGitHubPreview(value) {
  if (value === null) return null;
  const safe = cloneSafeJsonValue(value);
  if (!isPlainObject(safe)) {
    throw localApiError("github-request-failed");
  }
  const fields = Reflect.ownKeys(safe);
  if (
    ![2, 3].includes(fields.length) ||
    fields.some((field) => (
      typeof field !== "string" || !["terms", "label", "cacheKey"].includes(field)
    )) ||
    !Object.hasOwn(safe, "terms") ||
    !Object.hasOwn(safe, "label") ||
    !Array.isArray(safe.terms) ||
    safe.terms.length > 6 ||
    !safe.terms.every((term) => typeof term === "string") ||
    typeof safe.label !== "string" ||
    (Object.hasOwn(safe, "cacheKey") && (
      typeof safe.cacheKey !== "string" || !safe.cacheKey || safe.cacheKey.length > 128
    ))
  ) {
    throw localApiError("github-request-failed");
  }
  return { terms: safe.terms, label: safe.label };
}

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  return new Date(milliseconds).toISOString() === value;
}

function normalizeGitHubRateLimit(value) {
  if (value === null) return null;
  if (!hasExactOwnDataFields(value, GITHUB_RATE_LIMIT_FIELDS)) {
    throw localApiError("github-request-failed");
  }
  const { remaining, reset, retryAt } = value;
  if (
    !(remaining === null || (Number.isSafeInteger(remaining) && remaining >= 0)) ||
    !(reset === null || (Number.isSafeInteger(reset) && reset >= 0)) ||
    !(retryAt === null || isCanonicalIsoTimestamp(retryAt))
  ) {
    throw localApiError("github-request-failed");
  }
  return { remaining, reset, retryAt };
}

function normalizeGitHubRateLimits(value) {
  if (!hasExactOwnDataFields(value, GITHUB_RATE_LIMIT_BUCKET_FIELDS)) {
    throw localApiError("github-request-failed");
  }
  return {
    search: normalizeGitHubRateLimit(value.search),
    codeSearch: normalizeGitHubRateLimit(value.codeSearch),
  };
}

function normalizeGitHubStatus(value) {
  const safe = cloneSafeJsonValue(value);
  if (
    !hasExactOwnDataFields(safe, GITHUB_STATUS_FIELDS) ||
    !GITHUB_STATES.includes(safe.state) ||
    !isCanonicalIsoTimestamp(safe.checkedAt)
  ) {
    throw localApiError("github-request-failed");
  }
  const rateLimits = normalizeGitHubRateLimits(safe.rateLimits);
  if (
    ["missing-token", "invalid-token", "github-unavailable"].includes(safe.state) &&
    (rateLimits.search !== null || rateLimits.codeSearch !== null)
  ) {
    throw localApiError("github-request-failed");
  }
  if (safe.state === "ready" && rateLimits.search?.remaining === 0) {
    throw localApiError("github-request-failed");
  }
  return { state: safe.state, checkedAt: safe.checkedAt, rateLimits };
}

function githubStatusError(status) {
  const code = {
    "missing-token": "github-token-missing",
    "invalid-token": "github-token-invalid",
    "rate-limited": "github-rate-limited",
    "github-unavailable": "github-unavailable",
  }[status.state];
  if (!code) return null;
  const error = new Error(code);
  Object.defineProperties(error, {
    code: { value: code, enumerable: true },
    stage: { value: "repository-search", enumerable: true },
    retryAt: {
      value: status.state === "rate-limited" ? status.rateLimits.search?.retryAt ?? null : null,
      enumerable: true,
    },
  });
  return error;
}

function normalizeRejectionCounts(value) {
  if (!Array.isArray(value) || value.length > GITHUB_REJECTION_REASONS.length) {
    throw localApiError("github-request-failed");
  }
  const output = [];
  let previousIndex = -1;
  for (const item of value) {
    if (!hasExactOwnDataFields(item, ["reason", "count"])) {
      throw localApiError("github-request-failed");
    }
    const reasonIndex = GITHUB_REJECTION_REASONS.indexOf(item.reason);
    if (
      reasonIndex <= previousIndex ||
      !Number.isSafeInteger(item.count) ||
      item.count < 1
    ) {
      throw localApiError("github-request-failed");
    }
    previousIndex = reasonIndex;
    output.push({ reason: item.reason, count: item.count });
  }
  return output;
}

function normalizeGitHubDiagnostics(value, { cached, incomplete }) {
  if (!hasExactOwnDataFields(value, GITHUB_DIAGNOSTIC_FIELDS)) {
    throw localApiError("github-request-failed");
  }
  const counters = [
    value.repositoryHits,
    value.codeHits,
    value.validatedCandidates,
    value.rejectedCandidates,
    value.deduplicatedCandidates,
  ];
  if (
    !GITHUB_STAGES.includes(value.stageReached) ||
    counters.some((count) => !Number.isSafeInteger(count) || count < 0) ||
    typeof value.cached !== "boolean" ||
    typeof value.incomplete !== "boolean" ||
    value.cached !== cached ||
    value.incomplete !== incomplete ||
    (!value.incomplete && value.stageReached !== "complete") ||
    (value.incomplete && value.stageReached === "complete")
  ) {
    throw localApiError("github-request-failed");
  }
  const rejectionCounts = normalizeRejectionCounts(value.rejectionCounts);
  if (
    rejectionCounts.reduce((sum, item) => sum + item.count, 0) !== value.rejectedCandidates ||
    (rejectionCounts.find((item) => item.reason === "duplicate")?.count ?? 0) !==
      value.deduplicatedCandidates
  ) {
    throw localApiError("github-request-failed");
  }
  return {
    stageReached: value.stageReached,
    repositoryHits: value.repositoryHits,
    codeHits: value.codeHits,
    validatedCandidates: value.validatedCandidates,
    rejectedCandidates: value.rejectedCandidates,
    deduplicatedCandidates: value.deduplicatedCandidates,
    rejectionCounts,
    cached: value.cached,
    incomplete: value.incomplete,
    rateLimits: normalizeGitHubRateLimits(value.rateLimits),
  };
}

function normalizeGitHubSuggestions(value, preview) {
  const safe = cloneSafeJsonValue(value);
  if (
    !hasExactOwnDataFields(safe, GITHUB_SUGGESTION_RESPONSE_FIELDS) ||
    !Array.isArray(safe.results) ||
    safe.results.length > 3 ||
    typeof safe.cached !== "boolean" ||
    typeof safe.incomplete !== "boolean"
  ) {
    throw localApiError("github-request-failed");
  }
  const expectedPreview = normalizePublicGitHubPreview(preview);
  const responsePreview = normalizePublicGitHubPreview(safe.preview);
  if (
    (expectedPreview === null) !== (responsePreview === null) ||
    (expectedPreview && responsePreview && (
      expectedPreview.label !== responsePreview.label ||
      expectedPreview.terms.length !== responsePreview.terms.length ||
      expectedPreview.terms.some((term, index) => term !== responsePreview.terms[index])
    ))
  ) {
    throw localApiError("github-request-failed");
  }
  const results = safe.results.map((item) => {
    if (!hasExactOwnDataFields(item, GITHUB_SUGGESTION_FIELDS)) {
      throw localApiError("github-request-failed");
    }
    const repositorySegments = typeof item.repository === "string"
      ? item.repository.split("/")
      : [];
    if (
      typeof item.repository !== "string" ||
      !GITHUB_REPOSITORY_PATTERN.test(item.repository) ||
      repositorySegments.some((segment) => segment === "." || segment === "..") ||
      typeof item.repositoryUrl !== "string" ||
      item.repositoryUrl !== `https://github.com/${item.repository}` ||
      typeof item.skillDirectory !== "string" ||
      typeof item.name !== "string" ||
      typeof item.summary !== "string" ||
      typeof item.reasonZh !== "string" ||
      typeof item.stars !== "number" ||
      !Number.isFinite(item.stars) ||
      item.stars < 0 ||
      typeof item.pushedAt !== "string" ||
      (item.license !== null && typeof item.license !== "string")
    ) {
      throw localApiError("github-request-failed");
    }
    return {
      repository: item.repository,
      repositoryUrl: item.repositoryUrl,
      skillDirectory: item.skillDirectory,
      name: item.name,
      summary: item.summary,
      reasonZh: item.reasonZh,
      stars: item.stars,
      pushedAt: item.pushedAt,
      license: item.license,
    };
  });
  const rateLimit = normalizeGitHubRateLimit(safe.rateLimit);
  const diagnostics = normalizeGitHubDiagnostics(safe.diagnostics, {
    cached: safe.cached,
    incomplete: safe.incomplete,
  });
  return {
    preview: expectedPreview,
    results,
    cached: safe.cached,
    incomplete: safe.incomplete,
    rateLimit,
    diagnostics,
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
  getGitHubStatus,
  previewGitHubSearch,
  findGitHubSuggestions,
  findOriginalGitHubSuggestions,
  rawSearchConsentStore = createRawSearchConsentStore(),
  onError = console.error,
}) {
  if (host !== DEFAULT_API_HOST) throw new Error("loopback-host-required");
  const previewSearch = typeof previewGitHubSearch === "function" ? previewGitHubSearch : () => null;
  const statusGetter = typeof getGitHubStatus === "function"
    ? getGitHubStatus
    : async () => ({
      state: "missing-token",
      checkedAt: new Date().toISOString(),
      rateLimits: { search: null, codeSearch: null },
    });
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
      if (url.pathname === "/api/github-status") {
        if (request.method !== "GET") {
          sendJson(response, 405, { error: "method-not-allowed" }, origin);
          return;
        }
        sendJson(response, 200, normalizeGitHubStatus(await statusGetter()), origin);
        return;
      }
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
          const fields = snapshotRequestBody(body, ["query"], { exact: true });
          if (!fields || !isValidQuery(fields.query)) {
            sendJson(response, 400, { error: "invalid-query" }, origin);
            return;
          }
          const canonicalQuery = fields.query.trim();
          const local = normalizeLocalRecommendations(recommend(canonicalQuery, await getCatalog()));
          const githubStatus = local.level === "strong"
            ? null
            : await resolveSafeRecommendDependency(async () => (
              normalizeGitHubStatus(await statusGetter())
            ));
          const githubSearch = local.level === "strong"
            ? null
            : await resolveSafeRecommendDependency(() => (
              normalizePublicGitHubPreview(previewSearch(canonicalQuery))
            ));
          if (!connection.canRespond()) return;
          const rawConsent = githubStatus?.state === "ready" && !githubSearch
            ? consentStore.issue(canonicalQuery)
            : null;
          await sendJsonWithRevocableConsent({
            response,
            status: 200,
            value: {
              localMatchLevel: local.level,
              results: local.results,
              githubSearch,
              githubStatus,
              rawConsent,
            },
            origin,
            connection,
            consent: rawConsent,
            revoke: consentStore.revoke,
          });
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
          const fields = snapshotRequestBody(body, ["query"], { exact: true });
          if (!fields || !isValidQuery(fields.query)) {
            sendJson(response, 400, { error: "invalid-query" }, origin);
            return;
          }
          const canonicalQuery = fields.query.trim();
          const local = normalizeLocalRecommendations(recommend(canonicalQuery, await getCatalog()));
          if (local.level === "strong") {
            sendJson(response, 409, { error: "local-match-available" }, origin);
            return;
          }
          const internalGitHubSearch = previewSearch(canonicalQuery);
          if (!internalGitHubSearch) {
            sendJson(response, 409, { error: "sanitized-query-unavailable" }, origin);
            return;
          }
          const githubSearch = normalizePublicGitHubPreview(internalGitHubSearch);
          const githubStatus = normalizeGitHubStatus(await statusGetter());
          const statusError = githubStatusError(githubStatus);
          if (statusError) throw statusError;
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
          await sendJsonWithRevocableConsent({
            response,
            status: 200,
            value: { ...suggestions, rawConsent },
            origin,
            connection,
            consent: rawConsent,
            revoke: consentStore.revoke,
          });
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
        const fields = snapshotRequestBody(body, ["query", "consentToken"], { exact: true });
        if (!fields) {
          const queryOnly = snapshotRequestBody(body, ["query"], { exact: true });
          sendJson(response, 400, {
            error: queryOnly && isValidQuery(queryOnly.query) ? "invalid-consent" : "invalid-query",
          }, origin);
          return;
        }
        if (!isValidQuery(fields.query)) {
          sendJson(response, 400, { error: "invalid-query" }, origin);
          return;
        }
        if (!isValidConsentToken(fields.consentToken)) {
          sendJson(response, 400, { error: "invalid-consent" }, origin);
          return;
        }
        const canonicalQuery = fields.query.trim();
        const local = normalizeLocalRecommendations(recommend(canonicalQuery, await getCatalog()));
        if (local.level === "strong") {
          sendJson(response, 409, { error: "local-match-available" }, origin);
          return;
        }
        const githubStatus = normalizeGitHubStatus(await statusGetter());
        const statusError = githubStatusError(githubStatus);
        if (statusError) throw statusError;
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
        "/api/github-status",
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
