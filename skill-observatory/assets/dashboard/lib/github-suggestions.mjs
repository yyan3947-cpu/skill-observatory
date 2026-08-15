import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, posix } from "node:path";

import yaml from "js-yaml";

import { atomicWriteJson, readJsonFile } from "./cache.mjs";
import { createGitHubClient } from "./github-client.mjs";
import { buildGitHubRepositoryQueries, buildGitHubSearchPreview } from "./github-query.mjs";
import { normalizeText, recommendSkills } from "./recommend.mjs";
import { ensurePrivateDirectory } from "./runtime-paths.mjs";

const CACHE_VERSION = 1;
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

async function withNetworkPermit(task) {
  if (activeNetworkRequests >= MAX_NETWORK_CONCURRENCY) {
    await new Promise((resolve) => pendingNetworkRequests.push(resolve));
  } else {
    activeNetworkRequests += 1;
  }
  try {
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

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || codePoint === 127;
  });
}

function normalizeRepository(item) {
  const repository = String(item?.full_name ?? "");
  const repositorySegments = repository.split("/");
  if (
    !item ||
    typeof item !== "object" ||
    !REPOSITORY_PATTERN.test(repository) ||
    repositorySegments.some((segment) => segment === "." || segment === "..")
  ) return null;
  if (item.archived || item.disabled || item.fork) return null;
  const defaultBranch = String(item.default_branch ?? "");
  if (!defaultBranch || defaultBranch.length > 255 || hasControlCharacters(defaultBranch)) return null;
  return {
    repository,
    defaultBranch,
    stars: Math.max(0, Number.isFinite(Number(item.stargazers_count)) ? Number(item.stargazers_count) : 0),
    pushedAt: typeof item.pushed_at === "string" && item.pushed_at.length <= 64 ? item.pushed_at : "",
    license: typeof item.license?.spdx_id === "string" && item.license.spdx_id.length <= 64
      ? item.license.spdx_id
      : null,
  };
}

function alternateRepositories(searches) {
  const queues = searches.map((search) => (search?.items ?? []).map(normalizeRepository).filter(Boolean));
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
        if (seen.has(item.repository)) continue;
        seen.add(item.repository);
        selected.push(item);
        break;
      }
    }
  }
  return selected;
}

function skillPathsFromTree(tree) {
  const seen = new Set();
  return (tree ?? [])
    .filter((item) => (
      item?.type === "blob" &&
      typeof item.path === "string" &&
      isSafeRelativePath(item.path) &&
      item.path.split("/").at(-1) === "SKILL.md" &&
      (!Number.isFinite(Number(item.size)) || Number(item.size) <= MAX_SKILL_BYTES)
    ))
    .map((item) => item.path)
    .filter((path) => {
      if (seen.has(path)) return false;
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

function candidateKeywords(name, description) {
  const normalized = normalizeText(`${name} ${description}`);
  const latin = normalized.match(/[a-z0-9][a-z0-9-]{1,}/gu) ?? [];
  const chineseRuns = normalized.match(/[\u3400-\u9fff]{2,}/gu) ?? [];
  const chinese = chineseRuns.flatMap((run) => {
    const values = [run];
    for (let index = 0; index < run.length - 1; index += 1) values.push(run.slice(index, index + 2));
    return values;
  });
  return [...new Set([...latin, ...chinese])].slice(0, 100);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
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
      status: "unchecked",
      category: "其他",
      aliases: [parsed.name.replace(/-/gu, " ")],
      intentTags: [],
      keywords: candidateKeywords(parsed.name, parsed.description),
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

function validCachedResult(item) {
  const repository = item?.repository;
  const name = item?.name;
  if (
    !isPlainObject(item) ||
    typeof repository !== "string" ||
    typeof name !== "string" ||
    !REPOSITORY_PATTERN.test(repository) ||
    repository.split("/").some((segment) => segment === "." || segment === "..") ||
    !SKILL_NAME_PATTERN.test(name)
  ) return null;
  const directory = item.skillDirectory;
  if (
    typeof directory !== "string" ||
    !directory ||
    directory.endsWith("SKILL.md") ||
    (directory !== "." && (!isSafeRelativePath(directory) || directory.split("/").at(-1) !== name))
  ) return null;
  const summary = item.summary;
  const reasonZh = item.reasonZh;
  const stars = item.stars;
  if (
    typeof summary !== "string" || !summary || summary.length > 220 ||
    typeof reasonZh !== "string" || !reasonZh || reasonZh.length > 160 ||
    !Number.isSafeInteger(stars) || stars < 0 ||
    typeof item.pushedAt !== "string" || item.pushedAt.length > 64 ||
    !(item.license === null || (typeof item.license === "string" && item.license.length <= 64))
  ) return null;
  return {
    repository,
    repositoryUrl: `https://github.com/${repository}`,
    skillDirectory: directory,
    name,
    summary,
    reasonZh,
    stars,
    pushedAt: item.pushedAt,
    license: item.license,
  };
}

function normalizeCachedRateLimit(value) {
  if (value === null) return null;
  if (!isPlainObject(value)) return undefined;
  const remaining = value.remaining;
  const reset = value.reset;
  if (
    !(remaining === null || (Number.isSafeInteger(remaining) && remaining >= 0)) ||
    !(reset === null || (Number.isSafeInteger(reset) && reset >= 0))
  ) return undefined;
  const resetDate = reset === null ? null : new Date(reset * 1000);
  if (resetDate && !Number.isFinite(resetDate.getTime())) return undefined;
  return {
    remaining,
    reset,
    retryAt: resetDate ? resetDate.toISOString() : null,
  };
}

function normalizeCachedTerms(value) {
  if (!Array.isArray(value) || !value.length || value.length > 6) return null;
  if (value.some((term) => typeof term !== "string")) return null;
  const terms = value;
  if (
    new Set(terms).size !== terms.length ||
    terms.some((term) => term !== term.trim() || term.length < 2 || term.length > 32 || !/^[a-z0-9\u3400-\u9fff -]+$/u.test(term)) ||
    terms.join(" ").length > 128
  ) return null;
  return terms;
}

function cacheKeyForTerms(terms) {
  return createHash("sha256").update(terms.join("\0")).digest("hex");
}

function sanitizeCacheEntry(entry, cacheKey, nowMilliseconds) {
  if (!isPlainObject(entry) || !isPlainObject(entry.preview) || typeof entry.expiresAt !== "string") return null;
  const expiresAt = Date.parse(entry.expiresAt);
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= nowMilliseconds ||
    expiresAt > nowMilliseconds + CACHE_TTL_MILLISECONDS ||
    typeof entry.incomplete !== "boolean"
  ) return null;
  const terms = normalizeCachedTerms(entry.preview.terms);
  if (!terms || cacheKeyForTerms(terms) !== cacheKey) return null;
  if (!Array.isArray(entry.results) || entry.results.length > 3) return null;
  const results = entry.results.map(validCachedResult);
  if (results.some((item) => item === null)) return null;
  const seen = new Set();
  for (let index = 0; index < results.length; index += 1) {
    const item = results[index];
    const key = `${item.repository}\0${item.skillDirectory}`;
    if (seen.has(key) || (index > 0 && results[index - 1].stars < item.stars)) return null;
    seen.add(key);
  }
  const rateLimit = normalizeCachedRateLimit(entry.rateLimit);
  if (rateLimit === undefined) return null;
  return {
    expiresAt: new Date(expiresAt).toISOString(),
    preview: { terms, label: terms.join(" · ") },
    results,
    incomplete: entry.incomplete,
    rateLimit,
  };
}

function readFreshCacheEntry(cache, preview, nowMilliseconds) {
  if (cache?.version !== CACHE_VERSION || !isPlainObject(cache.entries)) return null;
  const entry = sanitizeCacheEntry(cache.entries[preview.cacheKey], preview.cacheKey, nowMilliseconds);
  if (!entry || entry.preview.terms.join("\0") !== preview.terms.join("\0")) return null;
  return {
    preview,
    results: entry.results,
    cached: true,
    incomplete: entry.incomplete,
    rateLimit: entry.rateLimit,
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
    const sanitized = sanitizeCacheEntry(entry, cacheKey, nowMilliseconds);
    if (sanitized) entries[cacheKey] = sanitized;
  }
  return { version: CACHE_VERSION, entries };
}

async function writeCacheEntry({ cachePath, preview, results, incomplete, rateLimit, nowMilliseconds }) {
  await withCacheWriteLock(cachePath, async () => {
    const currentCache = await readPrivateCache(cachePath);
    const normalizedCache = sanitizedCacheForWrite(currentCache, nowMilliseconds);
    normalizedCache.entries[preview.cacheKey] = {
      expiresAt: new Date(nowMilliseconds + CACHE_TTL_MILLISECONDS).toISOString(),
      preview: { terms: preview.terms, label: preview.label },
      results,
      incomplete,
      rateLimit,
    };
    await atomicWriteJson(cachePath, normalizedCache);
  });
}

function isFatalRequestError(error) {
  return ["github-rate-limited", "github-request-timeout"].includes(error?.code);
}

async function findUncachedGitHubSkillSuggestions({
  preview,
  cachePath,
  fetchImpl = globalThis.fetch,
  token = "",
  now = Date.now(),
  requestTimeoutMilliseconds,
} = {}) {
  const nowMilliseconds = resolveNow(now);
  await ensurePrivateDirectory(dirname(cachePath));
  const cache = await readPrivateCache(cachePath);
  const cached = readFreshCacheEntry(cache, preview, nowMilliseconds);
  if (cached) return cached;

  const client = createGitHubClient({
    fetchImpl,
    token,
    requestTimeoutMilliseconds,
    requestScheduler: withNetworkPermit,
  });
  const repositoryQueries = buildGitHubRepositoryQueries(preview.terms);
  const searches = [];
  let incomplete = false;
  let rateLimit = null;
  let firstError = null;
  for (const repositoryQuery of repositoryQueries) {
    try {
      const search = await client.searchRepositories({ ...repositoryQuery, perPage: MAX_REPOSITORIES });
      searches.push(search);
      incomplete ||= search.incomplete;
      rateLimit = mergeRateLimit(rateLimit, search.rateLimit);
    } catch (error) {
      if (isFatalRequestError(error)) throw error;
      firstError ??= error;
      incomplete = true;
      rateLimit = mergeRateLimit(rateLimit, error.rateLimit);
    }
  }
  if (!searches.length && firstError) throw firstError;

  const repositories = alternateRepositories(searches);
  const validation = {
    fatalError: null,
    treeSuccesses: 0,
    firstTreeError: null,
    contentPaths: 0,
    contentSuccesses: 0,
    firstContentError: null,
  };
  const repositoryCandidates = await mapWithConcurrency(repositories, MAX_NETWORK_CONCURRENCY, async (repository) => {
    if (validation.fatalError) return [];
    let treeResponse;
    try {
      treeResponse = await client.getTree(repository);
      validation.treeSuccesses += 1;
      rateLimit = mergeRateLimit(rateLimit, treeResponse.rateLimit);
      incomplete ||= treeResponse.truncated;
    } catch (error) {
      if (isFatalRequestError(error)) validation.fatalError ??= error;
      else validation.firstTreeError ??= error;
      incomplete = true;
      rateLimit = mergeRateLimit(rateLimit, error.rateLimit);
      return [];
    }

    const candidates = [];
    const skillPaths = skillPathsFromTree(treeResponse.tree);
    validation.contentPaths += skillPaths.length;
    for (const skillPath of skillPaths) {
      if (validation.fatalError) break;
      try {
        const content = await client.getTextContent({
          ...repository,
          skillPath,
          maxBytes: MAX_SKILL_BYTES,
        });
        validation.contentSuccesses += 1;
        rateLimit = mergeRateLimit(rateLimit, content.rateLimit);
        const parsed = parseCandidate({ repository: repository.repository, path: skillPath, text: content.text });
        if (parsed) candidates.push({ ...repository, ...parsed });
      } catch (error) {
        if (["github-content-too-large", "github-content-invalid"].includes(error.code)) {
          validation.contentSuccesses += 1;
        } else if (isFatalRequestError(error)) {
          validation.fatalError ??= error;
          incomplete = true;
        } else {
          validation.firstContentError ??= error;
          incomplete = true;
        }
        rateLimit = mergeRateLimit(rateLimit, error.rateLimit);
      }
    }
    return candidates;
  }, () => Boolean(validation.fatalError));

  if (validation.fatalError) throw validation.fatalError;
  if (repositories.length && validation.treeSuccesses === 0) {
    throw validation.firstTreeError ?? Object.assign(new Error("github-request-failed"), {
      code: "github-request-failed",
    });
  }
  if (validation.contentPaths > 0 && validation.contentSuccesses === 0) {
    throw validation.firstContentError ?? Object.assign(new Error("github-request-failed"), {
      code: "github-request-failed",
    });
  }

  const candidates = repositoryCandidates.flat();
  const queryText = preview.terms.join(" ");
  const matched = [];
  const seenPaths = new Set();
  for (const candidate of candidates) {
    const key = `${candidate.repository}\0${candidate.path}`;
    if (seenPaths.has(key)) continue;
    seenPaths.add(key);
    const [match] = recommendSkills(queryText, { skills: [candidate.catalogRecord] }, {
      limit: 36,
      minimumScore: 12,
    });
    if (match) matched.push({ ...candidate, matchScore: match.score, match });
  }

  matched.sort((a, b) => (
    b.stars - a.stars ||
    b.matchScore - a.matchScore ||
    b.pushedAt.localeCompare(a.pushedAt) ||
    a.repository.localeCompare(b.repository) ||
    a.skillDirectory.localeCompare(b.skillDirectory)
  ));
  const results = matched.slice(0, 3).map((candidate) => publicResult(candidate, candidate.match));
  const response = { preview, results, cached: false, incomplete, rateLimit };

  await writeCacheEntry({ cachePath, preview, results, incomplete, rateLimit, nowMilliseconds });
  return response;
}

export async function findGitHubSkillSuggestions({
  query,
  cachePath,
  fetchImpl = globalThis.fetch,
  token = "",
  now = Date.now(),
  requestTimeoutMilliseconds,
} = {}) {
  const preview = buildGitHubSearchPreview(query);
  if (!preview) {
    return { preview: null, results: [], cached: false, incomplete: false, rateLimit: null };
  }
  if (!isAbsolute(String(cachePath ?? ""))) throw new Error("absolute-github-cache-required");
  const inFlightKey = `${cachePath}\0${preview.cacheKey}\0${preview.terms.join("\0")}`;
  const current = inFlightSuggestions.get(inFlightKey);
  if (current) return current;

  const pending = findUncachedGitHubSkillSuggestions({
    preview,
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
