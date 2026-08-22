import {
  isAbortError,
  readBrowserApiError,
  type BrowserApiErrorCode,
} from "./api.ts";
import type {
  GitHubSearchPreview,
  GitHubSearchDiagnostics,
  GitHubSearchStage,
  GitHubServiceStatus,
  GitHubSkillSuggestion,
  GitHubSuggestionResponse,
  LocalMatchLevel,
  RawSearchConsent,
  Recommendation,
  TaskRecommendationResponse,
} from "./catalog.ts";

export type TaskSearchPhase =
  | "idle"
  | "local-searching"
  | "sanitized-searching"
  | "sanitized-error"
  | "raw-consent"
  | "raw-revoking"
  | "raw-revoke-error"
  | "raw-searching"
  | "raw-error"
  | "complete"
  | "cancelled";

export type OriginalSearchOutcome = "none" | "results" | "empty" | "incomplete";
export type TaskSearchErrorCode = BrowserApiErrorCode | "raw-consent-unavailable" | "raw-revoke-error";
export type TaskSearchErrorStage = "local" | "sanitized" | "original" | "revoke";

export interface TaskSearchError {
  stage: TaskSearchErrorStage;
  code: TaskSearchErrorCode;
  retryAt: string | null;
}

export interface TaskSearchState {
  query: string;
  submittedQuery: string;
  localMatchLevel: LocalMatchLevel | null;
  results: Recommendation[] | null;
  githubSearch: GitHubSearchPreview | null;
  githubResults: GitHubSkillSuggestion[] | null;
  githubIncomplete: boolean;
  githubStatus: GitHubServiceStatus | null;
  githubDiagnostics: GitHubSearchDiagnostics | null;
  githubStage: GitHubSearchStage | null;
  rawConsent: RawSearchConsent | null;
  phase: TaskSearchPhase;
  originalOutcome: OriginalSearchOutcome;
  error: TaskSearchError | null;
}

interface TaskSearchDependencies {
  recommendTask(query: string, signal?: AbortSignal): Promise<TaskRecommendationResponse>;
  getGitHubStatus?(signal?: AbortSignal): Promise<GitHubServiceStatus>;
  searchSanitizedGitHubSkills(query: string, signal?: AbortSignal): Promise<GitHubSuggestionResponse>;
  searchOriginalGitHubSkills(
    query: string,
    consentToken: string,
    signal?: AbortSignal,
  ): Promise<GitHubSuggestionResponse>;
  revokeOriginalSearchConsent(consentToken: string): Promise<void>;
}

const INITIAL_STATE: TaskSearchState = {
  query: "",
  submittedQuery: "",
  localMatchLevel: null,
  results: null,
  githubSearch: null,
  githubResults: null,
  githubIncomplete: false,
  githubStatus: null,
  githubDiagnostics: null,
  githubStage: null,
  rawConsent: null,
  phase: "idle",
  originalOutcome: "none",
  error: null,
};

export function isTaskSearchInFlight(state: TaskSearchState) {
  return ["local-searching", "sanitized-searching", "raw-revoking", "raw-searching"].includes(state.phase);
}

function formatRetryTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

export function formatTaskSearchError(error: TaskSearchError | null) {
  if (!error) return "";
  if (error.stage === "revoke") {
    return "未能确认撤销，请重试取消或等待授权自动失效。";
  }
  if (error.stage === "local") {
    if (error.code === "local-origin-forbidden") return "本机访问来源未获允许。";
    if (error.code === "local-query-too-long") return "任务描述过长，请缩短后重新匹配。";
    if (error.code === "local-response-invalid") return "本机数据响应无效，请重新启动看台后重试。";
    return "本机数据服务暂时不可用，请重试。";
  }

  if (error.code === "github-rate-limited") {
    const retry = error.retryAt && Number.isFinite(Date.parse(error.retryAt))
      ? `可在 ${formatRetryTime(error.retryAt)} 后`
      : "请稍后";
    return error.stage === "sanitized"
      ? `GitHub 当前限流，${retry}重试脱敏搜索。`
      : `GitHub 当前限流，${retry}重新匹配并重试原文搜索。`;
  }
  if (error.code === "github-token-missing") {
    return "未检测到 GitHub Token，请配置后重新启动看台。";
  }
  if (error.code === "github-token-invalid") {
    return "GitHub Token 无效，请更正后重新启动看台。";
  }
  if (error.code === "github-access-denied") {
    return "GitHub 拒绝了当前 Token 的访问权限，请检查权限后重试。";
  }
  if (error.code === "local-match-available") {
    return "本机 Skill 已更新，请重新匹配查看本地结果。";
  }
  if (error.code === "local-origin-forbidden") return "本机访问来源未获允许。";
  if (error.code === "github-suggestions-unavailable") {
    return "GitHub 查找功能暂时不可用，请稍后重新匹配。";
  }

  if (error.stage === "sanitized") {
    if (error.code === "sanitized-query-unavailable") return "无法生成安全能力词，请重新匹配。";
    if (error.code === "github-query-rejected" || error.code === "github-request-invalid") {
      return "GitHub 不接受这次脱敏搜索，请改写或缩短任务后重新匹配。";
    }
    if (error.code === "github-request-timeout") return "脱敏搜索超时，请重试脱敏搜索。";
    if (error.code === "github-response-invalid") return "GitHub 返回的数据无法验证，请重试脱敏搜索。";
    if (error.code === "raw-consent-unavailable") {
      return "脱敏搜索已完成，但未取得原文发送许可。请重新匹配。";
    }
    return "连接 GitHub 失败，请重试脱敏搜索。";
  }

  if (error.code === "raw-consent-required") return "原文发送许可已失效，请重新匹配。";
  if (error.code === "github-query-rejected" || error.code === "github-request-invalid") {
    return "GitHub 不接受这段完整查询，未进行截断。请改写或缩短任务后重新匹配。";
  }
  if (error.code === "github-request-timeout") return "原文搜索超时，请重新匹配后再试。";
  if (error.code === "github-response-invalid") return "GitHub 返回的数据无法验证，请重新匹配后再试原文搜索。";
  return "连接 GitHub 失败，请重新匹配后再试原文搜索。";
}

function normalizeError(value: unknown, stage: TaskSearchErrorStage): TaskSearchError {
  const safe = readBrowserApiError(value);
  return {
    stage,
    code: safe?.code ?? (stage === "local" ? "local-service-unavailable" : "github-network-failed"),
    retryAt: safe?.retryAt ?? null,
  };
}

function cloneRateLimits(value: GitHubServiceStatus["rateLimits"]) {
  const cloneBucket = (bucket: GitHubServiceStatus["rateLimits"]["search"]) => bucket
    ? { remaining: bucket.remaining, reset: bucket.reset, retryAt: bucket.retryAt }
    : null;
  return {
    search: cloneBucket(value.search),
    codeSearch: cloneBucket(value.codeSearch),
  };
}

function materializeGitHubStatus(status: GitHubServiceStatus | null | undefined) {
  return status
    ? {
        state: status.state,
        checkedAt: status.checkedAt,
        rateLimits: cloneRateLimits(status.rateLimits),
      }
    : null;
}

function materializeGitHubDiagnostics(diagnostics: GitHubSearchDiagnostics) {
  return {
    stageReached: diagnostics.stageReached,
    repositoryHits: diagnostics.repositoryHits,
    codeHits: diagnostics.codeHits,
    validatedCandidates: diagnostics.validatedCandidates,
    rejectedCandidates: diagnostics.rejectedCandidates,
    deduplicatedCandidates: diagnostics.deduplicatedCandidates,
    rejectionCounts: diagnostics.rejectionCounts.map((item) => ({
      reason: item.reason,
      count: item.count,
    })),
    cached: diagnostics.cached,
    incomplete: diagnostics.incomplete,
    rateLimits: cloneRateLimits(diagnostics.rateLimits),
  };
}

function unavailableStatusError(status: GitHubServiceStatus): TaskSearchError | null {
  const codes: Partial<Record<GitHubServiceStatus["state"], TaskSearchErrorCode>> = {
    "missing-token": "github-token-missing",
    "invalid-token": "github-token-invalid",
    "rate-limited": "github-rate-limited",
    "github-unavailable": "github-network-failed",
  };
  const code = codes[status.state];
  if (!code) return null;
  return {
    stage: "sanitized",
    code,
    retryAt: status.state === "rate-limited"
      ? status.rateLimits.search?.retryAt ?? null
      : null,
  };
}

function normalizeGitHubError(value: unknown, stage: "sanitized" | "original") {
  const safe = readBrowserApiError(value);
  return {
    error: normalizeError(value, stage),
    githubStage: safe?.stage ?? "repository-search" as GitHubSearchStage,
  };
}

export function createTaskSearchController(dependencies: TaskSearchDependencies) {
  let state: TaskSearchState = { ...INITIAL_STATE };
  let requestVersion = 0;
  let requestInFlight = false;
  let activeRequest: AbortController | null = null;
  let originalConsentInFlight: RawSearchConsent | null = null;
  let statusVersion = 0;
  let activeStatusRequest: AbortController | null = null;
  let statusRequestInFlight: Promise<boolean> | null = null;
  let disposed = false;
  const successfulRevocations = new WeakSet<RawSearchConsent>();
  const inFlightRevocations = new WeakMap<RawSearchConsent, Promise<boolean>>();
  const interactiveRevocations = new WeakMap<RawSearchConsent, Promise<boolean>>();
  const listeners = new Set<(next: TaskSearchState) => void>();

  function update(patch: Partial<TaskSearchState>) {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  }

  function isCurrent(version: number) {
    return !disposed && version === requestVersion;
  }

  function startRequest() {
    activeRequest?.abort();
    activeRequest = new AbortController();
    requestInFlight = true;
    requestVersion += 1;
    return { controller: activeRequest, version: requestVersion };
  }

  function finishRequest(version: number) {
    if (!isCurrent(version)) return;
    requestInFlight = false;
    activeRequest = null;
  }

  function replaceGitHubStatus(status: GitHubServiceStatus) {
    statusVersion += 1;
    activeStatusRequest?.abort();
    activeStatusRequest = null;
    statusRequestInFlight = null;
    const githubStatus = materializeGitHubStatus(status);
    update({ githubStatus });
    return githubStatus;
  }

  function refreshGitHubStatus() {
    if (disposed || !dependencies.getGitHubStatus) return Promise.resolve(false);
    if (statusRequestInFlight) return statusRequestInFlight;
    const controller = new AbortController();
    const version = statusVersion + 1;
    statusVersion = version;
    activeStatusRequest = controller;
    const request = Promise.resolve()
      .then(() => dependencies.getGitHubStatus?.(controller.signal))
      .then((status) => {
        if (
          !status ||
          disposed ||
          version !== statusVersion ||
          controller.signal.aborted
        ) return false;
        update({ githubStatus: materializeGitHubStatus(status) });
        return true;
      }, (error) => {
        if (
          disposed ||
          version !== statusVersion ||
          (isAbortError(error) && controller.signal.aborted)
        ) return false;
        return false;
      });
    const tracked = request.finally(() => {
      if (statusRequestInFlight === tracked) statusRequestInFlight = null;
      if (activeStatusRequest === controller) activeStatusRequest = null;
    });
    statusRequestInFlight = tracked;
    return tracked;
  }

  function revokeConsent(consent: RawSearchConsent) {
    if (successfulRevocations.has(consent)) return Promise.resolve(true);
    const existing = inFlightRevocations.get(consent);
    if (existing) return existing;

    let request: Promise<boolean>;
    try {
      request = Promise.resolve(dependencies.revokeOriginalSearchConsent(consent.token))
        .then(() => {
          successfulRevocations.add(consent);
          return true;
        }, () => false);
    } catch {
      request = Promise.resolve(false);
    }
    const tracked = request.finally(() => {
      if (inFlightRevocations.get(consent) === tracked) inFlightRevocations.delete(consent);
    });
    inFlightRevocations.set(consent, tracked);
    return tracked;
  }

  function revokeConsentBestEffort(consent: RawSearchConsent | null) {
    if (!consent) return;
    void revokeConsent(consent);
  }

  async function revokeUncertainOriginalConsent(consent: RawSearchConsent) {
    if (originalConsentInFlight !== consent) {
      const existing = interactiveRevocations.get(consent) ?? inFlightRevocations.get(consent);
      if (existing) await existing;
      return { owned: false, revoked: successfulRevocations.has(consent) };
    }

    const revoked = await revokeConsent(consent);
    const owned = originalConsentInFlight === consent;
    if (owned) originalConsentInFlight = null;
    return { owned, revoked };
  }

  function beginRevocationBarrier(consent: RawSearchConsent) {
    const existing = interactiveRevocations.get(consent);
    if (existing) return existing;
    update({
      phase: "raw-revoking",
      originalOutcome: "none",
      error: null,
    });
    const barrier = revokeConsent(consent)
      .then((revoked) => {
        if (!disposed && state.rawConsent === consent) {
          update(revoked
            ? {
                rawConsent: null,
                phase: "cancelled",
                originalOutcome: "none",
                error: null,
              }
            : {
                phase: "raw-revoke-error",
                originalOutcome: "none",
                error: { stage: "revoke", code: "raw-revoke-error", retryAt: null },
              });
        }
        return revoked;
      })
      .finally(() => {
        if (interactiveRevocations.get(consent) === barrier) {
          interactiveRevocations.delete(consent);
        }
      });
    interactiveRevocations.set(consent, barrier);
    return barrier;
  }

  function materializeConsent(consent: RawSearchConsent | null) {
    return consent ? { token: consent.token, expiresAt: consent.expiresAt } : null;
  }

  async function runSanitizedSearch(
    query: string,
    preview: GitHubSearchPreview,
    version: number,
    signal: AbortSignal,
  ) {
    update({
      githubSearch: preview,
      githubResults: null,
      githubIncomplete: false,
      githubDiagnostics: null,
      githubStage: "repository-search",
      rawConsent: null,
      phase: "sanitized-searching",
      originalOutcome: "none",
      error: null,
    });
    try {
      const response = await dependencies.searchSanitizedGitHubSkills(query, signal);
      const responseConsent = materializeConsent(response.rawConsent);
      if (!isCurrent(version)) {
        revokeConsentBestEffort(responseConsent);
        return;
      }
      const githubResults = response.results.slice(0, 3);
      const githubDiagnostics = materializeGitHubDiagnostics(response.diagnostics);
      const responseIncomplete = response.incomplete ||
        githubDiagnostics.incomplete ||
        githubDiagnostics.stageReached !== "complete";
      if (responseIncomplete) {
        revokeConsentBestEffort(responseConsent);
        update({
          githubResults,
          githubIncomplete: true,
          githubDiagnostics,
          githubStage: githubDiagnostics.stageReached,
          rawConsent: null,
          phase: "sanitized-error",
          error: null,
        });
      } else if (githubResults.length === 0 && responseConsent) {
        update({
          githubResults,
          githubIncomplete: false,
          githubDiagnostics,
          githubStage: githubDiagnostics.stageReached,
          rawConsent: responseConsent,
          phase: "raw-consent",
          error: null,
        });
      } else if (githubResults.length === 0) {
        revokeConsentBestEffort(responseConsent);
        update({
          githubResults,
          githubIncomplete: false,
          githubDiagnostics,
          githubStage: githubDiagnostics.stageReached,
          rawConsent: null,
          phase: "sanitized-error",
          error: { stage: "sanitized", code: "raw-consent-unavailable", retryAt: null },
        });
      } else {
        revokeConsentBestEffort(responseConsent);
        update({
          githubResults,
          githubIncomplete: false,
          githubDiagnostics,
          githubStage: githubDiagnostics.stageReached,
          rawConsent: null,
          phase: "complete",
          error: null,
        });
      }
    } catch (error) {
      if (!isCurrent(version) || (isAbortError(error) && signal.aborted)) return;
      const normalized = normalizeGitHubError(error, "sanitized");
      update({
        githubResults: null,
        githubIncomplete: false,
        githubDiagnostics: null,
        githubStage: normalized.githubStage,
        rawConsent: null,
        phase: "sanitized-error",
        error: normalized.error,
      });
    }
  }

  return {
    getState() {
      return state;
    },
    subscribe(listener: (next: TaskSearchState) => void) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refreshGitHubStatus,
    changeQuery(value: string) {
      if (disposed) return;
      if (state.phase === "raw-consent" && value.trim() === state.submittedQuery) {
        update({ query: value });
        return;
      }
      requestVersion += 1;
      requestInFlight = false;
      activeRequest?.abort();
      activeRequest = null;
      const abandonedConsent = state.rawConsent ?? originalConsentInFlight;
      if (originalConsentInFlight === abandonedConsent) originalConsentInFlight = null;
      const githubStatus = state.githubStatus;
      if (abandonedConsent) {
        update({
          ...INITIAL_STATE,
          query: value,
          githubStatus,
          rawConsent: abandonedConsent,
          phase: "raw-revoking",
        });
        void beginRevocationBarrier(abandonedConsent);
        return;
      }
      update({ ...INITIAL_STATE, query: value, githubStatus });
    },
    async submit() {
      const taskQuery = state.query.trim();
      if (
        disposed ||
        requestInFlight ||
        ["raw-revoking", "raw-revoke-error"].includes(state.phase) ||
        !taskQuery
      ) return false;
      const abandonedConsent = state.rawConsent;
      if (abandonedConsent) {
        requestVersion += 1;
        const barrierVersion = requestVersion;
        const revoked = await beginRevocationBarrier(abandonedConsent);
        if (
          !revoked ||
          disposed ||
          barrierVersion !== requestVersion ||
          taskQuery !== state.query.trim()
        ) {
          return false;
        }
      }
      const { controller, version } = startRequest();
      const currentGitHubStatus = state.githubStatus;
      update({
        ...INITIAL_STATE,
        query: state.query,
        submittedQuery: taskQuery,
        githubStatus: currentGitHubStatus,
        phase: "local-searching",
      });
      try {
        const response = await dependencies.recommendTask(taskQuery, controller.signal);
        const responseConsent = materializeConsent(response.rawConsent);
        if (!isCurrent(version)) {
          revokeConsentBestEffort(responseConsent);
          return true;
        }
        if (response.localMatchLevel === "strong") {
          revokeConsentBestEffort(responseConsent);
          update({
            localMatchLevel: response.localMatchLevel,
            results: response.results,
            phase: "complete",
          });
          return true;
        }
        const githubStatus = response.githubStatus
          ? replaceGitHubStatus(response.githubStatus)
          : null;
        update({
          localMatchLevel: response.localMatchLevel,
          results: response.results,
          githubSearch: response.githubSearch,
        });
        if (!githubStatus) {
          revokeConsentBestEffort(responseConsent);
          update({
            githubStage: "repository-search",
            phase: "sanitized-error",
            error: { stage: "sanitized", code: "github-response-invalid", retryAt: null },
          });
        } else if (githubStatus.state !== "ready") {
          revokeConsentBestEffort(responseConsent);
          update({
            githubResults: null,
            githubIncomplete: false,
            githubDiagnostics: null,
            githubStage: "repository-search",
            rawConsent: null,
            phase: "sanitized-error",
            error: unavailableStatusError(githubStatus),
          });
        } else if (response.githubSearch) {
          revokeConsentBestEffort(responseConsent);
          await runSanitizedSearch(taskQuery, response.githubSearch, version, controller.signal);
        } else if (responseConsent) {
          update({ rawConsent: responseConsent, phase: "raw-consent" });
        } else {
          update({
            phase: "sanitized-error",
            error: { stage: "sanitized", code: "raw-consent-unavailable", retryAt: null },
          });
        }
      } catch (error) {
        if (!isCurrent(version) || (isAbortError(error) && controller.signal.aborted)) return true;
        update({
          rawConsent: null,
          phase: "idle",
          error: normalizeError(error, "local"),
        });
      } finally {
        finishRequest(version);
      }
      return true;
    },
    async retrySanitizedSearch() {
      if (
        disposed ||
        requestInFlight ||
        state.phase !== "sanitized-error" ||
        !state.githubSearch ||
        !state.submittedQuery
      ) return false;
      const query = state.submittedQuery;
      const preview = state.githubSearch;
      const { controller, version } = startRequest();
      try {
        const refreshed = await refreshGitHubStatus();
        if (!isCurrent(version)) return true;
        const githubStatus = state.githubStatus;
        if (!refreshed || !githubStatus || githubStatus.state !== "ready") {
          update({
            githubResults: state.githubResults,
            githubIncomplete: state.githubIncomplete,
            githubDiagnostics: state.githubDiagnostics,
            githubStage: "repository-search",
            rawConsent: null,
            phase: "sanitized-error",
            error: githubStatus && githubStatus.state !== "ready"
              ? unavailableStatusError(githubStatus)
              : { stage: "sanitized", code: "github-network-failed", retryAt: null },
          });
          return true;
        }
        await runSanitizedSearch(query, preview, version, controller.signal);
      } finally {
        finishRequest(version);
      }
      return true;
    },
    async confirmOriginalSearch() {
      if (
        disposed ||
        requestInFlight ||
        state.phase !== "raw-consent" ||
        !state.rawConsent ||
        !state.submittedQuery
      ) return false;
      const query = state.submittedQuery;
      const originalConsent = state.rawConsent;
      originalConsentInFlight = originalConsent;
      const { controller, version } = startRequest();
      update({
        githubResults: null,
        githubIncomplete: false,
        githubDiagnostics: null,
        githubStage: "repository-search",
        rawConsent: null,
        phase: "raw-searching",
        originalOutcome: "none",
        error: null,
      });
      try {
        const response = await dependencies.searchOriginalGitHubSkills(
          query,
          originalConsent.token,
          controller.signal,
        );
        if (!isCurrent(version)) {
          await revokeUncertainOriginalConsent(originalConsent);
          return true;
        }
        const githubResults = response.results.slice(0, 3);
        const githubDiagnostics = materializeGitHubDiagnostics(response.diagnostics);
        const githubIncomplete = response.incomplete ||
          githubDiagnostics.incomplete ||
          githubDiagnostics.stageReached !== "complete";
        originalConsentInFlight = null;
        update({
          githubResults,
          githubIncomplete,
          githubDiagnostics,
          githubStage: githubDiagnostics.stageReached,
          rawConsent: null,
          phase: "complete",
          originalOutcome: githubIncomplete
            ? "incomplete"
            : githubResults.length === 0
              ? "empty"
              : "results",
          error: null,
        });
      } catch (error) {
        const normalized = normalizeGitHubError(error, "original");
        const cleanup = await revokeUncertainOriginalConsent(originalConsent);
        if (cleanup.owned && isCurrent(version)) {
          update(cleanup.revoked
            ? {
                githubResults: null,
                githubIncomplete: false,
                githubDiagnostics: null,
                githubStage: normalized.githubStage,
                rawConsent: null,
                phase: "raw-error",
                originalOutcome: "none",
                error: normalized.error,
              }
            : {
                githubResults: null,
                githubIncomplete: false,
                githubDiagnostics: null,
                githubStage: normalized.githubStage,
                rawConsent: originalConsent,
                phase: "raw-revoke-error",
                originalOutcome: "none",
                error: { stage: "revoke", code: "raw-revoke-error", retryAt: null },
              });
        }
      } finally {
        finishRequest(version);
      }
      return true;
    },
    cancelOriginalSearch() {
      if (disposed || !state.rawConsent) return Promise.resolve(false);
      if (state.phase === "raw-revoking") {
        return beginRevocationBarrier(state.rawConsent);
      }
      if (!["raw-consent", "raw-revoke-error"].includes(state.phase)) {
        return Promise.resolve(false);
      }
      const abandonedConsent = state.rawConsent;
      requestVersion += 1;
      requestInFlight = false;
      activeRequest?.abort();
      activeRequest = null;
      return beginRevocationBarrier(abandonedConsent);
    },
    dispose() {
      if (disposed) return;
      const abandonedConsent = state.rawConsent ?? originalConsentInFlight;
      if (originalConsentInFlight === abandonedConsent) originalConsentInFlight = null;
      state = { ...state, submittedQuery: "", rawConsent: null, error: null };
      disposed = true;
      requestVersion += 1;
      requestInFlight = false;
      activeRequest?.abort();
      activeRequest = null;
      statusVersion += 1;
      activeStatusRequest?.abort();
      activeStatusRequest = null;
      statusRequestInFlight = null;
      listeners.clear();
      revokeConsentBestEffort(abandonedConsent);
    },
  };
}
