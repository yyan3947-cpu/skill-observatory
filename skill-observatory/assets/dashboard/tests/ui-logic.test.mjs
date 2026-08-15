import assert from "node:assert/strict";
import test from "node:test";
import { filterSkills, sortSkills } from "../app/lib/catalog.ts";

const skills = [
  { name: "codex-ppt", summaryZh: "生成演示文稿", description: "PPT", category: "演示与视觉设计", aliases: ["幻灯片"], usageCount: 1, status: "ready", sourceType: "user", lastUsedAt: "2026-08-10T00:00:00Z" },
  { name: "a-share-analysis", summaryZh: "分析股票基本面", description: "A股", category: "投资与市场", aliases: ["股票分析"], usageCount: 4, status: "ready", sourceType: "user", lastUsedAt: "2026-08-11T00:00:00Z" },
  { name: "unused-skill", summaryZh: "整理资料", description: "unused", category: "数据与办公", aliases: ["整理"], usageCount: 0, status: "unchecked", sourceType: "plugin", lastUsedAt: null },
];

test("combines dashboard filters and sorts without mutating input", () => {
  const filtered = filterSkills(skills, {
    query: "股票",
    used: "used",
    status: "all",
    category: "投资与市场",
    source: "all",
  });
  assert.deepEqual(filtered.map((skill) => skill.name), ["a-share-analysis"]);
  assert.deepEqual(sortSkills(skills, "usage").map((skill) => skill.name), [
    "a-share-analysis",
    "codex-ppt",
    "unused-skill",
  ]);
  assert.deepEqual(skills.map((skill) => skill.name), ["codex-ppt", "a-share-analysis", "unused-skill"]);
});
