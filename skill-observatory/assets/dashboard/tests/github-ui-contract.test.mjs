import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const matcherUrl = new URL("../app/components/TaskMatcher.tsx", import.meta.url);
const apiUrl = new URL("../app/lib/api.ts", import.meta.url);
const catalogUrl = new URL("../app/lib/catalog.ts", import.meta.url);
const controllerUrl = new URL("../app/lib/task-search-controller.ts", import.meta.url);
const stylesUrl = new URL("../app/globals.css", import.meta.url);

async function source(url) {
  return readFile(url, "utf8");
}

test("Task Matcher uses the executable search controller and disables submit for every remote phase", async () => {
  const file = await source(matcherUrl);
  assert.match(file, /createTaskSearchController\(\{/);
  assert.match(file, /controller\.subscribe\(setState\)/);
  assert.match(file, /controller\.dispose\(\)/);
  assert.match(file, /void controller\.submit\(\)/);
  assert.match(file, /const submitBlocked = isSearching \|\| phase === "raw-revoke-error"/);
  assert.match(file, /disabled=\{submitBlocked \|\| !query\.trim\(\)\}/);
  assert.match(file, /aria-busy=\{isSearching\}/);
  assert.match(file, /正在用脱敏能力词自动搜索 GitHub/);
  assert.doesNotMatch(file, />在 GitHub 查找</);
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
  for (const field of ["repository", "skillDirectory", "pushedAt", "license", "stars"]) {
    assert.match(file, new RegExp(`result\\.${field}`));
  }
  assert.match(file, /aria-label=\{`仓库 Star/);
  assert.match(file, /target="_blank"/);
  assert.match(file, /rel="noreferrer"/);
  assert.match(file, /result\.license\?\.trim\(\) \|\| "未标注"/);
  assert.doesNotMatch(file, /installSkill|\/api\/install|自动安装|立即安装|安装按钮/);
});

test("response types expose nullable previews and transient raw consent", async () => {
  const file = await source(catalogUrl);
  assert.match(file, /export interface RawSearchConsent/);
  assert.match(file, /token: string;/);
  assert.match(file, /expiresAt: string;/);
  assert.match(file, /rawConsent: RawSearchConsent \| null;/);
  assert.match(file, /preview: GitHubSearchPreview \| null;/);
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

test("browser API posts exact bodies to the four loopback endpoints", async (context) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/api/recommend")) {
      return Response.json({
        results: [],
        githubSearch: { terms: ["data validation", "testing", "skill"], label: "data validation · testing · skill" },
        rawConsent: null,
      });
    }
    if (String(url).endsWith("/api/github-suggestions")) {
      return Response.json({
        preview: { terms: ["data validation", "testing", "skill"], label: "data validation · testing · skill" },
        results: [],
        cached: false,
        incomplete: false,
        rawConsent: { token: "opaque-consent-token", expiresAt: "2026-08-16T00:05:00.000Z" },
        rateLimit: null,
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
    });
  };
  context.after(() => { globalThis.fetch = originalFetch; });

  const {
    recommendTask,
    revokeOriginalSearchConsent,
    searchOriginalGitHubSkills,
    searchSanitizedGitHubSkills,
  } = await import(apiUrl);
  const controller = new AbortController();
  const local = await recommendTask("检测数据", controller.signal);
  assert.equal(local.githubSearch.label, "data validation · testing · skill");
  const sanitized = await searchSanitizedGitHubSkills("检测数据", controller.signal);
  assert.equal(sanitized.rawConsent.token, "opaque-consent-token");
  const original = await searchOriginalGitHubSkills("检测数据", "opaque-consent-token", controller.signal);
  assert.equal(original.preview, null);
  await revokeOriginalSearchConsent("opaque-consent-token");

  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:4318/api/recommend",
    "http://127.0.0.1:4318/api/github-suggestions",
    "http://127.0.0.1:4318/api/github-suggestions/original",
    "http://127.0.0.1:4318/api/github-suggestions/revoke",
  ]);
  assert.deepEqual(calls.map((call) => JSON.parse(call.options.body)), [
    { query: "检测数据" },
    { query: "检测数据" },
    { query: "检测数据", consentToken: "opaque-consent-token" },
    { consentToken: "opaque-consent-token" },
  ]);
  assert.ok(calls.every((call) => call.options.method === "POST"));
  assert.ok(calls.slice(0, 3).every((call) => call.options.signal === controller.signal));
  assert.equal(calls[3].options.signal, undefined);
  assert.equal(calls[3].options.keepalive, true);
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
        results: [],
        githubSearch: null,
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
      return safe?.code === fixture.code && formatTaskSearchError({
        stage: fixture.stage,
        code: safe.code,
        retryAt: safe.retryAt,
      }) === fixture.copy;
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
        formatTaskSearchError({ stage: "sanitized", ...safe }) ===
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
