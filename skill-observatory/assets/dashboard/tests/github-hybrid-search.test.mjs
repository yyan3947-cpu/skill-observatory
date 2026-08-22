import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  findGitHubSkillSuggestions,
  findGitHubSkillSuggestionsFromOriginalQuery,
} from "../lib/github-suggestions.mjs";

const RATE_HEADERS = {
  "x-ratelimit-remaining": "41",
  "x-ratelimit-reset": "1780000000",
};

function skillText(name, description = "Generate QR codes from text and links.") {
  return ["---", `name: ${name}`, `description: ${description}`, "---", ""].join("\n");
}

function repositoryItem(repository, stars, defaultBranch = "main") {
  return {
    full_name: repository,
    html_url: `https://github.com/${repository}`,
    default_branch: defaultBranch,
    stargazers_count: stars,
    pushed_at: "2026-08-10T10:00:00Z",
    archived: false,
    disabled: false,
    fork: false,
    license: { spdx_id: "MIT" },
  };
}

function codeItem(repository, path) {
  return {
    name: path.split("/").at(-1),
    path,
    sha: "a".repeat(40),
    repository: { full_name: repository },
  };
}

function definition(name, stars, options = {}) {
  return {
    name,
    stars,
    path: options.path ?? `${name}/SKILL.md`,
    text: options.text ?? skillText(name, options.description),
    declaredSize: options.declaredSize,
    defaultBranch: options.defaultBranch ?? "main",
    stageFailure: options.stageFailure ?? "",
  };
}

function createHybridRouter({
  repositoryNames = [],
  codeNames = [],
  definitions = [],
  codeIncomplete = false,
  codePayload,
  fatalMetadataRepository = "",
  beforeCodeResponse = async () => {},
} = {}) {
  const byName = new Map(definitions.map((item) => [item.name, item]));
  const byRepository = new Map(definitions.map((item) => [`owner/${item.name}`, item]));
  const calls = [];
  let repositorySearches = 0;
  let activeValidationRequests = 0;
  let maximumActiveValidationRequests = 0;

  async function validationResponse(factory) {
    activeValidationRequests += 1;
    maximumActiveValidationRequests = Math.max(
      maximumActiveValidationRequests,
      activeValidationRequests,
    );
    try {
      await new Promise((resolve) => setImmediate(resolve));
      return factory();
    } finally {
      activeValidationRequests -= 1;
    }
  }

  return {
    calls,
    get maximumActiveValidationRequests() {
      return maximumActiveValidationRequests;
    },
    setCodeIncomplete(value) {
      codeIncomplete = value;
    },
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      calls.push(parsed.toString());

      if (parsed.pathname === "/search/repositories") {
        repositorySearches += 1;
        const items = repositorySearches === 1
          ? repositoryNames.map((name) => {
            const item = byName.get(name);
            return repositoryItem(`owner/${name}`, item.stars, item.defaultBranch);
          })
          : [];
        return Response.json({ items, incomplete_results: false }, { headers: RATE_HEADERS });
      }

      if (parsed.pathname === "/search/code") {
        await beforeCodeResponse();
        if (codePayload) return codePayload();
        return Response.json({
          items: codeNames.map((name) => {
            const item = byName.get(name);
            return codeItem(`owner/${name}`, item.path);
          }),
          incomplete_results: codeIncomplete,
        }, { headers: { ...RATE_HEADERS, "x-ratelimit-resource": "code_search" } });
      }

      const treeMatch = parsed.pathname.match(/^\/repos\/owner\/([^/]+)\/git\/trees\//u);
      if (treeMatch) {
        const item = byName.get(treeMatch[1]);
        if (item.stageFailure === "tree-network") throw new Error("stage-tree-network-secret");
        if (item.stageFailure === "tree-404") {
          return new Response("stage-tree-404-secret", { status: 404, headers: RATE_HEADERS });
        }
        return validationResponse(() => Response.json({
          tree: [{
            path: item.path,
            type: "blob",
            size: item.declaredSize ?? Buffer.byteLength(item.text),
          }],
          truncated: false,
        }, { headers: RATE_HEADERS }));
      }

      const contentMatch = parsed.pathname.match(/^\/repos\/owner\/([^/]+)\/contents\/(.+)$/u);
      if (contentMatch) {
        const item = byName.get(contentMatch[1]);
        if (item.stageFailure === "content-network") throw new Error("stage-content-network-secret");
        if (item.stageFailure === "content-404") {
          return new Response("stage-content-404-secret", { status: 404, headers: RATE_HEADERS });
        }
        return validationResponse(() => Response.json({
          encoding: "base64",
          content: Buffer.from(item.text).toString("base64"),
          size: item.declaredSize ?? Buffer.byteLength(item.text),
        }, { headers: RATE_HEADERS }));
      }

      const metadataMatch = parsed.pathname.match(/^\/repos\/owner\/([^/]+)$/u);
      if (metadataMatch) {
        const repository = `owner/${metadataMatch[1]}`;
        if (repository === fatalMetadataRepository) {
          return new Response("fatal-metadata-body-secret", {
            status: 429,
            headers: { ...RATE_HEADERS, "x-ratelimit-remaining": "0" },
          });
        }
        const item = byRepository.get(repository);
        return validationResponse(() => Response.json({
          ...repositoryItem(repository, item.stars, item.defaultBranch),
        }, { headers: RATE_HEADERS }));
      }

      return new Response(null, { status: 404, headers: RATE_HEADERS });
    },
  };
}

function paths(router, pathname) {
  return router.calls.filter((url) => new URL(url).pathname === pathname);
}

function rejectionMap(diagnostics) {
  return Object.fromEntries(diagnostics.rejectionCounts.map(({ reason, count }) => [reason, count]));
}

function assertExactDiagnostics(diagnostics) {
  assert.deepEqual(Object.keys(diagnostics), [
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
  assert.deepEqual(Object.keys(diagnostics.rateLimits), ["search", "codeSearch"]);
  for (const item of diagnostics.rejectionCounts) {
    assert.deepEqual(Object.keys(item), ["reason", "count"]);
    assert.ok([
      "invalid-structure",
      "invalid-content",
      "irrelevant",
      "duplicate",
      "unavailable",
    ].includes(item.reason));
  }
}

test("falls back once from an empty repository search and validates at most 12 exact Skill files", async () => {
  const definitions = [
    definition("qr-premium", 500),
    definition("qr-standard", 80),
    definition("qr-basic", 20),
    definition("biography-tool", 500_000, {
      description: "Research biographies from public sources.",
    }),
    ...Array.from({ length: 10 }, (_, index) => definition(`qr-extra-${index}`, 10 - index)),
  ];
  const router = createHybridRouter({
    codeNames: definitions.map((item) => item.name),
    definitions,
  });
  const root = await mkdtemp(join(tmpdir(), "skill-observatory-hybrid-zero-"));

  const result = await findGitHubSkillSuggestions({
    query: "为 Acme 私有项目生成二维码",
    cachePath: join(root, "state", "github-suggestions-cache.json"),
    fetchImpl: router.fetchImpl,
  });

  assert.equal(paths(router, "/search/code").length, 1);
  assert.equal(result.diagnostics.codeHits, definitions.length);
  assert.equal(
    router.calls.filter((url) => /^\/repos\/owner\/[^/]+$/u.test(new URL(url).pathname)).length,
    12,
  );
  assert.deepEqual(result.results.map((item) => item.stars), [500, 80, 20]);
  assert.equal(result.results.some((item) => item.name === "biography-tool"), false);
  assert.equal(rejectionMap(result.diagnostics).irrelevant, 1);
  assert.equal(router.maximumActiveValidationRequests <= 3, true);
  assert.equal(result.incomplete, false);
  assert.equal(result.diagnostics.stageReached, "complete");
  assertExactDiagnostics(result.diagnostics);
  assert.doesNotMatch(
    JSON.stringify(result.diagnostics),
    /Acme|owner|qr-premium|SKILL\.md|Generate QR codes/u,
  );
});

test("combines two repository candidates with one code candidate and orders by Stars", async () => {
  const definitions = [
    definition("qr-repository-a", 80),
    definition("qr-repository-b", 20),
    definition("qr-generator", 500),
  ];
  const router = createHybridRouter({
    repositoryNames: ["qr-repository-a", "qr-repository-b"],
    codeNames: ["qr-generator"],
    definitions,
  });
  const root = await mkdtemp(join(tmpdir(), "skill-observatory-hybrid-combine-"));

  const result = await findGitHubSkillSuggestions({
    query: "生成二维码",
    cachePath: join(root, "state", "github-suggestions-cache.json"),
    fetchImpl: router.fetchImpl,
  });

  assert.equal(paths(router, "/search/code").length, 1);
  assert.deepEqual(result.results.map((item) => item.stars), [500, 80, 20]);
  assert.equal(result.diagnostics.validatedCandidates, 3);
});

for (const stageCase of [
  { label: "tree network", stageFailure: "tree-network", reason: "unavailable" },
  { label: "content 404", stageFailure: "content-404", reason: "unavailable" },
  { label: "invalid candidate", stageFailure: "", reason: "invalid-content", invalid: true },
]) {
  test(`continues from a nonfatal Stage A ${stageCase.label} into one code fallback`, async () => {
    const stageDefinition = definition("qr-stage-a", 900, {
      stageFailure: stageCase.stageFailure,
      ...(stageCase.invalid ? { text: "---\nname: [invalid\n---\nprivate-body-secret\n" } : {}),
    });
    const codeDefinition = definition("qr-fallback", 70);
    const router = createHybridRouter({
      repositoryNames: [stageDefinition.name],
      codeNames: [codeDefinition.name],
      definitions: [stageDefinition, codeDefinition],
    });
    const root = await mkdtemp(join(tmpdir(), `skill-observatory-stage-a-${stageCase.stageFailure || "invalid"}-`));
    const cachePath = join(root, "state", "github-suggestions-cache.json");

    const result = await findGitHubSkillSuggestions({
      query: "生成二维码",
      cachePath,
      fetchImpl: router.fetchImpl,
    });

    assert.equal(paths(router, "/search/code").length, 1);
    assert.deepEqual(result.results.map((item) => item.name), ["qr-fallback"]);
    assert.equal(result.incomplete, true);
    assert.equal(result.diagnostics.incomplete, true);
    assert.equal(rejectionMap(result.diagnostics)[stageCase.reason] >= 1, true);
    assert.doesNotMatch(
      JSON.stringify(result.diagnostics),
      /qr-stage-a|private-body-secret|stage-tree-network-secret|stage-content-404-secret/u,
    );
    await assert.rejects(readFile(cachePath, "utf8"), (error) => error.code === "ENOENT");
  });
}

test("returns incomplete when Stage A and code fallback both fail nonfatally", async () => {
  const stageDefinition = definition("qr-stage-double-failure", 10, {
    stageFailure: "tree-network",
  });
  const router = createHybridRouter({
    repositoryNames: [stageDefinition.name],
    definitions: [stageDefinition],
    codePayload: () => new Response("code-fallback-body-secret", {
      status: 503,
      headers: RATE_HEADERS,
    }),
  });
  const root = await mkdtemp(join(tmpdir(), "skill-observatory-stage-double-failure-"));
  const cachePath = join(root, "state", "github-suggestions-cache.json");

  const result = await findGitHubSkillSuggestions({
    query: "生成二维码",
    cachePath,
    fetchImpl: router.fetchImpl,
  });

  assert.equal(paths(router, "/search/code").length, 1);
  assert.deepEqual(result.results, []);
  assert.equal(result.incomplete, true);
  assert.equal(rejectionMap(result.diagnostics).unavailable >= 2, true);
  assert.doesNotMatch(JSON.stringify(result), /stage-tree-network-secret|code-fallback-body-secret/u);
  await assert.rejects(readFile(cachePath, "utf8"), (error) => error.code === "ENOENT");
});

test("rejects invalid repository default refs before tree access and still uses code fallback", async () => {
  const invalidRefs = [
    "a..b",
    "bad ref",
    "refs/heads/main?",
    ".hidden",
    "main.lock",
    "@",
  ];
  const invalidDefinitions = invalidRefs.map((defaultBranch, index) => definition(`qr-bad-ref-${index}`, 100 - index, {
    defaultBranch,
  }));
  const codeDefinition = definition("qr-ref-fallback", 40);
  const router = createHybridRouter({
    repositoryNames: invalidDefinitions.map((item) => item.name),
    codeNames: [codeDefinition.name],
    definitions: [...invalidDefinitions, codeDefinition],
  });
  const root = await mkdtemp(join(tmpdir(), "skill-observatory-invalid-stage-a-ref-"));
  const cachePath = join(root, "state", "github-suggestions-cache.json");

  const result = await findGitHubSkillSuggestions({
    query: "生成二维码",
    cachePath,
    fetchImpl: router.fetchImpl,
  });

  assert.equal(router.calls.some((url) => new URL(url).pathname.includes("/git/trees/")), false);
  assert.equal(paths(router, "/search/code").length, 1);
  assert.deepEqual(result.results.map((item) => item.name), ["qr-ref-fallback"]);
  assert.equal(result.incomplete, true);
  assert.equal(rejectionMap(result.diagnostics)["invalid-structure"], invalidRefs.length);
  assert.doesNotMatch(JSON.stringify(result.diagnostics), /a\.\.b|bad ref|main\.lock|hidden/u);
  await assert.rejects(readFile(cachePath, "utf8"), (error) => error.code === "ENOENT");
});

test("does not issue code search after three validated repository candidates", async () => {
  const definitions = [
    definition("qr-one", 3),
    definition("qr-two", 2),
    definition("qr-three", 1),
  ];
  const router = createHybridRouter({
    repositoryNames: definitions.map((item) => item.name),
    codeNames: ["qr-one"],
    definitions,
  });
  const root = await mkdtemp(join(tmpdir(), "skill-observatory-hybrid-repository-only-"));

  const result = await findGitHubSkillSuggestions({
    query: "生成二维码",
    cachePath: join(root, "state", "github-suggestions-cache.json"),
    fetchImpl: router.fetchImpl,
  });

  assert.equal(paths(router, "/search/code").length, 0);
  assert.equal(result.results.length, 3);
  assert.equal(result.diagnostics.codeHits, 0);
});

test("deduplicates repository path and ref across discovery stages", async () => {
  const definitions = [definition("qr-shared", 100), definition("qr-new", 10)];
  const router = createHybridRouter({
    repositoryNames: ["qr-shared"],
    codeNames: ["qr-shared", "qr-new"],
    definitions,
  });
  const root = await mkdtemp(join(tmpdir(), "skill-observatory-hybrid-dedupe-"));

  const result = await findGitHubSkillSuggestions({
    query: "生成二维码",
    cachePath: join(root, "state", "github-suggestions-cache.json"),
    fetchImpl: router.fetchImpl,
  });

  assert.deepEqual(result.results.map((item) => item.name), ["qr-shared", "qr-new"]);
  assert.equal(result.diagnostics.deduplicatedCandidates, 1);
  assert.equal(rejectionMap(result.diagnostics).duplicate, 1);
  assert.equal(
    router.calls.filter((url) => new URL(url).pathname.includes("/qr-shared/contents/")).length,
    1,
  );
});

test("groups malformed frontmatter path mismatch and oversized content under safe reasons", async () => {
  const definitions = [
    definition("qr-malformed", 30, { text: "---\nname: [broken\n---\n" }),
    definition("qr-path-mismatch", 20, {
      path: "different-directory/SKILL.md",
      text: skillText("qr-path-mismatch"),
    }),
    definition("qr-oversized", 10, { declaredSize: 256 * 1024 + 1 }),
  ];
  const router = createHybridRouter({ codeNames: definitions.map((item) => item.name), definitions });
  const root = await mkdtemp(join(tmpdir(), "skill-observatory-hybrid-invalid-"));
  const cachePath = join(root, "state", "github-suggestions-cache.json");

  const result = await findGitHubSkillSuggestions({
    query: "生成二维码",
    cachePath,
    fetchImpl: router.fetchImpl,
  });

  assert.deepEqual(result.results, []);
  assert.equal(result.diagnostics.rejectedCandidates, 3);
  assert.equal(rejectionMap(result.diagnostics)["invalid-content"], 3);
  assert.doesNotMatch(JSON.stringify(result.diagnostics), /malformed|mismatch|oversized|different-directory/u);

  let cacheMissCalls = 0;
  const cachedZero = await findGitHubSkillSuggestions({
    query: "生成二维码",
    cachePath,
    fetchImpl: async () => {
      cacheMissCalls += 1;
      throw new Error("complete-zero-cache-miss");
    },
  });
  assert.equal(cachedZero.cached, true);
  assert.equal(cachedZero.diagnostics.cached, true);
  assert.deepEqual(cachedZero.results, []);
  assert.equal(cacheMissCalls, 0);
});

test("returns partial code results as incomplete and never caches them", async () => {
  const definitions = [definition("qr-partial", 50)];
  const router = createHybridRouter({ codeNames: ["qr-partial"], definitions, codeIncomplete: true });
  const root = await mkdtemp(join(tmpdir(), "skill-observatory-hybrid-incomplete-"));
  const cachePath = join(root, "state", "github-suggestions-cache.json");

  const first = await findGitHubSkillSuggestions({ query: "生成二维码", cachePath, fetchImpl: router.fetchImpl });
  assert.equal(first.incomplete, true);
  assert.equal(first.diagnostics.incomplete, true);
  assert.deepEqual(first.results.map((item) => item.name), ["qr-partial"]);
  await assert.rejects(readFile(cachePath, "utf8"), (error) => error.code === "ENOENT");

  const callsBeforeRetry = router.calls.length;
  router.setCodeIncomplete(false);
  const second = await findGitHubSkillSuggestions({ query: "生成二维码", cachePath, fetchImpl: router.fetchImpl });
  assert.equal(second.cached, false);
  assert.equal(second.incomplete, false);
  assert.equal(router.calls.length > callsBeforeRetry, true);

  let cacheMissCalls = 0;
  const third = await findGitHubSkillSuggestions({
    query: "生成二维码",
    cachePath,
    fetchImpl: async () => {
      cacheMissCalls += 1;
      throw new Error("network-must-not-run");
    },
  });
  assert.equal(third.cached, true);
  assert.equal(third.diagnostics.cached, true);
  assert.equal(cacheMissCalls, 0);
});

test("a fatal code metadata limit stops new scheduling immediately", async () => {
  const definitions = Array.from({ length: 12 }, (_, index) => definition(`qr-fatal-${index}`, 100 - index));
  const router = createHybridRouter({
    codeNames: definitions.map((item) => item.name),
    definitions,
    fatalMetadataRepository: "owner/qr-fatal-0",
  });
  const root = await mkdtemp(join(tmpdir(), "skill-observatory-hybrid-fatal-"));

  await assert.rejects(
    () => findGitHubSkillSuggestions({
      query: "生成二维码",
      cachePath: join(root, "state", "github-suggestions-cache.json"),
      fetchImpl: router.fetchImpl,
    }),
    (error) => error.code === "github-rate-limited" &&
      !String(error.stack).includes("fatal-metadata-body-secret"),
  );
  assert.equal(
    router.calls.filter((url) => /^\/repos\/owner\/[^/]+$/u.test(new URL(url).pathname)).length <= 3,
    true,
  );
  assert.equal(router.calls.some((url) => new URL(url).pathname.includes("/contents/")), false);
});

test("a queued fatal request prevents later queued requests from reaching the network", async () => {
  const definitions = Array.from({ length: 3 }, (_, index) => definition(`qr-queued-${index}`, 30 - index));
  const root = await mkdtemp(join(tmpdir(), "skill-observatory-hybrid-queued-fatal-"));
  const blockerReleases = [];
  let blockersStarted = 0;
  let notifyBlockersStarted;
  const allBlockersStarted = new Promise((resolve) => { notifyBlockersStarted = resolve; });
  const blockerPromises = [];

  function startBlockers() {
    if (blockerPromises.length) return allBlockersStarted;
    for (let index = 0; index < 2; index += 1) {
      let firstRepositoryRequest = true;
      blockerPromises.push(findGitHubSkillSuggestions({
        query: "生成二维码",
        cachePath: join(root, `blocker-${index}`, "github-suggestions-cache.json"),
        fetchImpl: async (url) => {
          const pathname = new URL(url).pathname;
          if (pathname === "/search/repositories") {
            if (firstRepositoryRequest) {
              firstRepositoryRequest = false;
              blockersStarted += 1;
              if (blockersStarted === 2) notifyBlockersStarted();
              await new Promise((resolve) => { blockerReleases[index] = resolve; });
            }
            return Response.json({ items: [], incomplete_results: false }, { headers: RATE_HEADERS });
          }
          if (pathname === "/search/code") {
            return Response.json({ items: [], incomplete_results: false }, { headers: RATE_HEADERS });
          }
          return new Response(null, { status: 404, headers: RATE_HEADERS });
        },
      }));
    }
    return allBlockersStarted;
  }

  const router = createHybridRouter({
    codeNames: definitions.map((item) => item.name),
    definitions,
    fatalMetadataRepository: "owner/qr-queued-0",
    beforeCodeResponse: startBlockers,
  });
  const fatalAttempt = findGitHubSkillSuggestions({
    query: "生成二维码",
    cachePath: join(root, "fatal", "github-suggestions-cache.json"),
    fetchImpl: router.fetchImpl,
  });

  try {
    await allBlockersStarted;
    await assert.rejects(fatalAttempt, (error) => error.code === "github-rate-limited");
    assert.equal(
      router.calls.filter((url) => /^\/repos\/owner\/[^/]+$/u.test(new URL(url).pathname)).length,
      1,
    );
    assert.equal(router.calls.some((url) => new URL(url).pathname.includes("/contents/")), false);
  } finally {
    for (const release of blockerReleases) release?.();
    await Promise.allSettled(blockerPromises);
  }
});

test("rejects accessor code responses without invoking them or leaking diagnostics", async () => {
  let getterCalls = 0;
  const responseSecret = "remote-code-response-secret";
  const router = createHybridRouter({
    codePayload: () => ({
      status: 200,
      ok: true,
      headers: new Headers(RATE_HEADERS),
      async json() {
        const payload = { incomplete_results: false };
        Object.defineProperty(payload, "items", {
          enumerable: true,
          get() {
            getterCalls += 1;
            throw new Error(responseSecret);
          },
        });
        return payload;
      },
    }),
  });
  const root = await mkdtemp(join(tmpdir(), "skill-observatory-hybrid-accessor-"));

  const result = await findGitHubSkillSuggestions({
    query: "生成二维码",
    cachePath: join(root, "state", "github-suggestions-cache.json"),
    fetchImpl: router.fetchImpl,
  });

  assert.equal(getterCalls, 0);
  assert.equal(result.incomplete, true);
  assert.equal(rejectionMap(result.diagnostics).unavailable, 1);
  assertExactDiagnostics(result.diagnostics);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(responseSecret, "u"));
});

test("the consented original-query path remains uncached and repository-only", async () => {
  const definitions = [definition("qr-original", 40)];
  const router = createHybridRouter({
    repositoryNames: ["qr-original"],
    codeNames: ["qr-original"],
    definitions,
  });

  const result = await findGitHubSkillSuggestionsFromOriginalQuery({
    query: "Generate QR codes",
    fetchImpl: router.fetchImpl,
  });

  assert.equal(paths(router, "/search/code").length, 0);
  assert.equal(result.cached, false);
  assert.deepEqual(result.results.map((item) => item.name), ["qr-original"]);
  assert.equal(result.diagnostics.codeHits, 0);
  assert.equal(result.diagnostics.stageReached, "complete");
});
