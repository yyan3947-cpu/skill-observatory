import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const matcherUrl = new URL("../app/components/TaskMatcher.tsx", import.meta.url);
const apiUrl = new URL("../app/lib/api.ts", import.meta.url);
const catalogUrl = new URL("../app/lib/catalog.ts", import.meta.url);
const stylesUrl = new URL("../app/globals.css", import.meta.url);

async function source(url) {
  return readFile(url, "utf8");
}

function functionBody(file, name, nextName) {
  const start = file.indexOf(`async function ${name}`);
  assert.notEqual(start, -1, `${name} should exist`);
  const end = nextName ? file.indexOf(`async function ${nextName}`, start + 1) : file.length;
  return file.slice(start, end === -1 ? file.length : end);
}

test("Task Matcher exposes an explicit GitHub action without an install action", async () => {
  const file = await source(matcherUrl);
  assert.match(file, /本机没有达到推荐阈值的 Skill。/);
  assert.match(file, /将发送到 GitHub/);
  assert.match(file, /在 GitHub 查找/);
  assert.match(file, /searchGitHubSkills/);
  assert.doesNotMatch(file, /自动安装|立即安装|安装 Skill/);
});

test("local submit resets remote state and never starts a GitHub search", async () => {
  const file = await source(matcherUrl);
  const submit = functionBody(file, "submit", "searchGitHub");
  for (const reset of [
    /setGithubSearch\(null\)/,
    /setGithubResults\(null\)/,
    /setGithubError\(""\)/,
    /setGithubIncomplete\(false\)/,
  ]) assert.match(submit, reset);
  assert.match(submit, /recommendTask\(/);
  assert.doesNotMatch(submit, /searchGitHubSkills\(/);
});

test("GitHub search prevents duplicate clicks and exposes accessible loading and retry states", async () => {
  const file = await source(matcherUrl);
  const searchGitHub = functionBody(file, "searchGitHub");
  assert.match(file, /githubRequestInFlight\.current/);
  assert.match(file, /disabled=\{githubLoading\}/);
  assert.match(file, /aria-busy=\{githubLoading\}/);
  assert.match(file, /role="status"/);
  assert.match(file, /role="alert"/);
  assert.match(file, /再次点击.*在 GitHub 查找.*重试/);
  assert.match(file, /results\?\.length === 0 && githubSearch && \(/);
  assert.match(searchGitHub, /setGithubError\(/);
  assert.match(searchGitHub, /setGithubLoading\(false\)/);
  assert.doesNotMatch(searchGitHub, /setGithubSearch\(null\)/);
});

test("GitHub results are capped and show repository metadata without installation controls", async () => {
  const file = await source(matcherUrl);
  assert.match(file, /\.slice\(0, 3\)/);
  for (const field of ["repository", "skillDirectory", "pushedAt", "license", "stars"]) {
    assert.match(file, new RegExp(`result\\.${field}`));
  }
  assert.match(file, /aria-label=\{`仓库 Star/);
  assert.match(file, /target="_blank"/);
  assert.match(file, /rel="noreferrer"/);
  assert.match(file, /result\.license\?\.trim\(\) \|\| "未标注"/);
  assert.doesNotMatch(file, /installSkill|\/api\/install|安装按钮/);
});

test("GitHub response types match the local service rate-limit contract", async () => {
  const file = await source(catalogUrl);
  assert.match(
    file,
    /rateLimit: \{ remaining: number \| null; reset: number \| null; retryAt: string \| null \} \| null;/,
  );
  assert.doesNotMatch(file, /resetAt/);
});

test("GitHub links keep a keyboard-focusable 44px target", async () => {
  const file = await source(stylesUrl);
  const start = file.indexOf(".external-link {");
  assert.notEqual(start, -1);
  const rule = file.slice(start, file.indexOf("}", start) + 1);
  assert.match(rule, /display: inline-flex/);
  assert.match(rule, /align-items: center/);
  assert.match(rule, /min-height: 44px/);
  assert.match(file, /a:focus-visible/);
});

test("browser API posts only to the loopback GitHub suggestions endpoint", async () => {
  const file = await source(apiUrl);
  assert.match(file, /const API_BASE = "http:\/\/127\.0\.0\.1:4318"/);
  assert.match(file, /export async function searchGitHubSkills/);
  assert.match(file, /`\$\{API_BASE\}\/api\/github-suggestions`/);
  assert.match(file, /method: "POST"/);
  assert.doesNotMatch(file, /api\.github\.com|GITHUB_TOKEN|Authorization|Bearer/);
});

test("browser API preserves local and GitHub response envelopes", async (context) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/api/recommend")) {
      return Response.json({
        results: [],
        githubSearch: { terms: ["diagram", "skill"], label: "diagram · skill" },
      });
    }
    return Response.json({
      preview: { terms: ["diagram", "skill"], label: "diagram · skill" },
      results: [],
      cached: false,
      incomplete: false,
      rateLimit: null,
    });
  };
  context.after(() => { globalThis.fetch = originalFetch; });

  const { recommendTask, searchGitHubSkills } = await import(apiUrl);
  const local = await recommendTask("画架构图");
  assert.equal(local.githubSearch.label, "diagram · skill");
  assert.deepEqual(local.results, []);
  const remote = await searchGitHubSkills("画架构图");
  assert.deepEqual(remote.results, []);
  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:4318/api/recommend",
    "http://127.0.0.1:4318/api/github-suggestions",
  ]);
  assert.ok(calls.every((call) => call.options.method === "POST"));
});

test("GitHub rate limits expose only a validated, locally formatted retry time", async (context) => {
  const originalFetch = globalThis.fetch;
  const retryAt = "2026-08-15T01:02:03.000Z";
  globalThis.fetch = async () => Response.json({
    error: "github-rate-limited",
    retryAt,
    message: "server-secret-must-not-appear",
  }, { status: 429 });
  context.after(() => { globalThis.fetch = originalFetch; });
  const { searchGitHubSkills } = await import(apiUrl);
  const expectedTime = new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(retryAt));
  await assert.rejects(
    searchGitHubSkills("news"),
    (error) => error.message === `GitHub 查询频率已达上限，可在 ${expectedTime} 后重试。` &&
      !error.message.includes("secret") && !error.message.includes(retryAt),
  );
});

test("GitHub rate limits ignore invalid or malformed response details", async (context) => {
  const originalFetch = globalThis.fetch;
  const responses = [
    Response.json({ retryAt: "not-a-date", message: "server-secret" }, { status: 429 }),
    new Response("not json server-secret", { status: 429 }),
  ];
  globalThis.fetch = async () => responses.shift();
  context.after(() => { globalThis.fetch = originalFetch; });
  const { searchGitHubSkills } = await import(apiUrl);
  for (const query of ["news", "research"]) {
    await assert.rejects(
      searchGitHubSkills(query),
      (error) => error.message === "GitHub 查询频率已达上限，请稍后重试。" &&
        !error.message.includes("secret"),
    );
  }
});
