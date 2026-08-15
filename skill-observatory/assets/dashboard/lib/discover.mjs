import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { SOURCE_TYPES } from "./contracts.mjs";
import { assessReadiness } from "./readiness.mjs";

function unquote(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).replace(/\\n/g, " ").replace(/\\"/g, '"');
  }
  return trimmed;
}

export function parseSkillDocument(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { name: "", description: "", body: text, warnings: ["missing-frontmatter"] };
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) {
    return { name: "", description: "", body: text, warnings: ["unterminated-frontmatter"] };
  }

  const values = new Map();
  for (let index = 1; index < end; index += 1) {
    const match = lines[index].match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) continue;
    const [, key, raw] = match;
    if (raw === ">" || raw === "|") {
      const chunks = [];
      while (index + 1 < end && /^\s+/.test(lines[index + 1])) {
        index += 1;
        chunks.push(lines[index].trim());
      }
      values.set(key, chunks.join(raw === ">" ? " " : "\n").trim());
    } else {
      values.set(key, unquote(raw));
    }
  }

  const warnings = [];
  if (!values.get("name")) warnings.push("missing-name");
  if (!values.get("description")) warnings.push("missing-description");
  return {
    name: values.get("name") ?? "",
    description: values.get("description") ?? "",
    body: lines.slice(end + 1).join("\n"),
    warnings,
  };
}

function inferSource(skillPath, root) {
  const normalized = skillPath.split(sep).join("/");
  if (normalized.includes("/.codex/plugins/cache/")) {
    const tail = normalized.split("/.codex/plugins/cache/")[1]?.split("/") ?? [];
    const label = tail[0] === "openai-curated-remote" && tail[1]
      ? `${tail[0]}/${tail[1]}`
      : tail.slice(0, 2).join("/");
    return { sourceType: SOURCE_TYPES.PLUGIN, sourceLabel: label || "plugin" };
  }
  if (normalized.includes("/.codex/skills/.system/")) {
    return { sourceType: SOURCE_TYPES.SYSTEM, sourceLabel: "Codex system" };
  }
  if (root.sourceType === SOURCE_TYPES.REPO) {
    return { sourceType: SOURCE_TYPES.REPO, sourceLabel: root.label || "repository" };
  }
  return { sourceType: root.sourceType ?? SOURCE_TYPES.USER, sourceLabel: root.label || "personal" };
}

async function readSkill(skillPath, root, env, pathValue) {
  const text = await readFile(skillPath, "utf8");
  const parsed = parseSkillDocument(text);
  const fallbackName = dirname(skillPath).split(sep).at(-1) || "unnamed-skill";
  const name = parsed.name || fallbackName;
  const source = inferSource(skillPath, root);
  const readiness = await assessReadiness({
    description: parsed.description,
    body: parsed.body,
    warnings: parsed.warnings,
    env,
    pathValue,
  });

  const contentHash = createHash("sha256").update(text).digest("hex");
  const id = createHash("sha256")
    .update(`${skillPath}\0${name}`)
    .digest("hex")
    .slice(0, 20);
  return {
    id,
    name,
    displayName: name.replace(/[-_:]+/g, " "),
    description: parsed.description,
    sourceType: source.sourceType,
    sourceLabel: source.sourceLabel,
    path: skillPath,
    contentHash,
    rootPath: root.path,
    body: parsed.body,
    ...readiness,
    warnings: parsed.warnings,
  };
}

export async function discoverSkills({ roots, env = process.env, pathValue = process.env.PATH ?? "" }) {
  const skills = [];
  const warnings = [];
  const sourceCounts = {};
  const seenSkillFiles = new Set();

  for (const root of roots) {
    if (!root?.path || !isAbsolute(root.path)) {
      warnings.push({ code: "invalid-root", path: String(root?.path ?? "") });
      continue;
    }
    let resolvedRoot;
    try {
      resolvedRoot = await realpath(root.path);
    } catch {
      continue;
    }
    const queue = [resolvedRoot];
    const seenDirectories = new Set();
    while (queue.length) {
      const directory = queue.pop();
      if (seenDirectories.has(directory)) continue;
      seenDirectories.add(directory);
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        warnings.push({ code: "unreadable-directory", path: directory, message: error.code ?? "error" });
        continue;
      }
      for (const entry of entries) {
        if (["node_modules", ".git", ".data", ".npm-cache"].includes(entry.name)) continue;
        const candidate = join(directory, entry.name);
        if (entry.isDirectory()) {
          queue.push(candidate);
          continue;
        }
        if (entry.isSymbolicLink()) {
          try {
            const target = await realpath(candidate);
            if (!isPathInside(target, resolvedRoot)) {
              warnings.push({ code: "symlink-outside-root", path: candidate });
              continue;
            }
            const info = await stat(target);
            if (info.isDirectory()) queue.push(target);
            else if (entry.name === "SKILL.md" && info.isFile()) {
              if (!seenSkillFiles.has(target)) {
                seenSkillFiles.add(target);
                skills.push(await readSkill(target, { ...root, path: resolvedRoot }, env, pathValue));
              }
            }
          } catch {
            warnings.push({ code: "broken-symlink", path: candidate });
          }
          continue;
        }
        if (!entry.isFile() || entry.name !== "SKILL.md") continue;
        let resolvedSkillPath;
        try {
          resolvedSkillPath = await realpath(candidate);
        } catch (error) {
          warnings.push({ code: "unreadable-skill", path: candidate, message: error.code ?? "error" });
          continue;
        }
        if (seenSkillFiles.has(resolvedSkillPath)) continue;
        seenSkillFiles.add(resolvedSkillPath);
        try {
          skills.push(await readSkill(resolvedSkillPath, { ...root, path: resolvedRoot }, env, pathValue));
        } catch (error) {
          warnings.push({ code: "unreadable-skill", path: resolvedSkillPath, message: error.code ?? "error" });
        }
      }
    }
  }

  const nameCounts = new Map();
  for (const skill of skills) nameCounts.set(skill.name, (nameCounts.get(skill.name) ?? 0) + 1);
  for (const skill of skills) {
    if ((nameCounts.get(skill.name) ?? 0) > 1) skill.warnings.push("duplicate-name");
    sourceCounts[skill.sourceType] = (sourceCounts[skill.sourceType] ?? 0) + 1;
    delete skill.body;
    delete skill.rootPath;
  }

  skills.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  return { skills, warnings, sourceCounts };
}

export function isPathInside(candidate, root) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
