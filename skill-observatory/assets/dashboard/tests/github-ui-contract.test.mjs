import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const matcherUrl = new URL("../app/components/TaskMatcher.tsx", import.meta.url);
const apiUrl = new URL("../app/lib/api.ts", import.meta.url);
const catalogUrl = new URL("../app/lib/catalog.ts", import.meta.url);
const controllerUrl = new URL("../app/lib/task-search-controller.ts", import.meta.url);
const stylesUrl = new URL("../app/globals.css", import.meta.url);
const diagnosticsUrl = new URL("../app/lib/task-search-diagnostics.ts", import.meta.url);

async function source(url) {
  return readFile(url, "utf8");
}

function githubStatus(state = "ready", overrides = {}) {
  return {
    state,
    checkedAt: "2026-08-19T01:02:03.000Z",
    rateLimits: { search: null, codeSearch: null },
    ...overrides,
  };
}

function githubDiagnostics(overrides = {}) {
  return {
    stageReached: "complete",
    repositoryHits: 0,
    codeHits: 0,
    validatedCandidates: 0,
    rejectedCandidates: 0,
    deduplicatedCandidates: 0,
    rejectionCounts: [],
    cached: false,
    incomplete: false,
    rateLimits: { search: null, codeSearch: null },
    ...overrides,
  };
}

test("Task Matcher uses the executable search controller and disables submit for every remote phase", async () => {
  const [file, diagnostics] = await Promise.all([source(matcherUrl), source(diagnosticsUrl)]);
  assert.match(file, /createTaskSearchController\(\{/);
  assert.match(file, /getGitHubStatus,/);
  assert.match(file, /createTaskMatcherLifecycle\(controller, setState\)/);
  assert.match(diagnostics, /controller\.subscribe\(onState\)/);
  assert.match(file, /lifecycle\.mount\(\)/);
  assert.match(file, /void controller\.submit\(\)/);
  assert.match(file, /const submitBlocked = isSearching \|\| phase === "raw-revoke-error"/);
  assert.match(file, /disabled=\{submitBlocked \|\| !query\.trim\(\)\}/);
  assert.match(file, /aria-busy=\{isSearching\}/);
  assert.match(file, /正在执行 GitHub 混合搜索/);
  assert.doesNotMatch(file, />在 GitHub 查找</);
});

test("Task Matcher renders distinct GitHub availability states and truthful hybrid progress", async () => {
  const file = await source(matcherUrl);
  for (const copy of [
    "未配置 GitHub Token，仅显示本机匹配。",
    "GitHub Token 无效，仅显示本机匹配。",
    "GitHub 搜索已限流，仅显示本机匹配。",
    "GitHub 暂时不可用，仅显示本机匹配。",
  ]) {
    assert.match(file, new RegExp(copy));
  }
  assert.match(file, /正在执行 GitHub 混合搜索：先搜索仓库，结果不足时继续检索 SKILL\.md。/);
  assert.match(file, /已生成但未发送的脱敏能力词/);
  assert.match(file, /未开始 GitHub 搜索/);
  assert.match(file, /githubDiagnostics\.stageReached/);
  for (const count of [
    "repositoryHits",
    "codeHits",
    "validatedCandidates",
    "rejectedCandidates",
    "deduplicatedCandidates",
  ]) {
    assert.match(file, new RegExp(`githubDiagnostics\\.${count}`));
  }
});

test("diagnostics stay keyboard-native and clipboard records are created only by an explicit click", async () => {
  const [matcher, diagnostics, styles] = await Promise.all([
    source(matcherUrl),
    source(diagnosticsUrl),
    source(stylesUrl),
  ]);
  assert.match(matcher, /<details className="search-diagnostics">/);
  assert.match(matcher, /<summary>搜索诊断<\/summary>/);
  assert.match(matcher, /async function copyTestRecord\(\)/);
  assert.match(matcher, /await copyTaskSearchTestRecord\(copiedState, navigator\.clipboard\)/);
  assert.match(diagnostics, /const record = buildTaskSearchTestRecord\(state\);/);
  assert.match(diagnostics, /await writeText\.call\(clipboard, record\)/);
  assert.match(matcher, /测试记录已复制。/);
  assert.match(matcher, /无法复制测试记录，请检查浏览器剪贴板权限。/);
  assert.match(matcher, /copyResult\?\.state === state/);
  assert.match(matcher, /setCopyResult\(\{ state: copiedState, status \}\)/);
  assert.match(matcher, /generation !== copyGeneration\.current/);
  assert.doesNotMatch(matcher, /useEffect\(\(\) => \{\s*setCopy/s);
  assert.match(matcher, /sentSanitizedTerms\.join\(" · "\) \|\| "无"/);
  assert.doesNotMatch(matcher, /sanitizedTerms\.join\(" · "\) \|\| "无"/);
  assert.doesNotMatch(matcher, /useMemo\([^)]*buildTaskSearchTestRecord|console\.(?:log|info|debug|warn|error)/s);
  assert.doesNotMatch(diagnostics, /\.\.\.state|\.\.\.state\.error|JSON\.stringify\(state/);
  assert.match(styles, /\.diagnostic-copy-button \{[^}]*min-height: 44px/s);
  assert.match(styles, /\.search-diagnostics > summary \{[^}]*min-height: 44px/s);
  assert.match(styles, /summary:focus-visible/);
  assert.match(styles, /\.search-diagnostics \{[^}]*min-width: 0/s);
  assert.match(styles, /\.diagnostic-value \{[^}]*overflow-wrap: anywhere/s);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.diagnostic-grid \{ grid-template-columns: 1fr; \}/s);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.diagnostic-copy-row \{[^}]*flex-direction: column/s);
});

test("original search requires the displayed full task and a consent click", async () => {
  const file = await source(matcherUrl);
  assert.match(file, /即将发送到 GitHub 搜索的完整内容/);
  assert.match(file, /value=\{submittedQuery\}/);
  assert.match(file, /确认发送原文到 GitHub/);
  assert.match(file, /原文可能包含名称、项目或业务信息/);
  assert.match(file, /本次内容不会写入本机搜索缓存或日志/);
  assert.match(file, /aria-label="将发送的原始任务全文"/);
  assert.match(file, /授权短时有效/);
  assert.match(file, /controller\.confirmOriginalSearch\(\)/);
  assert.match(file, /controller\.cancelOriginalSearch\(\)/);
  assert.doesNotMatch(file, /localStorage|sessionStorage|indexedDB|URLSearchParams|sendBeacon|analytics/i);
  assert.doesNotMatch(file, /console\.(?:log|info|debug|warn|error)/);
  assert.doesNotMatch(file, /caught|\.message/);
});

test("raw-searching uses confirmed sending copy while preserving the protected full-text panel", async () => {
  const file = await source(matcherUrl);
  assert.match(
    file,
    /phase === "raw-searching" \? \(\s*<p className="empty-inline raw-consent-intro">\s*已确认发送原始任务全文，正在等待 GitHub 搜索结果。/s,
  );
  assert.match(
    file,
    /phase === "raw-searching"\s*\? "已确认发送到 GitHub 搜索的完整内容"\s*: "即将发送到 GitHub 搜索的完整内容"/s,
  );
  assert.match(file, /value=\{submittedQuery\}/);
  assert.match(file, /本次内容不会写入本机搜索缓存或日志/);
  assert.match(file, /aria-busy=\{phase === "raw-searching"\}/);
  assert.match(file, /disabled=\{phase === "raw-searching"\}/);
});

test("revocation UI distinguishes pending, confirmed, and retryable failure states", async () => {
  const [matcher, controller, styles] = await Promise.all([
    source(matcherUrl),
    source(controllerUrl),
    source(stylesUrl),
  ]);
  assert.match(controller, /"raw-revoking"/);
  assert.match(controller, /"raw-revoke-error"/);
  assert.match(matcher, /正在撤销授权…/);
  assert.match(matcher, /已取消，原始任务未发送/);
  assert.match(matcher, /未能确认撤销，请重试取消或等待授权自动失效/);
  assert.match(matcher, /aria-live="polite"/);
  assert.match(matcher, /aria-busy={phase === "raw-revoking"}/);
  assert.match(matcher, /void controller\.cancelOriginalSearch\(\)/);
  assert.match(styles, /\.raw-revoke-actions button \{[^}]*min-height: 44px/s);
  assert.doesNotMatch(matcher, /rawConsent\.token|consentToken/);
});

test("sanitized zero and missing-preview states explain why raw consent is offered", async () => {
  const file = await source(matcherUrl);
  assert.match(file, /GitHub 上没有找到经过验证的相关 Skill。你可以选择发送下面的原始任务，再搜索一次。/);
  assert.match(file, /无法生成安全能力词，尚未向 GitHub 发送脱敏查询。/);
  assert.match(file, /已保留以下本机可能相关的 Skill，正在使用脱敏能力词搜索 GitHub。/);
  assert.match(file, /未生成可安全发送的能力词，尚未向 GitHub 发送查询；是否发送原始任务全文由你确认。/);
  assert.doesNotMatch(file, /以下本机 Skill 可能相关；看台将继续搜索 GitHub。/);
  assert.match(file, /只发送任务能力词，不发送未识别的名称或项目内容。/);
});

test("incomplete and failed sanitized searches cannot expose raw consent", async () => {
  const file = await source(matcherUrl);
  assert.match(file, /GitHub 返回的结果不完整，未启用原文搜索。/);
  assert.match(file, /重试脱敏搜索/);
  assert.match(file, /已发送原文，但仍没有找到经过验证的相关 Skill。/);
  assert.match(file, /originalOutcome === "empty"/);
  assert.match(file, /originalOutcome === "incomplete"/);
});

test("GitHub results are capped and show repository metadata without installation controls", async () => {
  const matcher = await source(matcherUrl);
  const controller = await source(controllerUrl);
  const file = `${matcher}\n${controller}`;
  assert.match(controller, /\.slice\(0, 3\)/);
  assert.match(matcher, /githubResults\.slice\(0, 3\)\.map/);
  assert.doesNotMatch(matcher, /githubResults\.(?:sort|toSorted)\(/);
  for (const field of ["repository", "skillDirectory", "pushedAt", "license", "stars"]) {
    assert.match(file, new RegExp(`result\\.${field}`));
  }
  assert.match(file, /aria-label=\{`仓库 Star/);
  assert.match(file, /target="_blank"/);
  assert.match(file, /rel="noreferrer"/);
  assert.match(file, /result\.license\?\.trim\(\) \|\| "未标注"/);
  assert.match(matcher, /Skill 路径/);
  assert.match(matcher, /formatSkillPath\(result\.skillDirectory\)/);
  assert.match(matcher, /以下本机 Skill 可能相关/);
  assert.match(matcher, /GitHub 推荐（按仓库 Stars 排序）/);
  assert.match(matcher, /仓库 Stars 只代表关注度/);
  assert.doesNotMatch(matcher, /results\?\.length === 0 && githubResults/);
  assert.doesNotMatch(file, /installSkill|\/api\/install|自动安装|立即安装|安装按钮/);
});

test("response types expose nullable previews and transient raw consent", async () => {
  const file = await source(catalogUrl);
  assert.match(file, /export type LocalMatchLevel = "strong" \| "weak" \| "none";/);
  assert.match(file, /localMatchLevel: LocalMatchLevel;/);
  assert.match(file, /export interface RawSearchConsent/);
  assert.match(file, /token: string;/);
  assert.match(file, /expiresAt: string;/);
  assert.match(file, /rawConsent: RawSearchConsent \| null;/);
  assert.match(file, /preview: GitHubSearchPreview \| null;/);
  assert.match(file, /export type GitHubServiceState/);
  assert.match(file, /export type GitHubSearchStage/);
  assert.match(file, /export type GitHubRejectionReason/);
  assert.match(file, /export interface GitHubRateLimits/);
  assert.match(file, /export interface GitHubSearchDiagnostics/);
  assert.match(file, /githubStatus: GitHubServiceStatus \| null;/);
  assert.match(file, /diagnostics: GitHubSearchDiagnostics;/);
  assert.match(
    file,
    /rateLimit: \{ remaining: number \| null; reset: number \| null; retryAt: string \| null \} \| null;/,
  );
  assert.doesNotMatch(file, /resetAt/);
});

test("consent controls and full-text view are keyboard accessible", async () => {
  const file = await source(stylesUrl);
  const rawQueryStart = file.indexOf(".raw-query {");
  assert.notEqual(rawQueryStart, -1);
  const rawQueryRule = file.slice(rawQueryStart, file.indexOf("}", rawQueryStart) + 1);
  assert.match(rawQueryRule, /white-space: pre-wrap/);
  assert.match(rawQueryRule, /overflow-wrap: anywhere/);
  assert.match(rawQueryRule, /max-height:/);
  assert.match(rawQueryRule, /overflow-y: auto/);
  const actionsStart = file.indexOf(".raw-consent-actions button {");
  assert.notEqual(actionsStart, -1);
  const actionsRule = file.slice(actionsStart, file.indexOf("}", actionsStart) + 1);
  assert.match(actionsRule, /min-height: 44px/);
  assert.match(file, /\.raw-query:focus-visible/);
  assert.match(file, /\.raw-consent-actions \{[^}]*flex-direction: column/s);
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

test("local result cards contain long unbroken names and reasons without horizontal overflow", async () => {
  const [matcher, styles] = await Promise.all([source(matcherUrl), source(stylesUrl)]);
  assert.match(matcher, /className="match-result-title"/);
  assert.match(matcher, /<strong>\{result\.name\}<\/strong>/);
  assert.match(matcher, /<p>\{result\.reasonZh\}<\/p>/);
  assert.match(styles, /\.match-result > div \{[^}]*min-width: 0[^}]*\}/s);
  assert.match(styles, /\.match-result strong,[\s\S]*\.match-result p \{[^}]*overflow-wrap: anywhere[^}]*\}/s);
  assert.match(styles, /\.match-result \{[^}]*grid-template-columns: 30px minmax\(0, 1fr\) auto/s);
});

test("browser API uses exact methods and bodies for the five loopback endpoints", async (context) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/api/recommend")) {
      return Response.json({
        localMatchLevel: "none",
        results: [],
        githubSearch: { terms: ["data validation", "testing", "skill"], label: "data validation · testing · skill" },
        githubStatus: githubStatus(),
        rawConsent: null,
      });
    }
    if (String(url).endsWith("/api/github-status")) {
      return Response.json(githubStatus());
    }
    if (String(url).endsWith("/api/github-suggestions")) {
      return Response.json({
        preview: { terms: ["data validation", "testing", "skill"], label: "data validation · testing · skill" },
        results: [],
        cached: false,
        incomplete: false,
        rawConsent: { token: "opaque-consent-token", expiresAt: "2026-08-16T00:05:00.000Z" },
        rateLimit: null,
        diagnostics: githubDiagnostics(),
      });
    }
    if (String(url).endsWith("/api/github-suggestions/revoke")) {
      return new Response(null, { status: 204 });
    }
    return Response.json({
      preview: null,
      results: [],
      cached: false,
      incomplete: false,
      rawConsent: null,
      rateLimit: null,
      diagnostics: githubDiagnostics(),
    });
  };
  context.after(() => { globalThis.fetch = originalFetch; });

  const {
    recommendTask,
    getGitHubStatus,
    revokeOriginalSearchConsent,
    searchOriginalGitHubSkills,
    searchSanitizedGitHubSkills,
  } = await import(apiUrl);
  const controller = new AbortController();
  const local = await recommendTask("检测数据", controller.signal);
  assert.equal(local.localMatchLevel, "none");
  assert.equal(local.githubSearch.label, "data validation · testing · skill");
  assert.equal((await getGitHubStatus(controller.signal)).state, "ready");
  const sanitized = await searchSanitizedGitHubSkills("检测数据", controller.signal);
  assert.equal(sanitized.rawConsent.token, "opaque-consent-token");
  const original = await searchOriginalGitHubSkills("检测数据", "opaque-consent-token", controller.signal);
  assert.equal(original.preview, null);
  await revokeOriginalSearchConsent("opaque-consent-token");

  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:4318/api/recommend",
    "http://127.0.0.1:4318/api/github-status",
    "http://127.0.0.1:4318/api/github-suggestions",
    "http://127.0.0.1:4318/api/github-suggestions/original",
    "http://127.0.0.1:4318/api/github-suggestions/revoke",
  ]);
  assert.deepEqual(calls.map((call) => call.options.body === undefined ? undefined : JSON.parse(call.options.body)), [
    { query: "检测数据" },
    undefined,
    { query: "检测数据" },
    { query: "检测数据", consentToken: "opaque-consent-token" },
    { consentToken: "opaque-consent-token" },
  ]);
  assert.deepEqual(calls.map((call) => call.options.method), ["POST", "GET", "POST", "POST", "POST"]);
  assert.ok(calls.slice(0, 4).every((call) => call.options.signal === controller.signal));
  assert.equal(calls[4].options.signal, undefined);
  assert.equal(calls[4].options.keepalive, true);
});

test("browser consent revocation fails with fixed safe errors", async (context) => {
  const originalFetch = globalThis.fetch;
  const sentinel = "private-revoke-error-sentinel";
  const { revokeOriginalSearchConsent } = await import(apiUrl);
  context.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async () => { throw new Error(sentinel); };
  await assert.rejects(
    revokeOriginalSearchConsent("opaque-consent-token"),
    (error) => error.code === "local-service-unavailable" && !error.message.includes(sentinel),
  );

  let parsed = false;
  globalThis.fetch = async () => ({
    ok: false,
    status: 502,
    json: async () => {
      parsed = true;
      return { secret: sentinel };
    },
  });
  await assert.rejects(
    revokeOriginalSearchConsent("opaque-consent-token"),
    (error) => error.code === "local-service-unavailable" && !error.message.includes(sentinel),
  );
  assert.equal(parsed, false);
});

test("browser consent parsing and revocation share one token syntax", async (context) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const { recommendTask, revokeOriginalSearchConsent } = await import(apiUrl);
  context.after(() => { globalThis.fetch = originalFetch; });

  for (const token of ["invalid:token:value", "x".repeat(513)]) {
    globalThis.fetch = async (...args) => {
      calls.push(args);
      return Response.json({
        localMatchLevel: "none",
        results: [],
        githubSearch: null,
        githubStatus: githubStatus(),
        rawConsent: { token, expiresAt: "2026-08-16T00:05:00.000Z" },
      });
    };
    await assert.rejects(
      recommendTask("检测数据"),
      (error) => error.code === "local-response-invalid",
    );
    const callsBeforeRevoke = calls.length;
    await assert.rejects(
      revokeOriginalSearchConsent(token),
      (error) => error.code === "local-service-unavailable",
    );
    assert.equal(calls.length, callsBeforeRevoke);
  }
});

test("browser API accepts consistent local levels and rejects unsafe or contradictory envelopes", async (context) => {
  const originalFetch = globalThis.fetch;
  const { recommendTask } = await import(apiUrl);
  context.after(() => { globalThis.fetch = originalFetch; });

  const card = {
    skillId: "local-skill",
    name: "local-skill",
    summaryZh: "本地技能",
    status: "ready",
    score: 18,
    reasonCodes: ["fuzzy-name"],
    reasonZh: "名称相近",
  };
  const response = (value) => ({
    ok: true,
    status: 200,
    json: async () => value,
  });
  const validConsent = {
    token: "valid-local-consent-token",
    expiresAt: "2026-08-16T00:05:00.000Z",
  };
  const validPreview = { terms: ["analysis", "skill"], label: "analysis · skill" };
  const accepted = [
    {
      localMatchLevel: "strong",
      results: [card],
      githubSearch: null,
      githubStatus: null,
      rawConsent: null,
    },
    {
      localMatchLevel: "weak",
      results: [card],
      githubSearch: validPreview,
      githubStatus: githubStatus(),
      rawConsent: null,
    },
    {
      localMatchLevel: "weak",
      results: [card],
      githubSearch: null,
      githubStatus: githubStatus(),
      rawConsent: validConsent,
    },
    {
      localMatchLevel: "none",
      results: [],
      githubSearch: validPreview,
      githubStatus: githubStatus(),
      rawConsent: null,
    },
    {
      localMatchLevel: "none",
      results: [],
      githubSearch: null,
      githubStatus: githubStatus(),
      rawConsent: validConsent,
    },
  ];
  for (const fixture of accepted) {
    globalThis.fetch = async () => response(fixture);
    const result = await recommendTask("分析任务");
    assert.equal(result.localMatchLevel, fixture.localMatchLevel);
    assert.equal(result.results.length, fixture.results.length);
  }

  let accessorCalls = 0;
  const accessor = {
    results: [],
    githubSearch: null,
    githubStatus: githubStatus(),
    rawConsent: null,
  };
  Object.defineProperty(accessor, "localMatchLevel", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return "private-level-sentinel";
    },
  });
  const inherited = Object.create({ localMatchLevel: "none" });
  Object.assign(inherited, {
    results: [],
    githubSearch: null,
    githubStatus: githubStatus(),
    rawConsent: null,
  });
  const invalid = [
    { results: [], githubSearch: null, rawConsent: null },
    inherited,
    accessor,
    new Proxy({
      localMatchLevel: "none",
      results: [],
      githubSearch: null,
      githubStatus: githubStatus(),
      rawConsent: null,
    }, {}),
    { localMatchLevel: "none", results: [card], githubSearch: null, githubStatus: githubStatus(), rawConsent: null },
    { localMatchLevel: "weak", results: [], githubSearch: null, githubStatus: githubStatus(), rawConsent: null },
    { localMatchLevel: "strong", results: [], githubSearch: null, githubStatus: null, rawConsent: null },
    { localMatchLevel: "strong", results: [card], githubSearch: validPreview, githubStatus: null, rawConsent: null },
    { localMatchLevel: "strong", results: [card], githubSearch: null, githubStatus: null, rawConsent: validConsent },
    { localMatchLevel: "strong", results: [card], githubSearch: null, githubStatus: githubStatus(), rawConsent: null },
    { localMatchLevel: "weak", results: [card], githubSearch: null, githubStatus: githubStatus(), rawConsent: null },
    {
      localMatchLevel: "weak",
      results: [card],
      githubSearch: validPreview,
      githubStatus: githubStatus(),
      rawConsent: validConsent,
    },
    { localMatchLevel: "none", results: [], githubSearch: null, githubStatus: githubStatus(), rawConsent: null },
    {
      localMatchLevel: "none",
      results: [],
      githubSearch: validPreview,
      githubStatus: githubStatus(),
      rawConsent: validConsent,
    },
  ];
  for (const fixture of invalid) {
    globalThis.fetch = async () => response(fixture);
    await assert.rejects(
      recommendTask("分析任务"),
      (error) => error.code === "local-response-invalid" &&
        !error.message.includes("private-level-sentinel"),
    );
  }
  assert.equal(accessorCalls, 0);
});

test("browser API rejects extra own fields at every local response layer", async (context) => {
  const originalFetch = globalThis.fetch;
  const { recommendTask } = await import(apiUrl);
  context.after(() => { globalThis.fetch = originalFetch; });

  const sentinel = "private-extra-local-field";
  const card = {
    skillId: "local-skill",
    name: "local-skill",
    summaryZh: "本地技能",
    status: "ready",
    score: 18,
    reasonCodes: ["fuzzy-name"],
    reasonZh: "名称相近",
  };
  const preview = { terms: ["analysis", "skill"], label: "analysis · skill" };
  const consent = {
    token: "valid-extra-field-consent",
    expiresAt: "2026-08-16T00:05:00.000Z",
  };
  const base = {
    localMatchLevel: "weak",
    results: [card],
    githubSearch: preview,
    githubStatus: githubStatus(),
    rawConsent: null,
  };
  const fixtures = [
    { ...base, extra: sentinel },
    { ...base, results: [{ ...card, extra: sentinel }] },
    { ...base, githubSearch: { ...preview, extra: sentinel } },
    { ...base, githubStatus: { ...githubStatus(), extra: sentinel } },
    {
      ...base,
      githubSearch: null,
      rawConsent: { ...consent, extra: sentinel },
    },
  ];

  for (const fixture of fixtures) {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => fixture,
    });
    await assert.rejects(
      recommendTask("分析任务"),
      (error) => error.code === "local-response-invalid" && !error.message.includes(sentinel),
    );
  }
});

test("browser GitHub status accepts only exact safe data and returns fresh clones", async (context) => {
  const originalFetch = globalThis.fetch;
  const { getGitHubStatus } = await import(apiUrl);
  context.after(() => { globalThis.fetch = originalFetch; });

  const valid = githubStatus("ready", {
    rateLimits: {
      search: { remaining: 12, reset: 1_780_000_000, retryAt: "2026-05-27T04:26:40.000Z" },
      codeSearch: { remaining: 0, reset: 1_780_000_060, retryAt: "2026-05-27T04:27:40.000Z" },
    },
  });
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => valid });
  const cloned = await getGitHubStatus();
  assert.deepEqual(cloned, valid);
  assert.notEqual(cloned, valid);
  assert.notEqual(cloned.rateLimits, valid.rateLimits);
  assert.notEqual(cloned.rateLimits.search, valid.rateLimits.search);
  valid.rateLimits.search.remaining = 999;
  assert.equal(cloned.rateLimits.search.remaining, 12);

  let accessorCalls = 0;
  const accessor = githubStatus();
  Object.defineProperty(accessor, "state", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return "ready";
    },
  });
  const withSymbol = githubStatus();
  withSymbol[Symbol("private-status")] = "private-status-sentinel";
  const nestedAccessor = githubStatus();
  Object.defineProperty(nestedAccessor.rateLimits, "search", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return null;
    },
  });
  const invalid = [
    { ...githubStatus(), extra: "private-status-sentinel" },
    githubStatus("unknown"),
    githubStatus("ready", { checkedAt: "2026-08-19T01:02:03Z" }),
    githubStatus("ready", { checkedAt: "not-a-time" }),
    githubStatus("ready", { rateLimits: { search: null, codeSearch: null, extra: true } }),
    githubStatus("ready", {
      rateLimits: {
        search: { remaining: 1, reset: 2, retryAt: null, extra: true },
        codeSearch: null,
      },
    }),
    githubStatus("ready", {
      rateLimits: { search: { remaining: -1, reset: 2, retryAt: null }, codeSearch: null },
    }),
    githubStatus("ready", {
      rateLimits: { search: { remaining: 1.5, reset: 2, retryAt: null }, codeSearch: null },
    }),
    githubStatus("ready", {
      rateLimits: { search: { remaining: 0, reset: 2, retryAt: null }, codeSearch: null },
    }),
    githubStatus("ready", {
      rateLimits: { search: { remaining: 1, reset: 2, retryAt: "not-a-time" }, codeSearch: null },
    }),
    githubStatus("missing-token", {
      rateLimits: { search: { remaining: 1, reset: 2, retryAt: null }, codeSearch: null },
    }),
    accessor,
    nestedAccessor,
    withSymbol,
    new Proxy(githubStatus(), {}),
    githubStatus("ready", { rateLimits: new Proxy({ search: null, codeSearch: null }, {}) }),
    Object.assign(Object.create({ inherited: true }), githubStatus()),
  ];
  for (const fixture of invalid) {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => fixture });
    await assert.rejects(
      getGitHubStatus(),
      (error) => error.code === "local-response-invalid" &&
        !error.message.includes("private-status-sentinel"),
    );
  }
  assert.equal(accessorCalls, 0);
});

test("browser GitHub diagnostics reject malformed snapshots and clone every nested value", async (context) => {
  const originalFetch = globalThis.fetch;
  const { searchSanitizedGitHubSkills } = await import(apiUrl);
  context.after(() => { globalThis.fetch = originalFetch; });

  const diagnostics = githubDiagnostics({
    repositoryHits: 5,
    codeHits: 2,
    validatedCandidates: 1,
    rejectedCandidates: 3,
    deduplicatedCandidates: 1,
    rejectionCounts: [
      { reason: "invalid-content", count: 2 },
      { reason: "duplicate", count: 1 },
    ],
    rateLimits: {
      search: { remaining: 11, reset: 1_780_000_000, retryAt: "2026-05-27T04:26:40.000Z" },
      codeSearch: null,
    },
  });
  const response = {
    preview: { terms: ["news"], label: "news" },
    results: [{
      repository: "owner/repo",
      repositoryUrl: "https://github.com/owner/repo",
      skillDirectory: "skills/example",
      name: "example",
      summary: "summary",
      reasonZh: "reason",
      stars: 1,
      pushedAt: "2026-08-16T00:00:00.000Z",
      license: null,
    }],
    cached: false,
    incomplete: false,
    rawConsent: null,
    rateLimit: null,
    diagnostics,
  };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => response });
  const cloned = await searchSanitizedGitHubSkills("news");
  assert.deepEqual(cloned.diagnostics, diagnostics);
  assert.notEqual(cloned.diagnostics, diagnostics);
  assert.notEqual(cloned.diagnostics.rejectionCounts, diagnostics.rejectionCounts);
  assert.notEqual(cloned.diagnostics.rejectionCounts[0], diagnostics.rejectionCounts[0]);
  assert.notEqual(cloned.diagnostics.rateLimits, diagnostics.rateLimits);
  diagnostics.rejectionCounts[0].count = 99;
  diagnostics.rateLimits.search.remaining = 99;
  assert.equal(cloned.diagnostics.rejectionCounts[0].count, 2);
  assert.equal(cloned.diagnostics.rateLimits.search.remaining, 11);

  const invalidDiagnostics = [
    { ...githubDiagnostics(), extra: true },
    githubDiagnostics({ stageReached: "private-stage" }),
    githubDiagnostics({ repositoryHits: -1 }),
    githubDiagnostics({ codeHits: 1.5 }),
    githubDiagnostics({ validatedCandidates: Number.MAX_SAFE_INTEGER + 1 }),
    githubDiagnostics({
      rejectedCandidates: 1,
      rejectionCounts: [{ reason: "private-reason", count: 1 }],
    }),
    githubDiagnostics({
      rejectedCandidates: 1,
      rejectionCounts: [{ reason: "irrelevant", count: 0 }],
    }),
    githubDiagnostics({
      rejectedCandidates: 2,
      rejectionCounts: [{ reason: "irrelevant", count: 1 }],
    }),
    githubDiagnostics({
      rejectedCandidates: 1,
      deduplicatedCandidates: 1,
      rejectionCounts: [{ reason: "irrelevant", count: 1 }],
    }),
    githubDiagnostics({ incomplete: true, stageReached: "complete" }),
    githubDiagnostics({ incomplete: false, stageReached: "code-search" }),
    githubDiagnostics({ cached: true }),
    githubDiagnostics({
      rateLimits: {
        search: { remaining: 1, reset: 2, retryAt: "not-a-time" },
        codeSearch: null,
      },
    }),
    githubDiagnostics({ rateLimits: { search: null, codeSearch: null, extra: true } }),
  ];
  const withSymbol = githubDiagnostics();
  withSymbol.rejectionCounts[Symbol("private-diagnostics")] = true;
  const rootSymbol = githubDiagnostics();
  rootSymbol[Symbol("private-diagnostics-root")] = true;
  let accessorCalls = 0;
  const nestedAccessor = githubDiagnostics();
  Object.defineProperty(nestedAccessor.rateLimits, "search", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return null;
    },
  });
  invalidDiagnostics.push(
    withSymbol,
    rootSymbol,
    nestedAccessor,
    new Proxy(githubDiagnostics(), {}),
    githubDiagnostics({ rateLimits: new Proxy({ search: null, codeSearch: null }, {}) }),
  );

  for (const fixture of invalidDiagnostics) {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ...response, diagnostics: fixture }),
    });
    await assert.rejects(
      searchSanitizedGitHubSkills("news"),
      (error) => error.code === "github-response-invalid",
    );
  }
  assert.equal(accessorCalls, 0);
});

test("browser API keeps GitHub credentials and remote error details out of the client", async (context) => {
  const [apiFile, matcherFile] = await Promise.all([source(apiUrl), source(matcherUrl)]);
  assert.match(apiFile, /const API_BASE = "http:\/\/127\.0\.0\.1:4318"/);
  assert.doesNotMatch(`${apiFile}\n${matcherFile}`, /api\.github\.com|GITHUB_TOKEN|Authorization|Bearer/);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    error: "github-network-failed",
    message: "remote-secret-must-not-appear",
    consentToken: "server-token-must-not-appear",
  }, { status: 502 });
  context.after(() => { globalThis.fetch = originalFetch; });
  const { searchSanitizedGitHubSkills } = await import(apiUrl);
  await assert.rejects(
    searchSanitizedGitHubSkills("news"),
    (error) => error.code === "github-network-failed" &&
      !error.message.includes("secret") && !error.message.includes("token"),
  );
});

test("browser API forwards cancellation to an in-flight sanitized request", async (context) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      reject(new DOMException("request cancelled", "AbortError"));
    }, { once: true });
  });
  context.after(() => { globalThis.fetch = originalFetch; });
  const { searchSanitizedGitHubSkills } = await import(apiUrl);
  const controller = new AbortController();
  const request = searchSanitizedGitHubSkills("news", controller.signal);
  controller.abort();
  await assert.rejects(request, (error) => error.name === "AbortError");
});

test("browser API fails closed for fetch, JSON, and malformed-success failures", async (context) => {
  const originalFetch = globalThis.fetch;
  const { searchOriginalGitHubSkills, searchSanitizedGitHubSkills } = await import(apiUrl);
  const sentinel = "private-browser-error-sentinel";
  context.after(() => { globalThis.fetch = originalFetch; });

  const fixtures = [
    {
      fetchImpl: async () => { throw new Error(sentinel); },
      call: () => searchSanitizedGitHubSkills("news"),
      code: "github-network-failed",
    },
    {
      fetchImpl: async () => ({
        ok: true,
        json: async () => { throw new Error(sentinel); },
      }),
      call: () => searchOriginalGitHubSkills("原文", "opaque-consent-token"),
      code: "github-response-invalid",
    },
    {
      fetchImpl: async () => Response.json({
        results: [],
        sentinel,
      }),
      call: () => searchSanitizedGitHubSkills("news"),
      code: "github-response-invalid",
    },
  ];

  for (const fixture of fixtures) {
    globalThis.fetch = fixture.fetchImpl;
    await assert.rejects(
      fixture.call,
      (error) => error.code === fixture.code && !error.message.includes(sentinel),
    );
  }

  const abortError = new DOMException(sentinel, "AbortError");
  globalThis.fetch = async () => { throw abortError; };
  await assert.rejects(
    searchSanitizedGitHubSkills("news"),
    (error) => error === abortError,
  );
});

test("browser API rejects GitHub cards whose repository identity and URL are not exact", async (context) => {
  const originalFetch = globalThis.fetch;
  const { searchSanitizedGitHubSkills } = await import(apiUrl);
  context.after(() => { globalThis.fetch = originalFetch; });

  const baseCard = {
    repository: "owner/repo",
    repositoryUrl: "https://github.com/owner/repo",
    skillDirectory: "skills/example",
    name: "example",
    summary: "summary",
    reasonZh: "reason",
    stars: 1,
    pushedAt: "2026-08-16T00:00:00.000Z",
    license: null,
  };
  const responseFor = (card) => Response.json({
    preview: null,
    results: [card],
    cached: false,
    incomplete: false,
    rawConsent: null,
    rateLimit: null,
    diagnostics: githubDiagnostics({ validatedCandidates: 1 }),
  });
  globalThis.fetch = async () => responseFor(baseCard);
  const accepted = await searchSanitizedGitHubSkills("news");
  assert.equal(accepted.results[0].repositoryUrl, baseCard.repositoryUrl);

  const unsafeCards = [
    { repository: "owner/repo", repositoryUrl: "https://evil.example/owner/repo" },
    { repository: "owner/repo", repositoryUrl: "data:text/html,unsafe" },
    { repository: "owner/repo/extra", repositoryUrl: "https://github.com/owner/repo/extra" },
    { repository: "../repo", repositoryUrl: "https://github.com/../repo" },
  ];

  for (const unsafe of unsafeCards) {
    globalThis.fetch = async () => responseFor({ ...baseCard, ...unsafe });
    await assert.rejects(
      searchSanitizedGitHubSkills("news"),
      (error) => error.code === "github-response-invalid" &&
        !error.message.includes(unsafe.repositoryUrl),
    );
  }
});

test("browser API rejects extra and unsafe GitHub response fields without leaking values", async (context) => {
  const originalFetch = globalThis.fetch;
  const { searchSanitizedGitHubSkills } = await import(apiUrl);
  const sentinel = "private-browser-github-sentinel";
  context.after(() => { globalThis.fetch = originalFetch; });

  const card = {
    repository: "owner/repo",
    repositoryUrl: "https://github.com/owner/repo",
    skillDirectory: "skills/example",
    name: "example",
    summary: "summary",
    reasonZh: "reason",
    stars: 1,
    pushedAt: "2026-08-16T00:00:00.000Z",
    license: null,
  };
  const response = {
    preview: { terms: ["news"], label: "news" },
    results: [card],
    cached: false,
    incomplete: false,
    rawConsent: null,
    rateLimit: { remaining: 10, reset: 20, retryAt: null },
    diagnostics: githubDiagnostics(),
  };
  const accessorResponse = { ...response };
  Object.defineProperty(accessorResponse, "cached", {
    enumerable: true,
    get() {
      throw new Error(sentinel);
    },
  });
  const inheritedResponse = Object.assign(Object.create({ privatePath: sentinel }), response);
  const proxyResponse = new Proxy(response, {});
  const fixtures = [
    { ...response, privatePath: sentinel },
    { ...response, results: [{ ...card, privatePath: sentinel }] },
    {
      ...response,
      rateLimit: { remaining: 10, reset: 20, retryAt: null, privatePath: sentinel },
    },
    {
      ...response,
      diagnostics: { ...githubDiagnostics(), privatePath: sentinel },
    },
    accessorResponse,
    inheritedResponse,
    proxyResponse,
  ];

  for (const fixture of fixtures) {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => fixture,
    });
    await assert.rejects(
      searchSanitizedGitHubSkills("news"),
      (error) => error.code === "github-response-invalid" && !error.message.includes(sentinel),
    );
  }
});

test("browser API gives safe stage-specific recovery copy", async (context) => {
  const originalFetch = globalThis.fetch;
  const {
    readBrowserApiError,
    searchOriginalGitHubSkills,
    searchSanitizedGitHubSkills,
  } = await import(apiUrl);
  const { formatTaskSearchError } = await import(controllerUrl);
  context.after(() => { globalThis.fetch = originalFetch; });

  const cases = [
    {
      call: () => searchSanitizedGitHubSkills("news"),
      response: Response.json({ error: "github-token-missing", stage: "repository-search" }, { status: 503 }),
      stage: "sanitized",
      githubStage: "repository-search",
      code: "github-token-missing",
      copy: "未检测到 GitHub Token，请配置后重新启动看台。",
    },
    {
      call: () => searchSanitizedGitHubSkills("news"),
      response: Response.json({ error: "github-token-invalid", stage: "repository-search" }, { status: 401 }),
      stage: "sanitized",
      githubStage: "repository-search",
      code: "github-token-invalid",
      copy: "GitHub Token 无效，请更正后重新启动看台。",
    },
    {
      call: () => searchSanitizedGitHubSkills("news"),
      response: Response.json({ error: "github-access-denied", stage: "candidate-validation" }, { status: 403 }),
      stage: "sanitized",
      githubStage: "candidate-validation",
      code: "github-access-denied",
      copy: "GitHub 拒绝了当前 Token 的访问权限，请检查权限后重试。",
    },
    {
      call: () => searchSanitizedGitHubSkills("news"),
      response: Response.json({ error: "github-rate-limited" }, { status: 429 }),
      stage: "sanitized",
      code: "github-rate-limited",
      copy: "GitHub 当前限流，请稍后重试脱敏搜索。",
    },
    {
      call: () => searchSanitizedGitHubSkills("news"),
      response: Response.json({ error: "github-request-timeout" }, { status: 504 }),
      stage: "sanitized",
      code: "github-request-timeout",
      copy: "脱敏搜索超时，请重试脱敏搜索。",
    },
    {
      call: () => searchOriginalGitHubSkills("完整原文", "opaque-consent-token"),
      response: Response.json({ error: "github-query-rejected" }, { status: 422 }),
      stage: "original",
      code: "github-query-rejected",
      copy: "GitHub 不接受这段完整查询，未进行截断。请改写或缩短任务后重新匹配。",
    },
    {
      call: () => searchOriginalGitHubSkills("完整原文", "opaque-consent-token"),
      response: Response.json({ error: "raw-consent-required" }, { status: 403 }),
      stage: "original",
      code: "raw-consent-required",
      copy: "原文发送许可已失效，请重新匹配。",
    },
    {
      call: () => searchSanitizedGitHubSkills("news"),
      response: Response.json({ error: "sanitized-query-unavailable" }, { status: 409 }),
      stage: "sanitized",
      code: "sanitized-query-unavailable",
      copy: "无法生成安全能力词，请重新匹配。",
    },
    {
      call: () => searchOriginalGitHubSkills("完整原文", "opaque-consent-token"),
      response: Response.json({ error: "github-suggestions-unavailable" }, { status: 503 }),
      stage: "original",
      code: "github-suggestions-unavailable",
      copy: "GitHub 查找功能暂时不可用，请稍后重新匹配。",
    },
  ];

  for (const fixture of cases) {
    globalThis.fetch = async () => fixture.response;
    await assert.rejects(fixture.call, (error) => {
      const safe = readBrowserApiError(error);
      return safe?.code === fixture.code &&
        safe.stage === (fixture.githubStage ?? null) && formatTaskSearchError({
        stage: fixture.stage,
        code: safe.code,
        retryAt: safe.retryAt,
      }) === fixture.copy;
    });
  }
});

test("browser GitHub error details expose only a validated exact stage", async (context) => {
  const originalFetch = globalThis.fetch;
  const { readBrowserApiError, searchSanitizedGitHubSkills } = await import(apiUrl);
  context.after(() => { globalThis.fetch = originalFetch; });

  for (const [stage, expected] of [
    ["repository-search", "repository-search"],
    ["code-search", "code-search"],
    ["candidate-validation", "candidate-validation"],
    ["complete", "complete"],
    ["private-stage", null],
    [123, null],
  ]) {
    globalThis.fetch = async () => Response.json({
      error: "github-network-failed",
      stage,
      privatePath: "/private/error-sentinel",
    }, { status: 502 });
    await assert.rejects(searchSanitizedGitHubSkills("news"), (error) => {
      const safe = readBrowserApiError(error);
      return safe?.code === "github-network-failed" && safe.stage === expected &&
        !error.message.includes("private-stage") && !error.message.includes("privatePath");
    });
  }
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
  const { readBrowserApiError, searchSanitizedGitHubSkills } = await import(apiUrl);
  const { formatTaskSearchError } = await import(controllerUrl);
  const expectedTime = new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(retryAt));
  await assert.rejects(
    searchSanitizedGitHubSkills("news"),
    (error) => {
      const safe = readBrowserApiError(error);
      return safe?.code === "github-rate-limited" && safe.retryAt === retryAt &&
        formatTaskSearchError({
          stage: "sanitized",
          code: safe.code,
          retryAt: safe.retryAt,
        }) ===
          `GitHub 当前限流，可在 ${expectedTime} 后重试脱敏搜索。` &&
        !error.message.includes("secret") && !error.message.includes(retryAt);
    },
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
  const { readBrowserApiError, searchSanitizedGitHubSkills } = await import(apiUrl);
  for (const query of ["news", "research"]) {
    await assert.rejects(
      searchSanitizedGitHubSkills(query),
      (error) => {
        const safe = readBrowserApiError(error);
        return safe?.code === "github-rate-limited" && safe.retryAt === null &&
          !error.message.includes("secret");
      },
    );
  }
});
