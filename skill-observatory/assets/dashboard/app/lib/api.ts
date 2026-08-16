import type {
  Catalog,
  GitHubSearchPreview,
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
}

const ERROR_CODE_SET = new Set<string>(BROWSER_API_ERROR_CODES);

function browserApiError(code: BrowserApiErrorCode, retryAt: string | null = null) {
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
    const code = codeDescriptor && Object.hasOwn(codeDescriptor, "value")
      ? codeDescriptor.value
      : undefined;
    const retryAt = retryDescriptor && Object.hasOwn(retryDescriptor, "value")
      ? retryDescriptor.value
      : null;
    if (typeof code !== "string" || !ERROR_CODE_SET.has(code)) return null;
    return {
      code: code as BrowserApiErrorCode,
      retryAt: typeof retryAt === "string" && Number.isFinite(Date.parse(retryAt)) ? retryAt : null,
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

function ownValue(record: PropertyDescriptorMap, key: string) {
  const descriptor = Object.hasOwn(record, key) ? record[key] : null;
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : MISSING;
}

function cloneStringArray(value: unknown, maximum = 256) {
  if (!Array.isArray(value) || value.length > maximum || !value.every((item) => typeof item === "string")) {
    return null;
  }
  return [...value] as string[];
}

function clonePreview(value: unknown): GitHubSearchPreview | null | typeof MISSING {
  if (value === null) return null;
  const record = descriptors(value);
  if (!record) return MISSING;
  const terms = cloneStringArray(ownValue(record, "terms"), 6);
  const label = ownValue(record, "label");
  if (!terms || typeof label !== "string") return MISSING;
  return { terms, label };
}

function cloneConsent(value: unknown): RawSearchConsent | null | typeof MISSING {
  if (value === null) return null;
  const record = descriptors(value);
  if (!record) return MISSING;
  const token = ownValue(record, "token");
  const expiresAt = ownValue(record, "expiresAt");
  if (
    !isValidConsentToken(token) ||
    typeof expiresAt !== "string" ||
    !Number.isFinite(Date.parse(expiresAt))
  ) {
    return MISSING;
  }
  return { token, expiresAt };
}

function cloneRecommendation(value: unknown): Recommendation | null {
  const record = descriptors(value);
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
  const record = descriptors(value);
  if (!record) return null;
  const resultValue = ownValue(record, "results");
  if (!Array.isArray(resultValue) || resultValue.length > 3) return null;
  const results = resultValue.map(cloneRecommendation);
  if (results.some((result) => result === null)) return null;
  const githubSearch = clonePreview(ownValue(record, "githubSearch"));
  const rawConsent = cloneConsent(ownValue(record, "rawConsent"));
  if (githubSearch === MISSING || rawConsent === MISSING) return null;
  return {
    results: results as Recommendation[],
    githubSearch,
    rawConsent,
  };
}

function cloneSuggestion(value: unknown): GitHubSkillSuggestion | null {
  const record = descriptors(value);
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
    typeof pushedAt !== "string" ||
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

function cloneRateLimit(value: unknown): GitHubSuggestionResponse["rateLimit"] | typeof MISSING {
  if (value === null) return null;
  const record = descriptors(value);
  if (!record) return MISSING;
  const remaining = ownValue(record, "remaining");
  const reset = ownValue(record, "reset");
  const retryAt = ownValue(record, "retryAt");
  if (
    (remaining !== null && (typeof remaining !== "number" || !Number.isFinite(remaining))) ||
    (reset !== null && (typeof reset !== "number" || !Number.isFinite(reset))) ||
    (retryAt !== null && (typeof retryAt !== "string" || !Number.isFinite(Date.parse(retryAt))))
  ) {
    return MISSING;
  }
  return { remaining, reset, retryAt };
}

function cloneSuggestionResponse(value: unknown): GitHubSuggestionResponse | null {
  const record = descriptors(value);
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
  if (preview === MISSING || rawConsent === MISSING || rateLimit === MISSING) return null;
  return {
    preview,
    results: results as GitHubSkillSuggestion[],
    cached,
    incomplete,
    rawConsent,
    rateLimit,
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
    if (value.length > 4096) return MISSING;
    const output = [];
    for (const item of value) {
      const cloned = safeJsonClone(item, depth + 1);
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
    throw safe ? browserApiError(safe.code, safe.retryAt) : browserApiError(errorCode);
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
    return {
      error: typeof error === "string" ? error : null,
      retryAt: typeof retryAt === "string" && Number.isFinite(Date.parse(retryAt)) ? retryAt : null,
    };
  } catch {
    return null;
  }
}

async function githubHttpError(response: Response) {
  const body = await readSafeErrorBody(response);
  if (response.status === 429) return browserApiError("github-rate-limited", body?.retryAt ?? null);
  if (response.status === 422) return browserApiError("github-query-rejected");
  if (response.status === 504) return browserApiError("github-request-timeout");
  if (response.status === 409) {
    if (body?.error === "sanitized-query-unavailable") return browserApiError("sanitized-query-unavailable");
    if (body?.error === "local-match-available") return browserApiError("local-match-available");
    return browserApiError("github-request-failed");
  }
  if (response.status === 403) {
    return body?.error === "raw-consent-required"
      ? browserApiError("raw-consent-required")
      : browserApiError("local-origin-forbidden");
  }
  if (response.status === 502) {
    return body?.error === "github-network-failed"
      ? browserApiError("github-network-failed")
      : browserApiError("github-request-failed");
  }
  if (response.status === 503) return browserApiError("github-suggestions-unavailable");
  if (response.status === 400 || response.status === 413) return browserApiError("github-request-invalid");
  return browserApiError("github-request-failed");
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
