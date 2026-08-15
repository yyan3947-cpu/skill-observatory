import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import {
  buildGitHubRepositoryQueries,
  buildGitHubSearchPreview,
} from "../lib/github-query.mjs";

test("reduces a task to capability terms and removes sensitive details", () => {
  const privatePath = join("/", "Users", "alice", "secret.txt");
  const preview = buildGitHubSearchPreview(
    `请读取 ${privatePath}，联系 alice@example.com，帮 Acme 20260815 搜寻国际时事`,
  );

  assert.deepEqual(preview.terms, ["current affairs", "news", "research"]);
  assert.equal(preview.label, "current affairs · news · research");
  assert.doesNotMatch(JSON.stringify(preview), /alice|Acme|20260815|secret/);
  assert.equal(
    preview.cacheKey,
    createHash("sha256").update("current affairs\0news\0research").digest("hex"),
  );
});

test("falls back to fixed action terms without sending arbitrary task subjects", () => {
  const chinese = buildGitHubSearchPreview("帮我分析星河项目内部并购计划");
  const english = buildGitHubSearchPreview("analyze acme confidential merger plans");

  assert.deepEqual(chinese?.terms, ["analysis", "skill"]);
  assert.deepEqual(english?.terms, ["analysis", "skill"]);
  assert.doesNotMatch(JSON.stringify(chinese), /星河|并购|计划/u);
  assert.doesNotMatch(JSON.stringify(english), /acme|confidential|merger|plans/u);
});

test("maps QR code and Airtable tasks to controlled capability terms", () => {
  assert.deepEqual(
    buildGitHubSearchPreview("生成二维码")?.terms,
    ["qr code", "generator", "skill"],
  );
  assert.deepEqual(
    buildGitHubSearchPreview("管理 Airtable 数据")?.terms,
    ["airtable", "data management", "skill"],
  );
});

test("returns null when neither a controlled capability nor action matches", () => {
  assert.equal(buildGitHubSearchPreview("星河项目内部并购计划"), null);
  assert.equal(buildGitHubSearchPreview("acme confidential merger plans"), null);
});

test("strips markdown code and path variants before matching capability rules", () => {
  const privatePath = join("/", "Users", "alice", "pdf", "secret.txt");
  const assignedPath = join("/", "Users", "alice", "word", "secret.txt");
  const task = [
    "check `ppt`",
    "~/private/ui/notes.txt",
    `file://${privatePath}`,
    String.raw`\\server\share\xhs\private.txt`,
    `path=${assignedPath}`,
  ].join(" ");

  assert.equal(buildGitHubSearchPreview(task), null);
});

test("does not match short English patterns inside unrelated words", () => {
  assert.equal(buildGitHubSearchPreview("building automation"), null);
  assert.equal(buildGitHubSearchPreview("password manager"), null);
  assert.deepEqual(
    buildGitHubSearchPreview("design a UI for the dashboard")?.terms,
    ["ui ux", "web design", "skill"],
  );
  assert.deepEqual(
    buildGitHubSearchPreview("edit a Word document")?.terms,
    ["document", "pdf", "skill"],
  );
  assert.deepEqual(
    buildGitHubSearchPreview("automate a private office workflow")?.terms,
    ["automation", "skill"],
  );
});

test("matches controlled English capabilities case-insensitively", () => {
  assert.deepEqual(
    buildGitHubSearchPreview("Debug this failing build")?.terms,
    ["debugging", "code", "skill"],
  );
  assert.deepEqual(
    buildGitHubSearchPreview("Create a Presentation for sales")?.terms,
    ["presentation", "powerpoint", "skill"],
  );
  assert.deepEqual(
    buildGitHubSearchPreview("Document editing assistant")?.terms,
    ["document", "pdf", "skill"],
  );
  assert.deepEqual(
    buildGitHubSearchPreview("Analyze Market News today")?.terms,
    ["market news", "news analysis", "research"],
  );
  assert.deepEqual(
    buildGitHubSearchPreview("Research World News")?.terms,
    ["current affairs", "news", "research"],
  );
  assert.deepEqual(
    buildGitHubSearchPreview("Xiaohongshu content")?.terms,
    ["xiaohongshu", "content", "skill"],
  );
});

test("builds best-match and star-sorted repository searches", () => {
  const queries = buildGitHubRepositoryQueries(["current affairs", "news", "research"]);

  assert.deepEqual(queries.map((item) => item.mode), ["best-match", "stars"]);
  assert.equal(queries[0].sort, undefined);
  assert.equal(queries[0].order, undefined);
  assert.equal(queries[1].sort, "stars");
  assert.equal(queries[1].order, "desc");
  assert.match(queries[0].q, /SKILL\.md/);
  assert.match(queries[0].q, /archived:false/);
  assert.equal(queries[0].q, queries[1].q);
});

test("caps externally supplied repository terms at six and 128 total characters", () => {
  const queries = buildGitHubRepositoryQueries([
    "news",
    "news",
    "research",
    "current affairs",
    "analysis",
    "codex",
    "skill",
    "ignored",
  ]);

  assert.equal(queries.length, 2);
  assert.doesNotMatch(queries[0].q, /ignored/);
  assert.equal((queries[0].q.match(/news/g) ?? []).length, 1);

  const longQueries = buildGitHubRepositoryQueries([
    "a".repeat(32),
    "b".repeat(32),
    "c".repeat(32),
    "d".repeat(32),
    "short",
    "sixth",
    "seventh",
  ]);
  const expression = longQueries[0].q.split(' "SKILL.md"')[0];
  const terms = [...expression.matchAll(/"([^"]+)"|(\S+)/gu)]
    .map((match) => match[1] ?? match[2]);
  assert.ok(terms.length <= 6);
  assert.ok(terms.join(" ").length <= 128);
});
