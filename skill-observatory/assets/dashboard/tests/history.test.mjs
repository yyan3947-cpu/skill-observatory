import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeHistory } from "../lib/history.mjs";

test("counts confirmed evidence once per turn and stores no conversation body", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-observatory-history-"));
  const sessionsRoot = join(root, "sessions");
  const skillPath = join(root, "skills", "alpha", "SKILL.md");
  const betaPath = join(root, "skills", "beta", "SKILL.md");
  await mkdir(join(root, "skills", "alpha", "references"), { recursive: true });
  await mkdir(join(root, "skills", "beta"), { recursive: true });
  await mkdir(sessionsRoot, { recursive: true });
  await writeFile(skillPath, "---\nname: alpha\ndescription: fixture\n---\n", "utf8");
  await writeFile(betaPath, "---\nname: beta\ndescription: fixture\n---\n", "utf8");
  const records = [
    { type: "session_meta", timestamp: "2026-08-15T00:00:00Z", payload: { id: "private-thread-id" } },
    { type: "turn_context", timestamp: "2026-08-15T00:00:01Z", payload: { turn_id: "turn-a" } },
    { type: "response_item", timestamp: "2026-08-15T00:00:02Z", payload: { type: "message", role: "developer", content: [{ text: "available alpha inventory" }] } },
    { type: "response_item", timestamp: "2026-08-15T00:00:03Z", payload: { type: "message", role: "user", content: [{ text: "$alpha private prompt text" }], internal_chat_message_metadata_passthrough: { turn_id: "turn-a" } } },
    { type: "response_item", timestamp: "2026-08-15T00:00:04Z", payload: { type: "custom_tool_call", input: `sed -n '1,20p' ${skillPath}`, internal_chat_message_metadata_passthrough: { turn_id: "turn-a" } } },
    { type: "turn_context", timestamp: "2026-08-15T00:01:00Z", payload: { turn_id: "turn-b" } },
    { type: "response_item", timestamp: "2026-08-15T00:01:01Z", payload: { type: "custom_tool_call", input: `read ${join(root, "skills", "alpha", "references", "guide.md")}`, internal_chat_message_metadata_passthrough: { turn_id: "turn-b" } } },
    { type: "turn_context", timestamp: "2026-08-15T00:02:00Z", payload: { turn_id: "turn-c" } },
    { type: "response_item", timestamp: "2026-08-15T00:02:01Z", payload: { type: "custom_tool_call", input: `read ${betaPath}`, internal_chat_message_metadata_passthrough: { turn_id: "turn-c" } } },
  ];
  const session = join(sessionsRoot, "fixture.jsonl");
  await writeFile(session, `${records.map(JSON.stringify).join("\n")}\n{malformed\n`, "utf8");

  const result = await analyzeHistory({
    sessionsRoot,
    skills: [{ id: "skill-alpha", name: "alpha", path: skillPath }],
    cachePath: join(root, "cache.json"),
    fullRebuild: true,
  });

  assert.equal(result.events.length, 2);
  assert.deepEqual(result.events.map((item) => item.evidenceType).sort(), ["explicit-invocation", "skill-resource-read"]);
  assert.equal(result.warnings[0].code, "malformed-jsonl-line");
  assert.doesNotMatch(JSON.stringify(result), /private prompt text|private-thread-id|available alpha inventory/);

  const afterInstallingBeta = await analyzeHistory({
    sessionsRoot,
    skills: [
      { id: "skill-alpha", name: "alpha", path: skillPath },
      { id: "skill-beta", name: "beta", path: betaPath },
    ],
    cachePath: join(root, "cache.json"),
  });
  assert.equal(afterInstallingBeta.events.length, 3);
  assert.ok(afterInstallingBeta.events.some((item) => item.skillId === "skill-beta"));
  assert.equal(afterInstallingBeta.warnings[0].code, "malformed-jsonl-line");
});
