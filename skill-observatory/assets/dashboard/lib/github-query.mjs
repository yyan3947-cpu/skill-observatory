import { createHash } from "node:crypto";

import {
  assertGitHubCodeQueryWithinLimit,
  assertGitHubRepositoryQueryWithinLimit,
  createGitHubQueryRejectedError,
} from "./github-query-contract.mjs";
import { normalizeText, TASK_INTENTS } from "./recommend.mjs";

const MAX_TERMS = 6;
const MAX_TOTAL_CHARACTERS = 128;
const REPOSITORY_QUERY_SUFFIX = ' "SKILL.md" in:name,description,readme archived:false';

const CAPABILITY_RULES = Object.freeze([
  {
    patterns: ["二维码", "qr code", "qrcode"],
    terms: ["qr code", "generator", "skill"],
    recallTerms: ["qr code", "generator"],
  },
  {
    patterns: ["airtable"],
    terms: ["airtable", "data management", "skill"],
    recallTerms: ["airtable", "data management"],
  },
  {
    patterns: [
      "检测数据",
      "校验数据",
      "验证数据",
      "数据检测",
      "数据校验",
      "数据验证",
      "数据质量",
      "validate data",
      "data validation",
      "data quality",
      "test data",
      "data testing",
    ],
    terms: ["data validation", "testing", "skill"],
    recallTerms: ["data validation", "data testing"],
  },
  {
    patterns: [
      "国际时事",
      "国际新闻",
      "全球新闻",
      "current affairs",
      "world news",
      ...(TASK_INTENTS["current-affairs"] ?? []),
    ],
    terms: ["current affairs", "news", "research"],
    recallTerms: ["current affairs", "world news"],
  },
  {
    patterns: ["市场新闻", "新闻影响", "market news"],
    terms: ["market news", "news analysis", "research"],
    recallTerms: ["market news", "news analysis"],
  },
  {
    patterns: ["小红书", "xiaohongshu", "xhs"],
    terms: ["xiaohongshu", "content", "skill"],
    recallTerms: ["xiaohongshu", "content"],
  },
  {
    patterns: ["ppt", "powerpoint", "presentation", "slide deck", "演示", "幻灯片"],
    terms: ["presentation", "powerpoint", "skill"],
    recallTerms: ["presentation", "powerpoint"],
  },
  {
    patterns: ["ui", "ux", "user interface", "user experience", "web design", "界面", "网站"],
    terms: ["ui ux", "web design", "skill"],
    recallTerms: ["ui ux", "web design"],
  },
  {
    patterns: ["a股", "股票", "港股", "美股"],
    terms: ["stock analysis", "finance", "skill"],
    recallTerms: ["stock analysis", "finance"],
  },
  {
    patterns: ["调试", "bug", "debug", "debugging"],
    terms: ["debugging", "code", "skill"],
    recallTerms: ["debugging", "code"],
  },
  {
    patterns: ["pdf", "word", "document", "文档"],
    terms: ["document", "pdf", "skill"],
    recallTerms: ["document", "pdf"],
  },
]);

// Fallbacks deliberately map only known action words to fixed search terms.
// Never derive a term from the remaining task text: it can contain customer,
// company, project, or other private names that must stay on the machine.
const ACTION_RULES = Object.freeze([
  {
    patterns: ["检测", "校验", "验证", "测试", "validate", "verify", "test", "check"],
    terms: ["validation", "testing"],
    recallTerms: ["validation", "testing"],
  },
  {
    patterns: ["生成", "创建", "制作", "generate", "create", "make"],
    terms: ["generator"],
    recallTerms: ["generator"],
  },
  {
    patterns: ["管理", "整理", "manage", "organize", "organise"],
    terms: ["management"],
    recallTerms: ["management"],
  },
  {
    patterns: ["分析", "analyze", "analyse"],
    terms: ["analysis"],
    recallTerms: ["analysis"],
  },
  {
    patterns: ["自动化", "automate"],
    terms: ["automation"],
    recallTerms: ["automation"],
  },
  {
    patterns: ["转换", "convert"],
    terms: ["converter"],
    recallTerms: ["converter"],
  },
  {
    patterns: ["翻译", "translate"],
    terms: ["translation"],
    recallTerms: ["translation"],
  },
  {
    patterns: ["摘要", "总结", "summarize", "summarise"],
    terms: ["summarization"],
    recallTerms: ["summarization"],
  },
  {
    patterns: ["提取", "extract"],
    terms: ["extraction"],
    recallTerms: ["extraction"],
  },
  {
    patterns: ["排程", "定时", "schedule"],
    terms: ["scheduling"],
    recallTerms: ["scheduling"],
  },
  {
    patterns: ["发布", "publish"],
    terms: ["publishing"],
    recallTerms: ["publishing"],
  },
  {
    patterns: ["可视化", "visualize", "visualise"],
    terms: ["visualization"],
    recallTerms: ["visualization"],
  },
  {
    patterns: ["监控", "监测", "monitor"],
    terms: ["monitoring"],
    recallTerms: ["monitoring"],
  },
]);

function stripMarkdownCode(value) {
  return value
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/`+[^`\n]*`+/gu, " ");
}

function stripQuotedSpans(value) {
  return stripMarkdownCode(value)
    .replace(/"[^"\n]*"/gu, " ")
    .replace(/'[^'\n]*'/gu, " ")
    .replace(/“[^”\n]*”/gu, " ")
    .replace(/‘[^’\n]*’/gu, " ")
    .replace(/「[^」\n]*」/gu, " ")
    .replace(/『[^』\n]*』/gu, " ");
}

function stripSensitiveDetails(value) {
  let text = stripQuotedSpans(String(value ?? "").normalize("NFKC"));
  text = text
    .replace(/\b(?:https?|ftp|file):\/\/[^\s，。！？；：、,!?;<>]+/giu, " ")
    .replace(/\bwww\.[^\s，。！？；：、,!?;<>]+/giu, " ")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, " ")
    .replace(/(^|[\s([{"'=，。！？；：、,!?;])\\\\[^\\\s，。！？；：、,!?;:'"()[\]{}<>]+\\[^\\\s，。！？；：、,!?;:'"()[\]{}<>]+(?:\\[^\\\s，。！？；：、,!?;:'"()[\]{}<>]+)*/gu, "$1 ")
    .replace(/\b[A-Z]:\\(?:[^\\\s，。！？；：、,!?;:'"()[\]{}<>]+\\)*[^\\\s，。！？；：、,!?;:'"()[\]{}<>]*/giu, " ")
    .replace(/(^|[\s([{"'=，。！？；：、,!?;])~\/(?:[^/\s，。！？；：、,!?;:'"()[\]{}<>]+\/)*[^/\s，。！？；：、,!?;:'"()[\]{}<>]*/gu, "$1 ")
    .replace(/(^|[\s([{"'=，。！？；：、,!?;])\/(?:[^/\s，。！？；：、,!?;:'"()[\]{}<>]+\/)*[^/\s，。！？；：、,!?;:'"()[\]{}<>]*/gu, "$1 ")
    .replace(/\d{4,}/gu, " ");
  return text;
}

function normalizeSearchTerm(value) {
  const normalized = normalizeText(value)
    .replace(/[^a-z0-9\u3400-\u9fff -]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length < 2 || normalized.length > 32) return "";
  return normalized;
}

function boundTerms(values) {
  const terms = [];
  const seen = new Set();
  let totalCharacters = 0;

  for (const value of values) {
    const term = normalizeSearchTerm(value);
    if (!term || seen.has(term)) continue;
    const nextTotal = totalCharacters + (terms.length ? 1 : 0) + term.length;
    if (nextTotal > MAX_TOTAL_CHARACTERS) continue;
    terms.push(term);
    seen.add(term);
    totalCharacters = nextTotal;
    if (terms.length === MAX_TERMS) break;
  }

  return terms;
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function matchesCapabilityPattern(value, patternValue) {
  const pattern = normalizeText(patternValue);
  if (!pattern) return false;
  if (/[\u3400-\u9fff]/u.test(pattern)) return value.includes(pattern);

  const expression = pattern
    .split(/[\s-]+/u)
    .map(escapeRegularExpression)
    .join("[\\s-]+");
  return new RegExp(`(^|[^a-z0-9])${expression}(?=$|[^a-z0-9])`, "u").test(value);
}

function buildCacheKey(terms) {
  return createHash("sha256").update(terms.join("\0")).digest("hex");
}

function selectControlledTerms(query) {
  const sanitized = stripSensitiveDetails(query);
  const normalized = normalizeText(sanitized);
  if (!normalized) return null;

  const matchedRule = CAPABILITY_RULES.find(({ patterns }) => (
    patterns.some((pattern) => matchesCapabilityPattern(normalized, pattern))
  ));
  if (matchedRule) {
    return { terms: matchedRule.terms, recallTerms: matchedRule.recallTerms };
  }

  const matchedActions = ACTION_RULES.filter(({ patterns }) => (
    patterns.some((pattern) => matchesCapabilityPattern(normalized, pattern))
  ));
  const terms = boundTerms([
    ...matchedActions.flatMap((rule) => rule.terms),
    ...(matchedActions.length ? ["skill"] : []),
  ]);
  if (!terms.length) return null;
  return {
    terms,
    recallTerms: matchedActions.flatMap((rule) => rule.recallTerms),
  };
}

function quoteRepositoryTerm(term) {
  return term.includes(" ") ? `"${term}"` : term;
}

function repositorySearches(q) {
  return [
    { mode: "best-match", q, sort: undefined, order: undefined },
    { mode: "stars", q, sort: "stars", order: "desc" },
  ];
}

function queryGroups(terms, recallTerms) {
  const groups = [boundTerms(terms)];
  for (const term of recallTerms) groups.push(boundTerms([term, "skill"]));
  const seen = new Set();
  return groups.filter((group) => {
    if (!group.length) return false;
    const key = group.join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 3);
}

function repositoryQueries(groups) {
  const values = groups.map((group) => {
    const capabilities = group.map(quoteRepositoryTerm).join(" ");
    return `${capabilities}${REPOSITORY_QUERY_SUFFIX}`;
  });
  const output = values.slice(0, 2).map((q) => ({
    mode: "best-match",
    q: assertGitHubRepositoryQueryWithinLimit(q),
    sort: undefined,
    order: undefined,
  }));
  const broadest = values.at(-1);
  if (broadest) {
    output.push({
      mode: "stars",
      q: assertGitHubRepositoryQueryWithinLimit(broadest),
      sort: "stars",
      order: "desc",
    });
  }
  return output.slice(0, 3);
}

function semanticTerms(groups) {
  const output = [];
  const seen = new Set();
  for (const term of groups.flat()) {
    if (term === "skill" || seen.has(term)) continue;
    seen.add(term);
    output.push(term);
  }
  return output;
}

function codeQuery(groups) {
  const terms = semanticTerms(groups).slice(0, 4).map(quoteRepositoryTerm);
  return assertGitHubCodeQueryWithinLimit(`${terms.join(" ")} filename:SKILL.md`);
}

export function buildGitHubSearchPlan(query) {
  const selection = selectControlledTerms(query);
  if (!selection) return null;
  const groups = queryGroups(selection.terms, selection.recallTerms);
  return {
    preview: {
      terms: groups[0],
      label: groups[0].join(" · "),
      cacheKey: buildCacheKey(groups[0]),
    },
    semanticTerms: semanticTerms(groups),
    repositoryQueries: repositoryQueries(groups),
    codeQuery: codeQuery(groups),
  };
}

export function buildGitHubSearchPreview(query) {
  const preview = buildGitHubSearchPlan(query)?.preview;
  if (!preview) return null;
  return { terms: preview.terms, label: preview.label };
}

export function buildGitHubRepositoryQueries(values) {
  const terms = boundTerms(values);
  if (!terms.length) return [];
  const capabilities = terms.map(quoteRepositoryTerm).join(" ");
  const q = `${capabilities}${REPOSITORY_QUERY_SUFFIX}`;

  return repositorySearches(q);
}

export function buildOriginalGitHubRepositoryQueries(query) {
  const original = typeof query === "string" ? query.trim() : "";
  if (!original) throw createGitHubQueryRejectedError();
  const q = assertGitHubRepositoryQueryWithinLimit(`${original}${REPOSITORY_QUERY_SUFFIX}`);
  return repositorySearches(q);
}
