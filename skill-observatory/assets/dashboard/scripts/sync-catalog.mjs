import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson } from "../lib/cache.mjs";
import { curateMissingOverrides, syncCatalog } from "../lib/catalog.mjs";
import { resolveRuntimePaths } from "../lib/runtime-paths.mjs";
import { readPrivateSkillOverrides } from "../lib/skill-overrides.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimePaths = resolveRuntimePaths({ projectRoot, homeDir: homedir(), env: process.env });
const fullRebuild = process.argv.includes("--full");
const curateMissing = process.argv.includes("--curate-missing");
const stagedReminderCatalog = join(runtimePaths.radarTemplateDirectory, "references", "catalog.json");

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function run() {
  let catalog = await syncCatalog({
    projectRoot,
    homeDir: homedir(),
    codexRoot: runtimePaths.codexRoot,
    cwd: projectRoot,
    dataDirectory: runtimePaths.dataDirectory,
    fullRebuild,
    reminderCatalogPath: await pathExists(join(runtimePaths.radarTemplateDirectory, "SKILL.md"))
      ? stagedReminderCatalog
      : undefined,
  });

  if (curateMissing) {
    const overridePath = runtimePaths.skillOverridesPath;
    const currentOverrides = await readPrivateSkillOverrides(overridePath);
    const { overrides, changed } = curateMissingOverrides(currentOverrides, catalog.skills);
    if (changed) {
      const sorted = Object.fromEntries(Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b)));
      await atomicWriteJson(overridePath, sorted);
      catalog = await syncCatalog({
        projectRoot,
        homeDir: homedir(),
        codexRoot: runtimePaths.codexRoot,
        cwd: projectRoot,
        dataDirectory: runtimePaths.dataDirectory,
        fullRebuild: false,
        reminderCatalogPath: await pathExists(join(runtimePaths.radarTemplateDirectory, "SKILL.md"))
          ? stagedReminderCatalog
          : undefined,
      });
    }
  }

  process.stdout.write(`${JSON.stringify({
    generatedAt: catalog.generatedAt,
    metrics: catalog.metrics,
    sessionFileCount: catalog.sessionFileCount,
    warningTotal: catalog.warningTotal,
  })}\n`);
}

run().catch((error) => {
  process.stderr.write(`同步失败：${error.code ?? error.message}\n`);
  process.exitCode = 1;
});
