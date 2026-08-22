import {
  matchedLatinTypoQueryTokens,
  maxChineseBigramDice,
} from "./fuzzy-match.mjs";

const WEIGHTS = Object.freeze({
  exactName: 100,
  nameSubstring: 45,
  exactAlias: 35,
  aliasSubstring: 22,
  fuzzyName: 18,
  intent: 14,
  chineseSimilarity: 12,
  keyword: 8,
  category: 4,
});

const MATCH_LEVEL_THRESHOLDS = Object.freeze({
  weak: 12,
  semanticStrong: 24,
  semanticLead: 8,
});

const GENERIC_WHOLE_QUERY_NOUNS = new Set([
  "分析", "文件", "内容", "数据",
  "analysis", "content", "data", "file",
]);
const BOUNDARY_SEPARATOR_CHARACTER = /^[-\s]$/u;
const SKILL_INVOCATION_CONTINUATION_CHARACTER = /^[\p{L}\p{N}-]$/u;

const FIELD_BUDGETS = Object.freeze({
  nameLength: 256,
  aliasCount: 256,
  aliasLength: 1024,
  summaryLength: 4096,
  descriptionLength: 65_536,
  keywordCount: 100,
  keywordLength: 4096,
  intentCount: 256,
  intentLength: 1024,
  sourceTokens: 262_144,
  queryTokens: 4096,
});

const CATEGORY_TERMS = Object.freeze({
  "小红书与社交内容": ["小红书", "xhs", "社交", "笔记", "抖音", "广告", "内容"],
  "演示与视觉设计": ["ppt", "演示", "幻灯片", "图片", "视觉", "设计", "canva"],
  "UI/UX 与网站": ["ui", "ux", "界面", "网站", "网页", "前端", "交互"],
  "写作与文档": ["写作", "文案", "文档", "pdf", "word", "改写", "翻译"],
  "投资与市场": ["股票", "a股", "港股", "美股", "投资", "市场", "行情", "财务"],
  "开发流程与代码": ["代码", "开发", "bug", "调试", "测试", "审查", "计划", "github"],
  "数据与办公": ["表格", "excel", "数据", "邮件", "会议", "办公"],
  "连接器与自动化": ["自动化", "连接器", "teams", "notion", "outlook", "sharepoint"],
  "思维框架": ["视角", "思维", "决策", "导师", "perspective"],
  "系统与管理": ["skill", "插件", "安装", "系统", "配置", "管理"],
});

const TASK_INTENTS = Object.freeze({
  "web-research": ["搜寻", "搜索", "检索", "查找", "调研", "调查", "查一下", "找一下", "research", "search", "look up"],
  "current-affairs": ["国际时事", "国际新闻", "全球新闻", "世界新闻", "时事", "时政", "地缘政治", "current affairs", "world news", "international news", "geopolitical"],
  "news-analysis": ["国际时事", "国际新闻", "全球新闻", "世界新闻", "新闻分析", "新闻影响", "事件影响", "市场新闻", "current affairs", "world news", "international news", "news analysis", "market-moving news"],
});

const STATUS_PRIORITY = Object.freeze({
  ready: 3,
  "needs-config": 2,
  unchecked: 1,
  abnormal: 0,
});

export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[_:]+/g, "-")
    .replace(/[，。！？；：、,.!?;:()[\]{}"'`~@#%^&*+=|\\/<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripBoundarySeparators(value) {
  let start = 0;
  let end = value.length;
  while (start < end && BOUNDARY_SEPARATOR_CHARACTER.test(value[start])) start += 1;
  while (end > start && BOUNDARY_SEPARATOR_CHARACTER.test(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

function hasExplicitSkillInvocation(query, name) {
  const invocation = `$${name}`;
  let offset = 0;
  while (offset < query.length) {
    const index = query.indexOf(invocation, offset);
    if (index < 0) return false;
    const nextCharacter = query[index + invocation.length] ?? "";
    if (!nextCharacter || !SKILL_INVOCATION_CONTINUATION_CHARACTER.test(nextCharacter)) {
      return true;
    }
    offset = index + invocation.length;
  }
  return false;
}

function tokenize(value, limit = FIELD_BUDGETS.sourceTokens) {
  const normalized = normalizeText(value);
  const latin = normalized.match(/[a-z0-9][a-z0-9-]{1,}/g) ?? [];
  const chineseRuns = normalized.match(/[\u3400-\u9fff]{2,}/g) ?? [];
  const output = new Set();
  for (const token of latin) {
    output.add(token);
    if (output.size >= limit) return [...output];
  }
  for (const run of chineseRuns) {
    output.add(run);
    if (output.size >= limit) return [...output];
    for (let index = 0; index < run.length - 1; index += 1) {
      output.add(run.slice(index, index + 2));
      if (output.size >= limit) return [...output];
    }
  }
  return [...output];
}

function extractIntentTags(query) {
  return Object.entries(TASK_INTENTS)
    .filter(([, terms]) => terms.some((term) => query.includes(normalizeText(term))))
    .map(([tag]) => tag);
}

function countIndependentTokenHits(query, tokens) {
  const intervals = tokens
    .map((token) => {
      const start = query.indexOf(token);
      return start < 0 ? null : { start, end: start + token.length };
    })
    .filter(Boolean)
    .sort((a, b) => a.end - b.end || a.start - b.start);
  let count = 0;
  let previousEnd = -1;
  for (const interval of intervals) {
    if (interval.start < previousEnd) continue;
    count += 1;
    previousEnd = interval.end;
  }
  return count;
}

function categoryMatches(query, category) {
  return (CATEGORY_TERMS[category] ?? []).some((term) => query.includes(normalizeText(term)));
}

function ownDataValue(object, property) {
  const descriptor = Object.getOwnPropertyDescriptor(object, property);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : "";
}

function boundedText(value, maximumLength, { rejectOversized = false } = {}) {
  const text = typeof value === "string" ? value : "";
  if (rejectOversized && text.length > maximumLength) return "";
  return text.slice(0, maximumLength);
}

function boundedList(value, count, length) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, count)
    .filter((item) => typeof item === "string" && item.length <= length);
}

function materializeSourceTokens(values) {
  const set = new Set();
  for (const value of values) {
    for (const token of tokenize(String(value ?? "").replace(/-/gu, " "))) {
      if (token.length >= 2) set.add(token);
      if (set.size >= FIELD_BUDGETS.sourceTokens) break;
    }
    if (set.size >= FIELD_BUDGETS.sourceTokens) break;
  }
  return { set, values: [...set] };
}

function matchedSourceTokens(queryTokens, sourceTokens) {
  return queryTokens.filter((token) => (
    sourceTokens.set.has(token) ||
    (token.length >= 3 && sourceTokens.values.some((sourceToken) => sourceToken.includes(token)))
  ));
}

function matchedIntentQueryTokens(query, queryTokens, intentTags) {
  const matchedTerms = intentTags.flatMap((tag) => (
    (TASK_INTENTS[tag] ?? [])
      .map(normalizeText)
      .filter((term) => term && query.includes(term))
  ));
  const intentTokens = materializeSourceTokens(matchedTerms);
  return queryTokens.filter((token) => (
    intentTokens.set.has(token) ||
    intentTokens.values.some((intentToken) => token.includes(intentToken))
  ));
}

function claimUnseenTokens(tokens, claimedTokens) {
  const unclaimed = [];
  for (const token of tokens) {
    if (claimedTokens.has(token)) continue;
    claimedTokens.add(token);
    unclaimed.push(token);
  }
  return unclaimed;
}

function reasonText(reasonCodes, category) {
  if (reasonCodes.includes("exact-name")) return "任务直接点名了这个 Skill";
  if (reasonCodes.includes("alias")) return "任务与它的典型触发场景一致";
  if (reasonCodes.includes("intent")) return "任务意图与它的能力范围一致";
  if (reasonCodes.includes("fuzzy-name")) return "任务中的名称与这个 Skill 高度相似";
  if (reasonCodes.includes("fuzzy-chinese")) return "任务表达与它的能力描述相近";
  if (reasonCodes.includes("category")) return `任务属于${category}`;
  return "任务关键词与它的能力描述高度重合";
}

function toPublicRecommendation(item) {
  return {
    skillId: item.skillId,
    name: item.name,
    summaryZh: item.summaryZh,
    status: item.status,
    score: item.score,
    reasonCodes: item.reasonCodes,
    reasonZh: item.reasonZh,
  };
}

function scoreQualifiedSkills(queryValue, catalog, { minimumScore = MATCH_LEVEL_THRESHOLDS.weak } = {}) {
  const query = normalizeText(queryValue);
  if (!query || query.length > 4096) return [];
  const genericWholeQuery = GENERIC_WHOLE_QUERY_NOUNS.has(stripBoundarySeparators(query));
  const queryTokens = tokenize(query, FIELD_BUDGETS.queryTokens).filter((token) => token.length >= 2);
  const queryIntentTags = extractIntentTags(query);

  const scored = [];
  for (const skill of catalog?.skills ?? []) {
    const nameValue = boundedText(ownDataValue(skill, "name"), FIELD_BUDGETS.nameLength, {
      rejectOversized: true,
    });
    const name = normalizeText(nameValue);
    if (!name) continue;
    const aliasValues = boundedList(
      ownDataValue(skill, "aliases"),
      FIELD_BUDGETS.aliasCount,
      FIELD_BUDGETS.aliasLength,
    );
    const aliases = aliasValues.map(normalizeText).filter(Boolean);
    const keywordValues = boundedList(
      ownDataValue(skill, "keywords"),
      FIELD_BUDGETS.keywordCount,
      FIELD_BUDGETS.keywordLength,
    );
    const keywords = keywordValues.map(normalizeText).filter(Boolean);
    const summary = boundedText(ownDataValue(skill, "summaryZh"), FIELD_BUDGETS.summaryLength);
    const description = boundedText(ownDataValue(skill, "description"), FIELD_BUDGETS.descriptionLength);
    const category = boundedText(ownDataValue(skill, "category"), FIELD_BUDGETS.aliasLength);
    const intentTags = boundedList(
      ownDataValue(skill, "intentTags"),
      FIELD_BUDGETS.intentCount,
      FIELD_BUDGETS.intentLength,
    );
    const reasonCodes = [];
    let matchedAliases = [];
    let matchedName = "";
    let exactIdentity = false;
    let score = 0;

    if (query === name || hasExplicitSkillInvocation(query, name)) {
      score += WEIGHTS.exactName;
      reasonCodes.push("exact-name");
      matchedName = nameValue;
      exactIdentity = true;
    } else if (name.length >= 3 && query.includes(name)) {
      score += WEIGHTS.nameSubstring;
      reasonCodes.push("name");
      matchedName = nameValue;
    }

    matchedAliases = aliases.filter((alias) => (
      alias.length >= 2 && (
        query.includes(alias) ||
        (query.length >= 4 && alias.includes(query))
      )
    ));
    if (matchedAliases.some((alias) => query === alias)) {
      score += WEIGHTS.exactAlias;
      reasonCodes.push("alias");
      exactIdentity = true;
    } else if (matchedAliases.length) {
      score += WEIGHTS.aliasSubstring;
      reasonCodes.push("alias");
    }

    const hasDirectNameEvidence = reasonCodes.some((code) => ["exact-name", "name", "alias"].includes(code));
    const matchedFuzzyNameTokens = hasDirectNameEvidence
      ? []
      : matchedLatinTypoQueryTokens(query, [nameValue, ...aliases]);
    if (matchedFuzzyNameTokens.length) {
      score += WEIGHTS.fuzzyName;
      reasonCodes.push("fuzzy-name");
    }

    const chineseSimilarity = maxChineseBigramDice(query, [
      nameValue,
      ...aliasValues,
      summary,
      description,
      ...keywordValues,
    ]);
    if (chineseSimilarity >= 0.5) {
      score += Math.round(chineseSimilarity * WEIGHTS.chineseSimilarity);
      reasonCodes.push("fuzzy-chinese");
    }

    const skillIntentTags = new Set(intentTags);
    const sharedIntentTags = queryIntentTags.filter((tag) => skillIntentTags.has(tag));
    if (sharedIntentTags.length) {
      score += Math.min(sharedIntentTags.length, 2) * WEIGHTS.intent;
      reasonCodes.push("intent");
    }

    const identityTokens = materializeSourceTokens([nameValue, ...aliasValues]);
    const weightedIdentityTokens = materializeSourceTokens([matchedName, ...matchedAliases]);
    const descriptionTokens = materializeSourceTokens([summary, description]);
    const keywordTokens = materializeSourceTokens(keywords);
    const matchedIdentityTokens = matchedSourceTokens(queryTokens, identityTokens);
    const weightedIdentityEvidence = new Set(
      matchedSourceTokens(queryTokens, weightedIdentityTokens),
    );
    const fuzzyIdentityEvidence = new Set(matchedFuzzyNameTokens);
    const intentEvidenceTokens = new Set(
      matchedIntentQueryTokens(query, queryTokens, sharedIntentTags),
    );
    const claimedTokens = new Set([
      ...intentEvidenceTokens,
      ...matchedIdentityTokens,
      ...matchedFuzzyNameTokens,
    ]);
    const unweightedIdentityTokens = matchedIdentityTokens.filter((token) => (
      !weightedIdentityEvidence.has(token) &&
      !fuzzyIdentityEvidence.has(token) &&
      !intentEvidenceTokens.has(token)
    ));
    const matchedDescriptionTokens = claimUnseenTokens(
      matchedSourceTokens(queryTokens, descriptionTokens),
      claimedTokens,
    );
    const matchedKeywordTokens = claimUnseenTokens(
      matchedSourceTokens(queryTokens, keywordTokens),
      claimedTokens,
    );
    const contentEvidenceTokens = [...new Set([
      ...matchedDescriptionTokens,
      ...matchedKeywordTokens,
    ])];
    const scoreableEvidenceTokens = [
      ...unweightedIdentityTokens,
      ...contentEvidenceTokens,
    ];
    const descriptionHits = countIndependentTokenHits(query, matchedDescriptionTokens);
    const keywordHits = countIndependentTokenHits(query, matchedKeywordTokens);
    const descriptionEvidence = new Set(matchedDescriptionTokens);
    const independentKeywordHits = countIndependentTokenHits(
      query,
      matchedKeywordTokens.filter((token) => !descriptionEvidence.has(token)),
    );
    const scoreableEvidenceHits = countIndependentTokenHits(query, scoreableEvidenceTokens);
    if (matchedIdentityTokens.length) reasonCodes.push("name-tokens");
    if (descriptionHits) reasonCodes.push("description");
    if (keywordHits) reasonCodes.push("keywords");
    if (scoreableEvidenceHits >= 2) {
      score += Math.min(scoreableEvidenceHits, 5) * WEIGHTS.keyword;
    }
    // A broad category is supporting evidence only. It must never make an
    // otherwise unrelated Skill cross the reminder threshold by itself.
    if (score > 0 && categoryMatches(query, category)) {
      score += WEIGHTS.category;
      reasonCodes.push("category");
    }
    const evidenceFamilies = new Set();
    if (exactIdentity) evidenceFamilies.add("exact-identity");
    if (reasonCodes.some((code) => ["exact-name", "name", "alias", "fuzzy-name", "name-tokens"].includes(code))) {
      evidenceFamilies.add("name");
    }
    if (reasonCodes.includes("intent")) evidenceFamilies.add("controlled-intent");
    if (reasonCodes.includes("description")) evidenceFamilies.add("description");
    if (independentKeywordHits) evidenceFamilies.add("keywords");
    if (reasonCodes.includes("category")) evidenceFamilies.add("category");

    const hasQualifyingEvidence = reasonCodes.some((code) => (
      ["exact-name", "name", "alias", "intent", "fuzzy-name"].includes(code)
    ));
    const qualifies = !genericWholeQuery && (
      hasQualifyingEvidence || evidenceFamilies.size >= 2
    );
    if (qualifies && score >= minimumScore) {
      scored.push({
        skillId: skill.id,
        name: nameValue,
        summaryZh: summary,
        status: skill.status,
        score: Number(score.toFixed(2)),
        reasonCodes: [...new Set(reasonCodes)],
        reasonZh: reasonText(reasonCodes, category),
        exactIdentity,
        evidenceFamilies: [...evidenceFamilies],
        usageCount: Number(skill.usageCount ?? 0),
        path: skill.path ?? "",
      });
    }
  }

  return scored
    .sort((a, b) => (
      b.score - a.score ||
      (STATUS_PRIORITY[b.status] ?? -1) - (STATUS_PRIORITY[a.status] ?? -1) ||
      b.usageCount - a.usageCount ||
      a.path.localeCompare(b.path) ||
      a.name.localeCompare(b.name)
    ));
}

function selectRecommendations(scored, limit) {
  const seenNames = new Set();
  return scored
    .filter((item) => {
      const key = normalizeText(item.name);
      if (seenNames.has(key)) return false;
      seenNames.add(key);
      return true;
    })
    .slice(0, Math.min(3, Math.max(0, limit)))
    .map(toPublicRecommendation);
}

export function recommendSkills(
  queryValue,
  catalog,
  { limit = 3, minimumScore = MATCH_LEVEL_THRESHOLDS.weak } = {},
) {
  return selectRecommendations(
    scoreQualifiedSkills(queryValue, catalog, { minimumScore }),
    limit,
  );
}

export function recommendSkillsWithLevel(query, catalog, options = {}) {
  const { limit = 3, minimumScore = MATCH_LEVEL_THRESHOLDS.weak } = options;
  const scored = scoreQualifiedSkills(query, catalog, { minimumScore });
  const results = selectRecommendations(scored, limit);
  if (!scored.length) return { level: "none", results };
  const top = scored[0];
  const runner = scored.find((item) => normalizeText(item.name) !== normalizeText(top.name));
  const lead = runner ? top.score - runner.score : Number.POSITIVE_INFINITY;
  const families = new Set(top.evidenceFamilies);
  const semanticStrong = (
    top.score >= MATCH_LEVEL_THRESHOLDS.semanticStrong &&
    families.has("controlled-intent") &&
    ["name", "description", "keywords"].some((family) => families.has(family)) &&
    lead >= MATCH_LEVEL_THRESHOLDS.semanticLead
  );
  return {
    level: top.exactIdentity || semanticStrong ? "strong" : "weak",
    results,
  };
}

export { TASK_INTENTS, WEIGHTS };
