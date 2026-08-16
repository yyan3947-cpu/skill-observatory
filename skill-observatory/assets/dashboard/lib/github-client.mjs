import {
  assertGitHubRepositoryQueryWithinLimit,
  createGitHubQueryRejectedError,
} from "./github-query-contract.mjs";

const API_ORIGIN = "https://api.github.com";
const DEFAULT_API_VERSION = "2022-11-28";
const DEFAULT_MAX_CONTENT_BYTES = 256 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MILLISECONDS = 15_000;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

function requestHeaders(token, apiVersion) {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "skill-observatory",
    "x-github-api-version": apiVersion,
    ...(token ? { authorization: ["Bearer", token].join(" ") } : {}),
  };
}

function integerHeader(headers, name) {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return null;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) ? value : null;
}

function readRateLimit(headers) {
  const remaining = integerHeader(headers, "x-ratelimit-remaining");
  const reset = integerHeader(headers, "x-ratelimit-reset");
  const resetDate = reset === null ? null : new Date(reset * 1000);
  return {
    remaining,
    reset,
    retryAt: resetDate && Number.isFinite(resetDate.getTime()) ? resetDate.toISOString() : null,
  };
}

function githubError(code, message, { status, rateLimit } = {}) {
  const error = new Error(message);
  Object.defineProperty(error, "code", {
    value: code,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  if (status !== undefined) error.status = status;
  if (rateLimit) {
    error.rateLimit = rateLimit;
    error.retryAt = rateLimit.retryAt;
  }
  return error;
}

function validateRepository(repository) {
  const value = String(repository ?? "");
  const segments = value.split("/");
  if (
    !REPOSITORY_PATTERN.test(value) ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw githubError("invalid-github-repository", "invalid-github-repository");
  }
  return value;
}

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || codePoint === 127;
  });
}

function validateRef(ref) {
  const value = String(ref ?? "");
  if (!value || value === "." || value === ".." || value.length > 255 || hasControlCharacters(value)) {
    throw githubError("invalid-github-ref", "invalid-github-ref");
  }
  return value;
}

function encodeRepository(repository) {
  return validateRepository(repository).split("/").map(encodeURIComponent).join("/");
}

function encodeSkillPath(path) {
  const value = String(path ?? "");
  const segments = value.split("/");
  if (
    !value ||
    value.length > 2048 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    hasControlCharacters(value) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw githubError("invalid-github-path", "invalid-github-path");
  }
  return segments.map(encodeURIComponent).join("/");
}

function normalizePerPage(value) {
  const perPage = value ?? 10;
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) {
    throw githubError("invalid-github-request", "invalid-github-request");
  }
  return perPage;
}

export function createGitHubClient({
  fetchImpl = globalThis.fetch,
  token = "",
  apiVersion = DEFAULT_API_VERSION,
  requestTimeoutMilliseconds = DEFAULT_REQUEST_TIMEOUT_MILLISECONDS,
  requestScheduler = (task) => task(),
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw githubError("invalid-github-client", "invalid-github-client");
  }
  const normalizedToken = String(token ?? "").trim();
  const normalizedApiVersion = String(apiVersion ?? DEFAULT_API_VERSION).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalizedApiVersion)) {
    throw githubError("invalid-github-api-version", "invalid-github-api-version");
  }
  if (
    !Number.isInteger(requestTimeoutMilliseconds) ||
    requestTimeoutMilliseconds < 1 ||
    requestTimeoutMilliseconds > 120_000 ||
    typeof requestScheduler !== "function"
  ) {
    throw githubError("invalid-github-client", "invalid-github-client");
  }

  async function requestJson(url) {
    return requestScheduler(async () => {
      const controller = new AbortController();
      let timeout;
      const timeoutFailure = new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(githubError("github-request-timeout", "github-request-timeout"));
        }, requestTimeoutMilliseconds);
      });
      const request = (async () => {
        let response;
        try {
          response = await fetchImpl(url, {
            method: "GET",
            headers: requestHeaders(normalizedToken, normalizedApiVersion),
            redirect: "error",
            signal: controller.signal,
          });
        } catch {
          if (controller.signal.aborted) {
            throw githubError("github-request-timeout", "github-request-timeout");
          }
          throw githubError("github-network-failed", "github-network-failed");
        }

        const rateLimit = readRateLimit(response.headers);
        if (response.status === 403 || response.status === 429) {
          throw githubError("github-rate-limited", "github-rate-limited", {
            status: 429,
            rateLimit,
          });
        }
        if (!response.ok) {
          throw githubError("github-request-failed", "github-request-failed", {
            status: response.status,
            rateLimit,
          });
        }

        let data;
        try {
          data = await response.json();
        } catch {
          if (controller.signal.aborted) {
            throw githubError("github-request-timeout", "github-request-timeout");
          }
          throw githubError("github-request-failed", "github-request-failed", {
            status: response.status,
            rateLimit,
          });
        }
        return { data, rateLimit };
      })();
      try {
        return await Promise.race([request, timeoutFailure]);
      } finally {
        clearTimeout(timeout);
      }
    });
  }

  async function searchRepositories({ q, sort, order, perPage = 10 } = {}) {
    const query = String(q ?? "").trim();
    if (!query) {
      throw githubError("invalid-github-request", "invalid-github-request");
    }
    assertGitHubRepositoryQueryWithinLimit(query);
    if (sort !== undefined && sort !== "stars") {
      throw githubError("invalid-github-request", "invalid-github-request");
    }
    if (order !== undefined && order !== "asc" && order !== "desc") {
      throw githubError("invalid-github-request", "invalid-github-request");
    }

    const url = new URL("/search/repositories", API_ORIGIN);
    url.searchParams.set("q", query);
    url.searchParams.set("per_page", String(normalizePerPage(perPage)));
    if (sort) url.searchParams.set("sort", sort);
    if (order) url.searchParams.set("order", order);
    let response;
    try {
      response = await requestJson(url);
    } catch (error) {
      if (error?.code === "github-request-failed" && error.status === 422) {
        throw createGitHubQueryRejectedError({ rateLimit: error.rateLimit });
      }
      throw error;
    }
    const { data, rateLimit } = response;
    if (!data || typeof data !== "object" || !Array.isArray(data.items)) {
      throw githubError("github-request-failed", "github-request-failed", { status: 200, rateLimit });
    }
    return {
      items: data.items,
      incomplete: Boolean(data.incomplete_results),
      rateLimit,
    };
  }

  async function getTree({ repository, defaultBranch } = {}) {
    const encodedRepository = encodeRepository(repository);
    const encodedRef = encodeURIComponent(validateRef(defaultBranch));
    const url = new URL(`/repos/${encodedRepository}/git/trees/${encodedRef}`, API_ORIGIN);
    url.searchParams.set("recursive", "1");
    const { data, rateLimit } = await requestJson(url);
    if (!data || typeof data !== "object" || !Array.isArray(data.tree)) {
      throw githubError("github-request-failed", "github-request-failed", { status: 200, rateLimit });
    }
    return { tree: data.tree, truncated: Boolean(data.truncated), rateLimit };
  }

  async function getTextContent({
    repository,
    skillPath,
    defaultBranch,
    maxBytes = DEFAULT_MAX_CONTENT_BYTES,
  } = {}) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_CONTENT_BYTES) {
      throw githubError("invalid-github-request", "invalid-github-request");
    }
    const encodedRepository = encodeRepository(repository);
    const encodedPath = encodeSkillPath(skillPath);
    const ref = validateRef(defaultBranch);
    const url = new URL(`/repos/${encodedRepository}/contents/${encodedPath}`, API_ORIGIN);
    url.searchParams.set("ref", ref);
    const { data, rateLimit } = await requestJson(url);
    if (!data || typeof data !== "object" || Array.isArray(data) || data.encoding !== "base64") {
      throw githubError("github-content-invalid", "github-content-invalid", { status: 200, rateLimit });
    }
    const declaredSize = Number(data.size);
    if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
      throw githubError("github-content-too-large", "github-content-too-large", { status: 200, rateLimit });
    }
    const encoded = String(data.content ?? "").replace(/\s+/gu, "");
    if (!encoded || encoded.length > Math.ceil(maxBytes / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
      throw githubError("github-content-invalid", "github-content-invalid", { status: 200, rateLimit });
    }
    const buffer = Buffer.from(encoded, "base64");
    if (buffer.byteLength > maxBytes) {
      throw githubError("github-content-too-large", "github-content-too-large", { status: 200, rateLimit });
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
    } catch {
      throw githubError("github-content-invalid", "github-content-invalid", { status: 200, rateLimit });
    }
    return { text, size: buffer.byteLength, rateLimit };
  }

  return { searchRepositories, getTree, getTextContent };
}

export { API_ORIGIN };
