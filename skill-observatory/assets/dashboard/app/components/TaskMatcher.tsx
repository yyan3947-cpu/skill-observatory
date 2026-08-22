import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  getGitHubStatus,
  recommendTask,
  revokeOriginalSearchConsent,
  searchOriginalGitHubSkills,
  searchSanitizedGitHubSkills,
} from "../lib/api";
import { STATUS_LABELS, formatDate } from "../lib/catalog";
import {
  createTaskSearchController,
  formatTaskSearchError,
  isTaskSearchInFlight,
} from "../lib/task-search-controller";
import {
  TASK_SEARCH_REJECTION_REASONS,
  copyTaskSearchTestRecord,
  createTaskMatcherLifecycle,
  didStartGitHubSearch,
  getSafeLocalEvidence,
  getSentSanitizedTerms,
} from "../lib/task-search-diagnostics";

const GITHUB_STAGE_LABELS = {
  "repository-search": "仓库搜索",
  "code-search": "SKILL.md 检索",
  "candidate-validation": "候选验证",
  complete: "完成",
} as const;

const REJECTION_LABELS = {
  "invalid-structure": "结构无效",
  "invalid-content": "内容无效",
  irrelevant: "相关性不足",
  duplicate: "重复候选",
  unavailable: "候选不可用",
} as const;

function formatSkillPath(skillDirectory: string) {
  return skillDirectory === "." ? "SKILL.md" : `${skillDirectory}/SKILL.md`;
}

export function TaskMatcher() {
  const [controller] = useState(() => createTaskSearchController({
    recommendTask,
    getGitHubStatus,
    searchSanitizedGitHubSkills,
    searchOriginalGitHubSkills,
    revokeOriginalSearchConsent,
  }));
  const [state, setState] = useState(() => controller.getState());
  const [lifecycle] = useState(() => createTaskMatcherLifecycle(controller, setState));
  const [copyResult, setCopyResult] = useState<{
    state: typeof state;
    status: "copied" | "failed";
  } | null>(null);
  const copyGeneration = useRef(0);

  useEffect(() => {
    const unmount = lifecycle.mount();
    return () => {
      copyGeneration.current += 1;
      unmount();
    };
  }, [lifecycle]);

  function submit(event: FormEvent) {
    event.preventDefault();
    void controller.submit();
  }

  async function copyTestRecord() {
    setCopyResult(null);
    const generation = ++copyGeneration.current;
    const copiedState = state;
    const status = await copyTaskSearchTestRecord(copiedState, navigator.clipboard);
    if (generation !== copyGeneration.current) return;
    setCopyResult({ state: copiedState, status });
  }

  const {
    query,
    submittedQuery,
    localMatchLevel,
    results,
    githubSearch,
    githubResults,
    githubIncomplete,
    githubStatus,
    githubDiagnostics,
    githubStage,
    rawConsent,
    phase,
    originalOutcome,
    error,
  } = state;
  const copyStatus = copyResult?.state === state ? copyResult.status : "idle";
  const isSearching = isTaskSearchInFlight(state);
  const submitBlocked = isSearching || phase === "raw-revoke-error";
  const errorMessage = formatTaskSearchError(error);
  const showRawConsent = (phase === "raw-consent" && rawConsent) || phase === "raw-searching";
  const localEvidence = getSafeLocalEvidence(state);
  const sentSanitizedTerms = getSentSanitizedTerms(state);
  const githubSearchStarted = didStartGitHubSearch(state);
  const diagnosticRateLimits = githubDiagnostics?.rateLimits ?? githubStatus?.rateLimits ?? {
    search: null,
    codeSearch: null,
  };
  const stageReached = githubDiagnostics?.stageReached ?? (githubSearchStarted ? githubStage : null);
  let githubAvailability = "正在检查 GitHub 搜索状态…";
  if (githubStatus?.state === "ready") {
    githubAvailability = githubStatus.rateLimits.codeSearch?.remaining === 0
      ? "GitHub 仓库搜索可用；SKILL.md 检索额度已用完，本次可能只返回仓库搜索结果。"
      : "GitHub 搜索可用。";
  } else if (githubStatus?.state === "missing-token") {
    githubAvailability = "未配置 GitHub Token，仅显示本机匹配。";
  } else if (githubStatus?.state === "invalid-token") {
    githubAvailability = "GitHub Token 无效，仅显示本机匹配。";
  } else if (githubStatus?.state === "rate-limited") {
    githubAvailability = "GitHub 搜索已限流，仅显示本机匹配。";
  } else if (githubStatus?.state === "github-unavailable") {
    githubAvailability = "GitHub 暂时不可用，仅显示本机匹配。";
  }
  const submitLabel = phase === "local-searching"
    ? "匹配中…"
    : phase === "sanitized-searching"
      ? "脱敏搜索中…"
      : phase === "raw-searching"
        ? "原文搜索中…"
        : phase === "raw-revoking"
          ? "正在撤销授权…"
        : "匹配 Skill";
  let weakMatchMessage: string | null = null;
  if (localMatchLevel === "weak") {
    if (githubSearch) {
      if (phase === "sanitized-searching") {
        weakMatchMessage = "已保留以下本机可能相关的 Skill，正在使用脱敏能力词搜索 GitHub。";
      } else if (phase === "raw-consent") {
        weakMatchMessage = "已保留以下本机可能相关的 Skill。脱敏搜索没有找到结果；是否发送原始任务全文由你确认。";
      } else if (phase === "raw-searching") {
        weakMatchMessage = "已保留以下本机可能相关的 Skill。你已确认发送原始任务全文，正在搜索 GitHub。";
      } else if (phase === "sanitized-error") {
        weakMatchMessage = githubSearchStarted
          ? "已保留以下本机可能相关的 Skill；脱敏 GitHub 搜索未完整完成。"
          : "已保留以下本机可能相关的 Skill；GitHub 搜索未开始。";
      } else if (phase === "complete") {
        weakMatchMessage = originalOutcome === "none"
          ? "已保留以下本机可能相关的 Skill；脱敏 GitHub 搜索已完成。"
          : "已保留以下本机可能相关的 Skill；原文 GitHub 搜索已完成。";
      } else {
        weakMatchMessage = "以下本机 Skill 可能相关。";
      }
    } else if (phase === "raw-consent") {
      weakMatchMessage = "以下本机 Skill 可能相关。未生成可安全发送的能力词，尚未向 GitHub 发送查询；是否发送原始任务全文由你确认。";
    } else if (phase === "raw-searching") {
      weakMatchMessage = "以下本机 Skill 可能相关。你已确认发送原始任务全文，正在搜索 GitHub。";
    } else {
      weakMatchMessage = "以下本机 Skill 可能相关。";
    }
  }

  return (
    <section className="matcher panel" aria-labelledby="matcher-title">
      <div>
        <p className="section-kicker">TASK MATCHER</p>
        <h2 id="matcher-title">任务匹配器</h2>
        <p>输入你要做的事情，看台只会推荐最多 3 个高相关 Skill。</p>
      </div>
      <div>
        <form className="matcher-form" onSubmit={submit}>
          <label htmlFor="task-query">描述一个任务</label>
          <div className="input-row">
            <input
              id="task-query"
              value={query}
              maxLength={4096}
              placeholder="例如：分析一只 A 股并生成报告"
              onChange={(event) => controller.changeQuery(event.target.value)}
            />
            <button type="submit" disabled={submitBlocked || !query.trim()} aria-busy={isSearching}>
              {submitLabel}
            </button>
          </div>
        </form>
        <p className={`github-availability ${githubStatus?.state ?? "checking"}`} role="status">
          {githubAvailability}
        </p>
        <div className="match-results" aria-live="polite">
          {error?.stage === "local" && <p className="inline-error" role="alert">{errorMessage}</p>}
          {localMatchLevel === "none" && (
            <p className="empty-inline">本机没有达到相关性门槛的 Skill。</p>
          )}
          {weakMatchMessage && (
            <p className="weak-match-intro">{weakMatchMessage}</p>
          )}
          {results?.map((result, index) => (
            <article className="match-result" key={result.skillId}>
              <span className="rank">0{index + 1}</span>
              <div>
                <div className="match-result-title">
                  <strong>{result.name}</strong>
                  {localMatchLevel === "weak" && (
                    <span className="weak-match-label">可能相关</span>
                  )}
                </div>
                <p>{result.reasonZh}</p>
              </div>
              <span className={`status ${result.status}`}>{STATUS_LABELS[result.status]}</span>
            </article>
          ))}

          {localMatchLevel !== "strong" && githubSearch && (
            <div className="github-search-action">
              <div>
                {phase === "sanitized-searching" ? (
                  <p className="github-status" role="status">
                    正在执行 GitHub 混合搜索：先搜索仓库，结果不足时继续检索 SKILL.md。
                  </p>
                ) : (
                  <p>
                    {githubSearchStarted ? "脱敏搜索使用的能力词" : "已生成但未发送的脱敏能力词"}：
                    <code>{githubSearch.label}</code>
                  </p>
                )}
                {phase === "sanitized-searching" && (
                  <p>脱敏搜索使用的能力词：<code>{githubSearch.label}</code></p>
                )}
                <p className="github-disclosure">只发送任务能力词，不发送未识别的名称或项目内容。</p>
              </div>
            </div>
          )}

          {githubDiagnostics && (
            <p className="github-stage-summary" role="status">
              已到达{GITHUB_STAGE_LABELS[githubDiagnostics.stageReached]}阶段：仓库命中
              {githubDiagnostics.repositoryHits}，SKILL.md 命中 {githubDiagnostics.codeHits}，
              验证通过 {githubDiagnostics.validatedCandidates}，拒绝
              {githubDiagnostics.rejectedCandidates}，去重 {githubDiagnostics.deduplicatedCandidates}。
            </p>
          )}
          {!githubDiagnostics && githubStage && phase !== "sanitized-searching" && githubSearchStarted && (
            <p className="github-stage-summary" role="status">
              搜索停在{GITHUB_STAGE_LABELS[githubStage]}阶段；没有可验证的完整计数。
            </p>
          )}
          {!githubDiagnostics && githubStage && phase !== "sanitized-searching" && !githubSearchStarted && (
            <p className="github-stage-summary" role="status">
              未开始 GitHub 搜索；以上能力词没有发送。
            </p>
          )}

          {localMatchLevel !== "strong" && phase === "sanitized-error" && (
            <div className="github-recovery">
              {githubIncomplete && (
                <p className="incomplete-note">GitHub 返回的结果不完整，未启用原文搜索。</p>
              )}
              {error?.stage === "sanitized" && <p className="inline-error" role="alert">{errorMessage}</p>}
              <button type="button" onClick={() => void controller.retrySanitizedSearch()} disabled={isSearching}>
                重试脱敏搜索
              </button>
            </div>
          )}

          {showRawConsent && (
            <>
              {phase === "raw-searching" ? (
                <p className="empty-inline raw-consent-intro">
                  已确认发送原始任务全文，正在等待 GitHub 搜索结果。
                </p>
              ) : githubSearch ? (
                <p className="empty-inline raw-consent-intro">
                  GitHub 上没有找到经过验证的相关 Skill。你可以选择发送下面的原始任务，再搜索一次。
                </p>
              ) : (
                <p className="incomplete-note raw-consent-intro">
                  无法生成安全能力词，尚未向 GitHub 发送脱敏查询。
                </p>
              )}
              <section className="raw-consent" aria-labelledby="raw-consent-title">
                <h3 id="raw-consent-title">
                  {phase === "raw-searching"
                    ? "已确认发送到 GitHub 搜索的完整内容"
                    : "即将发送到 GitHub 搜索的完整内容"}
                </h3>
                <textarea
                  className="raw-query"
                  value={submittedQuery}
                  rows={6}
                  readOnly
                  spellCheck={false}
                  aria-label="将发送的原始任务全文"
                />
                <p>原文可能包含名称、项目或业务信息。本次内容不会写入本机搜索缓存或日志。</p>
                <p className="consent-expiry">授权短时有效；失效后需要重新匹配。</p>
                <div className="raw-consent-actions" aria-busy={phase === "raw-searching"}>
                  <button
                    className="raw-confirm-button"
                    type="button"
                    onClick={() => void controller.confirmOriginalSearch()}
                    disabled={phase === "raw-searching"}
                  >
                    {phase === "raw-searching" ? "正在发送并搜索…" : "确认发送原文到 GitHub"}
                  </button>
                  <button
                    className="raw-cancel-button"
                    type="button"
                    onClick={() => void controller.cancelOriginalSearch()}
                    disabled={phase === "raw-searching"}
                  >
                    取消
                  </button>
                </div>
              </section>
            </>
          )}

          {phase === "raw-revoking" && (
            <section
              className="raw-revoke-status"
              aria-live="polite"
              aria-busy={phase === "raw-revoking"}
            >
              <p role="status">正在撤销授权…</p>
              <div className="raw-revoke-actions">
                <button type="button" disabled>正在撤销授权…</button>
              </div>
            </section>
          )}
          {phase === "raw-revoke-error" && (
            <section className="raw-revoke-status" aria-live="polite" aria-busy={false}>
              <p className="inline-error" role="alert">
                未能确认撤销，请重试取消或等待授权自动失效。
              </p>
              <div className="raw-revoke-actions">
                <button type="button" onClick={() => void controller.cancelOriginalSearch()}>
                  重试取消
                </button>
              </div>
            </section>
          )}

          {phase === "cancelled" && (
            <p className="empty-inline" role="status">已取消，原始任务未发送。</p>
          )}
          {phase === "raw-error" && error?.stage === "original" && (
            <p className="inline-error" role="alert">{errorMessage}</p>
          )}
          {originalOutcome === "empty" && (
            <p className="empty-inline">已发送原文，但仍没有找到经过验证的相关 Skill。</p>
          )}
          {originalOutcome === "incomplete" && (
            <p className="incomplete-note">原文搜索返回的结果不完整。请修改任务后重新匹配。</p>
          )}

          {githubResults && githubResults.length > 0 && (
            <section className="github-results" aria-labelledby="github-results-title">
              <h3 id="github-results-title">GitHub 推荐（按仓库 Stars 排序）</h3>
              {githubResults.slice(0, 3).map((result) => (
                <article className="github-result" key={`${result.repository}/${result.skillDirectory}`}>
                  <div className="github-result-heading">
                    <div>
                      <strong>{result.name}</strong>
                      <p>{result.summary}</p>
                    </div>
                    <span className="repo-stars" aria-label={`仓库 Star ${result.stars.toLocaleString()}`}>
                      ★ {result.stars.toLocaleString()}
                    </span>
                  </div>
                  <p className="github-reason">{result.reasonZh}</p>
                  <dl className="github-metadata">
                    <div><dt>仓库</dt><dd>{result.repository}</dd></div>
                    <div><dt>Skill 路径</dt><dd>{formatSkillPath(result.skillDirectory)}</dd></div>
                    <div><dt>更新时间</dt><dd>{result.pushedAt ? formatDate(result.pushedAt) : "未知"}</dd></div>
                    <div><dt>许可证</dt><dd>{result.license?.trim() || "未标注"}</dd></div>
                  </dl>
                  <a className="external-link" href={result.repositoryUrl} target="_blank" rel="noreferrer">
                    在 GitHub 查看 {result.repository}
                  </a>
                </article>
              ))}
              <p className="github-disclosure">
                仓库 Stars 只代表关注度，不代表安全、质量或兼容性。
              </p>
            </section>
          )}

          <details className="search-diagnostics">
            <summary>搜索诊断</summary>
            <div className="diagnostic-content">
              <p className="github-disclosure">
                这里只显示固定安全字段；复制操作只写入本机剪贴板，不会发送记录。
              </p>
              <dl className="diagnostic-grid">
                <div>
                  <dt>本机匹配</dt>
                  <dd className="diagnostic-value">{localMatchLevel ?? "尚未匹配"}</dd>
                </div>
                <div>
                  <dt>本机证据</dt>
                  <dd className="diagnostic-value">{localEvidence.join(" · ") || "无"}</dd>
                </div>
                <div>
                  <dt>脱敏能力词</dt>
                  <dd className="diagnostic-value">{sentSanitizedTerms.join(" · ") || "无"}</dd>
                </div>
                <div>
                  <dt>到达阶段</dt>
                  <dd className="diagnostic-value">
                    {stageReached ? GITHUB_STAGE_LABELS[stageReached] : "尚未搜索"}
                  </dd>
                </div>
                <div>
                  <dt>命中与验证</dt>
                  <dd className="diagnostic-value">
                    仓库 {githubDiagnostics?.repositoryHits ?? 0} · SKILL.md
                    {githubDiagnostics?.codeHits ?? 0} · 通过
                    {githubDiagnostics?.validatedCandidates ?? 0}
                  </dd>
                </div>
                <div>
                  <dt>拒绝与去重</dt>
                  <dd className="diagnostic-value">
                    拒绝 {githubDiagnostics?.rejectedCandidates ?? 0} · 去重
                    {githubDiagnostics?.deduplicatedCandidates ?? 0}
                  </dd>
                </div>
                <div>
                  <dt>缓存与完整性</dt>
                  <dd className="diagnostic-value">
                    {githubDiagnostics ? (githubDiagnostics.cached ? "缓存命中" : "非缓存") : "无缓存记录"} ·
                    {githubDiagnostics
                      ? (githubDiagnostics.incomplete ? "结果不完整" : "结果完整")
                      : githubIncomplete || stageReached
                        ? "未取得完整诊断"
                        : "尚未搜索"}
                  </dd>
                </div>
                <div>
                  <dt>固定错误码</dt>
                  <dd className="diagnostic-value">{error?.code ?? "无"}</dd>
                </div>
                <div>
                  <dt>仓库搜索额度</dt>
                  <dd className="diagnostic-value">
                    剩余 {diagnosticRateLimits.search?.remaining ?? "未知"} · 重置
                    {diagnosticRateLimits.search?.reset ?? "未知"}
                  </dd>
                </div>
                <div>
                  <dt>SKILL.md 检索额度</dt>
                  <dd className="diagnostic-value">
                    剩余 {diagnosticRateLimits.codeSearch?.remaining ?? "未知"} · 重置
                    {diagnosticRateLimits.codeSearch?.reset ?? "未知"}
                  </dd>
                </div>
              </dl>
              <ul className="diagnostic-rejections" aria-label="候选拒绝计数">
                {TASK_SEARCH_REJECTION_REASONS.map((reason) => (
                  <li key={reason}>
                    <span>{REJECTION_LABELS[reason]}</span>
                    <strong>{githubDiagnostics?.rejectionCounts.find((item) => (
                      item.reason === reason
                    ))?.count ?? 0}</strong>
                  </li>
                ))}
              </ul>
              <div className="diagnostic-copy-row">
                <button className="diagnostic-copy-button" type="button" onClick={() => void copyTestRecord()}>
                  复制测试记录
                </button>
                <p className="diagnostic-copy-status" role="status">
                  {copyStatus === "copied" && "测试记录已复制。"}
                  {copyStatus === "failed" && "无法复制测试记录，请检查浏览器剪贴板权限。"}
                </p>
              </div>
            </div>
          </details>
        </div>
      </div>
    </section>
  );
}
