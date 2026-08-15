import { access, readFile } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { atomicWriteJson, readJsonFile } from "./cache.mjs";
import { APPROVED_CATEGORIES, CATALOG_SCHEMA_VERSION, MAX_WARNING_EXAMPLES, SOURCE_TYPES } from "./contracts.mjs";
import { discoverSkills } from "./discover.mjs";
import { analyzeHistory } from "./history.mjs";
import { normalizeText } from "./recommend.mjs";
import { ensurePrivateDirectory } from "./runtime-paths.mjs";

const CATEGORY_RULES = [
  ["小红书与社交内容", /xhs|xiaohongshu|redbook|redfox|小红书|douyin|social|ads-intelligence|media-crawler/i],
  ["演示与视觉设计", /ppt|presentation|canva|imagegen|visualize|social-card|design-feedback/i],
  ["UI/UX 与网站", /ui-ux|ux-writing|sites-|browser|chrome|computer-use|frontend|website/i],
  ["写作与文档", /humanizer|shuorenhua|document|pdf|writing|translate|knowledge-capture/i],
  ["投资与市场", /share|stock|trading|market-news|finance|fund|uzi|deep-analysis/i],
  ["开发流程与代码", /github|gh-|debug|code-review|verification|brainstorming|writing-plans|agents-sdk|openai-api|build-chatgpt/i],
  ["数据与办公", /spreadsheet|excel|outlook-email|meeting|bulk-create/i],
  ["连接器与自动化", /teams|notion|sharepoint|plugin-management|automation|planner/i],
  ["思维框架", /perspective|mentor|nuwa|munger|feynman|karpathy|musk|jobs|graham|naval|taleb|trump|yiming|xuefeng/i],
  ["系统与管理", /skill-|plugin-|openai-docs|template-creator|hatch-pet/i],
];

const SUMMARY_RULES = [
  [/perspective/i, (name) => `使用 ${name.replace(/-perspective$/i, "").replace(/-/g, " ")} 的思维框架分析问题并提供建议。`],
  [/^canva-brand-check$/, () => "检查 Canva 设计是否符合品牌色、字体与标志规范。"],
  [/^canva-edit-design$/, () => "编辑 Canva 设计中的文字、图片与版式。"],
  [/^canva-/i, () => "按专用流程创建、检查或调整 Canva 设计。"],
  [/^teams-daily-digest$/, () => "汇总 Microsoft Teams 中指定范围的每日动态。"],
  [/^teams-/i, () => "读取或处理 Microsoft Teams 中的消息、通知和任务。"],
  [/^notion-/i, () => "把 Notion 中的资料整理为结构化知识、会议材料或实施任务。"],
  [/^gh-fix-ci$/, () => "排查并修复 GitHub Actions 中失败的拉取请求检查。"],
  [/^gh-address-comments$/, () => "处理 GitHub 拉取请求中尚未解决的审查意见。"],
  [/^github|^yeet$/i, () => "处理 GitHub 仓库、议题、拉取请求或发布工作流。"],
  [/spreadsheet|excel/i, () => "创建、编辑、分析并验证电子表格。"],
  [/presentation|ppt/i, () => "创建、编辑或增强可演示的幻灯片文件。"],
  [/document/i, () => "创建、编辑和检查专业文档。"],
  [/^pdf/i, () => "读取、创建、检查和验证 PDF 文件。"],
  [/^sites-/i, () => "构建或管理可交互的网站与内部工具。"],
  [/browser|chrome|computer-use/i, () => "控制本机浏览器或应用界面完成交互任务。"],
  [/outlook/i, () => "读取、整理和撰写 Outlook 邮件。"],
  [/sharepoint/i, () => "检查和管理 Microsoft SharePoint 中的站点与文件。"],
  [/skill-installer/i, () => "从精选列表或 GitHub 仓库安装 Codex Skill。"],
  [/skill-creator/i, () => "创建或更新可被 Codex 自动发现的专用 Skill。"],
  [/openai-docs/i, () => "检索 OpenAI 官方文档并回答 Codex 与 API 使用问题。"],
];

function firstSentence(value) {
  const compact = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  const match = compact.match(/^.{1,150}?[。！？.!?](?:\s|$)/);
  return (match?.[0] ?? compact.slice(0, 140)).trim();
}

function inferCategory(skill, override) {
  if (APPROVED_CATEGORIES.includes(override?.category)) return override.category;
  const haystack = `${skill.name} ${skill.description}`;
  return CATEGORY_RULES.find(([, pattern]) => pattern.test(haystack))?.[0] ?? "其他";
}

function inferChineseSummary(skill, override) {
  if (override?.summaryZh) return { summaryZh: override.summaryZh, summaryState: "curated" };
  const chineseSentence = firstSentence(skill.description);
  if (/[\u3400-\u9fff]/.test(chineseSentence)) {
    return { summaryZh: chineseSentence, summaryState: "source-fallback" };
  }
  const generated = SUMMARY_RULES.find(([pattern]) => pattern.test(skill.name));
  if (generated) return { summaryZh: generated[1](skill.name), summaryState: "source-fallback" };
  return {
    summaryZh: `按 ${skill.displayName} 的专用流程处理相关任务。`,
    summaryState: "source-fallback",
  };
}

function buildKeywords(skill, summary, category, aliases) {
  const raw = `${skill.name} ${skill.description} ${summary} ${category} ${aliases.join(" ")}`;
  const normalized = normalizeText(raw);
  const latin = normalized.match(/[a-z0-9][a-z0-9-]{1,}/g) ?? [];
  const chineseRuns = normalized.match(/[\u3400-\u9fff]{2,}/g) ?? [];
  const chinese = chineseRuns.flatMap((run) => {
    const values = [run];
    for (let index = 0; index < run.length - 1; index += 1) values.push(run.slice(index, index + 2));
    return values;
  });
  return [...new Set([...latin, ...chinese])].slice(0, 100);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function buildScanRoots({ homeDir, codexRoot = join(homeDir, ".codex"), cwd }) {
  const roots = [
    { path: join(codexRoot, "skills"), sourceType: SOURCE_TYPES.USER, label: "Codex personal" },
    { path: join(homeDir, ".agents", "skills"), sourceType: SOURCE_TYPES.USER, label: "Agent personal" },
    { path: join(codexRoot, "plugins", "cache"), sourceType: SOURCE_TYPES.PLUGIN, label: "plugins" },
  ];
  let cursor = cwd;
  const filesystemRoot = parse(cursor).root;
  while (cursor && cursor !== filesystemRoot) {
    const candidate = join(cursor, ".agents", "skills");
    if (await exists(candidate)) roots.push({ path: candidate, sourceType: SOURCE_TYPES.REPO, label: cursor });
    cursor = dirname(cursor);
  }
  return roots;
}

export async function syncCatalog({
  projectRoot,
  homeDir,
  codexRoot = join(homeDir, ".codex"),
  cwd = projectRoot,
  dataDirectory,
  fullRebuild = false,
  reminderCatalogPath,
}) {
  await ensurePrivateDirectory(dataDirectory);
  const overrides = await readJsonFile(join(projectRoot, "data", "skill-overrides.json"), {});
  const validationRegistry = await readJsonFile(join(dataDirectory, "skill-validations.json"), {
    schemaVersion: 1,
    records: {},
  });
  const roots = await buildScanRoots({ homeDir, codexRoot, cwd });
  const discovery = await discoverSkills({ roots });
  const sessionsRoot = join(codexRoot, "sessions");
  const historyAvailable = await exists(sessionsRoot);
  const history = historyAvailable
    ? await analyzeHistory({
        sessionsRoot,
        skills: discovery.skills,
        cachePath: join(dataDirectory, "history-cache.json"),
        fullRebuild,
      })
    : { events: [], sessionFileCount: 0, skippedFileCount: 0, warnings: [{ code: "history-unavailable" }] };

  const eventsBySkill = new Map();
  for (const event of history.events) {
    const list = eventsBySkill.get(event.skillId) ?? [];
    list.push(event);
    eventsBySkill.set(event.skillId, list);
  }
  const monthPrefix = new Date().toISOString().slice(0, 7);
  const skills = discovery.skills.map((skill) => {
    const override = overrides[skill.name] ?? {};
    const category = inferCategory(skill, override);
    const summary = inferChineseSummary(skill, override);
    const aliases = [...new Set([...(override.aliases ?? []), skill.name.replace(/[-_:]+/g, " ")])];
    const intentTags = [...new Set(
      (Array.isArray(override.intentTags) ? override.intentTags : [])
        .filter((tag) => /^[a-z][a-z0-9-]{1,63}$/.test(tag)),
    )].sort();
    const events = eventsBySkill.get(skill.id) ?? [];
    const lastUsedAt = events[0]?.invokedAt ?? null;
    const overrideEnvNames = Array.isArray(override.requiredEnvNames)
      ? override.requiredEnvNames.filter((name) => /^[A-Z][A-Z0-9_]+$/.test(name))
      : [];
    const requiredEnvNames = [...new Set([...skill.requiredEnvNames, ...overrideEnvNames])].sort();
    const missingEnvNames = requiredEnvNames.filter((name) => !process.env[name]);
    const hasStatusOverride = ["ready", "needs-config", "abnormal", "unchecked"].includes(override.statusOverride);
    const storedValidation = validationRegistry?.records?.[skill.path];
    const hasCurrentValidation = Boolean(
      storedValidation &&
      storedValidation.contentHash === skill.contentHash &&
      ["ready", "needs-config", "abnormal", "unchecked"].includes(storedValidation.status) &&
      Array.isArray(storedValidation.statusReasons),
    );
    const effectiveStatus = hasStatusOverride
      ? override.statusOverride
      : skill.status === "abnormal"
        ? "abnormal"
        : missingEnvNames.length
          ? "needs-config"
          : hasCurrentValidation
            ? storedValidation.status
            : skill.status;
    const statusReasons = Array.isArray(override.statusReasons)
      ? override.statusReasons
      : !hasStatusOverride && skill.status !== "abnormal" && !missingEnvNames.length && hasCurrentValidation
        ? storedValidation.statusReasons
        : [...new Set([
            ...skill.statusReasons,
            ...missingEnvNames.map((name) => `missing-env:${name}`),
          ])];
    return {
      ...skill,
      ...summary,
      category,
      aliases,
      intentTags,
      status: effectiveStatus,
      statusReasons,
      validationMethod: hasCurrentValidation ? storedValidation.method ?? null : null,
      validatedAt: hasCurrentValidation ? storedValidation.checkedAt ?? null : null,
      requiredEnvNames,
      missingEnvNames,
      keywords: buildKeywords(skill, summary.summaryZh, category, aliases),
      usageCount: historyAvailable ? events.length : null,
      lastUsedAt,
      usedThisMonth: Boolean(lastUsedAt?.startsWith(monthPrefix)),
    };
  });

  skills.sort((a, b) => {
    if (a.lastUsedAt && b.lastUsedAt) return b.lastUsedAt.localeCompare(a.lastUsedAt);
    if (a.lastUsedAt) return -1;
    if (b.lastUsedAt) return 1;
    return a.name.localeCompare(b.name);
  });

  const skillById = new Map(skills.map((skill) => [skill.id, skill]));
  const activity = history.events
    .filter((event) => skillById.has(event.skillId))
    .slice(0, 100)
    .map((event) => ({
      skillId: event.skillId,
      skillName: skillById.get(event.skillId).name,
      invokedAt: event.invokedAt,
      evidenceType: event.evidenceType,
    }));
  const warnings = [...discovery.warnings, ...history.warnings];
  const catalog = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    historyAvailable,
    metrics: {
      installed: skills.length,
      confirmedUsed: skills.filter((skill) => Number(skill.usageCount) > 0).length,
      usedThisMonth: skills.filter((skill) => skill.usedThisMonth).length,
      needsConfig: skills.filter((skill) => skill.status === "needs-config").length,
      abnormal: skills.filter((skill) => skill.status === "abnormal").length,
    },
    sourceCounts: discovery.sourceCounts,
    sessionFileCount: history.sessionFileCount,
    skippedFileCount: history.skippedFileCount,
    warningTotal: warnings.length,
    warnings: warnings.slice(0, MAX_WARNING_EXAMPLES),
    skills,
    activity,
  };

  const catalogPath = join(dataDirectory, "catalog.json");
  await atomicWriteJson(catalogPath, catalog);
  if (reminderCatalogPath) {
    try {
      await atomicWriteJson(reminderCatalogPath, catalog);
    } catch (error) {
      catalog.warningTotal += 1;
      catalog.warnings.unshift({ code: "reminder-catalog-sync-failed", message: error.code ?? "error" });
      await atomicWriteJson(catalogPath, catalog);
    }
  }
  return catalog;
}

export async function readCatalog(dataDirectory) {
  const path = join(dataDirectory, "catalog.json");
  return JSON.parse(await readFile(path, "utf8"));
}
