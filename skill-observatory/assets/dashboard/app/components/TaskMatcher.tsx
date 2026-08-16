import { useEffect, useState, type FormEvent } from "react";
import {
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

export function TaskMatcher() {
  const [controller] = useState(() => createTaskSearchController({
    recommendTask,
    searchSanitizedGitHubSkills,
    searchOriginalGitHubSkills,
    revokeOriginalSearchConsent,
  }));
  const [state, setState] = useState(() => controller.getState());

  useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    return () => {
      unsubscribe();
      controller.dispose();
    };
  }, [controller]);

  function submit(event: FormEvent) {
    event.preventDefault();
    void controller.submit();
  }

  const {
    query,
    submittedQuery,
    results,
    githubSearch,
    githubResults,
    githubIncomplete,
    rawConsent,
    phase,
    originalOutcome,
    error,
  } = state;
  const isSearching = isTaskSearchInFlight(state);
  const submitBlocked = isSearching || phase === "raw-revoke-error";
  const errorMessage = formatTaskSearchError(error);
  const showRawConsent = (phase === "raw-consent" && rawConsent) || phase === "raw-searching";
  const submitLabel = phase === "local-searching"
    ? "匹配中…"
    : phase === "sanitized-searching"
      ? "脱敏搜索中…"
      : phase === "raw-searching"
        ? "原文搜索中…"
        : phase === "raw-revoking"
          ? "正在撤销授权…"
        : "匹配 Skill";

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
        <div className="match-results" aria-live="polite">
          {error?.stage === "local" && <p className="inline-error" role="alert">{errorMessage}</p>}
          {results?.length === 0 && <p className="empty-inline">本机没有达到推荐阈值的 Skill。</p>}
          {results?.map((result, index) => (
            <article className="match-result" key={result.skillId}>
              <span className="rank">0{index + 1}</span>
              <div>
                <strong>{result.name}</strong>
                <p>{result.reasonZh}</p>
              </div>
              <span className={`status ${result.status}`}>{STATUS_LABELS[result.status]}</span>
            </article>
          ))}

          {results?.length === 0 && githubSearch && (
            <div className="github-search-action">
              <div>
                {phase === "sanitized-searching" ? (
                  <p className="github-status" role="status">
                    正在用脱敏能力词自动搜索 GitHub：<code>{githubSearch.label}</code>
                  </p>
                ) : (
                  <p>脱敏搜索使用的能力词：<code>{githubSearch.label}</code></p>
                )}
                <p className="github-disclosure">只发送任务能力词，不发送未识别的名称或项目内容。</p>
              </div>
            </div>
          )}

          {results?.length === 0 && phase === "sanitized-error" && (
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
              {githubSearch ? (
                <p className="empty-inline raw-consent-intro">
                  GitHub 上没有找到经过验证的相关 Skill。你可以选择发送下面的原始任务，再搜索一次。
                </p>
              ) : (
                <p className="incomplete-note raw-consent-intro">
                  无法生成安全能力词，尚未向 GitHub 发送脱敏查询。
                </p>
              )}
              <section className="raw-consent" aria-labelledby="raw-consent-title">
                <h3 id="raw-consent-title">即将发送到 GitHub 搜索的完整内容</h3>
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

          {results?.length === 0 && githubResults?.map((result) => (
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
                <div><dt>Skill 目录</dt><dd>{result.skillDirectory}</dd></div>
                <div><dt>更新时间</dt><dd>{result.pushedAt ? formatDate(result.pushedAt) : "未知"}</dd></div>
                <div><dt>许可证</dt><dd>{result.license?.trim() || "未标注"}</dd></div>
              </dl>
              <a className="external-link" href={result.repositoryUrl} target="_blank" rel="noreferrer">
                查看 GitHub
              </a>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
