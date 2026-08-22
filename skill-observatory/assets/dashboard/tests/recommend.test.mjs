import assert from "node:assert/strict";
import test from "node:test";
import { recommendSkills, recommendSkillsWithLevel } from "../lib/recommend.mjs";

const catalog = {
  skills: [
    { id: "xhs", name: "post-to-xhs", summaryZh: "发布小红书图文。", description: "Publish Xiaohongshu content.", status: "unchecked", category: "小红书与社交内容", aliases: ["发布小红书", "小红书图文"], keywords: ["发布", "小红书", "图文"], usageCount: 2 },
    { id: "stock", name: "a-share-analysis", summaryZh: "分析 A 股。", description: "Analyze A-share stocks.", status: "ready", category: "投资与市场", aliases: ["A股分析", "分析A股", "股票基本面"], keywords: ["a股", "股票", "基本面", "分析"], usageCount: 4 },
    { id: "ppt", name: "codex-ppt", summaryZh: "生成演示文稿。", description: "Create presentation decks.", status: "ready", category: "演示与视觉设计", aliases: ["制作PPT", "演示文稿", "presentation deck"], keywords: ["ppt", "演示", "幻灯片"], usageCount: 1 },
    { id: "image", name: "imagegen", summaryZh: "生成图片。", description: "Generate images.", status: "ready", category: "演示与视觉设计", aliases: ["生成图片", "AI绘图"], keywords: ["图片", "图像"], usageCount: 20 },
    { id: "sharepoint", name: "sharepoint", summaryZh: "管理站点与文件。", description: "Manage SharePoint sites and files.", status: "ready", category: "连接器与自动化", aliases: ["sharepoint"], keywords: ["站点", "文件"], usageCount: 30 },
    { id: "reach-a", name: "agent-reach", summaryZh: "搜索和调研互联网资料。", description: "Research the web.", status: "needs-config", category: "其他", aliases: ["agent reach"], intentTags: ["web-research"], keywords: ["搜索", "调研"], usageCount: 13, path: "/skills/a/agent-reach/SKILL.md" },
    { id: "reach-b", name: "agent-reach", summaryZh: "搜索和调研互联网资料。", description: "Research the web.", status: "needs-config", category: "其他", aliases: ["agent reach"], intentTags: ["web-research"], keywords: ["搜索", "调研"], usageCount: 6, path: "/skills/b/agent-reach/SKILL.md" },
    { id: "news", name: "market-news-analyst", summaryZh: "分析国际与市场新闻。", description: "Analyze market-moving news.", status: "ready", category: "投资与市场", aliases: ["市场新闻分析"], intentTags: ["current-affairs", "news-analysis"], keywords: ["新闻", "地缘政治", "影响", "油价"], usageCount: 1, path: "/skills/market-news/SKILL.md" },
    { id: "incidental", name: "research-biography", summaryZh: "整理人物资料。", description: "Research biographies.", status: "ready", category: "写作与文档", aliases: ["人物资料"], intentTags: [], keywords: ["调研", "分析"], usageCount: 1, path: "/skills/biography/SKILL.md" },
    { id: "overlap", name: "overlapping-keywords", summaryZh: "测试重叠词元。", description: "Test overlapping terms.", status: "ready", category: "其他", aliases: ["重叠词元"], intentTags: [], keywords: ["分析", "析近"], usageCount: 1, path: "/skills/overlap/SKILL.md" },
    {
      id: "data-quality",
      name: "data-quality",
      summaryZh: "检测数据质量。",
      description: "Validate data quality.",
      status: "ready",
      category: "数据与办公",
      aliases: ["检测数据"],
      keywords: ["数据", "检测", "质量"],
      usageCount: 0,
      path: "/skills/data-quality/SKILL.md",
    },
  ],
};

function skill(overrides = {}) {
  const id = overrides.id ?? overrides.name ?? "candidate";
  return {
    id,
    name: id,
    summaryZh: "",
    description: "",
    status: "ready",
    category: "其他",
    aliases: [],
    intentTags: [],
    keywords: [],
    usageCount: 0,
    path: `/skills/${id}/SKILL.md`,
    ...overrides,
  };
}

test("ranks direct task matches and stays silent for unrelated work", () => {
  assert.equal(recommendSkills("发布一篇小红书图文", catalog)[0].name, "post-to-xhs");
  assert.equal(recommendSkills("分析贵州茅台的股票基本面", catalog)[0].name, "a-share-analysis");
  assert.equal(recommendSkills("分析A股并生成报告", catalog)[0].name, "a-share-analysis");
  assert.equal(recommendSkills("制作一份演示文稿", catalog)[0].name, "codex-ppt");
  assert.deepEqual(recommendSkills("制作一份演示文稿", catalog).map((item) => item.name), ["codex-ppt"]);
  assert.deepEqual(recommendSkills("今天天气怎么样", catalog), []);
  assert.ok(recommendSkills("股票分析和演示", catalog).length <= 3);
});

test("matches task intent, rejects weak evidence, and deduplicates installed copies", () => {
  assert.deepEqual(
    recommendSkills("搜寻国际时事", catalog).map((item) => item.name),
    ["market-news-analyst", "agent-reach"],
  );
  assert.equal(
    recommendSkills("搜寻国际时事", catalog).filter((item) => item.name === "agent-reach").length,
    1,
  );
  assert.deepEqual(
    recommendSkills("搜索国际新闻", catalog).map((item) => item.name),
    ["market-news-analyst", "agent-reach"],
  );
  assert.deepEqual(
    recommendSkills("分析近期地缘政治新闻对油价影响", catalog).map((item) => item.name),
    ["market-news-analyst"],
  );
  assert.deepEqual(
    recommendSkills("帮我查一下某个话题", catalog).map((item) => item.name),
    ["agent-reach"],
  );
  assert.deepEqual(
    recommendSkills("分析", { skills: [catalog.skills.find((skill) => skill.id === "incidental")] }),
    [],
  );
  assert.deepEqual(recommendSkills("今天天气怎么样", catalog), []);
});

test("classifies direct, fuzzy, and unrelated local matches", () => {
  assert.equal(recommendSkillsWithLevel("codex-ppt", catalog).level, "strong");

  const typo = recommendSkillsWithLevel("build a presentaton deck", catalog);
  assert.equal(typo.level, "weak");
  assert.equal(typo.results[0].name, "codex-ppt");
  assert.ok(typo.results[0].reasonCodes.includes("fuzzy-name"));

  const chinese = recommendSkillsWithLevel("数据检测", catalog);
  assert.equal(chinese.results.some((item) => item.reasonCodes.includes("fuzzy-chinese")), true);

  assert.deepEqual(recommendSkillsWithLevel("分析", catalog), { level: "none", results: [] });
  assert.deepEqual(recommendSkillsWithLevel("数据", catalog), { level: "none", results: [] });
  assert.deepEqual(recommendSkillsWithLevel("今天天气怎么样", catalog), { level: "none", results: [] });
});

test("keeps only exact normalized names and aliases as direct strong identity", () => {
  const aliasCandidate = skill({
    id: "slide-maker",
    aliases: ["presentation deck"],
  });

  assert.equal(recommendSkillsWithLevel("codex-ppt", catalog).level, "strong");
  assert.equal(recommendSkillsWithLevel("$codex-ppt", catalog).level, "strong");
  assert.equal(recommendSkillsWithLevel("please use $codex-ppt, now", catalog).level, "strong");
  assert.equal(recommendSkillsWithLevel("presentation deck", { skills: [aliasCandidate] }).level, "strong");
  assert.equal(recommendSkillsWithLevel("build presentation deck", { skills: [aliasCandidate] }).level, "weak");

  const prefixCollision = recommendSkillsWithLevel("$codex-pptx", catalog);
  assert.equal(prefixCollision.results[0].name, "codex-ppt");
  assert.equal(prefixCollision.results[0].reasonCodes.includes("exact-name"), false);
  assert.equal(prefixCollision.level, "weak");
});

test("collects every direct alias match independent of alias order", () => {
  const query = "search web sources reports";
  const runner = skill({
    id: "exact-runner",
    aliases: [query],
  });
  const aliasPermutations = [
    ["search web", "sources reports"],
    ["sources reports", "search web"],
  ];

  for (const [index, aliases] of aliasPermutations.entries()) {
    const router = skill({
      id: "router",
      aliases,
      intentTags: ["web-research"],
    });
    const result = recommendSkillsWithLevel(query, { skills: [router, runner] });

    assert.equal(result.level, "weak", `permutation ${index}`);
    assert.deepEqual(
      result.results.map((item) => [item.name, item.score]),
      [["router", 36], ["exact-runner", 35]],
      `permutation ${index}`,
    );
  }
});

test("claims normalized name and alias tokens before scoring repeated content evidence", () => {
  const query = "please search web excel sources reports";
  const runner = skill({ id: "search" });
  const duplicateDescription = skill({
    id: "duplicate-description",
    aliases: ["search web"],
    description: "search web",
    category: "数据与办公",
    intentTags: ["web-research"],
  });
  const duplicateKeywords = skill({
    id: "duplicate-keywords",
    aliases: ["search web"],
    keywords: ["search", "web"],
    category: "数据与办公",
    intentTags: ["web-research"],
  });
  const distinctDescription = skill({
    id: "distinct-description",
    aliases: ["search web"],
    description: "search web sources reports",
    category: "数据与办公",
    intentTags: ["web-research"],
  });
  const duplicateName = skill({
    id: "search",
    description: "search web",
  });
  const distinctName = skill({
    id: "search",
    description: "search web sources",
  });

  for (const duplicate of [duplicateDescription, duplicateKeywords]) {
    const result = recommendSkillsWithLevel(query, { skills: [duplicate, runner] });
    assert.deepEqual(result.results.map((item) => item.name), ["search", duplicate.name]);
    assert.deepEqual(result.results.map((item) => item.score), [45, 40]);
    assert.equal(result.level, "weak");
  }

  const distinct = recommendSkillsWithLevel(query, { skills: [distinctDescription, runner] });
  assert.deepEqual(distinct.results.map((item) => item.name), ["distinct-description", "search"]);
  assert.deepEqual(distinct.results.map((item) => item.score), [56, 45]);
  assert.equal(distinct.level, "strong");

  assert.equal(
    recommendSkillsWithLevel(query, { skills: [duplicateName] }).results[0].score,
    45,
  );
  assert.equal(
    recommendSkillsWithLevel(query, { skills: [distinctName] }).results[0].score,
    61,
  );
});

test("claims every normalized query token that provides identity token evidence", () => {
  const cases = [
    {
      label: "exact compound token",
      query: "search web excel",
      candidate: skill({
        id: "search-tool",
        description: "search web",
        category: "数据与办公",
        intentTags: ["web-research"],
      }),
      score: 18,
      level: "weak",
      reasonCode: "name-tokens",
    },
    {
      label: "substring compound token",
      query: "search web excel",
      candidate: skill({
        id: "searching-tool",
        description: "search web",
        category: "数据与办公",
        intentTags: ["web-research"],
      }),
      score: 18,
      level: "weak",
      reasonCode: "name-tokens",
    },
    {
      label: "alias token",
      query: "search web excel",
      candidate: skill({
        id: "alias-router",
        aliases: ["searching workflow"],
        description: "search web",
        category: "数据与办公",
        intentTags: ["web-research"],
      }),
      score: 18,
      level: "weak",
      reasonCode: "name-tokens",
    },
    {
      label: "independent description tokens",
      query: "search web excel sources reports",
      candidate: skill({
        id: "searching-tool",
        description: "search web sources reports",
        category: "数据与办公",
        intentTags: ["web-research"],
      }),
      score: 42,
      level: "strong",
      reasonCode: "name-tokens",
    },
    {
      label: "fuzzy identity token",
      query: "presentaton slides excel",
      candidate: skill({
        id: "presentation-tool",
        description: "presentaton slides",
        category: "数据与办公",
      }),
      score: 22,
      level: "weak",
      reasonCode: "fuzzy-name",
    },
  ];

  for (const fixture of cases) {
    const result = recommendSkillsWithLevel(fixture.query, { skills: [fixture.candidate] });
    assert.equal(result.results[0].score, fixture.score, fixture.label);
    assert.equal(result.level, fixture.level, fixture.label);
    assert.equal(result.results[0].reasonCodes.includes(fixture.reasonCode), true, fixture.label);
  }

  const remoteNameTokens = skill({
    id: "csv-data-validation",
    description: "Data validation and testing skill for structured CSV records.",
    status: "unchecked",
  });
  const remote = recommendSkillsWithLevel(
    "data validation testing data testing",
    { skills: [remoteNameTokens] },
  );
  assert.equal(remote.results[0].score, 24);
  assert.equal(remote.results[0].reasonCodes.includes("name-tokens"), true);
  assert.equal(remote.level, "weak");
});

test("aggregates globally claimed identity and content tokens deterministically", () => {
  const cases = [
    {
      label: "name and independent description token qualify",
      candidate: skill({ id: "csv-tool", description: "CSV validation" }),
      expected: { level: "weak", score: 16, reasons: ["name-tokens", "description"] },
    },
    {
      label: "repeated token across every field scores once",
      candidate: skill({
        id: "csv-tool",
        description: "CSV validation",
        keywords: ["csv", "validation"],
      }),
      expected: { level: "weak", score: 16, reasons: ["name-tokens", "description"] },
    },
    {
      label: "name and independent keyword token qualify",
      candidate: skill({ id: "csv-tool", keywords: ["csv", "validation"] }),
      expected: { level: "weak", score: 16, reasons: ["name-tokens", "keywords"] },
    },
    {
      label: "one repeated token is insufficient",
      candidate: skill({ id: "csv-tool", description: "CSV", keywords: ["csv"] }),
      expected: { level: "none" },
    },
    {
      label: "description alone remains ineligible",
      candidate: skill({ id: "unrelated-tool", description: "CSV validation" }),
      expected: { level: "none" },
    },
    {
      label: "keywords alone remain ineligible",
      candidate: skill({ id: "unrelated-tool", keywords: ["csv", "validation"] }),
      expected: { level: "none" },
    },
  ];

  for (const fixture of cases) {
    const result = recommendSkillsWithLevel("csv validation", { skills: [fixture.candidate] });
    assert.equal(result.level, fixture.expected.level, fixture.label);
    if (fixture.expected.level === "none") {
      assert.deepEqual(result.results, [], fixture.label);
      continue;
    }
    assert.equal(result.results[0].score, fixture.expected.score, fixture.label);
    assert.deepEqual(result.results[0].reasonCodes, fixture.expected.reasons, fixture.label);
  }
});

test("claims controlled-intent tokens before aggregating identity and content", () => {
  const runner = skill({
    id: "ranking-runner",
    aliases: ["excel"],
    category: "数据与办公",
  });
  const cases = [
    {
      label: "intent repeated in description",
      query: "csv search validation excel",
      description: "search validation",
      expectedScore: 30,
      expectedLevel: "weak",
    },
    {
      label: "independent description evidence",
      query: "csv search source validation excel",
      description: "source validation",
      expectedScore: 38,
      expectedLevel: "strong",
    },
  ];

  for (const fixture of cases) {
    const candidate = skill({
      id: "csv-tool",
      description: fixture.description,
      intentTags: ["web-research"],
    });
    const result = recommendSkillsWithLevel(fixture.query, { skills: [candidate, runner] });
    assert.deepEqual(result.results.map((item) => item.score), [fixture.expectedScore, 26], fixture.label);
    assert.equal(result.level, fixture.expectedLevel, fixture.label);
  }
});

test("keeps bounded fuzzy alias evidence invariant under alias permutations", () => {
  const queryNoise = [
    "aaaa00000",
    ...Array.from({ length: 452 }, (_, index) => `aaa${index.toString(36).padStart(5, "0")}`),
  ];
  const query = ["presentaton", ...queryNoise].join(" ");
  const aliasNoise = Array.from(
    { length: 144 },
    (_, index) => `zzzzzzz${index.toString(36).padStart(5, "0")}`,
  );
  const permutations = [
    ["presentation", ...aliasNoise],
    [...aliasNoise, "presentation"],
    [...aliasNoise.slice(72), "presentation", ...aliasNoise.slice(0, 72)],
  ];

  assert.equal(query.length, 4089);
  for (const [index, aliases] of permutations.entries()) {
    const result = recommendSkillsWithLevel(query, {
      skills: [skill({ id: "slide-router", aliases })],
    });
    assert.equal(result.level, "weak", `permutation ${index}`);
    assert.equal(result.results[0].score, 18, `permutation ${index}`);
    assert.equal(result.results[0].reasonCodes.includes("fuzzy-name"), true, `permutation ${index}`);
  }
});

test("prioritizes exact character-signature candidates at maximum input size", () => {
  const alphabet = "mnopqrstuvwxyz";
  const queryNoise = Array.from({ length: 680 }, (_, index) => {
    let value = index;
    let token = "";
    for (let offset = 0; offset < 5; offset += 1) {
      token = `${alphabet[value % alphabet.length]}${token}`;
      value = Math.floor(value / alphabet.length);
    }
    return token;
  });
  const maximumQuery = [...queryNoise, "ikjl"].join(" ");
  const candidateNoise = Array.from(
    { length: 818 },
    (_, index) => `a${index.toString().padStart(3, "0")}`,
  );
  const candidateTokens = [...candidateNoise, "ijkl"];
  const aliases = Array.from(
    { length: 6 },
    (_, group) => candidateTokens.slice(group * 137, (group + 1) * 137).join(" "),
  );
  const candidate = skill({ id: "signature-router", aliases });

  assert.equal(maximumQuery.length, 4084);
  assert.ok(aliases.every((alias) => alias.length <= 1024));
  for (const [label, query] of [["single token", "ikjl"], ["maximum query", maximumQuery]]) {
    const result = recommendSkillsWithLevel(query, { skills: [candidate] });
    assert.equal(result.level, "weak", label);
    assert.equal(result.results[0].score, 18, label);
    assert.deepEqual(result.results[0].reasonCodes, ["fuzzy-name"], label);
  }
});

test("keeps non-fuzzy evidence after the fuzzy work budget is exhausted", () => {
  const queryNoise = Array.from(
    { length: 452 },
    (_, index) => `aaa${index.toString(36).padStart(5, "0")}`,
  );
  const query = ["csv", "validation", ...queryNoise].join(" ");
  const aliases = Array.from(
    { length: 256 },
    (_, group) => Array.from(
      { length: 113 },
      (__, index) => `zzz${(group * 113 + index).toString(36).padStart(5, "0")}`,
    ).join(" "),
  );
  const result = recommendSkillsWithLevel(query, {
    skills: [skill({ id: "csv-tool", description: "CSV validation", aliases })],
  });

  assert.ok(query.length <= 4096);
  assert.ok(aliases.every((alias) => alias.length <= 1024));
  assert.equal(result.level, "weak");
  assert.equal(result.results[0].score, 16);
  assert.deepEqual(result.results[0].reasonCodes, ["name-tokens", "description"]);
});

test("score alone cannot create a semantic strong match", () => {
  const candidate = skill({
    id: "generic-manager",
    description: "Manage Airtable data management workflows",
    category: "数据与办公",
    keywords: ["airtable", "data", "management"],
  });
  const result = recommendSkillsWithLevel(
    "manage Airtable data management workflows",
    { skills: [candidate] },
  );

  assert.ok(result.results[0].score >= 24);
  assert.equal(result.results[0].reasonCodes.includes("intent"), false);
  assert.equal(result.level, "weak");
});

test("semantic strong requires controlled intent and independent capability evidence", () => {
  const intentOnly = skill({
    id: "intent-router",
    intentTags: ["web-research"],
  });
  const intentAndDescription = skill({
    id: "research-router",
    description: "Search web sources.",
    intentTags: ["web-research"],
  });

  assert.equal(recommendSkillsWithLevel("search web sources", { skills: [intentOnly] }).level, "weak");
  assert.equal(
    recommendSkillsWithLevel("search web sources", { skills: [intentAndDescription] }).level,
    "strong",
  );
});

test("semantic strong requires an eight-point lead over the next distinct candidate", () => {
  const query = "search web excel sources";
  const top = skill({
    id: "semantic-top",
    description: "Search web Excel sources",
    category: "数据与办公",
    intentTags: ["web-research"],
  });
  const sevenPointRunner = skill({
    id: "seven-point-runner",
    aliases: [query],
  });
  const eightPointRunner = skill({
    id: "eight-point-runner",
    description: "Search web Excel",
    category: "数据与办公",
    intentTags: ["web-research"],
  });

  const sevenPointLead = recommendSkillsWithLevel(query, { skills: [top, sevenPointRunner] });
  assert.deepEqual(sevenPointLead.results.map((item) => item.score), [42, 35]);
  assert.equal(sevenPointLead.level, "weak");

  const eightPointLead = recommendSkillsWithLevel(query, { skills: [top, eightPointRunner] });
  assert.deepEqual(eightPointLead.results.map((item) => item.score), [42, 34]);
  assert.equal(eightPointLead.level, "strong");
});

test("fixed tasks do not gain unrelated local filler results", () => {
  const fixedCatalog = {
    skills: [
      ...catalog.skills,
      skill({ id: "skill-radar", description: "Discover installed Codex skills." }),
      skill({ id: "skill-creator", description: "Create or update Codex skills." }),
      skill({ id: "plugin-creator", description: "Scaffold Codex plugins." }),
    ],
  };
  const cases = [
    ["管理 Airtable 数据", "weak", ["data-quality"]],
    ["生成二维码", "none", []],
    ["检测数据", "strong", ["data-quality"]],
    ["分析", "none", []],
    ["分析A股并生成报告", "weak", ["a-share-analysis"]],
    ["制作一份演示文稿", "weak", ["codex-ppt"]],
    ["搜寻国际时事", "weak", ["market-news-analyst", "agent-reach"]],
  ];

  for (const [query, level, expectedNames] of cases) {
    const result = recommendSkillsWithLevel(query, fixedCatalog);
    assert.equal(result.level, level, query);
    assert.deepEqual(result.results.map((item) => item.name), expectedNames, query);
  }
});

test("keeps the array-only matcher compatible", () => {
  const tiered = recommendSkillsWithLevel("搜寻国际时事", catalog);
  assert.deepEqual(recommendSkills("搜寻国际时事", catalog), tiered.results);
  assert.equal(tiered.level, "weak");
});

test("keeps remote name and description provenance independent from generated keywords", () => {
  const remoteCatalog = {
    skills: [{
      id: "owner/news-skill\0news-skill/SKILL.md",
      name: "news-skill",
      summaryZh: "Research current affairs and analyze international news from public sources.",
      description: "Research current affairs and analyze international news from public sources.",
      status: "unchecked",
      category: "其他",
      aliases: ["news skill"],
      intentTags: [],
      keywords: [],
      usageCount: 0,
      path: "owner/news-skill/news-skill/SKILL.md",
    }],
  };

  const [remote] = recommendSkills("current affairs news research", remoteCatalog);
  assert.equal(remote.name, "news-skill");
  assert.ok(remote.reasonCodes.includes("name-tokens"));
  assert.ok(remote.reasonCodes.includes("description"));
  assert.equal(remote.reasonCodes.includes("keywords"), false);
});

test("does not qualify candidates backed by generated-looking keywords alone", () => {
  const keywordOnly = {
    id: "keyword-only",
    name: "unrelated-tool",
    summaryZh: "",
    description: "",
    status: "ready",
    category: "其他",
    aliases: [],
    intentTags: [],
    keywords: ["alpha", "beta", "gamma"],
    usageCount: 0,
    path: "/skills/keyword-only/SKILL.md",
  };

  assert.deepEqual(recommendSkillsWithLevel("alpha beta gamma", { skills: [keywordOnly] }), {
    level: "none",
    results: [],
  });
});

test("does not qualify candidates backed by description tokens alone", () => {
  const descriptionOnly = {
    id: "description-only",
    name: "unrelated-tool",
    summaryZh: "",
    description: "alpha beta gamma",
    status: "ready",
    category: "其他",
    aliases: [],
    intentTags: [],
    keywords: [],
    usageCount: 0,
    path: "/skills/description-only/SKILL.md",
  };

  assert.deepEqual(recommendSkillsWithLevel("alpha beta gamma", { skills: [descriptionOnly] }), {
    level: "none",
    results: [],
  });

  const chineseDescriptionOnly = {
    ...descriptionOnly,
    id: "chinese-description-only",
    description: "数据检测",
    path: "/skills/chinese-description-only/SKILL.md",
  };
  assert.deepEqual(recommendSkillsWithLevel("数据检测", { skills: [chineseDescriptionOnly] }), {
    level: "none",
    results: [],
  });
});

test("keeps controlled intents available for exact action queries", () => {
  const result = recommendSkillsWithLevel("search", catalog);
  assert.equal(result.level, "weak");
  assert.deepEqual(result.results.map((item) => item.name), ["agent-reach"]);
  assert.ok(result.results[0].reasonCodes.includes("intent"));
});

test("rejects separator-decorated generic names and aliases but preserves explicit invocation", () => {
  const genericTerms = ["data", "analysis", "file", "content", "分析", "文件", "内容", "数据"];
  for (const [index, term] of genericTerms.entries()) {
    const nameCandidate = {
      id: `generic-name-${index}`,
      name: term,
      summaryZh: "专用工具。",
      description: "Specialized utility.",
      status: "ready",
      category: "其他",
      aliases: [],
      intentTags: [],
      keywords: [],
      usageCount: 0,
      path: `/skills/generic-name-${index}/SKILL.md`,
    };
    const aliasCandidate = {
      ...nameCandidate,
      id: `generic-alias-${index}`,
      name: `generic-alias-${index}`,
      aliases: [term],
      path: `/skills/generic-alias-${index}/SKILL.md`,
    };

    const decoratedQueries = [
      term,
      `${term}:`,
      `${term}_`,
      `${term}：`,
      `：＿${term}＿＿：`,
      `--${term}---`,
      `${term} :`,
      `: ${term}`,
      `${term} _`,
      `_ ${term}`,
      `：＿ ${term} ＿＿：`,
      `: _ ${term} _ :`,
    ];
    for (const query of decoratedQueries) {
      assert.deepEqual(recommendSkillsWithLevel(query, { skills: [nameCandidate, aliasCandidate] }), {
        level: "none",
        results: [],
      });
    }
  }

  const explicit = {
    id: "explicit-analysis",
    name: "analysis",
    summaryZh: "专用分析工具。",
    description: "Specialized analysis utility.",
    status: "ready",
    category: "其他",
    aliases: [],
    intentTags: [],
    keywords: [],
    usageCount: 0,
    path: "/skills/analysis/SKILL.md",
  };
  assert.deepEqual(recommendSkills("$analysis", { skills: [explicit] }).map((item) => item.name), ["analysis"]);

  const hyphenated = {
    ...explicit,
    id: "analysis-tool",
    name: "analysis-tool",
    path: "/skills/analysis-tool/SKILL.md",
  };
  assert.deepEqual(
    recommendSkills("analysis-tool", { skills: [hyphenated] }).map((item) => item.name),
    ["analysis-tool"],
  );
});

test("bounds generic canonicalization for a nonmatching internal hyphen run", { timeout: 2_000 }, () => {
  const query = `x${"-".repeat(4_090)}y`;
  assert.deepEqual(recommendSkillsWithLevel(query, { skills: [] }), { level: "none", results: [] });
});

function semanticTwentyThreeSkill({
  id = "semantic-23",
  name = id,
  status = "ready",
  usageCount = 0,
  path = `/skills/${id}/SKILL.md`,
} = {}) {
  return {
    id,
    name,
    summaryZh: "数据检验呢",
    description: "",
    status,
    category: "其他",
    aliases: [],
    intentTags: [],
    keywords: ["数据", "检测"],
    usageCount,
    path,
  };
}

test("does not let a lower-ranked direct candidate promote the top result", () => {
  const weak = semanticTwentyThreeSkill({ usageCount: 100 });
  const direct = {
    id: "direct-alias",
    name: "direct-alias",
    summaryZh: "Run a direct action.",
    description: "",
    status: "ready",
    category: "其他",
    aliases: ["go"],
    intentTags: [],
    keywords: [],
    usageCount: 0,
    path: "/skills/direct/SKILL.md",
  };
  const result = recommendSkillsWithLevel("go 数据检测", { skills: [weak, direct] });

  assert.equal(result.results[0].name, weak.name);
  assert.equal(result.results[0].score, 23);
  assert.ok(result.results.some((item) => item.reasonCodes.includes("alias")));
  assert.equal(result.level, "weak");
});

test("does not let a hidden rank-four direct candidate promote the top result", () => {
  const weakCandidates = [
    semanticTwentyThreeSkill({ id: "weak-a", usageCount: 3 }),
    semanticTwentyThreeSkill({ id: "weak-b", usageCount: 2 }),
    semanticTwentyThreeSkill({ id: "weak-c", usageCount: 1 }),
  ];
  const direct = {
    id: "rank-four-direct",
    name: "rank-four-direct",
    summaryZh: "Run a direct action.",
    description: "",
    status: "ready",
    category: "其他",
    aliases: ["go"],
    intentTags: [],
    keywords: [],
    usageCount: 0,
    path: "/skills/rank-four/SKILL.md",
  };
  const result = recommendSkillsWithLevel("go 数据检测", { skills: [...weakCandidates, direct] });

  assert.equal(result.results.length, 3);
  assert.equal(result.results.some((item) => item.name === direct.name), false);
  assert.equal(result.level, "weak");
});

test("uses history only after semantic score and status when sorting", () => {
  const skills = [
    semanticTwentyThreeSkill({ id: "ready-low-usage", usageCount: 1, path: "/z/SKILL.md" }),
    semanticTwentyThreeSkill({ id: "unchecked-high-usage", status: "unchecked", usageCount: 100, path: "/a/SKILL.md" }),
    semanticTwentyThreeSkill({ id: "ready-high-usage-z", usageCount: 100, path: "/z/SKILL.md" }),
    semanticTwentyThreeSkill({ id: "ready-high-usage-a", usageCount: 100, path: "/a/SKILL.md" }),
  ];
  const tiered = recommendSkillsWithLevel("数据检测", { skills }, { limit: 3 });

  assert.equal(tiered.level, "weak");
  assert.ok(tiered.results.every((item) => item.score === 23));
  assert.deepEqual(tiered.results.map((item) => item.name), [
    "ready-high-usage-a",
    "ready-high-usage-z",
    "ready-low-usage",
  ]);
});

test("enforces deterministic catalog field budgets", { timeout: 5_000 }, () => {
  const boundedDescription = {
    id: "bounded-description",
    name: "bounded-description",
    summaryZh: "",
    description: `validate records ${"甲-".repeat(20_000)}`,
    status: "ready",
    category: "其他",
    aliases: ["validate records", ...Array.from({ length: 2_000 }, (_, index) => `noise-alias-${index}`)],
    intentTags: [],
    keywords: Array.from({ length: 2_000 }, (_, index) => `noise-keyword-${index}`),
    usageCount: 0,
    path: "/skills/bounded-description/SKILL.md",
  };
  assert.deepEqual(
    recommendSkills("validate records", { skills: [boundedDescription] }).map((item) => item.name),
    ["bounded-description"],
  );

  const validLongName = { ...boundedDescription, id: "valid-long-name", name: "n".repeat(256), description: "" };
  assert.deepEqual(
    recommendSkills("n".repeat(256), { skills: [validLongName] }).map((item) => item.name),
    ["n".repeat(256)],
  );

  const oversizedName = { ...boundedDescription, id: "oversized-name", name: "n".repeat(257), description: "" };
  assert.deepEqual(recommendSkills("n".repeat(257), { skills: [oversizedName] }), []);

  const lateAlias = {
    ...boundedDescription,
    id: "late-alias",
    name: "late-alias",
    description: "",
    aliases: [...Array.from({ length: 32 }, (_, index) => `noise-alias-${index}`), "hidden target"],
    keywords: [],
  };
  assert.deepEqual(
    recommendSkills("hidden target", { skills: [lateAlias] }).map((item) => item.name),
    ["late-alias"],
  );

  const overContractAlias = {
    ...lateAlias,
    id: "over-contract-alias",
    name: "over-contract-alias",
    aliases: [...Array.from({ length: 256 }, (_, index) => `noise-alias-${index}`), "outside contract"],
  };
  assert.deepEqual(recommendSkills("outside contract", { skills: [overContractAlias] }), []);

  const lateKeywords = {
    ...boundedDescription,
    id: "late-keywords",
    name: "late-keywords",
    description: "",
    aliases: [],
    keywords: [...Array.from({ length: 100 }, (_, index) => `noise-keyword-${index}`), "hidden", "target"],
  };
  assert.deepEqual(recommendSkills("hidden target", { skills: [lateKeywords] }), []);
});
