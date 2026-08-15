const WEIGHTS = Object.freeze({
  exactName: 100,
  nameSubstring: 45,
  exactAlias: 35,
  aliasSubstring: 22,
  intent: 14,
  keyword: 8,
  category: 4,
  historicalTieBreak: 0.01,
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

function tokenize(value) {
  const normalized = normalizeText(value);
  const latin = normalized.match(/[a-z0-9][a-z0-9-]{1,}/g) ?? [];
  const chineseRuns = normalized.match(/[\u3400-\u9fff]{2,}/g) ?? [];
  const chinese = chineseRuns.flatMap((run) => {
    const pieces = [run];
    for (let index = 0; index < run.length - 1; index += 1) pieces.push(run.slice(index, index + 2));
    return pieces;
  });
  return [...new Set([...latin, ...chinese])];
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

function reasonText(reasonCodes, skill) {
  if (reasonCodes.includes("exact-name")) return "任务直接点名了这个 Skill";
  if (reasonCodes.includes("alias")) return "任务与它的典型触发场景一致";
  if (reasonCodes.includes("intent")) return "任务意图与它的能力范围一致";
  if (reasonCodes.includes("category")) return `任务属于${skill.category}`;
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

export function recommendSkills(queryValue, catalog, { limit = 3, minimumScore = 12 } = {}) {
  const query = normalizeText(queryValue);
  if (!query || query.length > 4096) return [];
  const queryTokens = tokenize(query).filter((token) => token.length >= 2);
  const queryIntentTags = extractIntentTags(query);

  const scored = [];
  for (const skill of catalog?.skills ?? []) {
    const name = normalizeText(skill.name);
    const aliases = (skill.aliases ?? []).map(normalizeText).filter(Boolean);
    const keywords = (skill.keywords ?? []).map(normalizeText).filter(Boolean);
    const reasonCodes = [];
    let score = 0;

    if (query === name || query.includes(`$${name}`)) {
      score += WEIGHTS.exactName;
      reasonCodes.push("exact-name");
    } else if (name.length >= 3 && query.includes(name)) {
      score += WEIGHTS.nameSubstring;
      reasonCodes.push("name");
    }

    for (const alias of aliases) {
      if (alias.length < 2) continue;
      if (query === alias) {
        score += WEIGHTS.exactAlias;
        reasonCodes.push("alias");
        break;
      }
      if (query.includes(alias) || (query.length >= 4 && alias.includes(query))) {
        score += WEIGHTS.aliasSubstring;
        reasonCodes.push("alias");
        break;
      }
    }

    const skillIntentTags = new Set(skill.intentTags ?? []);
    const sharedIntentTags = queryIntentTags.filter((tag) => skillIntentTags.has(tag));
    if (sharedIntentTags.length) {
      score += Math.min(sharedIntentTags.length, 2) * WEIGHTS.intent;
      reasonCodes.push("intent");
    }

    const matchedKeywordTokens = queryTokens.filter((token) => (
      keywords.some((keyword) => keyword === token || (token.length >= 3 && keyword.includes(token)))
    ));
    const keywordHits = countIndependentTokenHits(query, matchedKeywordTokens);
    if (keywordHits) {
      score += Math.min(keywordHits, 5) * WEIGHTS.keyword;
      reasonCodes.push("keywords");
    }
    // A broad category is supporting evidence only. It must never make an
    // otherwise unrelated Skill cross the reminder threshold by itself.
    if (score > 0 && categoryMatches(query, skill.category)) {
      score += WEIGHTS.category;
      reasonCodes.push("category");
    }
    score += Math.min(Number(skill.usageCount ?? 0), 100) * WEIGHTS.historicalTieBreak;

    const hasStrongEvidence = reasonCodes.some((code) => ["exact-name", "name", "alias", "intent"].includes(code));
    const qualifies = hasStrongEvidence || keywordHits >= 2;
    if (qualifies && score >= minimumScore) {
      scored.push({
        skillId: skill.id,
        name: skill.name,
        summaryZh: skill.summaryZh,
        status: skill.status,
        score: Number(score.toFixed(2)),
        reasonCodes: [...new Set(reasonCodes)],
        reasonZh: reasonText(reasonCodes, skill),
        usageCount: Number(skill.usageCount ?? 0),
        path: skill.path ?? "",
      });
    }
  }

  const seenNames = new Set();
  return scored
    .sort((a, b) => (
      b.score - a.score ||
      (STATUS_PRIORITY[b.status] ?? -1) - (STATUS_PRIORITY[a.status] ?? -1) ||
      b.usageCount - a.usageCount ||
      a.path.localeCompare(b.path) ||
      a.name.localeCompare(b.name)
    ))
    .filter((item) => {
      const key = normalizeText(item.name);
      if (seenNames.has(key)) return false;
      seenNames.add(key);
      return true;
    })
    .slice(0, Math.min(3, Math.max(0, limit)))
    .map(toPublicRecommendation);
}

export { TASK_INTENTS, WEIGHTS };
