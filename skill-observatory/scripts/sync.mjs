import { spawn } from "node:child_process";
import { homedir } from "node:os";
import {
  resolveRadarTemplateRoot,
  resolveSkillRoot,
} from "./install-skill-radar.mjs";
import { isMainModule } from "./is-main.mjs";
import { resolveDashboardRoot, resolveRuntimeStateDirectory } from "./setup.mjs";
import { assertSetupCompleted } from "./start.mjs";

export async function syncDashboard({
  skillRoot = resolveSkillRoot(),
  args = [],
  env = process.env,
  homeDirectory = homedir(),
  spawnImpl = spawn,
} = {}) {
  const dashboardRoot = resolveDashboardRoot(skillRoot);
  const radarTemplateRoot = resolveRadarTemplateRoot(skillRoot);
  await assertSetupCompleted({
    dashboardRoot,
    radarTemplateRoot,
    stateDirectory: resolveRuntimeStateDirectory({ env, homeDirectory }),
  });
  const childEnvironment = {
    ...env,
    SKILL_OBSERVATORY_RADAR_TEMPLATE_DIR: radarTemplateRoot,
  };
  delete childEnvironment.GITHUB_TOKEN;
  const child = spawnImpl(process.execPath, ["scripts/sync-catalog.mjs", ...args], {
    cwd: dashboardRoot,
    env: childEnvironment,
    stdio: "inherit",
  });
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`sync-terminated:${signal}`));
      else if (code !== 0) reject(new Error(`sync-exited:${code}`));
      else resolvePromise(0);
    });
  });
}

if (isMainModule(import.meta.url)) {
  syncDashboard({ args: process.argv.slice(2) }).catch((error) => {
    process.stderr.write(`${error.code ?? error.message}\n`);
    process.exitCode = 1;
  });
}
