import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { createInterface } from "node:readline";
import { atomicWriteJson, loadIncrementalCache } from "./cache.mjs";

const EVIDENCE_PRIORITY = Object.freeze({
  "structured-selection": 1,
  "skill-file-read": 2,
  "skill-resource-read": 3,
  "explicit-invocation": 4,
});

function hashThread(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function fingerprintSkills(skills) {
  const stable = skills
    .map((skill) => `${skill.id}\0${skill.name}\0${skill.path}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(stable).digest("hex");
}

async function listJsonlFiles(root) {
  const files = [];
  const queue = [root];
  while (queue.length) {
    const directory = queue.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  }
  return files.sort();
}

function extractMessageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      return typeof item.text === "string" ? item.text : "";
    })
    .join("\n");
}

function buildSkillLookup(skills) {
  return skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    normalizedPath: skill.path.split(sep).join("/"),
    folderPath: skill.path.split(sep).join("/").replace(/\/SKILL\.md$/, "/"),
  }));
}

function matchExplicitInvocations(text, lookup) {
  const matches = [];
  for (const skill of lookup) {
    const escaped = skill.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:^|\\s)\\$${escaped}(?=$|\\s|[，。,.!?；;:：])`, "i").test(text)) {
      matches.push({ skill, evidenceType: "explicit-invocation" });
    }
  }
  return matches;
}

function matchToolInput(input, lookup) {
  if (typeof input !== "string") return [];
  const normalized = input.split("\\").join("/");
  const matches = [];
  for (const skill of lookup) {
    if (normalized.includes(skill.normalizedPath)) {
      matches.push({ skill, evidenceType: "skill-file-read" });
    } else if (normalized.includes(skill.folderPath)) {
      matches.push({ skill, evidenceType: "skill-resource-read" });
    }
  }
  return matches;
}

function upsertEvent(events, event) {
  const key = `${event.threadHash}:${event.turnKey}:${event.skillId}`;
  const existing = events.get(key);
  if (!existing || EVIDENCE_PRIORITY[event.evidenceType] > EVIDENCE_PRIORITY[existing.evidenceType]) {
    events.set(key, event);
  }
}

async function parseSessionFile(path, skills) {
  const lookup = buildSkillLookup(skills);
  const events = new Map();
  const warnings = [];
  let threadSource = basename(path);
  let currentTurn = "unknown";
  let lineNumber = 0;

  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      warnings.push({ code: "malformed-jsonl-line", path, line: lineNumber });
      continue;
    }
    if (record.type === "session_meta" && record.payload?.id) {
      threadSource = String(record.payload.id);
      continue;
    }
    if (record.type === "turn_context" && record.payload?.turn_id) {
      currentTurn = String(record.payload.turn_id);
      continue;
    }
    if (record.type !== "response_item") continue;

    const payload = record.payload ?? {};
    const turnKey = String(payload.internal_chat_message_metadata_passthrough?.turn_id ?? currentTurn);
    const invokedAt = typeof record.timestamp === "string" ? record.timestamp : new Date(0).toISOString();
    const threadHash = hashThread(threadSource);

    if (payload.type === "message" && payload.role === "user") {
      const text = extractMessageText(payload.content);
      for (const match of matchExplicitInvocations(text, lookup)) {
        upsertEvent(events, {
          skillId: match.skill.id,
          threadHash,
          turnKey,
          invokedAt,
          evidenceType: match.evidenceType,
        });
      }
      continue;
    }
    if (payload.type === "custom_tool_call" || payload.type === "function_call") {
      const input = typeof payload.input === "string"
        ? payload.input
        : typeof payload.arguments === "string"
          ? payload.arguments
          : "";
      for (const match of matchToolInput(input, lookup)) {
        upsertEvent(events, {
          skillId: match.skill.id,
          threadHash,
          turnKey,
          invokedAt,
          evidenceType: match.evidenceType,
        });
      }
    }
  }
  return { events: [...events.values()], warnings };
}

export async function analyzeHistory({ sessionsRoot, skills, cachePath, fullRebuild = false }) {
  const files = await listJsonlFiles(sessionsRoot);
  const skillFingerprint = fingerprintSkills(skills);
  const loaded = fullRebuild ? { version: 1, files: {} } : await loadIncrementalCache(cachePath);
  const previous = loaded.skillFingerprint === skillFingerprint ? loaded : { version: 1, files: {} };
  const next = { version: 1, skillFingerprint, files: {} };
  const warnings = [];
  let skippedFileCount = 0;

  for (const path of files) {
    try {
      const info = await stat(path);
      const cached = previous.files[path];
      if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
        next.files[path] = cached;
        warnings.push(...(cached.warnings ?? []));
        continue;
      }
      const parsed = await parseSessionFile(path, skills);
      warnings.push(...parsed.warnings);
      next.files[path] = {
        size: info.size,
        mtimeMs: info.mtimeMs,
        events: parsed.events,
        warnings: parsed.warnings,
      };
    } catch (error) {
      skippedFileCount += 1;
      warnings.push({ code: "unreadable-session", path, message: error.code ?? "error" });
    }
  }

  await atomicWriteJson(cachePath, next);
  const events = Object.values(next.files).flatMap((entry) => entry.events ?? []);
  events.sort((a, b) => b.invokedAt.localeCompare(a.invokedAt));
  return { events, sessionFileCount: files.length, skippedFileCount, warnings };
}
