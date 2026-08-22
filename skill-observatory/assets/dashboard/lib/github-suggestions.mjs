import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, posix } from "node:path";
import { types } from "node:util";

import yaml from "js-yaml";

import { atomicWriteJson, readJsonFile } from "./cache.mjs";
import { createGitHubClient, isValidGitRef } from "./github-client.mjs";
import {
  buildGitHubSearchPlan,
  buildOriginalGitHubRepositoryQueries,
} from "./github-query.mjs";
import { normalizeText, recommendSkills } from "./recommend.mjs";
import { ensurePrivateDirectory } from "./runtime-paths.mjs";

const CACHE_VERSION = 4;
const CACHE_TTL_MILLISECONDS = 24 * 60 * 60 * 1000;
const MAX_REPOSITORIES = 12;
const MAX_SKILL_FILES_PER_REPOSITORY = 3;
const MAX_SKILL_BYTES = 256 * 1024;
const MAX_NETWORK_CONCURRENCY = 3;
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
const ALLOWED_FRONTMATTER_PROPERTIES = new Set(["name", "description", "license", "allowed-tools", "metadata"]);
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const YAML_1_1_BOOLEAN_PATTERN = /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/u;
const YAML_1_1_SEXAGESIMAL_INTEGER_PATTERN = /^[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+$/u;
const YAML_1_1_SEXAGESIMAL_FLOAT_PATTERN = /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/u;
const SAFE_REJECTION_REASONS = Object.freeze([
  "invalid-structure",
  "invalid-content",
  "irrelevant",
  "duplicate",
  "unavailable",
]);

function constructSexagesimal(value) {
  const normalized = value.replaceAll("_", "");
  const negative = normalized.startsWith("-");
  const unsigned = /^[+-]/u.test(normalized) ? normalized.slice(1) : normalized;
  const total = unsigned.split(":").reduce((result, part) => result * 60 + Number(part), 0);
  return negative ? -total : total;
}

const YAML_1_1_SAFE_SCHEMA = yaml.DEFAULT_SCHEMA.extend({
  implicit: [
    new yaml.Type("tag:yaml.org,2002:bool", {
      kind: "scalar",
      resolve: (value) => YAML_1_1_BOOLEAN_PATTERN.test(value),
      construct: (value) => /^(?:yes|Yes|YES|true|True|TRUE|on|On|ON)$/u.test(value),
    }),
    new yaml.Type("tag:skill-observatory.local,2026:yaml-1.1-sexagesimal-int", {
      kind: "scalar",
      resolve: (value) => YAML_1_1_SEXAGESIMAL_INTEGER_PATTERN.test(value),
      construct: constructSexagesimal,
    }),
    new yaml.Type("tag:skill-observatory.local,2026:yaml-1.1-sexagesimal-float", {
      kind: "scalar",
      resolve: (value) => YAML_1_1_SEXAGESIMAL_FLOAT_PATTERN.test(value),
      construct: constructSexagesimal,
    }),
    new yaml.Type("tag:skill-observatory.local,2026:unsupported-plain-scalar", {
      kind: "scalar",
      resolve: (value) => value === "=" || value === "<<",
      construct: () => undefined,
    }),
  ],
});
const inFlightSuggestions = new Map();
const cacheWriteQueues = new Map();

let activeNetworkRequests = 0;
const pendingNetworkRequests = [];

async function withNetworkPermit(task, {
  shouldStop = () => false,
  stopError = () => codedError("github-request-cancelled"),
} = {}) {
  if (shouldStop()) throw stopError();
  if (activeNetworkRequests >= MAX_NETWORK_CONCURRENCY) {
    await new Promise((resolve) => pendingNetworkRequests.push(resolve));
  } else {
    activeNetworkRequests += 1;
  }
  try {
    if (shouldStop()) throw stopError();
    return await task();
  } finally {
    const next = pendingNetworkRequests.shift();
    if (next) next();
    else activeNetworkRequests -= 1;
  }
}

function withCacheWriteLock(cachePath, task) {
  const previous = cacheWriteQueues.get(cachePath) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(task);
  const queueTail = result.catch(() => {});
  cacheWriteQueues.set(cachePath, queueTail);
  return result.finally(() => {
    if (cacheWriteQueues.get(cachePath) === queueTail) cacheWriteQueues.delete(cachePath);
  });
}

function resolveNow(now) {
  const value = typeof now === "function" ? now() : (now ?? Date.now());
  const milliseconds = value instanceof Date
    ? value.getTime()
    : typeof value === "string"
      ? Date.parse(value)
      : Number(value);
  if (!Number.isFinite(milliseconds)) throw new Error("invalid-current-time");
  return milliseconds;
}

function mergeRateLimit(current, next) {
  if (!next || typeof next !== "object") return current;
  if (!current) return next;
  const currentRemaining = Number.isFinite(current.remaining) ? current.remaining : Number.POSITIVE_INFINITY;
  const nextRemaining = Number.isFinite(next.remaining) ? next.remaining : Number.POSITIVE_INFINITY;
  return nextRemaining <= currentRemaining ? next : current;
}

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  try {
    return new Date(milliseconds).toISOString() === value;
  } catch {
    return false;
  }
}

function publicRateLimit(value) {
  if (!value || typeof value !== "object") return null;
  const remaining = value.remaining;
  const reset = value.reset;
  const retryAt = value.retryAt;
  if (
    !(remaining === null || (Number.isSafeInteger(remaining) && remaining >= 0)) ||
    !(reset === null || (Number.isSafeInteger(reset) && reset >= 0)) ||
    !(retryAt === null || isCanonicalIsoTimestamp(retryAt))
  ) return null;
  return { remaining, reset, retryAt };
}

function createDiagnostics() {
  return {
    stageReached: "repository-search",
    repositoryHits: 0,
    codeHits: 0,
    validatedCandidates: 0,
    rejectedCandidates: 0,
    deduplicatedCandidates: 0,
    rejectionCounts: new Map(),
    cached: false,
    incomplete: false,
    rateLimits: { search: null, codeSearch: null },
  };
}

function recordRejection(diagnostics, reason) {
  if (!SAFE_REJECTION_REASONS.includes(reason)) return;
  diagnostics.rejectedCandidates += 1;
  diagnostics.rejectionCounts.set(reason, (diagnostics.rejectionCounts.get(reason) ?? 0) + 1);
  if (reason === "duplicate") diagnostics.deduplicatedCandidates += 1;
}

function noteDiagnosticRateLimit(diagnostics, bucket, rateLimit) {
  const next = publicRateLimit(rateLimit);
  if (!next) return;
  diagnostics.rateLimits[bucket] = publicRateLimit(
    mergeRateLimit(diagnostics.rateLimits[bucket], next),
  );
}

function finalizeDiagnostics(diagnostics, { cached = diagnostics.cached } = {}) {
  return {
    stageReached: diagnostics.stageReached,
    repositoryHits: diagnostics.repositoryHits,
    codeHits: diagnostics.codeHits,
    validatedCandidates: diagnostics.validatedCandidates,
    rejectedCandidates: diagnostics.rejectedCandidates,
    deduplicatedCandidates: diagnostics.deduplicatedCandidates,
    rejectionCounts: SAFE_REJECTION_REASONS
      .filter((reason) => diagnostics.rejectionCounts.has(reason))
      .map((reason) => ({ reason, count: diagnostics.rejectionCounts.get(reason) })),
    cached,
    incomplete: diagnostics.incomplete,
    rateLimits: {
      search: diagnostics.rateLimits.search,
      codeSearch: diagnostics.rateLimits.codeSearch,
    },
  };
}

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || codePoint === 127;
  });
}

function plainDataDescriptors(value) {
  if (types.isProxy(value) || !value || typeof value !== "object" || Array.isArray(value)) return null;
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

function plainArrayValues(value) {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return null;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptorValue(descriptors, "length");
  if (!Number.isSafeInteger(length) || length < 0) return null;
  if (Reflect.ownKeys(descriptors).some((key) => {
    if (!Object.hasOwn(descriptors[key], "value")) return true;
    if (key === "length") return false;
    if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)) return true;
    return Number(key) >= length;
  })) return null;
  const output = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
    output.push(descriptor.value);
  }
  return output;
}

function normalizeRepository(item) {
  const descriptors = plainDataDescriptors(item);
  const repository = descriptorValue(descriptors, "full_name");
  if (
    !descriptors ||
    typeof repository !== "string" ||
    !REPOSITORY_PATTERN.test(repository)
  ) return null;
  const repositorySegments = repository.split("/");
  if (repositorySegments.some((segment) => segment === "." || segment === "..")) return null;
  const defaultBranch = descriptorValue(descriptors, "default_branch");
  if (!isValidGitRef(defaultBranch)) return null;
  const archived = descriptorValue(descriptors, "archived");
  const disabled = descriptorValue(descriptors, "disabled");
  const fork = descriptorValue(descriptors, "fork");
  if (
    typeof archived !== "boolean" ||
    typeof disabled !== "boolean" ||
    typeof fork !== "boolean" ||
    archived || disabled || fork
  ) return null;
  const rawStars = descriptorValue(descriptors, "stargazers_count");
  const pushedAt = descriptorValue(descriptors, "pushed_at");
  const licensePayload = descriptorValue(descriptors, "license");
  const licenseDescriptors = licensePayload === null ? null : plainDataDescriptors(licensePayload);
  const license = licensePayload === null ? null : descriptorValue(licenseDescriptors, "spdx_id");
  if (
    !Number.isSafeInteger(rawStars) || rawStars < 0 ||
    typeof pushedAt !== "string" || pushedAt.length > 64 ||
    !(license === null || (typeof license === "string" && license.length <= 64))
  ) return null;
  return {
    repository,
    defaultBranch,
    stars: rawStars,
    pushedAt,
    license,
  };
}

function alternateRepositories(searches, diagnostics) {
  let incomplete = false;
  const queues = searches.map((search) => {
    const items = plainArrayValues(search.items) ?? [];
    return items.map((item) => {
      const normalized = normalizeRepository(item);
      if (!normalized) {
        recordRejection(diagnostics, "invalid-structure");
        const descriptors = plainDataDescriptors(item);
        const invalidDefaultBranch = !isValidGitRef(descriptorValue(descriptors, "default_branch"));
        const archived = descriptorValue(descriptors, "archived");
        const disabled = descriptorValue(descriptors, "disabled");
        const fork = descriptorValue(descriptors, "fork");
        const policyExclusion = (
          typeof archived === "boolean" &&
          typeof disabled === "boolean" &&
          typeof fork === "boolean" &&
          (archived || disabled || fork)
        );
        incomplete ||= invalidDefaultBranch || !policyExclusion;
      }
      return normalized;
    }).filter(Boolean);
  });
  const indexes = queues.map(() => 0);
  const selected = [];
  const seen = new Set();
  let madeProgress = true;
  while (selected.length < MAX_REPOSITORIES && madeProgress) {
    madeProgress = false;
    for (let queueIndex = 0; queueIndex < queues.length && selected.length < MAX_REPOSITORIES; queueIndex += 1) {
      const queue = queues[queueIndex];
      while (indexes[queueIndex] < queue.length) {
        const item = queue[indexes[queueIndex]];
        indexes[queueIndex] += 1;
        madeProgress = true;
        const key = item.repository.toLowerCase();
        if (seen.has(key)) {
          recordRejection(diagnostics, "duplicate");
          continue;
        }
        seen.add(key);
        selected.push(item);
        break;
      }
    }
  }
  return { repositories: selected, incomplete };
}

function skillPathsFromTree(tree, diagnostics) {
  const seen = new Set();
  const values = plainArrayValues(tree);
  if (!values) {
    recordRejection(diagnostics, "invalid-structure");
    return [];
  }
  return values
    .map((item) => {
      const descriptors = plainDataDescriptors(item);
      const type = descriptorValue(descriptors, "type");
      const path = descriptorValue(descriptors, "path");
      const size = descriptorValue(descriptors, "size");
      if (type !== "blob" || typeof path !== "string" || path.split("/").at(-1) !== "SKILL.md") {
        return null;
      }
      if (!isSafeRelativePath(path)) {
        recordRejection(diagnostics, "invalid-structure");
        return null;
      }
      if (Number.isFinite(Number(size)) && Number(size) > MAX_SKILL_BYTES) {
        recordRejection(diagnostics, "invalid-content");
        return null;
      }
      return path;
    })
    .filter(Boolean)
    .filter((path) => {
      if (seen.has(path)) {
        recordRejection(diagnostics, "duplicate");
        return false;
      }
      seen.add(path);
      return true;
    })
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
    .slice(0, MAX_SKILL_FILES_PER_REPOSITORY);
}

function isSafeRelativePath(path) {
  const value = String(path ?? "");
  const segments = value.split("/");
  return Boolean(
    value &&
    value.length <= 2048 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !hasControlCharacters(value) &&
    segments.every((segment) => segment && segment !== "." && segment !== "..")
  );
}

function compactSummary(description) {
  const compact = String(description ?? "").replace(/\s+/gu, " ").trim();
  if (!compact) return "";
  const sentence = compact.match(/^.{1,220}?[。！？.!?](?:\s|$)/u)?.[0] ?? compact.slice(0, 220);
  return sentence.trim();
}

function isPlainObject(value) {
  if (types.isProxy(value) || !value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPlainYamlValue(value, seen = new WeakSet(), depth = 0) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (typeof value !== "object" || depth > 20 || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => isPlainYamlValue(item, seen, depth + 1));
  if (!isPlainObject(value)) return false;
  return Object.entries(value).every(([key, item]) => (
    !["__proto__", "prototype", "constructor"].includes(key) &&
    isPlainYamlValue(item, seen, depth + 1)
  ));
}

function parseStrictFrontmatter(text) {
  const source = String(text ?? "");
  if (!source.startsWith("---\n")) return null;
  const lines = source.split("\n");
  const end = lines.findIndex((line, index) => index > 0 && line === "---");
  if (end < 0) return null;
  const frontmatterLines = lines.slice(1, end);
  if (frontmatterLines.some((line) => ["...", "---"].includes(line.trim()) || line.trimStart().startsWith("%"))) {
    return null;
  }
  const frontmatterText = frontmatterLines.join("\n");
  if (/(^|[\s:[{,])(?:&|\*)[A-Za-z0-9_-]+(?=$|[\s,\]}])/u.test(frontmatterText)) return null;
  let document;
  try {
    document = yaml.load(frontmatterText, {
      schema: YAML_1_1_SAFE_SCHEMA,
      json: false,
    });
  } catch {
    return null;
  }
  if (!isPlainObject(document) || !isPlainYamlValue(document)) return null;
  if (Object.keys(document).some((key) => !ALLOWED_FRONTMATTER_PROPERTIES.has(key))) return null;
  if (typeof document.name !== "string" || typeof document.description !== "string") return null;
  const name = document.name.trim();
  const description = document.description.trim();
  if (
    name.length > MAX_SKILL_NAME_LENGTH ||
    description.length > MAX_SKILL_DESCRIPTION_LENGTH ||
    description.includes("<") ||
    description.includes(">")
  ) return null;
  return {
    name,
    description,
  };
}

function parseCandidate({ repository, path, text }) {
  const parsed = parseStrictFrontmatter(text);
  if (!parsed || !SKILL_NAME_PATTERN.test(parsed.name)) return null;
  const summary = compactSummary(parsed.description);
  if (!summary) return null;
  const skillDirectory = posix.dirname(path);
  if (skillDirectory !== "." && posix.basename(skillDirectory) !== parsed.name) return null;
  return {
    id: `${repository}\0${path}`,
    name: parsed.name,
    summary,
    skillDirectory,
    path,
    catalogRecord: {
      id: `${repository}\0${path}`,
      name: parsed.name,
      summaryZh: summary,
      description: parsed.description,
      status: "unchecked",
      category: "其他",
      aliases: [],
      intentTags: [],
      keywords: [],
      usageCount: 0,
      path: `${repository}/${path}`,
    },
  };
}

async function mapWithConcurrency(items, concurrency, mapper, shouldStop = () => false) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length && !shouldStop()) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  const count = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: count }, () => worker()));
  return results;
}

function publicResult(candidate, match) {
  return {
    repository: candidate.repository,
    repositoryUrl: `https://github.com/${candidate.repository}`,
    skillDirectory: candidate.skillDirectory,
    name: candidate.name,
    summary: candidate.summary,
    reasonZh: match.reasonZh,
    stars: candidate.stars,
    pushedAt: candidate.pushedAt,
    license: candidate.license,
  };
}

function canonicalReferenceKey(repository, path, ref) {
  return `${String(repository).toLowerCase()}\0${path}\0${ref}`;
}

async function validateCandidateReference({
  client,
  repository,
  defaultBranch,
  skillPath,
  metadata,
  matchText,
  diagnostics,
}) {
  let content;
  try {
    content = await client.getTextContent({
      repository,
      defaultBranch,
      skillPath,
      maxBytes: MAX_SKILL_BYTES,
    });
  } catch (error) {
    if (["github-content-too-large", "github-content-invalid"].includes(error?.code)) {
      recordRejection(diagnostics, "invalid-content");
      return null;
    }
    throw error;
  }
  const parsed = parseCandidate({ repository, path: skillPath, text: content.text });
  if (!parsed) {
    recordRejection(diagnostics, "invalid-content");
    return null;
  }
  const [match] = recommendSkills(matchText, { skills: [parsed.catalogRecord] }, {
    limit: 1,
    minimumScore: 12,
  });
  if (!match) {
    recordRejection(diagnostics, "irrelevant");
    return null;
  }
  diagnostics.validatedCandidates += 1;
  return {
    ...metadata,
    ...parsed,
    matchScore: match.score,
    match,
  };
}

function distinctCandidateCount(candidates, deduplicateNames) {
  if (!deduplicateNames) return candidates.length;
  return new Set(candidates.map((candidate) => normalizeText(candidate.name))).size;
}

function validCachedResult(item) {
  const descriptors = plainDataDescriptors(item);
  const fields = [
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
  if (!descriptors || Reflect.ownKeys(descriptors).some((key) => !fields.includes(key))) return null;
  if (Reflect.ownKeys(descriptors).length !== fields.length) return null;
  const repository = descriptorValue(descriptors, "repository");
  const name = descriptorValue(descriptors, "name");
  if (
    typeof repository !== "string" ||
    typeof name !== "string" ||
    !REPOSITORY_PATTERN.test(repository) ||
    repository.split("/").some((segment) => segment === "." || segment === "..") ||
    !SKILL_NAME_PATTERN.test(name)
  ) return null;
  const repositoryUrl = descriptorValue(descriptors, "repositoryUrl");
  const directory = descriptorValue(descriptors, "skillDirectory");
  if (
    repositoryUrl !== `https://github.com/${repository}` ||
    typeof directory !== "string" ||
    !directory ||
    directory.endsWith("SKILL.md") ||
    (directory !== "." && (!isSafeRelativePath(directory) || directory.split("/").at(-1) !== name))
  ) return null;
  const summary = descriptorValue(descriptors, "summary");
  const reasonZh = descriptorValue(descriptors, "reasonZh");
  const stars = descriptorValue(descriptors, "stars");
  const pushedAt = descriptorValue(descriptors, "pushedAt");
  const license = descriptorValue(descriptors, "license");
  if (
    typeof summary !== "string" || !summary || summary.length > 220 ||
    typeof reasonZh !== "string" || !reasonZh || reasonZh.length > 160 ||
    !Number.isSafeInteger(stars) || stars < 0 ||
    typeof pushedAt !== "string" || pushedAt.length > 64 ||
    !(license === null || (typeof license === "string" && license.length <= 64))
  ) return null;
  return {
    repository,
    repositoryUrl: `https://github.com/${repository}`,
    skillDirectory: directory,
    name,
    summary,
    reasonZh,
    stars,
    pushedAt,
    license,
  };
}

function normalizeCachedRateLimit(value) {
  if (value === null) return null;
  const descriptors = plainDataDescriptors(value);
  if (
    !descriptors ||
    Reflect.ownKeys(descriptors).length !== 3 ||
    Reflect.ownKeys(descriptors).some((key) => !["remaining", "reset", "retryAt"].includes(key))
  ) return undefined;
  const remaining = descriptorValue(descriptors, "remaining");
  const reset = descriptorValue(descriptors, "reset");
  const retryAt = descriptorValue(descriptors, "retryAt");
  if (
    !(remaining === null || (Number.isSafeInteger(remaining) && remaining >= 0)) ||
    !(reset === null || (Number.isSafeInteger(reset) && reset >= 0)) ||
    !(retryAt === null || isCanonicalIsoTimestamp(retryAt))
  ) return undefined;
  return { remaining, reset, retryAt };
}

function normalizeCachedTerms(value) {
  const terms = plainArrayValues(value);
  if (!terms || !terms.length || terms.length > 6) return null;
  if (terms.some((term) => typeof term !== "string")) return null;
  if (
    new Set(terms).size !== terms.length ||
    terms.some((term) => term !== term.trim() || term.length < 2 || term.length > 32 || !/^[a-z0-9\u3400-\u9fff -]+$/u.test(term)) ||
    terms.join(" ").length > 128
  ) return null;
  return terms;
}

function normalizeCachedRejectionCounts(value) {
  const values = plainArrayValues(value);
  if (!values || values.length > SAFE_REJECTION_REASONS.length) return null;
  const output = [];
  let previousIndex = -1;
  for (const item of values) {
    const descriptors = plainDataDescriptors(item);
    if (
      !descriptors ||
      Reflect.ownKeys(descriptors).length !== 2 ||
      Reflect.ownKeys(descriptors).some((key) => !["reason", "count"].includes(key))
    ) return null;
    const reason = descriptorValue(descriptors, "reason");
    const count = descriptorValue(descriptors, "count");
    const reasonIndex = SAFE_REJECTION_REASONS.indexOf(reason);
    if (reasonIndex <= previousIndex || !Number.isSafeInteger(count) || count < 1) return null;
    previousIndex = reasonIndex;
    output.push({ reason, count });
  }
  return output;
}

function normalizeCachedDiagnostics(value) {
  const descriptors = plainDataDescriptors(value);
  const fields = [
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
  if (
    !descriptors ||
    Reflect.ownKeys(descriptors).length !== fields.length ||
    Reflect.ownKeys(descriptors).some((key) => !fields.includes(key))
  ) return null;
  const stageReached = descriptorValue(descriptors, "stageReached");
  const counters = fields.slice(1, 6).map((field) => descriptorValue(descriptors, field));
  if (
    stageReached !== "complete" ||
    counters.some((count) => !Number.isSafeInteger(count) || count < 0) ||
    descriptorValue(descriptors, "cached") !== false ||
    descriptorValue(descriptors, "incomplete") !== false
  ) return null;
  const rejectionCounts = normalizeCachedRejectionCounts(descriptorValue(descriptors, "rejectionCounts"));
  const rateLimitDescriptors = plainDataDescriptors(descriptorValue(descriptors, "rateLimits"));
  if (
    !rejectionCounts ||
    !rateLimitDescriptors ||
    Reflect.ownKeys(rateLimitDescriptors).length !== 2 ||
    Reflect.ownKeys(rateLimitDescriptors).some((key) => !["search", "codeSearch"].includes(key))
  ) return null;
  const rateLimits = {
    search: normalizeCachedRateLimit(descriptorValue(rateLimitDescriptors, "search")),
    codeSearch: normalizeCachedRateLimit(descriptorValue(rateLimitDescriptors, "codeSearch")),
  };
  if (rateLimits.search === undefined || rateLimits.codeSearch === undefined) return null;
  const [repositoryHits, codeHits, validatedCandidates, rejectedCandidates, deduplicatedCandidates] = counters;
  if (
    rejectionCounts.reduce((sum, item) => sum + item.count, 0) !== rejectedCandidates ||
    (rejectionCounts.find((item) => item.reason === "duplicate")?.count ?? 0) !== deduplicatedCandidates
  ) return null;
  return {
    stageReached,
    repositoryHits,
    codeHits,
    validatedCandidates,
    rejectedCandidates,
    deduplicatedCandidates,
    rejectionCounts,
    cached: false,
    incomplete: false,
    rateLimits,
  };
}

function sanitizeCacheEntry(entry, nowMilliseconds) {
  const descriptors = plainDataDescriptors(entry);
  const fields = ["expiresAt", "preview", "results", "incomplete", "rateLimit", "diagnostics"];
  if (
    !descriptors ||
    Reflect.ownKeys(descriptors).length !== fields.length ||
    Reflect.ownKeys(descriptors).some((key) => !fields.includes(key))
  ) return null;
  const preview = descriptorValue(descriptors, "preview");
  const previewDescriptors = plainDataDescriptors(preview);
  if (
    !previewDescriptors ||
    Reflect.ownKeys(previewDescriptors).length !== 2 ||
    Reflect.ownKeys(previewDescriptors).some((key) => !["terms", "label"].includes(key))
  ) return null;
  const expiresAtValue = descriptorValue(descriptors, "expiresAt");
  if (typeof expiresAtValue !== "string") return null;
  const expiresAt = Date.parse(expiresAtValue);
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= nowMilliseconds ||
    expiresAt > nowMilliseconds + CACHE_TTL_MILLISECONDS ||
    descriptorValue(descriptors, "incomplete") !== false
  ) return null;
  const terms = normalizeCachedTerms(descriptorValue(previewDescriptors, "terms"));
  const label = descriptorValue(previewDescriptors, "label");
  if (!terms || label !== terms.join(" · ")) return null;
  const rawResults = plainArrayValues(descriptorValue(descriptors, "results"));
  if (!rawResults || rawResults.length > 3) return null;
  const results = rawResults.map(validCachedResult);
  if (results.some((item) => item === null)) return null;
  const seen = new Set();
  const seenNames = new Set();
  for (let index = 0; index < results.length; index += 1) {
    const item = results[index];
    const key = `${item.repository}\0${item.skillDirectory}`;
    const nameKey = normalizeText(item.name);
    if (
      seen.has(key) ||
      seenNames.has(nameKey) ||
      (index > 0 && results[index - 1].stars < item.stars)
    ) return null;
    seen.add(key);
    seenNames.add(nameKey);
  }
  const rateLimit = normalizeCachedRateLimit(descriptorValue(descriptors, "rateLimit"));
  const diagnostics = normalizeCachedDiagnostics(descriptorValue(descriptors, "diagnostics"));
  if (
    rateLimit === undefined ||
    !diagnostics ||
    diagnostics.validatedCandidates < results.length
  ) return null;
  return {
    expiresAt: new Date(expiresAt).toISOString(),
    preview: { terms, label: terms.join(" · ") },
    results,
    incomplete: false,
    rateLimit,
    diagnostics,
  };
}

function readFreshCacheEntry(cache, preview, cacheIdentity, nowMilliseconds) {
  if (cache?.version !== CACHE_VERSION || !isPlainObject(cache.entries)) return null;
  const entry = sanitizeCacheEntry(cache.entries[cacheIdentity], nowMilliseconds);
  if (!entry || entry.preview.terms.join("\0") !== preview.terms.join("\0")) return null;
  return {
    preview: { terms: preview.terms, label: preview.label },
    results: entry.results,
    cached: true,
    incomplete: entry.incomplete,
    rateLimit: entry.rateLimit,
    diagnostics: { ...entry.diagnostics, cached: true },
  };
}

async function readPrivateCache(cachePath) {
  try {
    const metadata = await lstat(cachePath);
    if (metadata.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
      return { version: CACHE_VERSION, entries: {} };
    }
  } catch {
    return { version: CACHE_VERSION, entries: {} };
  }
  return readJsonFile(cachePath, { version: CACHE_VERSION, entries: {} });
}

function sanitizedCacheForWrite(cache, nowMilliseconds) {
  const entries = {};
  if (cache?.version !== CACHE_VERSION || !isPlainObject(cache.entries)) {
    return { version: CACHE_VERSION, entries };
  }
  for (const [cacheKey, entry] of Object.entries(cache.entries)) {
    if (!/^[a-f0-9]{64}$/u.test(cacheKey)) continue;
    const sanitized = sanitizeCacheEntry(entry, nowMilliseconds);
    if (sanitized) entries[cacheKey] = sanitized;
  }
  return { version: CACHE_VERSION, entries };
}

async function writeCacheEntry({
  cachePath,
  cacheIdentity,
  preview,
  results,
  incomplete,
  rateLimit,
  diagnostics,
  nowMilliseconds,
}) {
  if (incomplete || diagnostics.incomplete || diagnostics.stageReached !== "complete") return;
  await withCacheWriteLock(cachePath, async () => {
    const currentCache = await readPrivateCache(cachePath);
    const normalizedCache = sanitizedCacheForWrite(currentCache, nowMilliseconds);
    normalizedCache.entries[cacheIdentity] = {
      expiresAt: new Date(nowMilliseconds + CACHE_TTL_MILLISECONDS).toISOString(),
      preview: { terms: preview.terms, label: preview.label },
      results,
      incomplete,
      rateLimit,
      diagnostics,
    };
    await atomicWriteJson(cachePath, normalizedCache);
  });
}

function codedError(code) {
  const error = new Error(code);
  Object.defineProperty(error, "code", {
    value: code,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return error;
}

function isFatalRequestError(error) {
  return [
    "github-query-rejected",
    "github-token-invalid",
    "github-rate-limited",
    "github-access-denied",
    "github-request-timeout",
  ].includes(error?.code);
}

async function discoverGitHubSkillSuggestions({
  repositoryQueries,
  codeQuery,
  matchText,
  preview,
  fetchImpl = globalThis.fetch,
  token = "",
  requestTimeoutMilliseconds,
} = {}) {
  const attempt = { fatalError: null };
  const rawClient = createGitHubClient({
    fetchImpl,
    token,
    requestTimeoutMilliseconds,
    requestScheduler: (task) => withNetworkPermit(async () => {
      try {
        return await task();
      } catch (error) {
        if (isFatalRequestError(error)) attempt.fatalError ??= error;
        throw error;
      }
    }, {
      shouldStop: () => Boolean(attempt.fatalError),
      stopError: () => attempt.fatalError ?? codedError("github-request-cancelled"),
    }),
  });
  const diagnostics = createDiagnostics();
  const searches = [];
  let incomplete = false;
  let rateLimit = null;
  let firstError = null;
  const noteRateLimit = (next) => {
    rateLimit = mergeRateLimit(rateLimit, next);
  };
  const client = {
    ...rawClient,
    async getTextContent(options) {
      try {
        const response = await rawClient.getTextContent(options);
        noteRateLimit(response.rateLimit);
        return response;
      } catch (error) {
        noteRateLimit(error?.rateLimit);
        throw error;
      }
    },
  };

  for (const repositoryQuery of repositoryQueries) {
    try {
      const search = await client.searchRepositories({ ...repositoryQuery, perPage: MAX_REPOSITORIES });
      const items = plainArrayValues(search.items);
      if (!items) {
        recordRejection(diagnostics, "invalid-structure");
        incomplete = true;
        searches.push({ ...search, items: [] });
      } else {
        diagnostics.repositoryHits += items.length;
        searches.push({ ...search, items });
      }
      incomplete ||= search.incomplete;
      noteRateLimit(search.rateLimit);
      noteDiagnosticRateLimit(diagnostics, "search", search.rateLimit);
    } catch (error) {
      if (isFatalRequestError(error)) throw error;
      firstError ??= error;
      incomplete = true;
      recordRejection(diagnostics, "unavailable");
      noteRateLimit(error?.rateLimit);
      noteDiagnosticRateLimit(diagnostics, "search", error?.rateLimit);
    }
  }
  if (!searches.length && firstError) throw firstError;

  const repositorySelection = alternateRepositories(searches, diagnostics);
  const repositories = repositorySelection.repositories;
  incomplete ||= repositorySelection.incomplete;
  const validation = {
    fatalError: null,
    treeSuccesses: 0,
    firstTreeError: null,
    contentPaths: 0,
    contentSuccesses: 0,
    firstContentError: null,
  };
  const seenReferences = new Set();
  if (repositories.length) diagnostics.stageReached = "candidate-validation";
  const repositoryCandidates = await mapWithConcurrency(repositories, MAX_NETWORK_CONCURRENCY, async (repository) => {
    if (validation.fatalError) return [];
    let treeResponse;
    try {
      treeResponse = await client.getTree(repository);
      validation.treeSuccesses += 1;
      noteRateLimit(treeResponse.rateLimit);
      incomplete ||= treeResponse.truncated;
    } catch (error) {
      if (isFatalRequestError(error)) validation.fatalError ??= error;
      else validation.firstTreeError ??= error;
      incomplete = true;
      recordRejection(diagnostics, "unavailable");
      noteRateLimit(error?.rateLimit);
      return [];
    }

    const candidates = [];
    const invalidTreeStructureBefore = diagnostics.rejectionCounts.get("invalid-structure") ?? 0;
    const invalidTreeContentBefore = diagnostics.rejectionCounts.get("invalid-content") ?? 0;
    const skillPaths = skillPathsFromTree(treeResponse.tree, diagnostics);
    incomplete ||= (
      (diagnostics.rejectionCounts.get("invalid-structure") ?? 0) > invalidTreeStructureBefore ||
      (diagnostics.rejectionCounts.get("invalid-content") ?? 0) > invalidTreeContentBefore
    );
    validation.contentPaths += skillPaths.length;
    for (const skillPath of skillPaths) {
      if (validation.fatalError) break;
      const referenceKey = canonicalReferenceKey(
        repository.repository,
        skillPath,
        repository.defaultBranch,
      );
      if (seenReferences.has(referenceKey)) {
        recordRejection(diagnostics, "duplicate");
        continue;
      }
      seenReferences.add(referenceKey);
      try {
        const invalidCandidatesBefore = diagnostics.rejectionCounts.get("invalid-content") ?? 0;
        const candidate = await validateCandidateReference({
          client,
          repository: repository.repository,
          defaultBranch: repository.defaultBranch,
          skillPath,
          metadata: repository,
          matchText,
          diagnostics,
        });
        validation.contentSuccesses += 1;
        incomplete ||= (diagnostics.rejectionCounts.get("invalid-content") ?? 0) > invalidCandidatesBefore;
        if (candidate) candidates.push(candidate);
      } catch (error) {
        if (isFatalRequestError(error)) {
          validation.fatalError ??= error;
          incomplete = true;
        } else {
          validation.firstContentError ??= error;
          incomplete = true;
          recordRejection(diagnostics, "unavailable");
        }
        noteRateLimit(error?.rateLimit);
      }
    }
    return candidates;
  }, () => Boolean(validation.fatalError));

  if (validation.fatalError) throw validation.fatalError;
  if (codeQuery === null && repositories.length && validation.treeSuccesses === 0) {
    throw validation.firstTreeError ?? codedError("github-request-failed");
  }
  if (codeQuery === null && validation.contentPaths > 0 && validation.contentSuccesses === 0) {
    throw validation.firstContentError ?? codedError("github-request-failed");
  }

  const matched = repositoryCandidates.flat();
  if (
    codeQuery &&
    distinctCandidateCount(matched, preview !== null) < 3
  ) {
    diagnostics.stageReached = "code-search";
    let codeSearch;
    try {
      codeSearch = await client.searchCode({ q: codeQuery, perPage: 12 });
      noteRateLimit(codeSearch.rateLimit);
      noteDiagnosticRateLimit(diagnostics, "codeSearch", codeSearch.rateLimit);
    } catch (error) {
      if (isFatalRequestError(error)) throw error;
      incomplete = true;
      recordRejection(diagnostics, "unavailable");
      noteRateLimit(error?.rateLimit);
      noteDiagnosticRateLimit(diagnostics, "codeSearch", error?.rateLimit);
    }

    if (codeSearch) {
      const rawCodeItems = plainArrayValues(codeSearch.items);
      if (!rawCodeItems) {
        incomplete = true;
        recordRejection(diagnostics, "invalid-structure");
      } else {
        diagnostics.codeHits = rawCodeItems.length;
        incomplete ||= codeSearch.incomplete;
        const selectedCodeItems = [];
        const seenCodeItems = new Set();
        for (const item of rawCodeItems) {
          const descriptors = plainDataDescriptors(item);
          const name = descriptorValue(descriptors, "name");
          const path = descriptorValue(descriptors, "path");
          const repository = descriptorValue(descriptors, "repository");
          if (
            !descriptors ||
            name !== "SKILL.md" ||
            typeof path !== "string" ||
            !isSafeRelativePath(path) ||
            path.split("/").at(-1) !== "SKILL.md" ||
            typeof repository !== "string" ||
            !REPOSITORY_PATTERN.test(repository)
          ) {
            recordRejection(diagnostics, "invalid-structure");
            continue;
          }
          const initialKey = `${repository.toLowerCase()}\0${path}`;
          if (seenCodeItems.has(initialKey)) {
            recordRejection(diagnostics, "duplicate");
            continue;
          }
          seenCodeItems.add(initialKey);
          if (selectedCodeItems.length < 12) selectedCodeItems.push({ repository, path });
        }

        if (selectedCodeItems.length) diagnostics.stageReached = "candidate-validation";
        const codeValidation = { fatalError: null };
        const codeCandidates = await mapWithConcurrency(
          selectedCodeItems,
          MAX_NETWORK_CONCURRENCY,
          async (item) => {
            if (codeValidation.fatalError) return null;
            let metadata;
            try {
              metadata = await client.getRepositoryMetadata({ repository: item.repository });
              noteRateLimit(metadata.rateLimit);
            } catch (error) {
              if (isFatalRequestError(error)) codeValidation.fatalError ??= error;
              else {
                incomplete = true;
                recordRejection(diagnostics, "unavailable");
              }
              noteRateLimit(error?.rateLimit);
              return null;
            }
            if (codeValidation.fatalError) return null;
            const referenceKey = canonicalReferenceKey(
              metadata.repository,
              item.path,
              metadata.defaultBranch,
            );
            if (seenReferences.has(referenceKey)) {
              recordRejection(diagnostics, "duplicate");
              return null;
            }
            seenReferences.add(referenceKey);
            try {
              return await validateCandidateReference({
                client,
                repository: metadata.repository,
                defaultBranch: metadata.defaultBranch,
                skillPath: item.path,
                metadata,
                matchText,
                diagnostics,
              });
            } catch (error) {
              if (isFatalRequestError(error)) codeValidation.fatalError ??= error;
              else {
                incomplete = true;
                recordRejection(diagnostics, "unavailable");
              }
              noteRateLimit(error?.rateLimit);
              return null;
            }
          },
          () => Boolean(codeValidation.fatalError),
        );
        if (codeValidation.fatalError) throw codeValidation.fatalError;
        matched.push(...codeCandidates.filter(Boolean));
      }
    }
  }

  matched.sort((a, b) => (
    b.stars - a.stars ||
    b.matchScore - a.matchScore ||
    a.repository.localeCompare(b.repository) ||
    a.path.localeCompare(b.path)
  ));
  const seenNames = new Set();
  const results = matched
    .filter((candidate) => {
      if (preview === null) return true;
      const key = normalizeText(candidate.name);
      if (seenNames.has(key)) {
        recordRejection(diagnostics, "duplicate");
        return false;
      }
      seenNames.add(key);
      return true;
    })
    .slice(0, 3)
    .map((candidate) => publicResult(candidate, candidate.match));
  diagnostics.incomplete = incomplete;
  if (!incomplete) diagnostics.stageReached = "complete";
  return {
    preview: preview === null ? null : { terms: preview.terms, label: preview.label },
    results,
    cached: false,
    incomplete,
    rateLimit: publicRateLimit(rateLimit),
    diagnostics: finalizeDiagnostics(diagnostics),
  };
}

async function findUncachedGitHubSkillSuggestions(options) {
  const nowMilliseconds = resolveNow(options.now);
  await ensurePrivateDirectory(dirname(options.cachePath));
  const cache = await readPrivateCache(options.cachePath);
  const cached = readFreshCacheEntry(
    cache,
    options.preview,
    options.cacheIdentity,
    nowMilliseconds,
  );
  if (cached) return cached;

  const response = await discoverGitHubSkillSuggestions({
    repositoryQueries: options.repositoryQueries,
    codeQuery: options.codeQuery,
    matchText: options.semanticTerms.join(" "),
    preview: options.preview,
    fetchImpl: options.fetchImpl,
    token: options.token,
    requestTimeoutMilliseconds: options.requestTimeoutMilliseconds,
  });
  const completionNowMilliseconds = Math.max(nowMilliseconds, resolveNow(options.now));

  await writeCacheEntry({
    cachePath: options.cachePath,
    cacheIdentity: options.cacheIdentity,
    preview: options.preview,
    results: response.results,
    incomplete: response.incomplete,
    rateLimit: response.rateLimit,
    diagnostics: response.diagnostics,
    nowMilliseconds: completionNowMilliseconds,
  });
  return response;
}

export async function findGitHubSkillSuggestions({
  query,
  cachePath,
  fetchImpl = globalThis.fetch,
  token = "",
  now = Date.now,
  requestTimeoutMilliseconds,
} = {}) {
  const plan = buildGitHubSearchPlan(query);
  if (!plan) {
    const diagnostics = createDiagnostics();
    diagnostics.stageReached = "complete";
    return {
      preview: null,
      results: [],
      cached: false,
      incomplete: false,
      rateLimit: null,
      diagnostics: finalizeDiagnostics(diagnostics),
    };
  }
  if (!isAbsolute(String(cachePath ?? ""))) throw new Error("absolute-github-cache-required");
  const searchPlanDigest = createHash("sha256")
    .update(JSON.stringify({
      version: CACHE_VERSION,
      repositoryQueries: plan.repositoryQueries,
      codeQuery: plan.codeQuery,
    }))
    .digest("hex");
  const inFlightKey = `${cachePath}\0${searchPlanDigest}`;
  const current = inFlightSuggestions.get(inFlightKey);
  if (current) return current;

  const pending = findUncachedGitHubSkillSuggestions({
    preview: plan.preview,
    semanticTerms: plan.semanticTerms,
    repositoryQueries: plan.repositoryQueries,
    codeQuery: plan.codeQuery,
    cacheIdentity: searchPlanDigest,
    cachePath,
    fetchImpl,
    token,
    now,
    requestTimeoutMilliseconds,
  });
  inFlightSuggestions.set(inFlightKey, pending);
  try {
    return await pending;
  } finally {
    if (inFlightSuggestions.get(inFlightKey) === pending) inFlightSuggestions.delete(inFlightKey);
  }
}

function ownDescriptorValue(descriptors, key) {
  return Object.hasOwn(descriptors, key) ? descriptors[key].value : undefined;
}

function normalizeOriginalSearchOptions(options) {
  if (types.isProxy(options)) throw codedError("invalid-original-search-options");
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw codedError("invalid-original-search-options");
  }
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null) {
    throw codedError("invalid-original-search-options");
  }
  const descriptors = Object.getOwnPropertyDescriptors(options);
  if (Object.hasOwn(descriptors, "cachePath")) {
    throw codedError("original-search-cache-not-allowed");
  }
  if (Reflect.ownKeys(descriptors).some((key) => !Object.hasOwn(descriptors[key], "value"))) {
    throw codedError("invalid-original-search-options");
  }
  return {
    query: ownDescriptorValue(descriptors, "query"),
    fetchImpl: ownDescriptorValue(descriptors, "fetchImpl"),
    token: ownDescriptorValue(descriptors, "token"),
    requestTimeoutMilliseconds: ownDescriptorValue(descriptors, "requestTimeoutMilliseconds"),
  };
}

export async function findGitHubSkillSuggestionsFromOriginalQuery(options = {}) {
  const {
    query,
    fetchImpl = globalThis.fetch,
    token = "",
    requestTimeoutMilliseconds,
  } = normalizeOriginalSearchOptions(options);
  const canonical = typeof query === "string" ? query.trim() : "";
  const repositoryQueries = buildOriginalGitHubRepositoryQueries(canonical);
  return discoverGitHubSkillSuggestions({
    repositoryQueries,
    codeQuery: null,
    matchText: canonical,
    preview: null,
    fetchImpl,
    token,
    requestTimeoutMilliseconds,
  });
}
