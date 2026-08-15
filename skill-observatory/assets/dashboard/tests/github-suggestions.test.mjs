import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findGitHubSkillSuggestions } from "../lib/github-suggestions.mjs";

const fixturesDirectory = join(import.meta.dirname, "fixtures");

async function fixture(name) {
  return readFile(join(fixturesDirectory, name), "utf8");
}

async function createRouter() {
  const best = JSON.parse(await fixture("github-search-best.json"));
  const stars = JSON.parse(await fixture("github-search-stars.json"));
  const tree = JSON.parse(await fixture("github-tree.json"));
  const valid = await fixture("github-skill-valid.md");
  const invalid = await fixture("github-skill-invalid.md");
  const calls = [];
  let activeTrees = 0;
  let maximumActiveTrees = 0;

  return {
    calls,
    get maximumActiveTrees() {
      return maximumActiveTrees;
    },
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      calls.push(parsed.toString());
      const headers = { "x-ratelimit-remaining": String(60 - calls.length), "x-ratelimit-reset": "1780000000" };
      if (parsed.pathname === "/search/repositories") {
        return Response.json(parsed.searchParams.get("sort") === "stars" ? stars : best, { headers });
      }

      const treeMatch = parsed.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/trees\//u);
      if (treeMatch) {
        activeTrees += 1;
        maximumActiveTrees = Math.max(maximumActiveTrees, activeTrees);
        await new Promise((resolve) => setImmediate(resolve));
        activeTrees -= 1;
        const repository = `${treeMatch[1]}/${treeMatch[2]}`;
        if (repository === "owner/news-skill") return Response.json(tree, { headers });
        const name = repository.split("/")[1];
        return Response.json({
          tree: [{ path: `${name}/SKILL.md`, type: "blob", size: 180 }],
          truncated: false,
        }, { headers });
      }

      const contentMatch = parsed.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/u);
      if (contentMatch) {
        const repository = `${contentMatch[1]}/${contentMatch[2]}`;
        let text = invalid;
        if (repository === "owner/news-skill") text = valid;
        if (repository === "owner/research-skill") {
          text = valid
            .replaceAll("news-skill", "research-skill")
            .replace("Research current affairs and analyze international news", "Research world news and current affairs");
        }
        if (repository === "owner/unrelated-tool") {
          text = valid
            .replaceAll("news-skill", "unrelated-tool")
            .replace("Research current affairs and analyze international news from public sources.", "Format local gardening notes.");
        }
        return Response.json({
          encoding: "base64",
          content: Buffer.from(text).toString("base64"),
          size: Buffer.byteLength(text),
        }, { headers });
      }
      return new Response(null, { status: 404, headers });
    },
  };
}

function repositoryItem(name = "news-skill", stars = 10) {
  return {
    full_name: `owner/${name}`,
    default_branch: "main",
    stargazers_count: stars,
    pushed_at: "2026-08-10T10:00:00Z",
    archived: false,
    disabled: false,
    fork: false,
    license: { spdx_id: "MIT" },
  };
}

function createSingleSkillRouter(skillText, {
  failAt = "",
  ordinary404 = false,
  skillName = "news-skill",
} = {}) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      calls.push(parsed.toString());
      const headers = { "x-ratelimit-remaining": "9", "x-ratelimit-reset": "1780000000" };
      const isSearch = parsed.pathname === "/search/repositories";
      const isTree = parsed.pathname.includes("/git/trees/");
      const isContent = parsed.pathname.includes("/contents/");
      if (failAt === "search" && isSearch) return new Response("limit-body-secret", { status: 403, headers });
      if (failAt === "tree" && isTree) return new Response("limit-body-secret", { status: 429, headers });
      if (failAt === "content" && isContent) return new Response("limit-body-secret", { status: 403, headers });
      if (failAt === "tree-network" && isTree) throw new Error("offline");
      if (failAt === "content-network" && isContent) throw new Error("offline");
      if (ordinary404 && isContent) return new Response("not-found-secret", { status: 404, headers });
      if (isSearch) {
        return Response.json({ items: [repositoryItem()], incomplete_results: false }, { headers });
      }
      if (isTree) {
        return Response.json({
          tree: [
            { path: `${skillName}/SKILL.md`, type: "blob", size: Buffer.byteLength(skillText) },
            { path: `${skillName}/nested/SKILL.md`, type: "blob", size: Buffer.byteLength(skillText) },
          ],
          truncated: false,
        }, { headers });
      }
      if (isContent) {
        return Response.json({
          encoding: "base64",
          content: Buffer.from(skillText).toString("base64"),
          size: Buffer.byteLength(skillText),
        }, { headers });
      }
      return new Response(null, { status: 404, headers });
    },
  };
}

test("validates candidates, removes duplicates, and orders qualified Skills by repository Stars", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-observatory-github-"));
  const cachePath = join(root, "state", "github-suggestions-cache.json");
  const router = await createRouter();

  const result = await findGitHubSkillSuggestions({
    query: "原始秘密任务：搜寻国际时事",
    cachePath,
    fetchImpl: router.fetchImpl,
    token: "test-token",
    now: new Date("2026-08-15T00:00:00Z"),
  });

  assert.deepEqual(result.results.map((item) => item.repository), ["owner/news-skill", "owner/research-skill"]);
  assert.deepEqual(result.results.map((item) => item.stars), [900, 100]);
  assert.ok(result.results.every((item) => item.skillDirectory.endsWith("SKILL.md") === false));
  assert.equal(result.results.length <= 3, true);
  assert.equal(new Set(result.results.map((item) => `${item.repository}/${item.skillDirectory}`)).size, result.results.length);
  assert.equal(result.results.some((item) => item.repository.includes("archived")), false);
  assert.equal(result.results.some((item) => item.repository.includes("invalid")), false);
  assert.equal(router.maximumActiveTrees <= 3, true);
  assert.equal(result.cached, false);
  assert.deepEqual(result.preview.terms, ["current affairs", "news", "research"]);
});

test("cache omits the original task, token, and Skill text, then expires after 24 hours", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-observatory-github-cache-"));
  const cachePath = join(root, "state", "github-suggestions-cache.json");
  const firstRouter = await createRouter();
  const firstNow = new Date("2026-08-15T00:00:00Z");
  const first = await findGitHubSkillSuggestions({
    query: "原始秘密任务：搜寻国际时事",
    cachePath,
    fetchImpl: firstRouter.fetchImpl,
    token: "test-token",
    now: firstNow,
  });
  assert.equal(first.cached, false);

  const cacheText = await readFile(cachePath, "utf8");
  assert.doesNotMatch(cacheText, /原始秘密任务|test-token|Read and summarize sources/);
  assert.match(cacheText, /current affairs/);
  assert.equal((await stat(cachePath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, "state"))).mode & 0o777, 0o700);

  let cachedNetworkCalls = 0;
  const cached = await findGitHubSkillSuggestions({
    query: "另一段秘密：国际时事",
    cachePath,
    fetchImpl: async () => {
      cachedNetworkCalls += 1;
      throw new Error("cache-miss");
    },
    token: "different-token",
    now: new Date(firstNow.getTime() + 23 * 60 * 60 * 1000),
  });
  assert.equal(cached.cached, true);
  assert.equal(cachedNetworkCalls, 0);

  const expiredRouter = await createRouter();
  const expired = await findGitHubSkillSuggestions({
    query: "过期后的任务：国际时事",
    cachePath,
    fetchImpl: expiredRouter.fetchImpl,
    token: "test-token",
    now: new Date(firstNow.getTime() + 24 * 60 * 60 * 1000 + 1),
  });
  assert.equal(expired.cached, false);
  assert.equal(expiredRouter.calls.length > 0, true);
});

test("returns an empty, network-free response when no controlled preview exists", async () => {
  let calls = 0;
  const result = await findGitHubSkillSuggestions({
    query: "Alice 的 Acme-20260815 私密计划",
    cachePath: "/should/not/be/used.json",
    fetchImpl: async () => {
      calls += 1;
      throw new Error("unexpected-network-call");
    },
  });

  assert.deepEqual(result, { preview: null, results: [], cached: false, incomplete: false, rateLimit: null });
  assert.equal(calls, 0);
});

for (const stage of ["search", "tree", "content"]) {
  test(`stops scheduling and does not cache when GitHub rate limits ${stage}`, async () => {
    const root = await mkdtemp(join(tmpdir(), `skill-observatory-rate-${stage}-`));
    const cachePath = join(root, "state", "github-suggestions-cache.json");
    const valid = await fixture("github-skill-valid.md");
    const router = createSingleSkillRouter(valid, { failAt: stage });

    await assert.rejects(
      () => findGitHubSkillSuggestions({
        query: "国际时事",
        cachePath,
        fetchImpl: router.fetchImpl,
        now: new Date("2026-08-15T00:00:00Z"),
      }),
      (error) => error.code === "github-rate-limited" && error.status === 429,
    );
    await assert.rejects(readFile(cachePath, "utf8"), (error) => error.code === "ENOENT");
    if (stage === "search") assert.equal(router.calls.length, 1);
    if (stage === "tree") assert.equal(router.calls.filter((url) => url.includes("/git/trees/")).length, 1);
    if (stage === "content") assert.equal(router.calls.filter((url) => url.includes("/contents/")).length, 1);
  });
}

for (const stage of ["tree-network", "content-network"]) {
  test(`does not cache an empty result when every ${stage} validation fails`, async () => {
    const root = await mkdtemp(join(tmpdir(), `skill-observatory-network-${stage}-`));
    const cachePath = join(root, "state", "github-suggestions-cache.json");
    const valid = await fixture("github-skill-valid.md");
    const router = createSingleSkillRouter(valid, { failAt: stage });
    await assert.rejects(
      () => findGitHubSkillSuggestions({
        query: "国际时事",
        cachePath,
        fetchImpl: router.fetchImpl,
      }),
      (error) => error.code === "github-network-failed",
    );
    await assert.rejects(readFile(cachePath, "utf8"), (error) => error.code === "ENOENT");
  });
}

test("does not cache when every candidate content request fails without a successful validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-observatory-content-404-"));
  const cachePath = join(root, "state", "github-suggestions-cache.json");
  const valid = await fixture("github-skill-valid.md");
  const router = createSingleSkillRouter(valid, { ordinary404: true });
  await assert.rejects(
    () => findGitHubSkillSuggestions({ query: "国际时事", cachePath, fetchImpl: router.fetchImpl }),
    (error) => error.code === "github-request-failed",
  );
  await assert.rejects(readFile(cachePath, "utf8"), (error) => error.code === "ENOENT");
});

test("keeps successful candidates when another repository returns an ordinary 404", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-observatory-partial-404-"));
  const router = await createRouter();
  const result = await findGitHubSkillSuggestions({
    query: "国际时事",
    cachePath: join(root, "state", "github-suggestions-cache.json"),
    fetchImpl: async (url, options) => {
      if (String(url).includes("/repos/owner/invalid-skill/contents/")) {
        return new Response("not-found-secret", { status: 404 });
      }
      return router.fetchImpl(url, options);
    },
  });
  assert.equal(result.incomplete, true);
  assert.deepEqual(result.results.map((item) => item.repository), ["owner/news-skill", "owner/research-skill"]);
});

test("strictly rejects unsafe or malformed YAML frontmatter", async () => {
  const malformedDocuments = [
    "---\nname: news-skill\ndescription: [current affairs\n---\n",
    "---\nname: news-skill\ndescription: 'current affairs\n---\n",
    "---\nname: news-skill\nname: duplicate\ndescription: current affairs research\n---\n",
    "---\nname: [news-skill]\ndescription: current affairs research\n---\n",
    "---\nname: news-skill\ndescription:\n  topic: current affairs\n---\n",
    "---\n- name: news-skill\n- description: current affairs research\n---\n",
    "---\nname: !!js/function function () {}\ndescription: current affairs research\n---\n",
    "---\nname: news-skill\ndescription: &desc current affairs research\nmetadata: *desc\n---\n",
    "---\nname: news-skill\ndescription: current affairs research\n...\n---\n",
    `---\nname: ${"n".repeat(65)}\ndescription: current affairs research\n---\n`,
    `---\nname: news-skill\ndescription: ${"current affairs ".padEnd(1025, "x")}\n---\n`,
    "---\nname: news-skill\ndescription: research <current affairs>\n---\n",
    "---\nname: news-skill\ndescription: '<<'\n---\n",
    "---\nname: news-skill\ndescription: !!str <<\n---\n",
    "---\nname: news-skill\ndescription: current affairs research\ncompatibility: any\n---\n",
  ];

  for (const [index, skillText] of malformedDocuments.entries()) {
    const root = await mkdtemp(join(tmpdir(), `skill-observatory-yaml-${index}-`));
    const router = createSingleSkillRouter(skillText);
    const result = await findGitHubSkillSuggestions({
      query: "国际时事",
      cachePath: join(root, "state", "github-suggestions-cache.json"),
      fetchImpl: router.fetchImpl,
    });
    assert.deepEqual(result.results, [], `malformed YAML fixture ${index} must be rejected`);
  }
});

test("requires exact LF frontmatter delimiters like the official validator", async () => {
  const validBody = "name: news-skill\ndescription: Research current affairs";
  const invalidDelimiters = [
    `\uFEFF---\n${validBody}\n---\n`,
    `---   \n${validBody}\n---\n`,
    `---\r\n${validBody.replaceAll("\n", "\r\n")}\r\n---\r\n`,
    `---\n${validBody}\n ---\n`,
    `---\n${validBody}\n---   \n`,
  ];
  for (const [index, skillText] of invalidDelimiters.entries()) {
    const root = await mkdtemp(join(tmpdir(), `skill-observatory-yaml-delimiter-${index}-`));
    const router = createSingleSkillRouter(skillText);
    const result = await findGitHubSkillSuggestions({
      query: "国际时事",
      cachePath: join(root, "state", "github-suggestions-cache.json"),
      fetchImpl: router.fetchImpl,
    });

    assert.deepEqual(result.results, [], `delimiter fixture ${index} must be rejected`);
  }
});

test("rejects unquoted typed or numeric-like YAML scalars", async () => {
  const plainScalars = [
    "yes",
    "off",
    "2020-01-01",
    "2020-01-01T00:00:00Z",
    "null",
    "42",
    "1.0e+3",
    "1e3",
    ".nan",
  ];
  for (const [index, name] of plainScalars.entries()) {
    const skillText = [
      "---",
      `name: ${name}`,
      "description: Research current affairs",
      "---",
      "",
    ].join("\n");
    const root = await mkdtemp(join(tmpdir(), `skill-observatory-yaml-plain-${index}-`));
    const router = createSingleSkillRouter(skillText, { skillName: name });
    const result = await findGitHubSkillSuggestions({
      query: "国际时事",
      cachePath: join(root, "state", "github-suggestions-cache.json"),
      fetchImpl: router.fetchImpl,
    });

    assert.deepEqual(result.results, [], `plain scalar ${name} must be rejected unless explicitly quoted`);
  }
});

test("rejects YAML 1.1 sexagesimal and special plain scalars in description", async () => {
  const plainDescriptions = [
    "1:20",
    "1:20:30",
    "1:2",
    "1:02",
    "59:59",
    "60:00",
    "190:20:30",
    "1:20:30:40",
    "-1:20",
    "+1:20",
    "1:20.5",
    "-1:20.5",
    "+1:20.5",
    "1:20:30.5",
    "-1:20:30.5",
    "+1:20:30.5",
    "0:20.5",
    "01:20.5",
    "=",
    "<<",
  ];
  for (const [index, description] of plainDescriptions.entries()) {
    const skillText = [
      "---",
      "name: current-affairs",
      `description: ${description}`,
      "---",
      "",
    ].join("\n");
    const root = await mkdtemp(join(tmpdir(), `skill-observatory-yaml-sexagesimal-${index}-`));
    const router = createSingleSkillRouter(skillText, { skillName: "current-affairs" });
    const result = await findGitHubSkillSuggestions({
      query: "国际时事",
      cachePath: join(root, "state", "github-suggestions-cache.json"),
      fetchImpl: router.fetchImpl,
    });

    assert.deepEqual(result.results, [], `plain description ${description} must be rejected`);
  }
});

test("accepts YAML 1.1 scalar forms the official loader keeps as strings", async () => {
  const stringDescriptions = [
    '"1:20"',
    "'1:20.5'",
    "!!str 1:20:30.5",
    "0:20",
    "01:20",
    "1:60",
    '"="',
    "!!str =",
  ];
  for (const [index, description] of stringDescriptions.entries()) {
    const skillText = [
      "---",
      "name: current-affairs",
      `description: ${description}`,
      "---",
      "",
    ].join("\n");
    const root = await mkdtemp(join(tmpdir(), `skill-observatory-yaml-string-scalar-${index}-`));
    const router = createSingleSkillRouter(skillText, { skillName: "current-affairs" });
    const result = await findGitHubSkillSuggestions({
      query: "国际时事",
      cachePath: join(root, "state", "github-suggestions-cache.json"),
      fetchImpl: router.fetchImpl,
    });

    assert.deepEqual(
      result.results.map((item) => item.name),
      ["current-affairs"],
      `string description ${description} must be accepted`,
    );
  }
});

test("accepts the official frontmatter key set at the name and description length limits", async () => {
  const name = "n".repeat(64);
  const description = "Research current affairs ".padEnd(1024, "x");
  const skillText = [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "license: MIT",
    "allowed-tools: []",
    "metadata:",
    "  source: public",
    "---",
    "",
  ].join("\n");
  const root = await mkdtemp(join(tmpdir(), "skill-observatory-yaml-boundary-"));
  const router = createSingleSkillRouter(skillText, { skillName: name });
  const result = await findGitHubSkillSuggestions({
    query: "国际时事",
    cachePath: join(root, "state", "github-suggestions-cache.json"),
    fetchImpl: router.fetchImpl,
  });

  assert.deepEqual(result.results.map((item) => item.name), [name]);
});

test("accepts explicitly quoted strings that YAML would otherwise type as plain scalars", async () => {
  for (const [index, name] of ["yes", "2020-01-01", "1e3", "0o10"].entries()) {
    const skillText = [
      "---",
      `name: ${JSON.stringify(name)}`,
      "description: \"Research current affairs\"",
      "---",
      "",
    ].join("\n");
    const root = await mkdtemp(join(tmpdir(), `skill-observatory-yaml-quoted-${index}-`));
    const router = createSingleSkillRouter(skillText, { skillName: name });
    const result = await findGitHubSkillSuggestions({
      query: "国际时事",
      cachePath: join(root, "state", "github-suggestions-cache.json"),
      fetchImpl: router.fetchImpl,
    });

    assert.deepEqual(result.results.map((item) => item.name), [name]);
  }
});

test("coalesces ten simultaneous requests for the same cache key", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-observatory-coalesced-"));
  const router = await createRouter();
  const requests = Array.from({ length: 10 }, () => findGitHubSkillSuggestions({
    query: "国际时事",
    cachePath: join(root, "state", "github-suggestions-cache.json"),
    fetchImpl: router.fetchImpl,
    now: new Date("2026-08-15T00:00:00Z"),
  }));

  const responses = await Promise.all(requests);
  assert.equal(router.calls.filter((url) => new URL(url).pathname === "/search/repositories").length, 2);
  assert.ok(responses.every((response) => response === responses[0]));
  assert.ok(responses.every((response) => response.cached === false));
});

test("serializes cache merges for different keys and globally limits GitHub requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-observatory-concurrent-cache-"));
  const cachePath = join(root, "state", "github-suggestions-cache.json");
  const router = await createRouter();
  let active = 0;
  let maximumActive = 0;
  const fetchImpl = async (...args) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      return await router.fetchImpl(...args);
    } finally {
      active -= 1;
    }
  };

  await Promise.all([
    findGitHubSkillSuggestions({ query: "国际时事", cachePath, fetchImpl }),
    findGitHubSkillSuggestions({ query: "小红书发布", cachePath, fetchImpl }),
  ]);

  const cache = JSON.parse(await readFile(cachePath, "utf8"));
  assert.equal(Object.keys(cache.entries).length, 2);
  assert.equal(maximumActive <= 3, true);
  assert.equal((await stat(cachePath)).mode & 0o777, 0o600);
});

test("does not cache timed-out requests or expose token and transport details", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-observatory-timeout-"));
  const cachePath = join(root, "state", "github-suggestions-cache.json");
  const token = "timeout-token-secret";

  await assert.rejects(
    () => findGitHubSkillSuggestions({
      query: "国际时事",
      cachePath,
      token,
      requestTimeoutMilliseconds: 5,
      fetchImpl: async (url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          reject(new Error(`transport-body-secret ${options.headers.authorization} ${url}`));
        }, { once: true });
      }),
    }),
    (error) => {
      assert.equal(error.code, "github-request-timeout");
      assert.equal(error.message, "github-request-timeout");
      assert.doesNotMatch(String(error.stack), /transport-body-secret|timeout-token-secret/);
      return true;
    },
  );
  await assert.rejects(readFile(cachePath, "utf8"), (error) => error.code === "ENOENT");
});

test("treats insecure or structurally tampered fresh caches as misses", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-observatory-cache-validation-"));
  const cachePath = join(root, "state", "github-suggestions-cache.json");
  const initialRouter = await createRouter();
  await findGitHubSkillSuggestions({
    query: "国际时事",
    cachePath,
    fetchImpl: initialRouter.fetchImpl,
    now: new Date("2026-08-15T00:00:00Z"),
  });

  await chmod(cachePath, 0o644);
  const insecureRouter = await createRouter();
  const insecure = await findGitHubSkillSuggestions({
    query: "国际时事",
    cachePath,
    fetchImpl: insecureRouter.fetchImpl,
    now: new Date("2026-08-15T01:00:00Z"),
  });
  assert.equal(insecure.cached, false);
  assert.equal(insecureRouter.calls.length > 0, true);
  assert.equal((await stat(cachePath)).mode & 0o777, 0o600);

  const scenarios = [
    (cache) => { cache.entries = []; },
    (cache) => { cache.entries[Object.keys(cache.entries)[0]].results[0].skillDirectory = "skills/not-the-name"; },
    (cache) => { cache.entries[Object.keys(cache.entries)[0]].results.push(cache.entries[Object.keys(cache.entries)[0]].results[0]); },
    (cache) => { cache.entries[Object.keys(cache.entries)[0]].results.reverse(); },
  ];
  for (const mutate of scenarios) {
    const cache = JSON.parse(await readFile(cachePath, "utf8"));
    mutate(cache);
    await writeFile(cachePath, `${JSON.stringify(cache)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(cachePath, 0o600);
    const router = await createRouter();
    const response = await findGitHubSkillSuggestions({
      query: "国际时事",
      cachePath,
      fetchImpl: router.fetchImpl,
      now: new Date("2026-08-15T02:00:00Z"),
    });
    assert.equal(response.cached, false);
    assert.equal(router.calls.length > 0, true);
  }
});
