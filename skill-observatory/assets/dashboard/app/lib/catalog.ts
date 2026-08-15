export type SkillStatus = "ready" | "needs-config" | "abnormal" | "unchecked";
export type SourceType = "user" | "repo" | "system" | "plugin";

export interface SkillRecord {
  id: string;
  name: string;
  displayName: string;
  description: string;
  summaryZh: string;
  summaryState: "curated" | "source-fallback";
  category: string;
  sourceType: SourceType;
  sourceLabel: string;
  path: string;
  status: SkillStatus;
  statusReasons: string[];
  validationMethod: string | null;
  validatedAt: string | null;
  requiredEnvNames: string[];
  missingEnvNames: string[];
  missingExecutableNames: string[];
  warnings: string[];
  aliases: string[];
  intentTags: string[];
  keywords: string[];
  usageCount: number | null;
  lastUsedAt: string | null;
  usedThisMonth: boolean;
}

export interface ActivityRecord {
  skillId: string;
  skillName: string;
  invokedAt: string;
  evidenceType: string;
}

export interface Catalog {
  schemaVersion: number;
  generatedAt: string;
  historyAvailable: boolean;
  metrics: {
    installed: number;
    confirmedUsed: number;
    usedThisMonth: number;
    needsConfig: number;
    abnormal: number;
  };
  sourceCounts: Record<string, number>;
  sessionFileCount: number;
  skippedFileCount: number;
  warningTotal: number;
  skills: SkillRecord[];
  activity: ActivityRecord[];
}

export interface Recommendation {
  skillId: string;
  name: string;
  summaryZh: string;
  status: SkillStatus;
  score: number;
  reasonCodes: string[];
  reasonZh: string;
}

export interface GitHubSearchPreview {
  terms: string[];
  label: string;
}

export interface GitHubSkillSuggestion {
  repository: string;
  repositoryUrl: string;
  skillDirectory: string;
  name: string;
  summary: string;
  reasonZh: string;
  stars: number;
  pushedAt: string;
  license: string | null;
}

export interface TaskRecommendationResponse {
  results: Recommendation[];
  githubSearch: GitHubSearchPreview | null;
}

export interface GitHubSuggestionResponse {
  preview: GitHubSearchPreview;
  results: GitHubSkillSuggestion[];
  cached: boolean;
  incomplete: boolean;
  rateLimit: { remaining: number | null; reset: number | null; retryAt: string | null } | null;
}

export interface FilterState {
  query: string;
  used: "all" | "used" | "unused";
  status: "all" | SkillStatus;
  category: string;
  source: "all" | SourceType;
}

export type SortKey = "recent" | "usage" | "name" | "category" | "status";

export const STATUS_LABELS: Record<SkillStatus, string> = {
  ready: "可用",
  "needs-config": "需配置",
  abnormal: "异常",
  unchecked: "待检查",
};

export const SOURCE_LABELS: Record<SourceType, string> = {
  user: "个人",
  repo: "项目",
  system: "系统",
  plugin: "插件",
};

export function filterSkills(skills: SkillRecord[], filters: FilterState) {
  const query = filters.query.trim().toLocaleLowerCase();
  return skills.filter((skill) => {
    if (filters.used === "used" && !skill.usageCount) return false;
    if (filters.used === "unused" && skill.usageCount) return false;
    if (filters.status !== "all" && skill.status !== filters.status) return false;
    if (filters.category !== "all" && skill.category !== filters.category) return false;
    if (filters.source !== "all" && skill.sourceType !== filters.source) return false;
    if (!query) return true;
    const haystack = [skill.name, skill.summaryZh, skill.description, skill.category, ...skill.aliases]
      .join(" ")
      .toLocaleLowerCase();
    return haystack.includes(query);
  });
}

export function sortSkills(skills: SkillRecord[], sort: SortKey) {
  const values = [...skills];
  const statusRank: Record<SkillStatus, number> = {
    abnormal: 0,
    "needs-config": 1,
    unchecked: 2,
    ready: 3,
  };
  values.sort((a, b) => {
    if (sort === "usage") return (b.usageCount ?? -1) - (a.usageCount ?? -1) || a.name.localeCompare(b.name);
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "category") return a.category.localeCompare(b.category) || a.name.localeCompare(b.name);
    if (sort === "status") return statusRank[a.status] - statusRank[b.status] || a.name.localeCompare(b.name);
    if (a.lastUsedAt && b.lastUsedAt) return b.lastUsedAt.localeCompare(a.lastUsedAt);
    if (a.lastUsedAt) return -1;
    if (b.lastUsedAt) return 1;
    return a.name.localeCompare(b.name);
  });
  return values;
}

export function formatDate(value: string | null, includeTime = false) {
  if (!value) return "从未确认使用";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(date);
}

export function evidenceLabel(value: string) {
  return ({
    "explicit-invocation": "显式调用",
    "skill-file-read": "读取工作流",
    "skill-resource-read": "读取资源",
    "structured-selection": "结构化选择",
  } as Record<string, string>)[value] ?? "确认使用";
}
