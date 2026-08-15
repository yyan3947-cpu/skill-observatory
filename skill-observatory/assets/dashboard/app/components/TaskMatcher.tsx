import { useRef, useState, type FormEvent } from "react";
import { recommendTask, searchGitHubSkills } from "../lib/api";
import {
  STATUS_LABELS,
  formatDate,
  type GitHubSearchPreview,
  type GitHubSkillSuggestion,
  type Recommendation,
} from "../lib/catalog";

export function TaskMatcher() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Recommendation[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [githubSearch, setGithubSearch] = useState<GitHubSearchPreview | null>(null);
  const [githubResults, setGithubResults] = useState<GitHubSkillSuggestion[] | null>(null);
  const [githubLoading, setGithubLoading] = useState(false);
  const [githubError, setGithubError] = useState("");
  const [githubIncomplete, setGithubIncomplete] = useState(false);
  const githubRequestInFlight = useRef(false);
  const githubRequestVersion = useRef(0);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const taskQuery = query.trim();
    if (!taskQuery) return;
    githubRequestVersion.current += 1;
    githubRequestInFlight.current = false;
    setLoading(true);
    setError("");
    setResults(null);
    setSubmittedQuery("");
    setGithubSearch(null);
    setGithubResults(null);
    setGithubLoading(false);
    setGithubError("");
    setGithubIncomplete(false);
    try {
      const response = await recommendTask(taskQuery);
      setResults(response.results);
      setGithubSearch(response.githubSearch);
      setSubmittedQuery(taskQuery);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "暂时无法完成匹配");
    } finally {
      setLoading(false);
    }
  }

  async function searchGitHub() {
    if (githubRequestInFlight.current || !githubSearch || results?.length !== 0 || !submittedQuery) return;
    githubRequestInFlight.current = true;
    const requestVersion = githubRequestVersion.current + 1;
    githubRequestVersion.current = requestVersion;
    setGithubLoading(true);
    setGithubResults(null);
    setGithubError("");
    setGithubIncomplete(false);
    try {
      const response = await searchGitHubSkills(submittedQuery);
      if (requestVersion !== githubRequestVersion.current) return;
      setGithubResults(response.results.slice(0, 3));
      setGithubIncomplete(response.incomplete);
    } catch (caught) {
      if (requestVersion !== githubRequestVersion.current) return;
      const message = caught instanceof Error ? caught.message : "GitHub 查找暂时失败。";
      setGithubError(`${message} 你可以再次点击“在 GitHub 查找”重试。`);
    } finally {
      if (requestVersion === githubRequestVersion.current) {
        githubRequestInFlight.current = false;
        setGithubLoading(false);
      }
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
              onChange={(event) => setQuery(event.target.value)}
            />
            <button type="submit" disabled={loading || !query.trim()}>
              {loading ? "匹配中…" : "匹配 Skill"}
            </button>
          </div>
        </form>
        <div className="match-results" aria-live="polite">
          {error && <p className="inline-error" role="alert">{error}</p>}
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
                <strong>从 GitHub 补充查找</strong>
                <p>将发送到 GitHub：<code>{githubSearch.label}</code></p>
              </div>
              <button
                className="github-search-button"
                type="button"
                onClick={searchGitHub}
                disabled={githubLoading}
                aria-busy={githubLoading}
              >
                {githubLoading ? "查找并验证中…" : "在 GitHub 查找"}
              </button>
            </div>
          )}
          {results?.length === 0 && githubSearch && (
            <div className="github-results" aria-live="polite" aria-busy={githubLoading}>
              {githubLoading && <p className="github-status" role="status">正在 GitHub 查找并验证 Skill…</p>}
              {githubError && <p className="inline-error" role="alert">{githubError}</p>}
              {githubResults?.length === 0 && (
                <p className="empty-inline">GitHub 上没有找到经过验证的相关 Skill。</p>
              )}
              {githubIncomplete && <p className="incomplete-note">GitHub 返回的结果可能不完整。</p>}
              {githubResults?.map((result) => (
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
          )}
        </div>
      </div>
    </section>
  );
}
