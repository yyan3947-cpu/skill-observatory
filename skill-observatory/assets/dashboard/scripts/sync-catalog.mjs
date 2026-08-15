import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, readJsonFile } from "../lib/cache.mjs";
import { syncCatalog } from "../lib/catalog.mjs";
import { resolveRuntimePaths } from "../lib/runtime-paths.mjs";

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
    const overridePath = join(projectRoot, "data", "skill-overrides.json");
    const overrides = await readJsonFile(overridePath, {});
    let changed = false;
    for (const skill of catalog.skills) {
      if (overrides[skill.name]?.summaryZh) continue;
      overrides[skill.name] = {
        summaryZh: skill.summaryZh,
        category: skill.category,
        aliases: [...new Set(skill.aliases ?? [])],
        requiredEnvNames: skill.requiredEnvNames ?? [],
      };
      changed = true;
    }
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
