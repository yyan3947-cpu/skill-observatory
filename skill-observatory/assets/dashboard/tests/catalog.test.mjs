import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readCatalog, syncCatalog } from "../lib/catalog.mjs";

async function writeSkill(homeDir, folder, document) {
  const directory = join(homeDir, ".codex", "skills", folder);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), document, "utf8");
}

test("builds a complete private catalog with curated summaries and exact aggregates", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-observatory-catalog-"));
  const homeDir = join(root, "home");
  const projectRoot = join(root, "project");
  const dataDirectory = join(projectRoot, "private-state");
  const sessions = join(homeDir, ".codex", "sessions");
  await mkdir(join(projectRoot, "data"), { recursive: true });
  await mkdir(sessions, { recursive: true });

  await writeSkill(homeDir, "alpha", "---\nname: alpha\ndescription: Local writing helper.\n---\n");
  await writeSkill(homeDir, "beta", "---\nname: beta\ndescription: Requires ZQX_SKILL_OBSERVATORY_API_KEY for API access.\n---\n");
  await writeSkill(homeDir, "broken", "name: broken\ndescription: no frontmatter\n");
  await writeFile(join(projectRoot, "data", "skill-overrides.json"), `${JSON.stringify({
    alpha: {
      summaryZh: "整理本机文本。",
      category: "写作与文档",
      aliases: ["整理文本"],
      intentTags: ["document-writing", "document-writing", "INVALID TAG"],
      requiredEnvNames: [],
    },
    beta: { summaryZh: "连接测试数据接口。", category: "数据与办公", aliases: ["测试数据"], requiredEnvNames: ["ZQX_SKILL_OBSERVATORY_API_KEY"] },
    broken: { summaryZh: "保留异常 Skill 记录。", category: "系统与管理", aliases: ["异常记录"], requiredEnvNames: [] },
  }, null, 2)}\n`, "utf8");

  const now = new Date().toISOString();
  const records = [
    { type: "session_meta", payload: { id: "private-fixture-thread" } },
    { type: "turn_context", payload: { turn_id: "alpha-old" } },
    { type: "response_item", timestamp: "2020-01-01T00:00:00.000Z", payload: { type: "message", role: "user", content: [{ text: "$alpha" }] } },
    { type: "turn_context", payload: { turn_id: "alpha-now" } },
    { type: "response_item", timestamp: now, payload: { type: "message", role: "user", content: [{ text: "$alpha" }] } },
    { type: "turn_context", payload: { turn_id: "beta-old" } },
    { type: "response_item", timestamp: "2020-01-02T00:00:00.000Z", payload: { type: "message", role: "user", content: [{ text: "$beta" }] } },
  ];
  await writeFile(join(sessions, "fixture.jsonl"), `${records.map(JSON.stringify).join("\n")}\n`, "utf8");

  const previous = process.env.ZQX_SKILL_OBSERVATORY_API_KEY;
  delete process.env.ZQX_SKILL_OBSERVATORY_API_KEY;
  let catalog;
  try {
    catalog = await syncCatalog({ projectRoot, homeDir, cwd: projectRoot, dataDirectory, fullRebuild: true });
  } finally {
    if (previous === undefined) delete process.env.ZQX_SKILL_OBSERVATORY_API_KEY;
    else process.env.ZQX_SKILL_OBSERVATORY_API_KEY = previous;
  }

  assert.deepEqual(catalog.metrics, {
    installed: 3,
    confirmedUsed: 2,
    usedThisMonth: 1,
    needsConfig: 1,
    abnormal: 1,
  });
  assert.equal(catalog.skills.find((skill) => skill.name === "alpha").usageCount, 2);
  assert.deepEqual(
    catalog.skills.find((skill) => skill.name === "alpha").intentTags,
    ["document-writing"],
  );
  assert.equal(catalog.skills.every((skill) => skill.summaryState === "curated"), true);
  assert.equal(catalog.activity[0].skillName, "alpha");
  assert.equal((await stat(dataDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(dataDirectory, "catalog.json"))).mode & 0o777, 0o600);
  assert.equal((await readCatalog(dataDirectory)).schemaVersion, catalog.schemaVersion);
  assert.doesNotMatch(JSON.stringify(catalog), /private-fixture-thread/);
});

test("applies path-scoped validation only while the Skill content hash matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-observatory-validation-"));
  const homeDir = join(root, "home");
  const projectRoot = join(root, "project");
  const dataDirectory = join(projectRoot, "private-state");
  const document = "---\nname: duplicate\ndescription: Browser connector workflow.\n---\n";
  await writeSkill(homeDir, "first", document);
  await writeSkill(homeDir, "second", document);
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const firstPath = await realpath(join(homeDir, ".codex", "skills", "first", "SKILL.md"));
  const secondPath = await realpath(join(homeDir, ".codex", "skills", "second", "SKILL.md"));
  const contentHash = createHash("sha256").update(document).digest("hex");
  await writeFile(join(dataDirectory, "skill-validations.json"), `${JSON.stringify({
    schemaVersion: 1,
    records: {
      [firstPath]: {
        contentHash,
        status: "ready",
        statusReasons: ["validated-local-toolchain"],
        method: "local-toolchain",
        checkedAt: "2026-08-15T00:00:00.000Z",
      },
      [secondPath]: {
        contentHash: "0".repeat(64),
        status: "ready",
        statusReasons: ["validated-local-toolchain"],
        method: "local-toolchain",
        checkedAt: "2026-08-15T00:00:00.000Z",
      },
    },
  }, null, 2)}\n`, "utf8");

  const catalog = await syncCatalog({ projectRoot, homeDir, cwd: projectRoot, dataDirectory, fullRebuild: true });
  const first = catalog.skills.find((skill) => skill.path === firstPath);
  const second = catalog.skills.find((skill) => skill.path === secondPath);
  assert.equal(first.status, "ready");
  assert.equal(first.validationMethod, "local-toolchain");
  assert.equal(first.validatedAt, "2026-08-15T00:00:00.000Z");
  assert.equal(second.status, "unchecked");
  assert.equal(second.validationMethod, null);
  assert.equal(second.validatedAt, null);
});

test("uses a custom Codex root for Skills, plugins, and history", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-observatory-custom-codex-"));
  const homeDir = join(root, "home");
  const codexRoot = join(root, "custom-codex");
  const projectRoot = join(root, "project");
  const dataDirectory = join(codexRoot, "state", "skill-observatory");
  await mkdir(join(projectRoot, "data"), { recursive: true });
  await writeSkill(homeDir, "host-only", "---\nname: host-only\ndescription: Must remain outside an isolated Codex root.\n---\n");
  const isolatedSkillDirectory = join(codexRoot, "skills", "isolated");
  await mkdir(isolatedSkillDirectory, { recursive: true });
  await writeFile(
    join(isolatedSkillDirectory, "SKILL.md"),
    "---\nname: isolated\ndescription: Custom Codex root fixture.\n---\n",
    "utf8",
  );
  const customPluginDirectory = join(codexRoot, "plugins", "cache", "custom-plugin");
  await mkdir(customPluginDirectory, { recursive: true });
  await writeFile(
    join(customPluginDirectory, "SKILL.md"),
    "---\nname: custom-plugin\ndescription: Custom Codex plugin fixture.\n---\n",
    "utf8",
  );
  const hostPluginDirectory = join(homeDir, ".codex", "plugins", "cache", "host-plugin");
  await mkdir(hostPluginDirectory, { recursive: true });
  await writeFile(
    join(hostPluginDirectory, "SKILL.md"),
    "---\nname: host-plugin\ndescription: Must remain outside an isolated Codex root.\n---\n",
    "utf8",
  );
  const agentSkillDirectory = join(homeDir, ".agents", "skills", "agent-shared");
  await mkdir(agentSkillDirectory, { recursive: true });
  await writeFile(
    join(agentSkillDirectory, "SKILL.md"),
    "---\nname: agent-shared\ndescription: Shared agent fixture.\n---\n",
    "utf8",
  );
  await mkdir(join(codexRoot, "sessions"), { recursive: true });
  await writeFile(join(codexRoot, "sessions", "fixture.jsonl"), `${JSON.stringify({
    type: "response_item",
    timestamp: "2026-08-15T00:00:00.000Z",
    payload: { type: "message", role: "user", content: [{ text: "$isolated" }] },
  })}\n`, "utf8");

  const catalog = await syncCatalog({
    projectRoot,
    homeDir,
    codexRoot,
    cwd: projectRoot,
    dataDirectory,
    fullRebuild: true,
  });

  assert.deepEqual(
    catalog.skills.map((skill) => skill.name).sort(),
    ["agent-shared", "custom-plugin", "isolated"],
  );
  assert.equal(catalog.skills.find((skill) => skill.name === "isolated").usageCount, 1);
  assert.equal(catalog.skills.some((skill) => skill.name === "host-only"), false);
  assert.equal(catalog.skills.some((skill) => skill.name === "host-plugin"), false);
});
