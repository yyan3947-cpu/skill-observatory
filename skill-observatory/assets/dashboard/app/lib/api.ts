import type {
  Catalog,
  GitHubSuggestionResponse,
  TaskRecommendationResponse,
} from "./catalog";

const API_BASE = "http://127.0.0.1:4318";

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    if (response.status === 403) throw new Error("本机访问来源未获允许");
    if (response.status === 413) throw new Error("任务描述过长");
    throw new Error("本机数据服务暂时不可用");
  }
  return response.json() as Promise<T>;
}

async function parseRetryAt(response: Response) {
  try {
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const retryAt = (body as { retryAt?: unknown }).retryAt;
    if (typeof retryAt !== "string") return null;
    const milliseconds = Date.parse(retryAt);
    return Number.isFinite(milliseconds) ? new Date(milliseconds) : null;
  } catch {
    return null;
  }
}

function formatRetryTime(date: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export async function fetchCatalog() {
  return parseResponse<Catalog>(await fetch(`${API_BASE}/api/catalog`, { cache: "no-store" }));
}

export async function syncCatalog() {
  return parseResponse<Catalog>(await fetch(`${API_BASE}/api/sync`, { method: "POST", cache: "no-store" }));
}

export async function recommendTask(query: string): Promise<TaskRecommendationResponse> {
  return parseResponse<TaskRecommendationResponse>(
    await fetch(`${API_BASE}/api/recommend`, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    }),
  );
}

export async function searchGitHubSkills(query: string): Promise<GitHubSuggestionResponse> {
  const response = await fetch(`${API_BASE}/api/github-suggestions`, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (response.ok) return response.json() as Promise<GitHubSuggestionResponse>;
  if (response.status === 429) {
    const retryAt = await parseRetryAt(response);
    throw new Error(retryAt
      ? `GitHub 查询频率已达上限，可在 ${formatRetryTime(retryAt)} 后重试。`
      : "GitHub 查询频率已达上限，请稍后重试。");
  }
  if (response.status === 409) throw new Error("本机 Skill 已更新，请先重新匹配。");
  if (response.status === 403) throw new Error("本机访问来源未获允许。");
  if (response.status === 400 || response.status === 413) throw new Error("任务描述无法用于 GitHub 查询。");
  if (response.status === 503) throw new Error("GitHub 查找功能暂时不可用。");
  throw new Error("连接 GitHub 失败，请检查网络。");
}
