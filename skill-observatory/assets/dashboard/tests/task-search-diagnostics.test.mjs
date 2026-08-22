import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTaskSearchTestRecord,
  copyTaskSearchTestRecord,
  getSentSanitizedTerms,
} from "../app/lib/task-search-diagnostics.ts";

const privateSentinels = {
  query: "PRIVATE_QUERY_SENTINEL",
  token: "PRIVATE_TOKEN_SENTINEL",
  digest: "PRIVATE_DIGEST_SENTINEL",
  path: "PRIVATE_PATH_SENTINEL",
  repo: "PRIVATE_REPO_SENTINEL",
  name: "PRIVATE_NAME_SENTINEL",
  content: "PRIVATE_CONTENT_SENTINEL",
  body: "PRIVATE_BODY_SENTINEL",
  stack: "PRIVATE_STACK_SENTINEL",
};

function state(overrides = {}) {
  return {
    query: privateSentinels.query,
    submittedQuery: `${privateSentinels.query}_SUBMITTED`,
    localMatchLevel: "weak",
    results: [
      {
        skillId: privateSentinels.path,
        name: privateSentinels.name,
        summaryZh: privateSentinels.content,
        status: "ready",
        score: 24,
        reasonCodes: ["keywords", "exact-name", "keywords", privateSentinels.body],
        reasonZh: privateSentinels.body,
      },
      { reasonCodes: ["alias", "description"] },
    ],
    githubSearch: {
      terms: ["testing", "data validation", "testing"],
      label: privateSentinels.query,
    },
    githubResults: [{
      repository: privateSentinels.repo,
      repositoryUrl: `https://github.com/${privateSentinels.repo}`,
      skillDirectory: privateSentinels.path,
      name: privateSentinels.name,
      summary: privateSentinels.content,
      reasonZh: privateSentinels.body,
      stars: 1,
      pushedAt: "2026-08-19T00:00:00.000Z",
      license: null,
    }],
    githubIncomplete: true,
    githubStatus: {
      state: "rate-limited",
      checkedAt: "2026-08-19T01:02:03.000Z",
      rateLimits: { search: null, codeSearch: null },
      token: privateSentinels.token,
    },
    githubDiagnostics: {
      stageReached: "candidate-validation",
      repositoryHits: 8,
      codeHits: 5,
      validatedCandidates: 3,
      rejectedCandidates: 4,
      deduplicatedCandidates: 2,
      rejectionCounts: [
        { reason: "unavailable", count: 1, body: privateSentinels.body },
        { reason: "invalid-content", count: 2 },
        { reason: "duplicate", count: 1 },
      ],
      cached: true,
      incomplete: true,
      rateLimits: {
        search: { remaining: 0, reset: 1_777_777_777, retryAt: "2026-08-19T02:03:04.000Z" },
        codeSearch: { remaining: 7, reset: 1_777_777_888, retryAt: null },
      },
      responseBody: privateSentinels.body,
    },
    githubStage: "candidate-validation",
    rawConsent: { token: privateSentinels.token, expiresAt: "2026-08-19T02:00:00.000Z" },
    phase: "sanitized-error",
    originalOutcome: "none",
    error: {
      stage: "sanitized",
      code: "github-rate-limited",
      retryAt: "2026-08-19T02:03:04.000Z",
      body: privateSentinels.body,
      stack: privateSentinels.stack,
    },
    taskDigest: privateSentinels.digest,
    responseBody: privateSentinels.body,
    ...overrides,
  };
}

test("builds one deterministic allowlisted diagnostic record", () => {
  const actual = buildTaskSearchTestRecord(state());
  assert.equal(actual, JSON.stringify({
    localMatchLevel: "weak",
    localEvidence: ["alias", "description", "exact-name", "keywords"],
    sanitizedTerms: ["data validation", "testing"],
    stageReached: "candidate-validation",
    repositoryHits: 8,
    codeHits: 5,
    validatedCandidates: 3,
    rejectedCandidates: 4,
    deduplicatedCandidates: 2,
    rejectionCounts: [
      { reason: "invalid-structure", count: 0 },
      { reason: "invalid-content", count: 2 },
      { reason: "irrelevant", count: 0 },
      { reason: "duplicate", count: 1 },
      { reason: "unavailable", count: 1 },
    ],
    cached: true,
    incomplete: true,
    rateLimits: {
      search: { remaining: 0, reset: 1_777_777_777, retryAt: "2026-08-19T02:03:04.000Z" },
      codeSearch: { remaining: 7, reset: 1_777_777_888, retryAt: null },
    },
    errorCode: "github-rate-limited",
  }, null, 2));

  for (const sentinel of Object.values(privateSentinels)) {
    assert.doesNotMatch(actual, new RegExp(sentinel.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  }
  const parsed = JSON.parse(actual);
  assert.equal(Object.hasOwn(parsed, "query"), false);
  assert.equal(Object.hasOwn(parsed, "submittedQuery"), false);
});

test("uses fixed empty counters, fixed rejection rows, and status rate limits without diagnostics", () => {
  const actual = JSON.parse(buildTaskSearchTestRecord(state({
    localMatchLevel: null,
    results: null,
    githubSearch: null,
    githubDiagnostics: null,
    githubStage: "repository-search",
    githubIncomplete: false,
    githubStatus: {
      state: "ready",
      checkedAt: "2026-08-19T01:02:03.000Z",
      rateLimits: {
        search: { remaining: 30, reset: 1_777_777_000, retryAt: null },
        codeSearch: null,
      },
    },
    error: { code: "PRIVATE_ERROR_SENTINEL", stack: privateSentinels.stack },
  })));

  assert.deepEqual(actual, {
    localMatchLevel: null,
    localEvidence: [],
    sanitizedTerms: [],
    stageReached: "repository-search",
    repositoryHits: 0,
    codeHits: 0,
    validatedCandidates: 0,
    rejectedCandidates: 0,
    deduplicatedCandidates: 0,
    rejectionCounts: [
      { reason: "invalid-structure", count: 0 },
      { reason: "invalid-content", count: 0 },
      { reason: "irrelevant", count: 0 },
      { reason: "duplicate", count: 0 },
      { reason: "unavailable", count: 0 },
    ],
    cached: false,
    incomplete: false,
    rateLimits: {
      search: { remaining: 30, reset: 1_777_777_000, retryAt: null },
      codeSearch: null,
    },
    errorCode: null,
  });
});

test("a non-ready status never claims preview terms were sent or a search stage was reached", () => {
  const nonReadyState = state({
    githubDiagnostics: null,
    githubStage: "repository-search",
    githubIncomplete: false,
    githubStatus: {
      state: "missing-token",
      checkedAt: "2026-08-19T01:02:03.000Z",
      rateLimits: { search: null, codeSearch: null },
    },
    phase: "sanitized-error",
    error: { stage: "sanitized", code: "github-token-missing", retryAt: null },
  });
  const actual = JSON.parse(buildTaskSearchTestRecord(nonReadyState));
  assert.deepEqual(getSentSanitizedTerms(nonReadyState), []);
  assert.deepEqual(actual.sanitizedTerms, []);
  assert.equal(actual.stageReached, null);
  assert.equal(actual.errorCode, "github-token-missing");
});

test("the diagnostic view exposes only allowlisted terms from an actual search", () => {
  assert.deepEqual(getSentSanitizedTerms(state({
    githubDiagnostics: null,
    githubStatus: {
      state: "ready",
      checkedAt: "2026-08-19T01:02:03.000Z",
      rateLimits: { search: null, codeSearch: null },
    },
    githubStage: "repository-search",
    phase: "sanitized-searching",
  })), ["data validation", "testing"]);
});

test("does not inspect or serialize unrelated accessor fields", () => {
  const input = state();
  Object.defineProperty(input, "privateBody", {
    enumerable: true,
    get() {
      throw new Error(privateSentinels.body);
    },
  });
  Object.defineProperty(input.error, "privateStack", {
    enumerable: true,
    get() {
      throw new Error(privateSentinels.stack);
    },
  });
  assert.doesNotThrow(() => buildTaskSearchTestRecord(input));
});

test("clipboard absence fails before a record is generated", async () => {
  const inaccessibleState = new Proxy({}, {
    get() {
      throw new Error(privateSentinels.query);
    },
  });
  assert.equal(await copyTaskSearchTestRecord(inaccessibleState, undefined), "failed");
});

test("clipboard rejection returns fixed failure without exposing its error", async () => {
  let copiedRecord = null;
  const outcome = await copyTaskSearchTestRecord(state(), {
    async writeText(value) {
      copiedRecord = value;
      throw new Error(privateSentinels.stack);
    },
  });
  assert.equal(outcome, "failed");
  assert.equal(typeof copiedRecord, "string");
  assert.doesNotMatch(copiedRecord, /PRIVATE_(?:QUERY|TOKEN|PATH|BODY|STACK)_SENTINEL/);
});

test("clipboard success writes exactly one freshly serialized safe record", async () => {
  const writes = [];
  const outcome = await copyTaskSearchTestRecord(state(), {
    async writeText(value) {
      writes.push(value);
    },
  });
  assert.equal(outcome, "copied");
  assert.deepEqual(writes, [buildTaskSearchTestRecord(state())]);
});
