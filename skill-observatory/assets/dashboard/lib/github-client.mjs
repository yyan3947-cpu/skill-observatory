import { types } from "node:util";

import {
  assertGitHubCodeQueryWithinLimit,
  assertGitHubRepositoryQueryWithinLimit,
  createGitHubQueryRejectedError,
} from "./github-query-contract.mjs";

const API_ORIGIN = "https://api.github.com";
const DEFAULT_API_VERSION = "2022-11-28";
const DEFAULT_MAX_CONTENT_BYTES = 256 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MILLISECONDS = 15_000;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const RATE_LIMIT_RESOURCES = new Set(["search", "code_search", "core"]);
const SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const IMF_FIXDATE_PATTERN = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), ([0-9]{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/u;
const RFC850_DATE_PATTERN = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), ([0-9]{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/u;
const ASCTIME_DATE_PATTERN = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([ 0-9][0-9]) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$/u;

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
  const text = raw.trim();
  if (!/^\d+$/u.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function buildUtcDate({ day, month, year, hour, minute, second }) {
  const monthIndex = MONTHS.indexOf(month);
  if (monthIndex === -1) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== monthIndex ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) return null;
  return date;
}

function buildHttpDate({ weekday, day, month, year, hour, minute, second }) {
  const weekdayIndex = SHORT_WEEKDAYS.indexOf(weekday.slice(0, 3));
  if (weekdayIndex === -1) return null;
  const date = buildUtcDate({ day, month, year, hour, minute, second });
  return date?.getUTCDay() === weekdayIndex ? date : null;
}

function parseImfFixdate(value) {
  const match = IMF_FIXDATE_PATTERN.exec(value);
  if (!match) return null;
  const [, weekday, day, month, year, hour, minute, second] = match;
  const date = buildHttpDate({
    weekday,
    day: Number(day),
    month,
    year: Number(year),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
  });
  return date?.toUTCString() === value ? date : null;
}

function resolveRfc850Year(twoDigitYear, { day, month, hour, minute, second }, nowMilliseconds) {
  const now = new Date(nowMilliseconds);
  if (!Number.isFinite(now.getTime())) return null;
  const currentYear = now.getUTCFullYear();
  let year = Math.floor(currentYear / 100) * 100 + twoDigitYear;
  if (year > currentYear + 50) return year - 100;
  if (year === currentYear + 50) {
    const candidate = buildUtcDate({ day, month, year, hour, minute, second });
    if (!candidate) return null;
    const candidateParts = [
      candidate.getUTCMonth(),
      candidate.getUTCDate(),
      candidate.getUTCHours(),
      candidate.getUTCMinutes(),
      candidate.getUTCSeconds(),
    ];
    const currentParts = [
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
    ];
    const firstDifference = candidateParts.findIndex((part, index) => part !== currentParts[index]);
    if (firstDifference !== -1 && candidateParts[firstDifference] > currentParts[firstDifference]) {
      year -= 100;
    }
  }
  return year;
}

function parseRfc850Date(value, nowMilliseconds) {
  const match = RFC850_DATE_PATTERN.exec(value);
  if (!match) return null;
  const [, weekday, day, month, shortYear, hour, minute, second] = match;
  const fields = {
    day: Number(day),
    month,
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
  };
  const year = resolveRfc850Year(Number(shortYear), fields, nowMilliseconds);
  if (year === null) return null;
  const date = buildHttpDate({
    weekday,
    year,
    ...fields,
  });
  if (!date) return null;
  const roundtrip = `${LONG_WEEKDAYS[date.getUTCDay()]}, ${day}-${month}-${shortYear} ${hour}:${minute}:${second} GMT`;
  return roundtrip === value ? date : null;
}

function parseAsctimeDate(value) {
  const match = ASCTIME_DATE_PATTERN.exec(value);
  if (!match) return null;
  const [, weekday, month, rawDay, hour, minute, second, year] = match;
  const day = Number(rawDay.trim());
  const date = buildHttpDate({
    weekday,
    day,
    month,
    year: Number(year),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
  });
  if (!date) return null;
  const roundtrip = `${weekday} ${month} ${day < 10 ? ` ${day}` : String(day)} ${hour}:${minute}:${second} ${year}`;
  return roundtrip === value ? date : null;
}

function retryAfterHeader(headers, now) {
  const raw = headers.get("retry-after");
  if (raw === null || raw.trim() === "") return null;
  const value = raw.trim();
  if (/^\d+$/u.test(value)) {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds)) return null;
    const date = new Date(now() + seconds * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  const imfFixdate = parseImfFixdate(value);
  if (imfFixdate) return imfFixdate.toISOString();
  const currentTime = now();
  const rfc850Date = parseRfc850Date(value, currentTime);
  if (rfc850Date) return rfc850Date.toISOString();
  return parseAsctimeDate(value)?.toISOString() ?? null;
}

function retryAtForReset(reset) {
  if (reset === null) return null;
  const resetDate = new Date(reset * 1000);
  return Number.isFinite(resetDate.getTime()) ? resetDate.toISOString() : null;
}

function readRateLimit(headers, retryAfter = null) {
  const remaining = integerHeader(headers, "x-ratelimit-remaining");
  const reset = integerHeader(headers, "x-ratelimit-reset");
  const rawResource = headers.get("x-ratelimit-resource");
  const resource = RATE_LIMIT_RESOURCES.has(rawResource) ? rawResource : null;
  return {
    remaining,
    reset,
    retryAt: retryAfter ?? retryAtForReset(reset),
    resource,
  };
}

function githubError(code, message, { status, rateLimit } = {}) {
  const error = new Error(message);
  const properties = Object.create(null);
  properties.code = {
    value: code,
    enumerable: true,
    configurable: true,
    writable: true,
  };
  if (status !== undefined) {
    properties.status = {
      value: status,
      enumerable: true,
      configurable: true,
      writable: true,
    };
  }
  if (rateLimit) {
    properties.rateLimit = {
      value: rateLimit,
      enumerable: true,
      configurable: true,
      writable: true,
    };
    properties.retryAt = {
      value: rateLimit.retryAt,
      enumerable: true,
      configurable: true,
      writable: true,
    };
  }
  Object.defineProperties(error, properties);
  return error;
}

function plainDataDescriptors(value) {
  if (types.isProxy(value) || !value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => !Object.hasOwn(descriptors[key], "value"))) {
    return null;
  }
  return descriptors;
}

function dataField(descriptors, key) {
  return descriptors && Object.hasOwn(descriptors, key) ? descriptors[key].value : undefined;
}

function snapshotExactOptions(options, allowedFields) {
  const value = options === undefined ? {} : options;
  const descriptors = plainDataDescriptors(value);
  if (
    !descriptors ||
    Reflect.ownKeys(descriptors).some((key) => (
      typeof key !== "string" || !allowedFields.includes(key)
    ))
  ) {
    throw githubError("invalid-github-request", "invalid-github-request");
  }
  const snapshot = Object.create(null);
  for (const field of allowedFields) {
    if (Object.hasOwn(descriptors, field)) snapshot[field] = descriptors[field].value;
  }
  return snapshot;
}

function requestFailed(rateLimit) {
  return githubError("github-request-failed", "github-request-failed", { status: 200, rateLimit });
}

function isValidRepository(value) {
  if (typeof value !== "string") return false;
  const segments = value.split("/");
  return REPOSITORY_PATTERN.test(value) &&
    !segments.some((segment) => segment === "." || segment === "..");
}

function validateRepository(repository) {
  const value = typeof repository === "string" ? repository : "";
  if (!isValidRepository(value)) {
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

export function isValidGitRef(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 255 ||
    value === "@" ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{")
  ) return false;
  const forbidden = new Set([" ", "~", "^", ":", "?", "*", "[", "\\"]);
  if ([...value].some((character) => forbidden.has(character))) return false;
  if (hasControlCharacters(value)) return false;
  return value.split("/").every((segment) => (
    segment && !segment.startsWith(".") && !segment.endsWith(".lock")
  ));
}

function validateRef(ref) {
  const value = typeof ref === "string" ? ref : "";
  if (!isValidGitRef(value)) {
    throw githubError("invalid-github-ref", "invalid-github-ref");
  }
  return value;
}

function encodeRepository(repository) {
  return validateRepository(repository).split("/").map(encodeURIComponent).join("/");
}

function encodeSkillPath(path) {
  const value = typeof path === "string" ? path : "";
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

function isValidCodeSearchPath(path) {
  if (typeof path !== "string") return false;
  const segments = path.split("/");
  return Boolean(path) &&
    path.length <= 2048 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !hasControlCharacters(path) &&
    segments.every((segment) => segment && segment !== "." && segment !== "..");
}

function plainArrayDataValues(value) {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return null;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = dataField(descriptors, "length");
  if (!Number.isSafeInteger(length) || length < 0) return null;
  if (Reflect.ownKeys(descriptors).some((key) => {
    if (!Object.hasOwn(descriptors[key], "value")) return true;
    if (key === "length") return false;
    if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)) return true;
    return Number(key) >= length;
  })) return null;
  const values = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
    values.push(descriptor.value);
  }
  return values;
}

function snapshotCodeSearchItem(item) {
  const descriptors = plainDataDescriptors(item);
  const name = dataField(descriptors, "name");
  const path = dataField(descriptors, "path");
  const sha = dataField(descriptors, "sha");
  const repositoryPayload = dataField(descriptors, "repository");
  const repositoryDescriptors = plainDataDescriptors(repositoryPayload);
  const repository = dataField(repositoryDescriptors, "full_name");
  if (
    !descriptors ||
    typeof name !== "string" ||
    !name ||
    name.length > 255 ||
    name.includes("/") ||
    name.includes("\\") ||
    hasControlCharacters(name) ||
    !isValidCodeSearchPath(path) ||
    path.split("/").at(-1) !== name ||
    typeof sha !== "string" ||
    !/^[a-f0-9]{40}$/iu.test(sha) ||
    !repositoryDescriptors ||
    !isValidRepository(repository)
  ) return null;
  return { name, path, sha, repository };
}

function isCanonicalGitHubTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)) {
    return false;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === `${value.slice(0, -1)}.000Z`;
}

function isValidSpdxIdentifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/u.test(value);
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
  now = Date.now,
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
    typeof requestScheduler !== "function" ||
    typeof now !== "function"
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

        const retryAfter = retryAfterHeader(response.headers, now);
        const rateLimit = readRateLimit(response.headers, retryAfter);
        if (response.status === 401) {
          throw githubError("github-token-invalid", "github-token-invalid", {
            status: 401,
            rateLimit,
          });
        }
        if (
          response.status === 429 ||
          retryAfter !== null ||
          (response.status === 403 && rateLimit.remaining === 0)
        ) {
          throw githubError("github-rate-limited", "github-rate-limited", {
            status: 429,
            rateLimit,
          });
        }
        if (response.status === 403) {
          throw githubError("github-access-denied", "github-access-denied", {
            status: 403,
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

  async function searchCode(options = {}) {
    const safe = snapshotExactOptions(options, ["q", "perPage"]);
    const q = dataField(Object.getOwnPropertyDescriptors(safe), "q");
    const perPage = dataField(Object.getOwnPropertyDescriptors(safe), "perPage") ?? 12;
    const query = typeof q === "string" ? q.trim() : "";
    assertGitHubCodeQueryWithinLimit(query);
    const url = new URL("/search/code", API_ORIGIN);
    url.searchParams.set("q", query);
    url.searchParams.set("per_page", String(normalizePerPage(perPage)));
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
    const descriptors = plainDataDescriptors(data);
    const rawItems = dataField(descriptors, "items");
    const incomplete = dataField(descriptors, "incomplete_results");
    const itemValues = plainArrayDataValues(rawItems);
    const items = itemValues?.map(snapshotCodeSearchItem);
    if (!items || items.some((item) => item === null) || typeof incomplete !== "boolean") {
      throw requestFailed(rateLimit);
    }
    return { items, incomplete, rateLimit };
  }

  async function getRepositoryMetadata(options = {}) {
    const safe = snapshotExactOptions(options, ["repository"]);
    const repository = dataField(Object.getOwnPropertyDescriptors(safe), "repository");
    const requestedRepository = validateRepository(repository);
    const encodedRepository = encodeRepository(requestedRepository);
    const url = new URL(`/repos/${encodedRepository}`, API_ORIGIN);
    const { data, rateLimit } = await requestJson(url);
    const descriptors = plainDataDescriptors(data);
    const responseRepository = dataField(descriptors, "full_name");
    const defaultBranch = dataField(descriptors, "default_branch");
    const stars = dataField(descriptors, "stargazers_count");
    const pushedAt = dataField(descriptors, "pushed_at");
    const licensePayload = dataField(descriptors, "license");
    const repositoryUrl = dataField(descriptors, "html_url");
    const validResponseRepository = isValidRepository(responseRepository) &&
      responseRepository.toLowerCase() === requestedRepository.toLowerCase();
    const validDefaultBranch = isValidGitRef(defaultBranch);
    const expectedRepositoryUrl = validResponseRepository
      ? `https://github.com/${responseRepository}`
      : "";
    if (
      !descriptors ||
      !validResponseRepository ||
      !validDefaultBranch ||
      !Number.isSafeInteger(stars) ||
      stars < 0 ||
      !isCanonicalGitHubTimestamp(pushedAt) ||
      repositoryUrl !== expectedRepositoryUrl
    ) {
      throw requestFailed(rateLimit);
    }

    let license = null;
    if (licensePayload !== null) {
      const licenseDescriptors = plainDataDescriptors(licensePayload);
      const spdxId = dataField(licenseDescriptors, "spdx_id");
      if (!licenseDescriptors || !isValidSpdxIdentifier(spdxId)) {
        throw requestFailed(rateLimit);
      }
      license = spdxId;
    }
    return {
      repository: responseRepository,
      defaultBranch,
      stars,
      pushedAt,
      license,
      repositoryUrl: expectedRepositoryUrl,
      rateLimit,
    };
  }

  function normalizeRateLimitBucket(value, expectedResource) {
    const descriptors = plainDataDescriptors(value);
    const remaining = dataField(descriptors, "remaining");
    const reset = dataField(descriptors, "reset");
    const resource = dataField(descriptors, "resource");
    if (
      !descriptors ||
      !Number.isSafeInteger(remaining) ||
      remaining < 0 ||
      !Number.isSafeInteger(reset) ||
      reset < 0 ||
      resource !== expectedResource
    ) return null;
    return {
      remaining,
      reset,
      retryAt: retryAtForReset(reset),
      resource,
    };
  }

  async function getRateLimitStatus(options = {}) {
    snapshotExactOptions(options, []);
    const url = new URL("/rate_limit", API_ORIGIN);
    const { data, rateLimit } = await requestJson(url);
    const descriptors = plainDataDescriptors(data);
    const resources = dataField(descriptors, "resources");
    const resourceDescriptors = plainDataDescriptors(resources);
    const search = normalizeRateLimitBucket(dataField(resourceDescriptors, "search"), "search");
    const codeSearch = normalizeRateLimitBucket(
      dataField(resourceDescriptors, "code_search"),
      "code_search",
    );
    if (!descriptors || !resourceDescriptors || !search || !codeSearch) {
      throw requestFailed(rateLimit);
    }
    return { search, codeSearch };
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

  return {
    searchRepositories,
    searchCode,
    getRepositoryMetadata,
    getRateLimitStatus,
    getTree,
    getTextContent,
  };
}

export { API_ORIGIN };
