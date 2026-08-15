import assert from "node:assert/strict";
import test from "node:test";
import { recommendSkills } from "../lib/recommend.mjs";

const catalog = {
  skills: [
    { id: "xhs", name: "post-to-xhs", summaryZh: "发布小红书图文。", status: "unchecked", category: "小红书与社交内容", aliases: ["发布小红书", "小红书图文"], keywords: ["发布", "小红书", "图文"], usageCount: 2 },
    { id: "stock", name: "a-share-analysis", summaryZh: "分析 A 股。", status: "ready", category: "投资与市场", aliases: ["A股分析", "分析A股", "股票基本面"], keywords: ["a股", "股票", "基本面", "分析"], usageCount: 4 },
    { id: "ppt", name: "codex-ppt", summaryZh: "生成演示文稿。", status: "ready", category: "演示与视觉设计", aliases: ["制作PPT", "演示文稿"], keywords: ["ppt", "演示", "幻灯片"], usageCount: 1 },
    { id: "image", name: "imagegen", summaryZh: "生成图片。", status: "ready", category: "演示与视觉设计", aliases: ["生成图片", "AI绘图"], keywords: ["图片", "图像"], usageCount: 20 },
    { id: "sharepoint", name: "sharepoint", summaryZh: "管理站点与文件。", status: "ready", category: "连接器与自动化", aliases: ["sharepoint"], keywords: ["站点", "文件"], usageCount: 30 },
    { id: "reach-a", name: "agent-reach", summaryZh: "搜索和调研互联网资料。", status: "needs-config", category: "其他", aliases: ["agent reach"], intentTags: ["web-research"], keywords: ["搜索", "调研"], usageCount: 13, path: "/skills/a/agent-reach/SKILL.md" },
    { id: "reach-b", name: "agent-reach", summaryZh: "搜索和调研互联网资料。", status: "needs-config", category: "其他", aliases: ["agent reach"], intentTags: ["web-research"], keywords: ["搜索", "调研"], usageCount: 6, path: "/skills/b/agent-reach/SKILL.md" },
    { id: "news", name: "market-news-analyst", summaryZh: "分析国际与市场新闻。", status: "ready", category: "投资与市场", aliases: ["市场新闻分析"], intentTags: ["current-affairs", "news-analysis"], keywords: ["新闻", "地缘政治", "影响", "油价"], usageCount: 1, path: "/skills/market-news/SKILL.md" },
    { id: "incidental", name: "research-biography", summaryZh: "整理人物资料。", status: "ready", category: "写作与文档", aliases: ["人物资料"], intentTags: [], keywords: ["调研", "分析"], usageCount: 1, path: "/skills/biography/SKILL.md" },
    { id: "overlap", name: "overlapping-keywords", summaryZh: "测试重叠词元。", status: "ready", category: "其他", aliases: ["重叠词元"], intentTags: [], keywords: ["分析", "析近"], usageCount: 1, path: "/skills/overlap/SKILL.md" },
  ],
};

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
