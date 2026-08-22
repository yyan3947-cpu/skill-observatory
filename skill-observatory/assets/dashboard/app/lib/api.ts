import type {
  Catalog,
  GitHubRateLimit,
  GitHubRateLimits,
  GitHubRejectionReason,
  GitHubSearchPreview,
  GitHubSearchDiagnostics,
  GitHubSearchStage,
  GitHubServiceStatus,
  GitHubSkillSuggestion,
  GitHubSuggestionResponse,
  RawSearchConsent,
  Recommendation,
  TaskRecommendationResponse,
} from "./catalog";
import { isValidConsentToken } from "../../lib/contracts.mjs";

const API_BASE = "http://127.0.0.1:4318";
const MISSING = Symbol("missing-browser-api-field");
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

const BROWSER_API_ERROR_CODES = [
  "local-origin-forbidden",
  "local-query-too-long",
  "local-service-unavailable",
  "local-response-invalid",
  "github-token-missing",
  "github-token-invalid",
  "github-access-denied",
  "github-rate-limited",
  "github-query-rejected",
  "github-request-timeout",
  "github-network-failed",
  "github-request-failed",
  "github-request-invalid",
  "github-response-invalid",
  "local-match-available",
  "sanitized-query-unavailable",
  "raw-consent-required",
  "github-suggestions-unavailable",
] as const;

export type BrowserApiErrorCode = typeof BROWSER_API_ERROR_CODES[number];

export interface BrowserApiErrorDetails {
  code: BrowserApiErrorCode;
  retryAt: string | null;
  stage: GitHubSearchStage | null;
}

const ERROR_CODE_SET = new Set<string>(BROWSER_API_ERROR_CODES);
const GITHUB_SERVICE_STATES = new Set([
  "ready",
  "missing-token",
  "invalid-token",
  "rate-limited",
  "github-unavailable",
]);
const GITHUB_SEARCH_STAGES = new Set<GitHubSearchStage>([
  "repository-search",
  "code-search",
  "candidate-validation",
  "complete",
]);
const GITHUB_REJECTION_REASONS: readonly GitHubRejectionReason[] = [
  "invalid-structure",
  "invalid-content",
  "irrelevant",
  "duplicate",
  "unavailable",
];

function browserApiError(
  code: BrowserApiErrorCode,
  retryAt: string | null = null,
  stage: GitHubSearchStage | null = null,
) {
  const error = new Error(code);
  Object.defineProperty(error, "code", {
    value: code,
    enumerable: true,
    configurable: true,
    writable: false,
  });
  Object.defineProperty(error, "retryAt", {
    value: retryAt,
    enumerable: true,
    configurable: true,
    writable: false,
  });
  Object.defineProperty(error, "stage", {
    value: stage,
    enumerable: true,
    configurable: true,
    writable: false,
  });
  return error;
}

export function isAbortError(value: unknown): value is DOMException {
  return typeof DOMException !== "undefined" && value instanceof DOMException && value.name === "AbortError";
}

export function readBrowserApiError(value: unknown): BrowserApiErrorDetails | null {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const codeDescriptor = Object.hasOwn(descriptors, "code") ? descriptors.code : null;
    const retryDescriptor = Object.hasOwn(descriptors, "retryAt") ? descriptors.retryAt : null;
    const stageDescriptor = Object.hasOwn(descriptors, "stage") ? descriptors.stage : null;
    const code = codeDescriptor && Object.hasOwn(codeDescriptor, "value")
      ? codeDescriptor.value
      : undefined;
    const retryAt = retryDescriptor && Object.hasOwn(retryDescriptor, "value")
      ? retryDescriptor.value
      : null;
    const stage = stageDescriptor && Object.hasOwn(stageDescriptor, "value")
      ? stageDescriptor.value
      : null;
    if (typeof code !== "string" || !ERROR_CODE_SET.has(code)) return null;
    return {
      code: code as BrowserApiErrorCode,
      retryAt: isCanonicalIsoTimestamp(retryAt) ? retryAt : null,
      stage: typeof stage === "string" && GITHUB_SEARCH_STAGES.has(stage as GitHubSearchStage)
        ? stage as GitHubSearchStage
        : null,
    };
  } catch {
    return null;
  }
}

function descriptors(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return Object.getOwnPropertyDescriptors(value);
}

function exactDataDescriptors(value: unknown, fields: readonly string[]) {
  const record = descriptors(value);
  if (!record) return null;
  const keys = Reflect.ownKeys(record);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  ) return null;
  if (fields.some((field) => {
    const descriptor = record[field];
    return !descriptor.enumerable || !Object.hasOwn(descriptor, "value");
  })) return null;
  return record;
}

function ownValue(record: PropertyDescriptorMap, key: string) {
  const descriptor = Object.hasOwn(record, key) ? record[key] : null;
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : MISSING;
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function cloneStringArray(value: unknown, maximum = 256) {
  if (!Array.isArray(value) || value.length > maximum || !value.every((item) => typeof item === "string")) {
    return null;
  }
  return [...value] as string[];
}

function clonePreview(value: unknown): GitHubSearchPreview | null | typeof MISSING {
  if (value === null) return null;
  const record = exactDataDescriptors(value, ["terms", "label"]);
  if (!record) return MISSING;
  const terms = cloneStringArray(ownValue(record, "terms"), 6);
  const label = ownValue(record, "label");
  if (!terms || typeof label !== "string") return MISSING;
  return { terms, label };
}

function cloneConsent(value: unknown): RawSearchConsent | null | typeof MISSING {
  if (value === null) return null;
  const record = exactDataDescriptors(value, ["token", "expiresAt"]);
  if (!record) return MISSING;
  const token = ownValue(record, "token");
  const expiresAt = ownValue(record, "expiresAt");
  if (
    !isValidConsentToken(token) ||
    !isCanonicalIsoTimestamp(expiresAt)
  ) {
    return MISSING;
  }
  return { token, expiresAt };
}

function cloneGitHubRateLimits(value: unknown): GitHubRateLimits | typeof MISSING {
  const record = exactDataDescriptors(value, ["search", "codeSearch"]);
  if (!record) return MISSING;
  const search = cloneRateLimit(ownValue(record, "search"));
  const codeSearch = cloneRateLimit(ownValue(record, "codeSearch"));
  if (search === MISSING || codeSearch === MISSING) return MISSING;
  return { search, codeSearch };
}

function cloneGitHubStatus(value: unknown): GitHubServiceStatus | null {
  const safe = cloneUnproxiedJsonValue(value);
  const record = safe === MISSING
    ? null
    : exactDataDescriptors(safe, ["state", "checkedAt", "rateLimits"]);
  if (!record) return null;
  const state = ownValue(record, "state");
  const checkedAt = ownValue(record, "checkedAt");
  const rateLimits = cloneGitHubRateLimits(ownValue(record, "rateLimits"));
  if (
    typeof state !== "string" ||
    !GITHUB_SERVICE_STATES.has(state) ||
    !isCanonicalIsoTimestamp(checkedAt) ||
    rateLimits === MISSING ||
    (["missing-token", "invalid-token", "github-unavailable"].includes(state) &&
      (rateLimits.search !== null || rateLimits.codeSearch !== null)) ||
    (state === "ready" && rateLimits.search?.remaining === 0)
  ) return null;
  return {
    state: state as GitHubServiceStatus["state"],
    checkedAt,
    rateLimits,
  };
}

function cloneRecommendation(value: unknown): Recommendation | null {
  const record = exactDataDescriptors(value, [
    "skillId",
    "name",
    "summaryZh",
    "status",
    "score",
    "reasonCodes",
    "reasonZh",
  ]);
  if (!record) return null;
  const skillId = ownValue(record, "skillId");
  const name = ownValue(record, "name");
  const summaryZh = ownValue(record, "summaryZh");
  const status = ownValue(record, "status");
  const score = ownValue(record, "score");
  const reasonCodes = cloneStringArray(ownValue(record, "reasonCodes"));
  const reasonZh = ownValue(record, "reasonZh");
  if (
    typeof skillId !== "string" ||
    typeof name !== "string" ||
    typeof summaryZh !== "string" ||
    !["ready", "needs-config", "abnormal", "unchecked"].includes(String(status)) ||
    typeof score !== "number" ||
    !Number.isFinite(score) ||
    !reasonCodes ||
    typeof reasonZh !== "string"
  ) {
    return null;
  }
  return {
    skillId,
    name,
    summaryZh,
    status: status as Recommendation["status"],
    score,
    reasonCodes,
    reasonZh,
  };
}

function cloneRecommendationResponse(value: unknown): TaskRecommendationResponse | null {
  const safe = cloneUnproxiedJsonValue(value);
  const record = safe === MISSING ? null : exactDataDescriptors(safe, [
    "localMatchLevel",
    "results",
    "githubSearch",
    "githubStatus",
    "rawConsent",
  ]);
  if (!record) return null;
  const localMatchLevel = ownValue(record, "localMatchLevel");
  const resultValue = ownValue(record, "results");
  if (!Array.isArray(resultValue) || resultValue.length > 3) return null;
  const results = resultValue.map(cloneRecommendation);
  if (results.some((result) => result === null)) return null;
  const githubSearch = clonePreview(ownValue(record, "githubSearch"));
  const githubStatusValue = ownValue(record, "githubStatus");
  const githubStatus = githubStatusValue === null ? null : cloneGitHubStatus(githubStatusValue);
  const rawConsent = cloneConsent(ownValue(record, "rawConsent"));
  if (
    typeof localMatchLevel !== "string" ||
    !["strong", "weak", "none"].includes(localMatchLevel) ||
    (localMatchLevel === "none" && results.length !== 0) ||
    (localMatchLevel !== "none" && results.length === 0) ||
    githubSearch === MISSING ||
    githubStatusValue === MISSING ||
    (githubStatusValue !== null && githubStatus === null) ||
    rawConsent === MISSING
  ) return null;
  const hasGitHubSearch = githubSearch !== null;
  const hasRawConsent = rawConsent !== null;
  if (
    (localMatchLevel === "strong" && (hasGitHubSearch || hasRawConsent || githubStatus !== null)) ||
    (localMatchLevel !== "strong" && githubStatus === null) ||
    (localMatchLevel !== "strong" && githubStatus?.state === "ready" && hasGitHubSearch === hasRawConsent) ||
    (localMatchLevel !== "strong" && githubStatus?.state !== "ready" && hasRawConsent)
  ) return null;
  return {
    localMatchLevel: localMatchLevel as TaskRecommendationResponse["localMatchLevel"],
    results: results as Recommendation[],
    githubSearch,
    githubStatus,
    rawConsent,
  };
}

function cloneSuggestion(value: unknown): GitHubSkillSuggestion | null {
  const record = exactDataDescriptors(value, [
    "repository",
    "repositoryUrl",
    "skillDirectory",
    "name",
    "summary",
    "reasonZh",
    "stars",
    "pushedAt",
    "license",
  ]);
  if (!record) return null;
  const repository = ownValue(record, "repository");
  const repositoryUrl = ownValue(record, "repositoryUrl");
  const skillDirectory = ownValue(record, "skillDirectory");
  const name = ownValue(record, "name");
  const summary = ownValue(record, "summary");
  const reasonZh = ownValue(record, "reasonZh");
  const stars = ownValue(record, "stars");
  const pushedAt = ownValue(record, "pushedAt");
  const license = ownValue(record, "license");
  const repositorySegments = typeof repository === "string" ? repository.split("/") : [];
  if (
    typeof repository !== "string" ||
    !GITHUB_REPOSITORY_PATTERN.test(repository) ||
    repositorySegments.some((segment) => segment === "." || segment === "..") ||
    typeof repositoryUrl !== "string" ||
    repositoryUrl !== `https://github.com/${repository}` ||
    typeof skillDirectory !== "string" ||
    typeof name !== "string" ||
    typeof summary !== "string" ||
    typeof reasonZh !== "string" ||
    typeof stars !== "number" ||
    !Number.isFinite(stars) ||
    stars < 0 ||
    !isCanonicalIsoTimestamp(pushedAt) ||
    (license !== null && typeof license !== "string")
  ) {
    return null;
  }
  return {
    repository,
    repositoryUrl,
    skillDirectory,
    name,
    summary,
    reasonZh,
    stars,
    pushedAt,
    license,
  };
}

function cloneRateLimit(value: unknown): GitHubRateLimit | null | typeof MISSING {
  if (value === null) return null;
  const record = exactDataDescriptors(value, ["remaining", "reset", "retryAt"]);
  if (!record) return MISSING;
  const remaining = ownValue(record, "remaining");
  const reset = ownValue(record, "reset");
  const retryAt = ownValue(record, "retryAt");
  if (
    (remaining !== null && (!Number.isSafeInteger(remaining) || remaining < 0)) ||
    (reset !== null && (!Number.isSafeInteger(reset) || reset < 0)) ||
    (retryAt !== null && !isCanonicalIsoTimestamp(retryAt))
  ) {
    return MISSING;
  }
  return { remaining, reset, retryAt };
}

function cloneRejectionCounts(value: unknown) {
  if (!Array.isArray(value) || value.length > GITHUB_REJECTION_REASONS.length) return null;
  const output: GitHubSearchDiagnostics["rejectionCounts"] = [];
  let previousIndex = -1;
  for (const item of value) {
    const record = exactDataDescriptors(item, ["reason", "count"]);
    if (!record) return null;
    const reason = ownValue(record, "reason");
    const count = ownValue(record, "count");
    const reasonIndex = GITHUB_REJECTION_REASONS.indexOf(reason as GitHubRejectionReason);
    if (
      reasonIndex <= previousIndex ||
      !Number.isSafeInteger(count) ||
      (count as number) < 1
    ) return null;
    previousIndex = reasonIndex;
    output.push({ reason: reason as GitHubRejectionReason, count: count as number });
  }
  return output;
}

function cloneGitHubDiagnostics(
  value: unknown,
  expected: { cached: boolean; incomplete: boolean },
): GitHubSearchDiagnostics | null {
  const record = exactDataDescriptors(value, [
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
  ]);
  if (!record) return null;
  const stageReached = ownValue(record, "stageReached");
  const repositoryHits = ownValue(record, "repositoryHits");
  const codeHits = ownValue(record, "codeHits");
  const validatedCandidates = ownValue(record, "validatedCandidates");
  const rejectedCandidates = ownValue(record, "rejectedCandidates");
  const deduplicatedCandidates = ownValue(record, "deduplicatedCandidates");
  const cached = ownValue(record, "cached");
  const incomplete = ownValue(record, "incomplete");
  const counters = [
    repositoryHits,
    codeHits,
    validatedCandidates,
    rejectedCandidates,
    deduplicatedCandidates,
  ];
  const rejectionCounts = cloneRejectionCounts(ownValue(record, "rejectionCounts"));
  const rateLimits = cloneGitHubRateLimits(ownValue(record, "rateLimits"));
  if (
    typeof stageReached !== "string" ||
    !GITHUB_SEARCH_STAGES.has(stageReached as GitHubSearchStage) ||
    counters.some((count) => !Number.isSafeInteger(count) || (count as number) < 0) ||
    typeof cached !== "boolean" ||
    typeof incomplete !== "boolean" ||
    cached !== expected.cached ||
    incomplete !== expected.incomplete ||
    (!incomplete && stageReached !== "complete") ||
    (incomplete && stageReached === "complete") ||
    !rejectionCounts ||
    rateLimits === MISSING ||
    rejectionCounts.reduce((sum, item) => sum + item.count, 0) !== rejectedCandidates ||
    (rejectionCounts.find((item) => item.reason === "duplicate")?.count ?? 0) !==
      deduplicatedCandidates
  ) return null;
  return {
    stageReached: stageReached as GitHubSearchStage,
    repositoryHits: repositoryHits as number,
    codeHits: codeHits as number,
    validatedCandidates: validatedCandidates as number,
    rejectedCandidates: rejectedCandidates as number,
    deduplicatedCandidates: deduplicatedCandidates as number,
    rejectionCounts,
    cached,
    incomplete,
    rateLimits,
  };
}

function cloneSuggestionResponse(value: unknown): GitHubSuggestionResponse | null {
  const safe = cloneUnproxiedJsonValue(value);
  const record = safe === MISSING ? null : exactDataDescriptors(safe, [
    "preview",
    "results",
    "cached",
    "incomplete",
    "rawConsent",
    "rateLimit",
    "diagnostics",
  ]);
  if (!record) return null;
  const resultValue = ownValue(record, "results");
  const cached = ownValue(record, "cached");
  const incomplete = ownValue(record, "incomplete");
  if (
    !Array.isArray(resultValue) ||
    resultValue.length > 3 ||
    typeof cached !== "boolean" ||
    typeof incomplete !== "boolean"
  ) {
    return null;
  }
  const results = resultValue.map(cloneSuggestion);
  if (results.some((result) => result === null)) return null;
  const preview = clonePreview(ownValue(record, "preview"));
  const rawConsent = cloneConsent(ownValue(record, "rawConsent"));
  const rateLimit = cloneRateLimit(ownValue(record, "rateLimit"));
  const diagnostics = cloneGitHubDiagnostics(ownValue(record, "diagnostics"), { cached, incomplete });
  if (
    preview === MISSING ||
    rawConsent === MISSING ||
    rateLimit === MISSING ||
    !diagnostics
  ) return null;
  return {
    preview,
    results: results as GitHubSkillSuggestion[],
    cached,
    incomplete,
    rawConsent,
    rateLimit,
    diagnostics,
  };
}

function safeJsonClone(value: unknown, depth = 0): unknown | typeof MISSING {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) return value;
  if (!value || typeof value !== "object" || depth >= 16) return MISSING;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return MISSING;
    const record = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length = lengthDescriptor && Object.hasOwn(lengthDescriptor, "value")
      ? lengthDescriptor.value
      : MISSING;
    if (!Number.isSafeInteger(length) || length < 0 || length > 4096) return MISSING;
    const allowedKeys = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
    if (Reflect.ownKeys(record).some((key) => typeof key !== "string" || !allowedKeys.has(key))) {
      return MISSING;
    }
    const output = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = record[String(index)];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return MISSING;
      const cloned = safeJsonClone(descriptor.value, depth + 1);
      if (cloned === MISSING) return MISSING;
      output.push(cloned);
    }
    return output;
  }
  const record = descriptors(value);
  if (!record || Reflect.ownKeys(record).length > 512) return MISSING;
  const output: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string") return MISSING;
    const descriptor = record[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return MISSING;
    const cloned = safeJsonClone(descriptor.value, depth + 1);
    if (cloned === MISSING) return MISSING;
    output[key] = cloned;
  }
  return output;
}

function cloneUnproxiedJsonValue(value: unknown): unknown | typeof MISSING {
  const cloned = safeJsonClone(value);
  if (cloned === MISSING) return MISSING;
  try {
    structuredClone(value);
  } catch {
    return MISSING;
  }
  return cloned;
}

function cloneCatalog(value: unknown): Catalog | null {
  const cloned = safeJsonClone(value);
  const record = cloned === MISSING ? null : descriptors(cloned);
  if (!record) return null;
  const schemaVersion = ownValue(record, "schemaVersion");
  const generatedAt = ownValue(record, "generatedAt");
  const historyAvailable = ownValue(record, "historyAvailable");
  const skills = ownValue(record, "skills");
  const activity = ownValue(record, "activity");
  const metrics = ownValue(record, "metrics");
  if (
    typeof schemaVersion !== "number" ||
    typeof generatedAt !== "string" ||
    typeof historyAvailable !== "boolean" ||
    !Array.isArray(skills) ||
    !Array.isArray(activity) ||
    !descriptors(metrics)
  ) return null;
  return cloned as Catalog;
}

async function fetchResponse(input: string, init: RequestInit, errorCode: BrowserApiErrorCode) {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw browserApiError(errorCode);
  }
}

async function parseSuccessfulResponse<T>(
  response: Response,
  validate: (value: unknown) => T | null,
  errorCode: BrowserApiErrorCode,
) {
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw browserApiError(errorCode);
  }
  try {
    const validated = validate(value);
    if (validated === null) throw browserApiError(errorCode);
    return validated;
  } catch (error) {
    if (isAbortError(error)) throw error;
    const safe = readBrowserApiError(error);
    throw safe
      ? browserApiError(safe.code, safe.retryAt, safe.stage)
      : browserApiError(errorCode);
  }
}

function localHttpError(response: Response) {
  if (response.status === 403) return browserApiError("local-origin-forbidden");
  if (response.status === 413) return browserApiError("local-query-too-long");
  return browserApiError("local-service-unavailable");
}

async function requestCatalog(path: "/api/catalog" | "/api/sync", method = "GET") {
  const response = await fetchResponse(`${API_BASE}${path}`, { method, cache: "no-store" }, "local-service-unavailable");
  if (!response.ok) throw localHttpError(response);
  return parseSuccessfulResponse(response, cloneCatalog, "local-response-invalid");
}

export async function fetchCatalog() {
  return requestCatalog("/api/catalog");
}

export async function syncCatalog() {
  return requestCatalog("/api/sync", "POST");
}

export async function recommendTask(
  query: string,
  signal?: AbortSignal,
): Promise<TaskRecommendationResponse> {
  const response = await fetchResponse(`${API_BASE}/api/recommend`, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
    signal,
  }, "local-service-unavailable");
  if (!response.ok) throw localHttpError(response);
  return parseSuccessfulResponse(response, cloneRecommendationResponse, "local-response-invalid");
}

export async function getGitHubStatus(signal?: AbortSignal): Promise<GitHubServiceStatus> {
  const response = await fetchResponse(`${API_BASE}/api/github-status`, {
    method: "GET",
    cache: "no-store",
    signal,
  }, "local-service-unavailable");
  if (!response.ok) throw localHttpError(response);
  return parseSuccessfulResponse(response, cloneGitHubStatus, "local-response-invalid");
}

async function readSafeErrorBody(response: Response) {
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    if (isAbortError(error)) throw error;
    return null;
  }
  try {
    const record = descriptors(value);
    if (!record) return null;
    const error = ownValue(record, "error");
    const retryAt = ownValue(record, "retryAt");
    const stage = ownValue(record, "stage");
    return {
      error: typeof error === "string" ? error : null,
      retryAt: isCanonicalIsoTimestamp(retryAt) ? retryAt : null,
      stage: typeof stage === "string" && GITHUB_SEARCH_STAGES.has(stage as GitHubSearchStage)
        ? stage as GitHubSearchStage
        : null,
    };
  } catch {
    return null;
  }
}

async function githubHttpError(response: Response) {
  const body = await readSafeErrorBody(response);
  const stage = body?.stage ?? null;
  if (response.status === 429) {
    return browserApiError("github-rate-limited", body?.retryAt ?? null, stage);
  }
  if (response.status === 401 && body?.error === "github-token-invalid") {
    return browserApiError("github-token-invalid", null, stage);
  }
  if (response.status === 422) return browserApiError("github-query-rejected", null, stage);
  if (response.status === 504) return browserApiError("github-request-timeout", null, stage);
  if (response.status === 409) {
    if (body?.error === "sanitized-query-unavailable") {
      return browserApiError("sanitized-query-unavailable", null, stage);
    }
    if (body?.error === "local-match-available") {
      return browserApiError("local-match-available", null, stage);
    }
    return browserApiError("github-request-failed", null, stage);
  }
  if (response.status === 403) {
    if (body?.error === "raw-consent-required") {
      return browserApiError("raw-consent-required", null, stage);
    }
    if (body?.error === "github-access-denied") {
      return browserApiError("github-access-denied", null, stage);
    }
    return browserApiError("local-origin-forbidden", null, stage);
  }
  if (response.status === 502) {
    return ["github-network-failed", "github-unavailable"].includes(body?.error ?? "")
      ? browserApiError("github-network-failed", null, stage)
      : browserApiError("github-request-failed", null, stage);
  }
  if (response.status === 503) {
    return body?.error === "github-token-missing"
      ? browserApiError("github-token-missing", null, stage)
      : browserApiError("github-suggestions-unavailable", null, stage);
  }
  if (response.status === 400 || response.status === 413) {
    return browserApiError("github-request-invalid", null, stage);
  }
  return browserApiError("github-request-failed", null, stage);
}

async function requestGitHubSuggestions(
  path: "/api/github-suggestions" | "/api/github-suggestions/original",
  body: { query: string; consentToken?: string },
  signal?: AbortSignal,
): Promise<GitHubSuggestionResponse> {
  const response = await fetchResponse(`${API_BASE}${path}`, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  }, "github-network-failed");
  if (!response.ok) throw await githubHttpError(response);
  return parseSuccessfulResponse(response, cloneSuggestionResponse, "github-response-invalid");
}

export async function searchSanitizedGitHubSkills(
  query: string,
  signal?: AbortSignal,
): Promise<GitHubSuggestionResponse> {
  return requestGitHubSuggestions("/api/github-suggestions", { query }, signal);
}

export async function searchOriginalGitHubSkills(
  query: string,
  consentToken: string,
  signal?: AbortSignal,
): Promise<GitHubSuggestionResponse> {
  return requestGitHubSuggestions(
    "/api/github-suggestions/original",
    { query, consentToken },
    signal,
  );
}

export async function revokeOriginalSearchConsent(consentToken: string): Promise<void> {
  if (!isValidConsentToken(consentToken)) {
    throw browserApiError("local-service-unavailable");
  }
  const response = await fetchResponse(`${API_BASE}/api/github-suggestions/revoke`, {
    method: "POST",
    cache: "no-store",
    keepalive: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ consentToken }),
  }, "local-service-unavailable");
  if (response.status !== 204) throw browserApiError("local-service-unavailable");
}
