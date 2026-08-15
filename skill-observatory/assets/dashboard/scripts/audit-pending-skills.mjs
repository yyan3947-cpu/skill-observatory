import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillDocument } from "../lib/discover.mjs";
import { ensurePrivateDirectory, resolveRuntimePaths } from "../lib/runtime-paths.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimePaths = resolveRuntimePaths({ projectRoot, homeDir: homedir(), env: process.env });
const catalog = JSON.parse(await readFile(runtimePaths.catalogPath, "utf8"));
const pythonCache = join(runtimePaths.dataDirectory, "validation-pycache");
await ensurePrivateDirectory(pythonCache);

async function listFiles(root, maxDepth = 5) {
  const files = [];
  const queue = [{ path: root, depth: 0 }];
  while (queue.length && files.length < 1000) {
    const { path, depth } = queue.pop();
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if ([".git", ".cache", ".venv", "node_modules", "__pycache__", "build", "dist"].includes(entry.name)) continue;
      const candidate = join(path, entry.name);
      if (entry.isDirectory() && depth < maxDepth) queue.push({ path: candidate, depth: depth + 1 });
      else if (entry.isFile()) files.push(candidate);
    }
  }
  return files;
}

function localReferences(text) {
  const values = new Set();
  for (const match of text.matchAll(/\]\((?!https?:|skill:|plugin:|#)([^)]+)\)/g)) {
    const value = match[1].split("#")[0].trim();
    if (value && !value.startsWith("/") && !/[<>{}$*]/.test(value)) values.add(value);
  }
  return [...values];
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function syntaxCheck(path) {
  const extension = extname(path).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(extension)) {
    return spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
  }
  if (extension === ".py") {
    return spawnSync("/usr/bin/python3", ["-m", "py_compile", path], {
      encoding: "utf8",
      env: { ...process.env, PYTHONPYCACHEPREFIX: pythonCache },
    });
  }
  if ([".sh", ".zsh", ".bash"].includes(extension)) {
    return spawnSync("/bin/zsh", ["-n", path], { encoding: "utf8" });
  }
  return null;
}

const results = [];
for (const skill of catalog.skills.filter((item) => item.status === "unchecked")) {
  const skillRoot = dirname(skill.path);
  const text = await readFile(skill.path, "utf8");
  const parsed = parseSkillDocument(text);
  const files = await listFiles(skillRoot);
  const missingReferences = [];
  for (const reference of localReferences(`${parsed.description}\n${parsed.body}`)) {
    if (!(await exists(resolve(skillRoot, reference)))) missingReferences.push(reference);
  }
  const syntaxFailures = [];
  for (const file of files) {
    const checked = syntaxCheck(file);
    if (checked && checked.status !== 0) {
      syntaxFailures.push({ file: file.slice(skillRoot.length + 1), code: checked.status });
    }
    if (extname(file).toLowerCase() === ".json") {
      try {
        JSON.parse(await readFile(file, "utf8"));
      } catch {
        syntaxFailures.push({ file: file.slice(skillRoot.length + 1), code: "invalid-json" });
      }
    }
  }
  results.push({
    id: skill.id,
    name: skill.name,
    path: skill.path,
    sourceType: skill.sourceType,
    sourceLabel: skill.sourceLabel,
    contentHash: createHash("sha256").update(text).digest("hex"),
    frontmatterValid: parsed.warnings.length === 0,
    frontmatterWarnings: parsed.warnings,
    fileCount: files.length,
    scriptCount: files.filter((file) => [".js", ".mjs", ".cjs", ".py", ".sh", ".zsh", ".bash"].includes(extname(file).toLowerCase())).length,
    missingReferences,
    syntaxFailures,
  });
}

process.stdout.write(`${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`);
