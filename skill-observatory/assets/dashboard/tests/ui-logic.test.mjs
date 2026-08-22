import assert from "node:assert/strict";
import test from "node:test";
import { filterSkills, sortSkills } from "../app/lib/catalog.ts";
import { createTaskSearchController } from "../app/lib/task-search-controller.ts";
import { createTaskMatcherLifecycle } from "../app/lib/task-search-diagnostics.ts";

const skills = [
  { name: "codex-ppt", summaryZh: "生成演示文稿", description: "PPT", category: "演示与视觉设计", aliases: ["幻灯片"], usageCount: 1, status: "ready", sourceType: "user", lastUsedAt: "2026-08-10T00:00:00Z" },
  { name: "a-share-analysis", summaryZh: "分析股票基本面", description: "A股", category: "投资与市场", aliases: ["股票分析"], usageCount: 4, status: "ready", sourceType: "user", lastUsedAt: "2026-08-11T00:00:00Z" },
  { name: "unused-skill", summaryZh: "整理资料", description: "unused", category: "数据与办公", aliases: ["整理"], usageCount: 0, status: "unchecked", sourceType: "plugin", lastUsedAt: null },
];

test("combines dashboard filters and sorts without mutating input", () => {
  const filtered = filterSkills(skills, {
    query: "股票",
    used: "used",
    status: "all",
    category: "投资与市场",
    source: "all",
  });
  assert.deepEqual(filtered.map((skill) => skill.name), ["a-share-analysis"]);
  assert.deepEqual(sortSkills(skills, "usage").map((skill) => skill.name), [
    "a-share-analysis",
    "codex-ppt",
    "unused-skill",
  ]);
  assert.deepEqual(skills.map((skill) => skill.name), ["codex-ppt", "a-share-analysis", "unused-skill"]);
});

test("Task Matcher lifecycle survives StrictMode replay and disposes one real unmount", () => {
  const deferredDisposals = [];
  let refreshes = 0;
  let subscriptions = 0;
  let unsubscriptions = 0;
  let disposals = 0;
  const lifecycle = createTaskMatcherLifecycle({
    subscribe() {
      subscriptions += 1;
      return () => { unsubscriptions += 1; };
    },
    refreshGitHubStatus() {
      refreshes += 1;
      return Promise.resolve(true);
    },
    dispose() {
      disposals += 1;
    },
  }, () => {}, (callback) => deferredDisposals.push(callback));

  const firstCleanup = lifecycle.mount();
  firstCleanup();
  const replayCleanup = lifecycle.mount();
  deferredDisposals.shift()();
  assert.equal(disposals, 0);
  assert.equal(refreshes, 2);
  assert.equal(subscriptions, 2);

  replayCleanup();
  deferredDisposals.shift()();
  assert.equal(disposals, 1);
  assert.equal(unsubscriptions, 2);
});

test("real unmount aborts a mount refresh and ignores its stale result", async () => {
  const status = Promise.withResolvers();
  let statusSignal;
  const controller = createTaskSearchController({
    getGitHubStatus: async (signal) => {
      statusSignal = signal;
      return status.promise;
    },
    recommendTask: async () => ({
      localMatchLevel: "none",
      results: [],
      githubSearch: null,
      githubStatus: {
        state: "ready",
        checkedAt: "2026-08-19T01:02:03.000Z",
        rateLimits: { search: null, codeSearch: null },
      },
      rawConsent: null,
    }),
    searchSanitizedGitHubSkills: async () => { throw new Error("not called"); },
    searchOriginalGitHubSkills: async () => { throw new Error("not called"); },
    revokeOriginalSearchConsent: async () => {},
  });
  const deferredDisposals = [];
  const lifecycle = createTaskMatcherLifecycle(
    controller,
    () => {},
    (callback) => deferredDisposals.push(callback),
  );
  const cleanup = lifecycle.mount();
  await Promise.resolve();
  cleanup();
  deferredDisposals.shift()();
  assert.equal(statusSignal.aborted, true);
  status.resolve({
    state: "invalid-token",
    checkedAt: "2026-08-19T03:00:00.000Z",
    rateLimits: { search: null, codeSearch: null },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(controller.getState().githubStatus, null);
});

test("real unmount disposes the controller and revokes a live grant", async () => {
  const revoked = [];
  const controller = createTaskSearchController({
    getGitHubStatus: async () => ({
      state: "ready",
      checkedAt: "2026-08-19T01:02:03.000Z",
      rateLimits: { search: null, codeSearch: null },
    }),
    recommendTask: async () => ({
      localMatchLevel: "none",
      results: [],
      githubSearch: null,
      githubStatus: {
        state: "ready",
        checkedAt: "2026-08-19T01:02:03.000Z",
        rateLimits: { search: null, codeSearch: null },
      },
      rawConsent: { token: "opaque-consent-token", expiresAt: "2026-08-19T02:00:00.000Z" },
    }),
    searchSanitizedGitHubSkills: async () => { throw new Error("not called"); },
    searchOriginalGitHubSkills: async () => { throw new Error("not called"); },
    revokeOriginalSearchConsent: async (token) => { revoked.push(token); },
  });
  const deferredDisposals = [];
  const lifecycle = createTaskMatcherLifecycle(
    controller,
    () => {},
    (callback) => deferredDisposals.push(callback),
  );
  const cleanup = lifecycle.mount();
  await Promise.resolve();
  controller.changeQuery("没有脱敏预览的任务");
  await controller.submit();
  assert.equal(controller.getState().phase, "raw-consent");

  cleanup();
  deferredDisposals.shift()();
  await Promise.resolve();
  assert.deepEqual(revoked, ["opaque-consent-token"]);
});
