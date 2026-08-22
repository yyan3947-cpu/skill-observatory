import assert from "node:assert/strict";
import test from "node:test";

import {
  createTaskSearchController,
  formatTaskSearchError,
  isTaskSearchInFlight,
} from "../app/lib/task-search-controller.ts";
import {
  revokeOriginalSearchConsent,
  searchOriginalGitHubSkills,
  searchSanitizedGitHubSkills,
} from "../app/lib/api.ts";
import { createLocalApi } from "../lib/local-api.mjs";
import { createRawSearchConsentStore } from "../lib/raw-search-consent.mjs";

const preview = {
  terms: ["data validation", "testing", "skill"],
  label: "data validation · testing · skill",
};

const consent = {
  token: "opaque-consent-token",
  expiresAt: "2026-08-16T00:05:00.000Z",
};

function recommendation(options = {}) {
  const {
    localMatchLevel = "none",
    results = [],
    githubSearch = null,
    rawConsent = null,
  } = options;
  const githubStatus = Object.hasOwn(options, "githubStatus")
    ? options.githubStatus
    : localMatchLevel === "strong"
      ? null
      : readyGitHubStatus();
  return { localMatchLevel, results, githubSearch, githubStatus, rawConsent };
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

function suggestions({ results = [], incomplete = false, rawConsent = null, diagnostics = null } = {}) {
  return {
    preview,
    results,
    cached: false,
    incomplete,
    rawConsent,
    rateLimit: null,
    diagnostics: diagnostics ?? githubDiagnostics({
      stageReached: incomplete ? "code-search" : "complete",
      validatedCandidates: results.length,
      incomplete,
    }),
  };
}

function githubStatus(state = "ready", overrides = {}) {
  return {
    state,
    checkedAt: "2026-08-19T01:02:03.000Z",
    rateLimits: { search: null, codeSearch: null },
    ...overrides,
  };
}

function readyGitHubStatus(overrides = {}) {
  return githubStatus("ready", overrides);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("timed out waiting for asynchronous test condition");
}

function browserError(code, stage = "repository-search", sentinel = "private-original-error") {
  const error = new Error(sentinel);
  Object.defineProperties(error, {
    code: { value: code, enumerable: true },
    retryAt: { value: null, enumerable: true },
    stage: { value: stage, enumerable: true },
  });
  return error;
}

function controllerWith(overrides = {}) {
  return createTaskSearchController({
    recommendTask: async () => recommendation(),
    getGitHubStatus: async () => readyGitHubStatus(),
    searchSanitizedGitHubSkills: async () => suggestions(),
    searchOriginalGitHubSkills: async () => suggestions(),
    revokeOriginalSearchConsent: async () => {},
    ...overrides,
  });
}

test("a local match completes with zero GitHub calls", async () => {
  let sanitizedCalls = 0;
  let originalCalls = 0;
  const controller = controllerWith({
    recommendTask: async () => recommendation({
      localMatchLevel: "strong",
      results: [{ skillId: "local-skill" }],
    }),
    searchSanitizedGitHubSkills: async () => {
      sanitizedCalls += 1;
      return suggestions();
    },
    searchOriginalGitHubSkills: async () => {
      originalCalls += 1;
      return suggestions();
    },
  });
  controller.changeQuery("检测数据");
  assert.equal(await controller.submit(), true);
  assert.equal(controller.getState().phase, "complete");
  assert.equal(controller.getState().localMatchLevel, "strong");
  assert.equal(controller.getState().results.length, 1);
  assert.equal(sanitizedCalls, 0);
  assert.equal(originalCalls, 0);
});

test("strong local completion never awaits an in-flight coalesced status refresh", async () => {
  const pendingStatus = deferred();
  let statusCalls = 0;
  let sanitizedCalls = 0;
  const controller = controllerWith({
    getGitHubStatus: async () => {
      statusCalls += 1;
      return pendingStatus.promise;
    },
    recommendTask: async () => recommendation({
      localMatchLevel: "strong",
      results: [{ skillId: "local-skill" }],
    }),
    searchSanitizedGitHubSkills: async () => {
      sanitizedCalls += 1;
      return suggestions();
    },
  });
  const firstRefresh = controller.refreshGitHubStatus();
  const secondRefresh = controller.refreshGitHubStatus();
  assert.equal(firstRefresh, secondRefresh);
  controller.changeQuery("检测数据");
  assert.equal(await controller.submit(), true);
  assert.equal(controller.getState().phase, "complete");
  assert.equal(statusCalls, 1);
  assert.equal(sanitizedCalls, 0);

  const status = readyGitHubStatus();
  pendingStatus.resolve(status);
  assert.equal(await firstRefresh, true);
  assert.deepEqual(controller.getState().githubStatus, status);
  assert.notEqual(controller.getState().githubStatus, status);
});

test("weak local results survive every non-ready status with fixed copy and zero finder calls", async () => {
  const cases = [
    [githubStatus("missing-token"), "未检测到 GitHub Token，请配置后重新启动看台。"],
    [githubStatus("invalid-token"), "GitHub Token 无效，请更正后重新启动看台。"],
    [githubStatus("github-unavailable"), "连接 GitHub 失败，请重试脱敏搜索。"],
    [githubStatus("rate-limited", {
      rateLimits: {
        search: { remaining: 0, reset: 1_780_000_000, retryAt: "2026-05-27T04:26:40.000Z" },
        codeSearch: null,
      },
    }), null],
  ];
  for (const [status, fixedCopy] of cases) {
    let sanitizedCalls = 0;
    const local = [{ skillId: "maybe-local", name: "maybe-local" }];
    const controller = controllerWith({
      recommendTask: async () => recommendation({
        localMatchLevel: "weak",
        results: local,
        githubSearch: preview,
        githubStatus: status,
      }),
      searchSanitizedGitHubSkills: async () => {
        sanitizedCalls += 1;
        return suggestions();
      },
    });
    controller.changeQuery("分析一个模糊任务");
    await controller.submit();
    const state = controller.getState();
    assert.equal(state.localMatchLevel, "weak", status.state);
    assert.deepEqual(state.results, local, status.state);
    assert.equal(state.phase, "sanitized-error", status.state);
    assert.equal(state.githubStatus.state, status.state);
    assert.equal(state.githubStage, "repository-search");
    assert.equal(state.rawConsent, null);
    assert.equal(sanitizedCalls, 0, status.state);
    const copy = formatTaskSearchError(state.error);
    if (fixedCopy) assert.equal(copy, fixedCopy);
    else assert.match(copy, /^GitHub 当前限流，/u);
  }
});

test("code-search exhaustion alone stays ready and permits repository discovery", async () => {
  let sanitizedCalls = 0;
  const status = readyGitHubStatus({
    rateLimits: {
      search: { remaining: 12, reset: 1_780_000_000, retryAt: null },
      codeSearch: { remaining: 0, reset: 1_780_000_060, retryAt: "2026-05-27T04:27:40.000Z" },
    },
  });
  const controller = controllerWith({
    recommendTask: async () => recommendation({ githubSearch: preview, githubStatus: status }),
    searchSanitizedGitHubSkills: async () => {
      sanitizedCalls += 1;
      return suggestions({ results: [{ name: "remote" }] });
    },
  });
  controller.changeQuery("检测数据");
  await controller.submit();
  assert.equal(sanitizedCalls, 1);
  assert.equal(controller.getState().phase, "complete");
  assert.equal(controller.getState().githubStatus.rateLimits.codeSearch.remaining, 0);
});

test("a weak local match stays visible while one sanitized search runs", async () => {
  const pending = deferred();
  let sanitizedCalls = 0;
  const local = [{ skillId: "maybe-local", name: "maybe-local" }];
  const controller = controllerWith({
    recommendTask: async () => recommendation({
      localMatchLevel: "weak",
      results: local,
      githubSearch: preview,
    }),
    searchSanitizedGitHubSkills: async () => {
      sanitizedCalls += 1;
      return pending.promise;
    },
  });

  controller.changeQuery("分析一个模糊任务");
  const request = controller.submit();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(controller.getState().localMatchLevel, "weak");
  assert.deepEqual(controller.getState().results, local);
  assert.equal(controller.getState().phase, "sanitized-searching");

  pending.resolve(suggestions({ results: [{ name: "remote-one" }] }));
  await request;
  assert.equal(sanitizedCalls, 1);
  assert.deepEqual(controller.getState().results, local);
  assert.deepEqual(controller.getState().githubResults.map((item) => item.name), ["remote-one"]);
});

test("successful and incomplete suggestions retain cloned diagnostics and safe partial results", async () => {
  const completeDiagnostics = githubDiagnostics({
    repositoryHits: 4,
    validatedCandidates: 1,
    rateLimits: {
      search: { remaining: 11, reset: 1_780_000_000, retryAt: null },
      codeSearch: null,
    },
  });
  const complete = controllerWith({
    recommendTask: async () => recommendation({ githubSearch: preview }),
    searchSanitizedGitHubSkills: async () => suggestions({
      results: [{ name: "remote-one" }],
      diagnostics: completeDiagnostics,
    }),
  });
  complete.changeQuery("检测数据");
  await complete.submit();
  assert.equal(complete.getState().githubStage, "complete");
  assert.deepEqual(complete.getState().githubDiagnostics, completeDiagnostics);
  assert.notEqual(complete.getState().githubDiagnostics, completeDiagnostics);
  assert.notEqual(complete.getState().githubDiagnostics.rateLimits, completeDiagnostics.rateLimits);
  completeDiagnostics.repositoryHits = 99;
  completeDiagnostics.rateLimits.search.remaining = 99;
  assert.equal(complete.getState().githubDiagnostics.repositoryHits, 4);
  assert.equal(complete.getState().githubDiagnostics.rateLimits.search.remaining, 11);

  const incompleteDiagnostics = githubDiagnostics({
    stageReached: "code-search",
    repositoryHits: 2,
    codeHits: 1,
    validatedCandidates: 1,
    incomplete: true,
  });
  const revokeCalls = [];
  const incomplete = controllerWith({
    recommendTask: async () => recommendation({ githubSearch: preview }),
    searchSanitizedGitHubSkills: async () => suggestions({
      results: [{ name: "partial-remote" }],
      incomplete: true,
      rawConsent: consent,
      diagnostics: incompleteDiagnostics,
    }),
    revokeOriginalSearchConsent: async (token) => { revokeCalls.push(token); },
  });
  incomplete.changeQuery("检测数据");
  await incomplete.submit();
  assert.deepEqual(incomplete.getState().githubResults.map((item) => item.name), ["partial-remote"]);
  assert.equal(incomplete.getState().githubIncomplete, true);
  assert.equal(incomplete.getState().githubStage, "code-search");
  assert.deepEqual(incomplete.getState().githubDiagnostics, incompleteDiagnostics);
  assert.equal(incomplete.getState().rawConsent, null);
  assert.equal(incomplete.getState().phase, "sanitized-error");
  await Promise.resolve();
  assert.deepEqual(revokeCalls, [consent.token]);
});

test("a complete weak sanitized zero keeps local results until explicit original confirmation", async () => {
  const local = [{ skillId: "maybe-local", name: "maybe-local" }];
  let sanitizedCalls = 0;
  let originalCalls = 0;
  const controller = controllerWith({
    recommendTask: async () => recommendation({
      localMatchLevel: "weak",
      results: local,
      githubSearch: preview,
    }),
    searchSanitizedGitHubSkills: async () => {
      sanitizedCalls += 1;
      return suggestions({ results: [], rawConsent: consent });
    },
    searchOriginalGitHubSkills: async () => {
      originalCalls += 1;
      return suggestions({ results: [{ name: "raw-remote" }] });
    },
  });

  controller.changeQuery("分析一个需要原文确认的任务");
  await controller.submit();
  assert.equal(sanitizedCalls, 1);
  assert.equal(originalCalls, 0);
  assert.equal(controller.getState().phase, "raw-consent");
  assert.equal(controller.getState().localMatchLevel, "weak");
  assert.deepEqual(controller.getState().results, local);

  await controller.confirmOriginalSearch();
  assert.equal(originalCalls, 1);
  assert.equal(controller.getState().localMatchLevel, "weak");
  assert.deepEqual(controller.getState().results, local);
  assert.deepEqual(controller.getState().githubResults.map((item) => item.name), ["raw-remote"]);
});

test("a weak no-preview consent keeps local results and revokes without any remote search", async () => {
  const local = [{ skillId: "maybe-local", name: "maybe-local" }];
  let sanitizedCalls = 0;
  let originalCalls = 0;
  const revokeCalls = [];
  const controller = controllerWith({
    recommendTask: async () => recommendation({
      localMatchLevel: "weak",
      results: local,
      rawConsent: consent,
    }),
    searchSanitizedGitHubSkills: async () => {
      sanitizedCalls += 1;
      return suggestions();
    },
    searchOriginalGitHubSkills: async () => {
      originalCalls += 1;
      return suggestions();
    },
    revokeOriginalSearchConsent: async (token) => {
      revokeCalls.push(token);
    },
  });

  controller.changeQuery("包含无法脱敏名称的模糊任务");
  await controller.submit();
  assert.equal(controller.getState().phase, "raw-consent");
  assert.equal(controller.getState().localMatchLevel, "weak");
  assert.deepEqual(controller.getState().results, local);
  assert.equal(sanitizedCalls, 0);
  assert.equal(originalCalls, 0);

  assert.equal(await controller.cancelOriginalSearch(), true);
  assert.equal(controller.getState().phase, "cancelled");
  assert.equal(controller.getState().localMatchLevel, "weak");
  assert.deepEqual(controller.getState().results, local);
  assert.equal(originalCalls, 0);
  assert.deepEqual(revokeCalls, [consent.token]);
});

test("an incomplete weak search preserves local cards and never unlocks raw search", async () => {
  const controller = controllerWith({
    recommendTask: async () => recommendation({
      localMatchLevel: "weak",
      results: [{ skillId: "maybe-local" }],
      githubSearch: preview,
    }),
    searchSanitizedGitHubSkills: async () => suggestions({ incomplete: true, rawConsent: consent }),
  });
  controller.changeQuery("分析一个模糊任务");
  await controller.submit();
  assert.equal(controller.getState().phase, "sanitized-error");
  assert.equal(controller.getState().results.length, 1);
  assert.equal(controller.getState().rawConsent, null);
});

test("a failed weak search preserves local cards and never unlocks raw search", async () => {
  const controller = controllerWith({
    recommendTask: async () => recommendation({
      localMatchLevel: "weak",
      results: [{ skillId: "maybe-local" }],
      githubSearch: preview,
    }),
    searchSanitizedGitHubSkills: async () => {
      throw new Error("private-remote-detail");
    },
  });
  controller.changeQuery("分析另一个模糊任务");
  await controller.submit();
  assert.equal(controller.getState().phase, "sanitized-error");
  assert.equal(controller.getState().localMatchLevel, "weak");
  assert.equal(controller.getState().results.length, 1);
  assert.equal(controller.getState().rawConsent, null);
});

test("retry refreshes status before finder traffic and stays local when refresh is non-ready", async () => {
  const order = [];
  let nextStatus = githubStatus("missing-token");
  let sanitizedCalls = 0;
  const controller = controllerWith({
    recommendTask: async () => recommendation({
      localMatchLevel: "weak",
      results: [{ skillId: "maybe-local" }],
      githubSearch: preview,
      githubStatus: githubStatus("missing-token"),
    }),
    getGitHubStatus: async () => {
      order.push("status");
      return nextStatus;
    },
    searchSanitizedGitHubSkills: async () => {
      order.push("finder");
      sanitizedCalls += 1;
      return suggestions({ results: [{ name: "remote-after-reset" }] });
    },
  });
  controller.changeQuery("分析模糊任务");
  await controller.submit();
  assert.equal(await controller.retrySanitizedSearch(), true);
  assert.deepEqual(order, ["status"]);
  assert.equal(sanitizedCalls, 0);
  assert.equal(controller.getState().phase, "sanitized-error");
  assert.equal(controller.getState().results.length, 1);

  nextStatus = readyGitHubStatus();
  assert.equal(await controller.retrySanitizedSearch(), true);
  assert.deepEqual(order, ["status", "status", "finder"]);
  assert.equal(sanitizedCalls, 1);
  assert.equal(controller.getState().phase, "complete");
  assert.deepEqual(controller.getState().githubResults.map((item) => item.name), ["remote-after-reset"]);
});

test("a recommendation status supersedes an older refresh without cancelling its suggestion", async () => {
  const pendingStatus = deferred();
  const pendingSuggestions = deferred();
  let statusSignal;
  let suggestionSignal;
  const controller = controllerWith({
    getGitHubStatus: async (signal) => {
      statusSignal = signal;
      signal.addEventListener("abort", () => {
        pendingStatus.reject(new DOMException("owned status abort", "AbortError"));
      }, { once: true });
      return pendingStatus.promise;
    },
    recommendTask: async () => recommendation({ githubSearch: preview }),
    searchSanitizedGitHubSkills: async (_query, signal) => {
      suggestionSignal = signal;
      return pendingSuggestions.promise;
    },
  });
  const refresh = controller.refreshGitHubStatus();
  controller.changeQuery("检测数据");
  const submission = controller.submit();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(statusSignal.aborted, true);
  assert.equal(suggestionSignal.aborted, false);
  assert.equal(await refresh, false);

  pendingSuggestions.resolve(suggestions({ results: [{ name: "current-remote" }] }));
  await submission;
  assert.equal(controller.getState().githubStatus.state, "ready");
  assert.deepEqual(controller.getState().githubResults.map((item) => item.name), ["current-remote"]);
  assert.equal(controller.getState().phase, "complete");
});

test("a superseded refresh that ignores abort cannot occupy the next retry slot", async () => {
  const staleStatus = deferred();
  let statusCalls = 0;
  let sanitizedCalls = 0;
  const controller = controllerWith({
    getGitHubStatus: async () => {
      statusCalls += 1;
      return statusCalls === 1 ? staleStatus.promise : readyGitHubStatus();
    },
    recommendTask: async () => recommendation({
      localMatchLevel: "weak",
      results: [{ skillId: "maybe-local" }],
      githubSearch: preview,
      githubStatus: githubStatus("missing-token"),
    }),
    searchSanitizedGitHubSkills: async () => {
      sanitizedCalls += 1;
      return suggestions({ results: [{ name: "fresh-remote" }] });
    },
  });
  const staleRefresh = controller.refreshGitHubStatus();
  controller.changeQuery("分析模糊任务");
  await controller.submit();
  assert.equal(controller.getState().phase, "sanitized-error");

  const retry = controller.retrySanitizedSearch();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(statusCalls, 2);
  assert.equal(await retry, true);
  assert.equal(sanitizedCalls, 1);
  assert.equal(controller.getState().phase, "complete");
  staleStatus.resolve(githubStatus("invalid-token"));
  assert.equal(await staleRefresh, false);
  assert.equal(controller.getState().githubStatus.state, "ready");
});

test("dispose independently aborts status and suggestion requests", async () => {
  const pendingStatus = deferred();
  const pendingSuggestions = deferred();
  let statusSignal;
  let suggestionSignal;
  const controller = controllerWith({
    getGitHubStatus: async (signal) => {
      statusSignal = signal;
      return pendingStatus.promise;
    },
    recommendTask: async () => recommendation({ githubSearch: preview }),
    searchSanitizedGitHubSkills: async (_query, signal) => {
      suggestionSignal = signal;
      return pendingSuggestions.promise;
    },
  });
  const refresh = controller.refreshGitHubStatus();
  controller.changeQuery("检测数据");
  const submission = controller.submit();
  await Promise.resolve();
  await Promise.resolve();
  controller.dispose();
  assert.equal(statusSignal.aborted, true);
  assert.equal(suggestionSignal.aborted, true);
  pendingStatus.resolve(readyGitHubStatus());
  pendingSuggestions.resolve(suggestions());
  assert.equal(await refresh, false);
  await submission;
});

test("a local no-match automatically runs one sanitized search", async () => {
  let sanitizedCalls = 0;
  const controller = controllerWith({
    recommendTask: async () => recommendation({ githubSearch: preview }),
    searchSanitizedGitHubSkills: async (query) => {
      sanitizedCalls += 1;
      assert.equal(query, "检测数据");
      return suggestions({ results: [{ name: "data-skill" }] });
    },
  });
  controller.changeQuery(" 检测数据 ");
  await controller.submit();
  assert.equal(sanitizedCalls, 1);
  assert.equal(controller.getState().phase, "complete");
  assert.equal(controller.getState().githubResults.length, 1);
});

test("editing input aborts and suppresses a stale local response", async () => {
  const pending = deferred();
  let signal;
  const controller = controllerWith({
    recommendTask: async (_query, requestSignal) => {
      signal = requestSignal;
      return pending.promise;
    },
  });
  controller.changeQuery("旧任务");
  const request = controller.submit();
  assert.equal(isTaskSearchInFlight(controller.getState()), true);
  controller.changeQuery("新任务");
  assert.equal(signal.aborted, true);
  pending.resolve(recommendation({
    localMatchLevel: "strong",
    results: [{ skillId: "stale-skill" }],
  }));
  await request;
  assert.equal(controller.getState().query, "新任务");
  assert.equal(controller.getState().results, null);
  assert.equal(controller.getState().phase, "idle");
});

test("editing input aborts and suppresses a stale sanitized response", async () => {
  const pending = deferred();
  const revokeCalls = [];
  let signal;
  const controller = controllerWith({
    recommendTask: async () => recommendation({ githubSearch: preview }),
    searchSanitizedGitHubSkills: async (_query, requestSignal) => {
      signal = requestSignal;
      return pending.promise;
    },
    revokeOriginalSearchConsent: async (token) => {
      revokeCalls.push(token);
    },
  });
  controller.changeQuery("旧任务");
  const request = controller.submit();
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(signal);
  controller.changeQuery("新任务");
  assert.equal(signal.aborted, true);
  pending.resolve(suggestions({ rawConsent: consent }));
  await request;
  assert.equal(controller.getState().query, "新任务");
  assert.equal(controller.getState().githubResults, null);
  assert.equal(controller.getState().phase, "idle");
  assert.deepEqual(revokeCalls, [consent.token]);
});

test("disposing the production controller aborts its active request", async () => {
  const pending = deferred();
  let signal;
  const controller = controllerWith({
    recommendTask: async (_query, requestSignal) => {
      signal = requestSignal;
      return pending.promise;
    },
  });
  controller.changeQuery("任务");
  const request = controller.submit();
  controller.dispose();
  assert.equal(signal.aborted, true);
  pending.resolve(recommendation());
  await request;
});

test("double submit and submit during original search are synchronously gated", async () => {
  const localPending = deferred();
  let localCalls = 0;
  const controller = controllerWith({
    recommendTask: async () => {
      localCalls += 1;
      return localPending.promise;
    },
  });
  controller.changeQuery("任务");
  const first = controller.submit();
  const second = controller.submit();
  assert.equal(await second, false);
  assert.equal(localCalls, 1);
  assert.equal(isTaskSearchInFlight(controller.getState()), true);
  localPending.resolve(recommendation({
    localMatchLevel: "strong",
    results: [{ skillId: "local" }],
  }));
  assert.equal(await first, true);

  const rawPending = deferred();
  const rawController = controllerWith({
    recommendTask: async () => recommendation({ rawConsent: consent }),
    searchOriginalGitHubSkills: async () => rawPending.promise,
  });
  rawController.changeQuery("原始任务");
  await rawController.submit();
  const original = rawController.confirmOriginalSearch();
  assert.equal(await rawController.submit(), false);
  rawPending.resolve(suggestions());
  await original;
});

test("double original confirmation sends one exact query and token", async () => {
  const pending = deferred();
  const calls = [];
  const revokeCalls = [];
  const controller = controllerWith({
    recommendTask: async () => recommendation({ rawConsent: consent }),
    searchOriginalGitHubSkills: async (...args) => {
      calls.push(args);
      return pending.promise;
    },
    revokeOriginalSearchConsent: async (token) => {
      revokeCalls.push(token);
    },
  });
  controller.changeQuery("  完整原文  ");
  await controller.submit();
  const first = controller.confirmOriginalSearch();
  const second = controller.confirmOriginalSearch();
  assert.equal(await second, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "完整原文");
  assert.equal(calls[0][1], consent.token);
  pending.resolve(suggestions({ results: [{ name: "raw-skill" }] }));
  assert.equal(await first, true);
  assert.deepEqual(revokeCalls, []);
});

test("uncertain original failures await one revocation and never leak private details", async () => {
  const failures = [
    new Error("private-network-failure"),
    new DOMException("private-unowned-abort", "AbortError"),
  ];
  for (const failure of failures) {
    const gate = deferred();
    let revokeCalls = 0;
    let settled = false;
    const controller = controllerWith({
      recommendTask: async () => recommendation({ rawConsent: consent }),
      searchOriginalGitHubSkills: async () => { throw failure; },
      revokeOriginalSearchConsent: async (token) => {
        assert.equal(token, consent.token);
        revokeCalls += 1;
        await gate.promise;
      },
    });
    controller.changeQuery("原始任务");
    await controller.submit();

    const confirmation = controller.confirmOriginalSearch();
    confirmation.then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(revokeCalls, 1);
    assert.equal(settled, false);
    assert.equal(await controller.cancelOriginalSearch(), false);
    gate.resolve();
    assert.equal(await confirmation, true);
    assert.equal(controller.getState().phase, "raw-error");
    assert.equal(controller.getState().rawConsent, null);
    const copy = formatTaskSearchError(controller.getState().error);
    assert.doesNotMatch(copy, /private-|opaque-consent-token/u);
    assert.equal(revokeCalls, 1);
  }
});

test("failed cleanup after an original failure restores only a retryable revoke barrier", async () => {
  let originalCalls = 0;
  let revokeCalls = 0;
  const controller = controllerWith({
    recommendTask: async () => recommendation({ rawConsent: consent }),
    searchOriginalGitHubSkills: async () => {
      originalCalls += 1;
      throw browserError("github-network-failed", "repository-search", "private-original-failure");
    },
    revokeOriginalSearchConsent: async () => {
      revokeCalls += 1;
      if (revokeCalls === 1) throw new Error("private-revoke-failure");
    },
  });
  controller.changeQuery("原始任务");
  await controller.submit();

  assert.equal(await controller.confirmOriginalSearch(), true);
  assert.equal(controller.getState().phase, "raw-revoke-error");
  assert.deepEqual(controller.getState().rawConsent, consent);
  assert.equal(await controller.confirmOriginalSearch(), false);
  const copy = formatTaskSearchError(controller.getState().error);
  assert.equal(copy, "未能确认撤销，请重试取消或等待授权自动失效。");
  assert.doesNotMatch(copy, /private-|opaque-consent-token/u);
  assert.equal(originalCalls, 1);

  assert.equal(await controller.cancelOriginalSearch(), true);
  assert.equal(revokeCalls, 2);
  assert.equal(controller.getState().phase, "cancelled");
  assert.equal(controller.getState().rawConsent, null);
  assert.equal(originalCalls, 1);
});

test("query replacement aborts an original request and shares its awaited revocation", async () => {
  const gate = deferred();
  let originalSignal;
  let revokeCalls = 0;
  let recommendationCalls = 0;
  const controller = controllerWith({
    recommendTask: async () => {
      recommendationCalls += 1;
      return recommendation(recommendationCalls === 1
        ? { rawConsent: consent }
        : { localMatchLevel: "strong", results: [{ skillId: "replacement" }] });
    },
    searchOriginalGitHubSkills: async (_query, _token, signal) => {
      originalSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new DOMException("private-owned-abort", "AbortError"));
        }, { once: true });
      });
    },
    revokeOriginalSearchConsent: async (token) => {
      assert.equal(token, consent.token);
      revokeCalls += 1;
      await gate.promise;
    },
  });
  controller.changeQuery("原始任务");
  await controller.submit();
  let settled = false;
  const confirmation = controller.confirmOriginalSearch();
  confirmation.then(() => { settled = true; });

  controller.changeQuery("替代任务");
  assert.equal(originalSignal.aborted, true);
  assert.equal(controller.getState().phase, "raw-revoking");
  assert.equal(controller.getState().query, "替代任务");
  assert.equal(revokeCalls, 1);
  assert.equal(await controller.submit(), false);
  assert.equal(settled, false);
  gate.resolve();
  assert.equal(await confirmation, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(revokeCalls, 1);
  assert.equal(controller.getState().phase, "cancelled");

  assert.equal(await controller.submit(), true);
  assert.equal(controller.getState().phase, "complete");
  assert.equal(controller.getState().results[0].skillId, "replacement");
});

test("a stale original response that ignores abort still awaits the shared revocation", async () => {
  const original = deferred();
  const revoke = deferred();
  let revokeCalls = 0;
  const controller = controllerWith({
    recommendTask: async () => recommendation({ rawConsent: consent }),
    searchOriginalGitHubSkills: async () => original.promise,
    revokeOriginalSearchConsent: async () => {
      revokeCalls += 1;
      await revoke.promise;
    },
  });
  controller.changeQuery("原始任务");
  await controller.submit();
  let settled = false;
  const confirmation = controller.confirmOriginalSearch();
  confirmation.then(() => { settled = true; });
  controller.changeQuery("替代任务");
  assert.equal(revokeCalls, 1);

  original.resolve(suggestions({ results: [{ name: "stale-private-result" }] }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(controller.getState().githubResults, null);
  revoke.resolve();
  assert.equal(await confirmation, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(revokeCalls, 1);
  assert.equal(controller.getState().phase, "cancelled");
  assert.equal(controller.getState().query, "替代任务");
  assert.equal(controller.getState().rawConsent, null);
});

test("dispose revokes a captured original grant once and confirmation awaits it", async () => {
  const gate = deferred();
  let originalSignal;
  let revokeCalls = 0;
  const controller = controllerWith({
    recommendTask: async () => recommendation({ rawConsent: consent }),
    searchOriginalGitHubSkills: async (_query, _token, signal) => {
      originalSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new DOMException("private-dispose-abort", "AbortError"));
        }, { once: true });
      });
    },
    revokeOriginalSearchConsent: async () => {
      revokeCalls += 1;
      await gate.promise;
    },
  });
  controller.changeQuery("原始任务");
  await controller.submit();
  let settled = false;
  const confirmation = controller.confirmOriginalSearch();
  confirmation.then(() => { settled = true; });
  controller.dispose();
  assert.equal(originalSignal.aborted, true);
  assert.equal(revokeCalls, 1);
  assert.equal(controller.getState().rawConsent, null);
  assert.equal(settled, false);
  gate.resolve();
  assert.equal(await confirmation, true);
  assert.equal(revokeCalls, 1);
  controller.dispose();
  assert.equal(revokeCalls, 1);
});

test("cancelling raw consent clears it and revokes exactly once without an original request", async () => {
  let originalCalls = 0;
  const revokeCalls = [];
  const controller = controllerWith({
    recommendTask: async () => recommendation({ rawConsent: consent }),
    searchOriginalGitHubSkills: async () => {
      originalCalls += 1;
      return suggestions();
    },
    revokeOriginalSearchConsent: async (token) => {
      revokeCalls.push(token);
    },
  });
  controller.changeQuery("原始任务");
  await controller.submit();
  assert.equal(await controller.cancelOriginalSearch(), true);
  assert.equal(controller.getState().phase, "cancelled");
  assert.equal(controller.getState().rawConsent, null);
  assert.equal(originalCalls, 0);
  assert.equal(await controller.cancelOriginalSearch(), false);
  await Promise.resolve();
  assert.deepEqual(revokeCalls, [consent.token]);
});

test("explicit cancellation waits for real loopback revocation before reporting success", async (context) => {
  const gate = deferred();
  let revokeRouteCalls = 0;
  const store = createRawSearchConsentStore({ createToken: () => "delayed-revoke-consent-token" });
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => ({ level: "none", results: [] }),
    getGitHubStatus: async () => readyGitHubStatus(),
    previewGitHubSearch: () => null,
    findOriginalGitHubSuggestions: async () => suggestions(),
    rawSearchConsentStore: {
      issue: store.issue,
      consume: store.consume,
      revoke(token) {
        revokeRouteCalls += 1;
        return store.revoke(token);
      },
    },
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const post = (path, body) => fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const controller = controllerWith({
    recommendTask: async (query) => {
      const response = await post("/api/recommend", { query });
      return response.json();
    },
    revokeOriginalSearchConsent: async (token) => {
      await gate.promise;
      const response = await post("/api/github-suggestions/revoke", { consentToken: token });
      assert.equal(response.status, 204);
    },
  });
  controller.changeQuery("原始任务");
  await controller.submit();
  const token = controller.getState().rawConsent.token;

  let settled = false;
  const cancellation = controller.cancelOriginalSearch();
  cancellation.then(() => { settled = true; });
  assert.equal(controller.getState().phase, "raw-revoking");
  assert.equal(controller.getState().rawConsent.token, token);
  assert.equal(isTaskSearchInFlight(controller.getState()), true);
  assert.equal(await controller.confirmOriginalSearch(), false);
  assert.equal(revokeRouteCalls, 0);
  assert.equal(settled, false);

  gate.resolve();
  assert.equal(await cancellation, true);
  assert.equal(controller.getState().phase, "cancelled");
  assert.equal(controller.getState().rawConsent, null);
  const rejected = await post("/api/github-suggestions/original", {
    query: "原始任务",
    consentToken: token,
  });
  assert.equal(rejected.status, 403);
});

test("original status failure awaits revocation and invalidates the real loopback grant", async (context) => {
  const originalFetch = globalThis.fetch;
  const gate = deferred();
  const store = createRawSearchConsentStore({ createToken: () => "status-failure-consent-token" });
  let status = readyGitHubStatus();
  let finderCalls = 0;
  let revokeCalls = 0;
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => ({ level: "none", results: [] }),
    getGitHubStatus: async () => status,
    previewGitHubSearch: () => null,
    findOriginalGitHubSuggestions: async () => {
      finderCalls += 1;
      return { ...suggestions(), preview: null };
    },
    rawSearchConsentStore: store,
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const baseUrl = `http://127.0.0.1:${address.port}`;
  globalThis.fetch = (input, options) => originalFetch(
    String(input).replace("http://127.0.0.1:4318", baseUrl),
    options,
  );
  context.after(() => { globalThis.fetch = originalFetch; });
  const post = (path, body) => originalFetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const controller = controllerWith({
    recommendTask: async (query) => {
      const response = await post("/api/recommend", { query });
      assert.equal(response.status, 200);
      return response.json();
    },
    searchOriginalGitHubSkills,
    revokeOriginalSearchConsent: async (token) => {
      revokeCalls += 1;
      await gate.promise;
      await revokeOriginalSearchConsent(token);
    },
  });
  controller.changeQuery("原始任务");
  await controller.submit();
  const grant = controller.getState().rawConsent;
  status = githubStatus("missing-token");

  let settled = false;
  const confirmation = controller.confirmOriginalSearch();
  confirmation.then(() => { settled = true; });
  await waitFor(() => revokeCalls === 1);
  assert.equal(revokeCalls, 1);
  assert.equal(settled, false);
  assert.equal(controller.getState().rawConsent, null);
  assert.equal(finderCalls, 0);

  gate.resolve();
  assert.equal(await confirmation, true);
  assert.equal(controller.getState().phase, "raw-error");
  assert.equal(controller.getState().error.code, "github-token-missing");
  assert.equal(controller.getState().rawConsent, null);
  status = readyGitHubStatus();
  const rejected = await post("/api/github-suggestions/original", {
    query: "原始任务",
    consentToken: grant.token,
  });
  assert.equal(rejected.status, 403);
  assert.equal(finderCalls, 0);
});

test("missing original finder cannot leave a live grant after controller failure", async (context) => {
  const originalFetch = globalThis.fetch;
  const gate = deferred();
  const store = createRawSearchConsentStore({ createToken: () => "finder-failure-consent-token" });
  let baseUrl = "";
  let revokeCalls = 0;
  const firstApi = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => ({ level: "none", results: [] }),
    getGitHubStatus: async () => readyGitHubStatus(),
    previewGitHubSearch: () => null,
    rawSearchConsentStore: store,
    onError() {},
  });
  const firstAddress = await firstApi.listen();
  context.after(() => firstApi.close());
  baseUrl = `http://127.0.0.1:${firstAddress.port}`;
  globalThis.fetch = (input, options) => originalFetch(
    String(input).replace("http://127.0.0.1:4318", baseUrl),
    options,
  );
  context.after(() => { globalThis.fetch = originalFetch; });
  const post = (path, body) => originalFetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const controller = controllerWith({
    recommendTask: async (query) => {
      const response = await post("/api/recommend", { query });
      return response.json();
    },
    searchOriginalGitHubSkills,
    revokeOriginalSearchConsent: async (token) => {
      revokeCalls += 1;
      await gate.promise;
      await revokeOriginalSearchConsent(token);
    },
  });
  controller.changeQuery("原始任务");
  await controller.submit();
  const grant = controller.getState().rawConsent;
  const confirmation = controller.confirmOriginalSearch();
  await waitFor(() => revokeCalls === 1);
  assert.equal(revokeCalls, 1);
  gate.resolve();
  await confirmation;
  assert.equal(controller.getState().phase, "raw-error");
  assert.equal(controller.getState().error.code, "github-suggestions-unavailable");

  let finderCalls = 0;
  const secondApi = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => ({ level: "none", results: [] }),
    getGitHubStatus: async () => readyGitHubStatus(),
    previewGitHubSearch: () => null,
    findOriginalGitHubSuggestions: async () => {
      finderCalls += 1;
      return { ...suggestions(), preview: null };
    },
    rawSearchConsentStore: store,
    onError() {},
  });
  const secondAddress = await secondApi.listen();
  context.after(() => secondApi.close());
  baseUrl = `http://127.0.0.1:${secondAddress.port}`;
  const rejected = await post("/api/github-suggestions/original", {
    query: "原始任务",
    consentToken: grant.token,
  });
  assert.equal(rejected.status, 403);
  assert.equal(finderCalls, 0);
});

test("revoke failure is safe, retains the grant, and retries without enabling confirm", async () => {
  const sentinel = "private-revoke-failure-detail";
  let revokeCalls = 0;
  const controller = controllerWith({
    recommendTask: async () => recommendation({ rawConsent: consent }),
    revokeOriginalSearchConsent: async () => {
      revokeCalls += 1;
      if (revokeCalls === 1) throw new Error(sentinel);
    },
  });
  controller.changeQuery("原始任务");
  await controller.submit();

  assert.equal(await controller.cancelOriginalSearch(), false);
  assert.equal(controller.getState().phase, "raw-revoke-error");
  assert.equal(controller.getState().rawConsent.token, consent.token);
  assert.equal(await controller.confirmOriginalSearch(), false);
  const copy = formatTaskSearchError(controller.getState().error);
  assert.equal(copy, "未能确认撤销，请重试取消或等待授权自动失效。");
  assert.doesNotMatch(copy, new RegExp(sentinel, "u"));

  assert.equal(await controller.cancelOriginalSearch(), true);
  assert.equal(revokeCalls, 2);
  assert.equal(controller.getState().phase, "cancelled");
  assert.equal(controller.getState().rawConsent, null);
});

test("double cancel shares one in-flight revocation and blocks confirm", async () => {
  const gate = deferred();
  let revokeCalls = 0;
  const controller = controllerWith({
    recommendTask: async () => recommendation({ rawConsent: consent }),
    revokeOriginalSearchConsent: async () => {
      revokeCalls += 1;
      await gate.promise;
    },
  });
  controller.changeQuery("原始任务");
  await controller.submit();
  const first = controller.cancelOriginalSearch();
  const second = controller.cancelOriginalSearch();
  assert.equal(second, first);
  assert.equal(revokeCalls, 1);
  assert.equal(await controller.confirmOriginalSearch(), false);
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(revokeCalls, 1);
});

test("query editing is instant but submit waits behind its revoke barrier", async () => {
  const gate = deferred();
  let recommendationCalls = 0;
  const controller = controllerWith({
    recommendTask: async () => {
      recommendationCalls += 1;
      return recommendation({
        rawConsent: recommendationCalls === 1 ? consent : null,
        localMatchLevel: recommendationCalls === 1 ? "none" : "strong",
        results: recommendationCalls === 1 ? [] : [{ skillId: "new-result" }],
      });
    },
    revokeOriginalSearchConsent: async () => gate.promise,
  });
  controller.changeQuery("旧任务");
  await controller.submit();
  controller.changeQuery("新任务");
  assert.equal(controller.getState().query, "新任务");
  assert.equal(controller.getState().submittedQuery, "");
  assert.equal(controller.getState().phase, "raw-revoking");
  assert.equal(await controller.submit(), false);
  assert.equal(recommendationCalls, 1);

  gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.getState().phase, "cancelled");
  assert.equal(await controller.submit(), true);
  assert.equal(recommendationCalls, 2);
});

test("replacement submit awaits revocation and stops safely when revocation fails", async () => {
  const gate = deferred();
  let recommendationCalls = 0;
  const controller = controllerWith({
    recommendTask: async () => {
      recommendationCalls += 1;
      return recommendation({
        rawConsent: recommendationCalls === 1 ? consent : null,
        localMatchLevel: recommendationCalls === 1 ? "none" : "strong",
        results: recommendationCalls === 1 ? [] : [{ skillId: "replacement" }],
      });
    },
    revokeOriginalSearchConsent: async () => gate.promise,
  });
  controller.changeQuery("原始任务");
  await controller.submit();
  const replacement = controller.submit();
  assert.equal(controller.getState().phase, "raw-revoking");
  assert.equal(recommendationCalls, 1);
  gate.resolve();
  assert.equal(await replacement, true);
  assert.equal(recommendationCalls, 2);

  let failedRecommendations = 0;
  const failed = controllerWith({
    recommendTask: async () => {
      failedRecommendations += 1;
      return recommendation({ rawConsent: consent });
    },
    revokeOriginalSearchConsent: async () => { throw new Error("private-failure"); },
  });
  failed.changeQuery("原始任务");
  await failed.submit();
  assert.equal(await failed.submit(), false);
  assert.equal(failedRecommendations, 1);
  assert.equal(failed.getState().phase, "raw-revoke-error");
});

test("dispose initiates one best-effort revocation and clears retained raw state", async () => {
  const gate = deferred();
  let revokeCalls = 0;
  const controller = controllerWith({
    recommendTask: async () => recommendation({ rawConsent: consent }),
    revokeOriginalSearchConsent: async () => {
      revokeCalls += 1;
      await gate.promise;
    },
  });
  controller.changeQuery("原始任务");
  await controller.submit();
  controller.dispose();
  assert.equal(revokeCalls, 1);
  assert.equal(controller.getState().rawConsent, null);
  controller.dispose();
  assert.equal(revokeCalls, 1);
  gate.resolve();
});

test("a safely reused token is revoked once for each distinct consent grant", async () => {
  const revokeCalls = [];
  const controller = controllerWith({
    recommendTask: async () => recommendation({ rawConsent: { ...consent } }),
    revokeOriginalSearchConsent: async (token) => {
      revokeCalls.push(token);
    },
  });
  controller.changeQuery("原始任务");
  await controller.submit();
  assert.equal(await controller.cancelOriginalSearch(), true);
  await controller.submit();
  assert.equal(await controller.cancelOriginalSearch(), true);
  await Promise.resolve();
  assert.deepEqual(revokeCalls, [consent.token, consent.token]);
});

test("query changes, replacement submits, and disposal revoke abandoned consent", async () => {
  for (const action of ["change", "submit", "dispose"]) {
    const revokeCalls = [];
    let recommendations = 0;
    const controller = controllerWith({
      recommendTask: async () => {
        recommendations += 1;
        return recommendation({
          rawConsent: recommendations === 1
            ? consent
            : { ...consent, token: "replacement-consent-token" },
        });
      },
      revokeOriginalSearchConsent: async (token) => {
        revokeCalls.push(token);
      },
    });
    controller.changeQuery("原始任务");
    await controller.submit();

    if (action === "change") controller.changeQuery("新任务");
    if (action === "submit") await controller.submit();
    if (action === "dispose") controller.dispose();
    if (action === "change") await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      controller.getState().rawConsent?.token ?? null,
      action === "submit" ? "replacement-consent-token" : null,
    );
    await Promise.resolve();
    assert.deepEqual(revokeCalls, [consent.token], action);
  }
});

test("new submit replaces raw consent before the next request settles", async () => {
  const next = deferred();
  const revokeCalls = [];
  let calls = 0;
  const controller = controllerWith({
    recommendTask: async () => {
      calls += 1;
      return calls === 1 ? recommendation({ rawConsent: consent }) : next.promise;
    },
    revokeOriginalSearchConsent: async (token) => {
      revokeCalls.push(token);
    },
  });
  controller.changeQuery("原始任务");
  await controller.submit();
  const replacement = controller.submit();
  assert.equal(controller.getState().phase, "raw-revoking");
  assert.equal(controller.getState().rawConsent.token, consent.token);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.getState().rawConsent, null);
  assert.deepEqual(revokeCalls, [consent.token]);
  next.resolve(recommendation({
    localMatchLevel: "strong",
    results: [{ skillId: "replacement" }],
  }));
  await replacement;
});

test("cancel and confirm races never revoke a token after original search begins", async () => {
  const revokeCalls = [];
  let originalCalls = 0;
  const controller = controllerWith({
    recommendTask: async () => recommendation({ rawConsent: consent }),
    searchOriginalGitHubSkills: async () => {
      originalCalls += 1;
      return suggestions();
    },
    revokeOriginalSearchConsent: async (token) => {
      revokeCalls.push(token);
    },
  });
  controller.changeQuery("原始任务");
  await controller.submit();
  const confirmed = controller.confirmOriginalSearch();
  assert.equal(await controller.cancelOriginalSearch(), false);
  await confirmed;
  assert.equal(originalCalls, 1);
  assert.deepEqual(revokeCalls, []);

  const cancelled = controllerWith({
    recommendTask: async () => recommendation({ rawConsent: consent }),
    searchOriginalGitHubSkills: async () => {
      originalCalls += 1;
      return suggestions();
    },
    revokeOriginalSearchConsent: async (token) => {
      revokeCalls.push(token);
    },
  });
  cancelled.changeQuery("原始任务");
  await cancelled.submit();
  assert.equal(await cancelled.cancelOriginalSearch(), true);
  assert.equal(await cancelled.confirmOriginalSearch(), false);
  await Promise.resolve();
  assert.equal(originalCalls, 1);
  assert.deepEqual(revokeCalls, [consent.token]);
});

test("stale or unusable response consent is revoked and failures never restore it", async () => {
  const pending = deferred();
  const revokeCalls = [];
  const controller = controllerWith({
    recommendTask: async () => pending.promise,
    revokeOriginalSearchConsent: async (token) => {
      revokeCalls.push(token);
      throw new Error("private-revoke-failure");
    },
  });
  controller.changeQuery("旧任务");
  const request = controller.submit();
  controller.changeQuery("新任务");
  pending.resolve(recommendation({ rawConsent: consent }));
  await request;
  await Promise.resolve();
  assert.deepEqual(revokeCalls, [consent.token]);
  assert.equal(controller.getState().rawConsent, null);
  assert.equal(controller.getState().query, "新任务");
});

test("abandonment paths revoke real loopback tokens before they can authorize original search", async (context) => {
  let tokenIndex = 0;
  let originalFinderCalls = 0;
  const store = createRawSearchConsentStore({
    createToken: () => `loopback-consent-token-${tokenIndex += 1}`,
  });
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => ({ level: "none", results: [] }),
    getGitHubStatus: async () => readyGitHubStatus(),
    previewGitHubSearch: () => null,
    findOriginalGitHubSuggestions: async () => {
      originalFinderCalls += 1;
      return suggestions();
    },
    rawSearchConsentStore: store,
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function post(path, body) {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  for (const action of ["cancel", "change", "dispose", "submit"]) {
    const revokeCalls = [];
    const revocations = [];
    let controllerOriginalCalls = 0;
    const controller = controllerWith({
      recommendTask: async (query) => {
        const response = await post("/api/recommend", { query });
        assert.equal(response.status, 200);
        return response.json();
      },
      searchOriginalGitHubSkills: async () => {
        controllerOriginalCalls += 1;
        return suggestions();
      },
      revokeOriginalSearchConsent(token) {
        revokeCalls.push(token);
        const revocation = post("/api/github-suggestions/revoke", { consentToken: token })
          .then((response) => assert.equal(response.status, 204));
        revocations.push(revocation);
        return revocation;
      },
    });
    controller.changeQuery(`原始任务-${action}`);
    await controller.submit();
    const abandoned = controller.getState().rawConsent;
    assert.ok(abandoned);

    if (action === "cancel") await controller.cancelOriginalSearch();
    if (action === "change") controller.changeQuery("替代任务");
    if (action === "dispose") controller.dispose();
    if (action === "submit") await controller.submit();
    if (action === "change") {
      await Promise.all(revocations);
      await new Promise((resolve) => setImmediate(resolve));
    }

    assert.equal(controllerOriginalCalls, 0);
    assert.equal(controller.getState().rawConsent?.token === abandoned.token, false, action);
    await Promise.all(revocations);
    assert.deepEqual(revokeCalls, [abandoned.token], action);

    const rejected = await post("/api/github-suggestions/original", {
      query: `原始任务-${action}`,
      consentToken: abandoned.token,
    });
    assert.equal(rejected.status, 403, action);
  }
  assert.equal(originalFinderCalls, 0);
});

test("a token reused after real loopback revocation is revoked for its second grant", async (context) => {
  const reusedToken = "reused-loopback-consent-token";
  const store = createRawSearchConsentStore({ createToken: () => reusedToken });
  const api = createLocalApi({
    port: 0,
    syncCatalog: async () => ({ skills: [] }),
    getCatalog: async () => ({ skills: [] }),
    recommend: () => ({ level: "none", results: [] }),
    getGitHubStatus: async () => readyGitHubStatus(),
    previewGitHubSearch: () => null,
    findOriginalGitHubSuggestions: async () => suggestions(),
    rawSearchConsentStore: store,
    onError() {},
  });
  const address = await api.listen();
  context.after(() => api.close());
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const revocations = [];
  const revokeCalls = [];
  const post = (path, body) => fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const controller = controllerWith({
    recommendTask: async (query) => {
      const response = await post("/api/recommend", { query });
      assert.equal(response.status, 200);
      return response.json();
    },
    revokeOriginalSearchConsent(token) {
      revokeCalls.push(token);
      const revocation = post("/api/github-suggestions/revoke", { consentToken: token })
        .then((response) => assert.equal(response.status, 204));
      revocations.push(revocation);
      return revocation;
    },
  });
  controller.changeQuery("原始任务");
  await controller.submit();
  await controller.cancelOriginalSearch();
  await controller.submit();
  await controller.cancelOriginalSearch();
  assert.deepEqual(revokeCalls, [reusedToken, reusedToken]);

  const rejected = await post("/api/github-suggestions/original", {
    query: "原始任务",
    consentToken: reusedToken,
  });
  assert.equal(rejected.status, 403);
});

test("incomplete empty original results are mutually exclusive with a verified empty result", async () => {
  const controller = controllerWith({
    recommendTask: async () => recommendation({ rawConsent: consent }),
    searchOriginalGitHubSkills: async () => suggestions({ results: [], incomplete: true }),
  });
  controller.changeQuery("原始任务");
  await controller.submit();
  await controller.confirmOriginalSearch();
  const state = controller.getState();
  assert.equal(state.githubIncomplete, true);
  assert.equal(state.originalOutcome, "incomplete");
  assert.notEqual(state.originalOutcome, "empty");
});

test("arbitrary sanitized and original exceptions become fixed stage recovery copy", async () => {
  const sentinel = "private-error-sentinel";
  const sanitized = controllerWith({
    recommendTask: async () => recommendation({ githubSearch: preview }),
    searchSanitizedGitHubSkills: async () => { throw new Error(sentinel); },
  });
  sanitized.changeQuery("任务");
  await sanitized.submit();
  const sanitizedCopy = formatTaskSearchError(sanitized.getState().error);
  assert.equal(sanitizedCopy, "连接 GitHub 失败，请重试脱敏搜索。");
  assert.doesNotMatch(sanitizedCopy, new RegExp(sentinel, "u"));

  const original = controllerWith({
    recommendTask: async () => recommendation({ rawConsent: consent }),
    searchOriginalGitHubSkills: async () => { throw new Error(sentinel); },
  });
  original.changeQuery("任务");
  await original.submit();
  await original.confirmOriginalSearch();
  const originalCopy = formatTaskSearchError(original.getState().error);
  assert.equal(originalCopy, "连接 GitHub 失败，请重新匹配后再试原文搜索。");
  assert.doesNotMatch(originalCopy, new RegExp(sentinel, "u"));
});

test("malformed 200 responses cannot leak payload text through either GitHub stage", async (context) => {
  const originalFetch = globalThis.fetch;
  const sentinel = "private-malformed-response-sentinel";
  const revokeCalls = [];
  globalThis.fetch = async () => Response.json({ sentinel });
  context.after(() => { globalThis.fetch = originalFetch; });

  const sanitized = controllerWith({
    recommendTask: async () => recommendation({ githubSearch: preview }),
    searchSanitizedGitHubSkills,
  });
  sanitized.changeQuery("任务");
  await sanitized.submit();
  const sanitizedCopy = formatTaskSearchError(sanitized.getState().error);
  assert.equal(sanitizedCopy, "GitHub 返回的数据无法验证，请重试脱敏搜索。");
  assert.doesNotMatch(sanitizedCopy, new RegExp(sentinel, "u"));

  const original = controllerWith({
    recommendTask: async () => recommendation({ rawConsent: consent }),
    searchOriginalGitHubSkills,
    revokeOriginalSearchConsent: async (token) => {
      revokeCalls.push(token);
    },
  });
  original.changeQuery("任务");
  await original.submit();
  await original.confirmOriginalSearch();
  const originalCopy = formatTaskSearchError(original.getState().error);
  assert.equal(originalCopy, "GitHub 返回的数据无法验证，请重新匹配后再试原文搜索。");
  assert.doesNotMatch(originalCopy, new RegExp(sentinel, "u"));
  assert.deepEqual(revokeCalls, [consent.token]);
});

test("unrelated AbortError failures become safe errors instead of leaving a stage busy", async () => {
  const sanitized = controllerWith({
    recommendTask: async () => recommendation({ githubSearch: preview }),
    searchSanitizedGitHubSkills: async (_query, signal) => {
      assert.equal(signal.aborted, false);
      throw new DOMException("dependency-abort-sentinel", "AbortError");
    },
  });
  sanitized.changeQuery("任务");
  await sanitized.submit();
  assert.equal(sanitized.getState().phase, "sanitized-error");
  assert.equal(isTaskSearchInFlight(sanitized.getState()), false);
  assert.equal(
    formatTaskSearchError(sanitized.getState().error),
    "连接 GitHub 失败，请重试脱敏搜索。",
  );

  const original = controllerWith({
    recommendTask: async () => recommendation({ rawConsent: consent }),
    searchOriginalGitHubSkills: async (_query, _token, signal) => {
      assert.equal(signal.aborted, false);
      throw new DOMException("dependency-abort-sentinel", "AbortError");
    },
    revokeOriginalSearchConsent: async (token) => {
      assert.equal(token, consent.token);
    },
  });
  original.changeQuery("任务");
  await original.submit();
  await original.confirmOriginalSearch();
  assert.equal(original.getState().phase, "raw-error");
  assert.equal(isTaskSearchInFlight(original.getState()), false);
  assert.equal(
    formatTaskSearchError(original.getState().error),
    "连接 GitHub 失败，请重新匹配后再试原文搜索。",
  );
});
