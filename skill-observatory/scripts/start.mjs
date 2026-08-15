import { spawn } from "node:child_process";
import { constants as fileConstants } from "node:fs";
import { access, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  resolveRadarTemplateRoot,
  resolveSkillRoot,
} from "./install-skill-radar.mjs";
import {
  createSetupFingerprint,
  resolveDashboardRoot,
  resolveRuntimeStateDirectory,
  SETUP_MARKER_NAME,
} from "./setup.mjs";
import { isMainModule } from "./is-main.mjs";

export async function assertSetupCompleted({ dashboardRoot, radarTemplateRoot, stateDirectory }) {
  try {
    await Promise.all([
      access(join(dashboardRoot, "package.json")),
      access(join(dashboardRoot, "node_modules")),
    ]);
    const markerPath = join(stateDirectory, SETUP_MARKER_NAME);
    const markerHandle = await open(
      markerPath,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW,
    );
    let markerMetadata;
    let marker;
    try {
      markerMetadata = await markerHandle.stat();
      if (!markerMetadata.isFile()) throw new Error("setup-marker-regular-file-required");
      marker = JSON.parse(await markerHandle.readFile("utf8"));
    } finally {
      await markerHandle.close();
    }
    const markerMode = markerMetadata.mode & 0o777;
    const fingerprint = await createSetupFingerprint({ dashboardRoot, radarTemplateRoot });
    if (markerMode !== 0o600 || marker.schemaVersion !== 1 || marker.fingerprint !== fingerprint) {
      throw new Error("setup-marker-invalid");
    }
  } catch {
    throw new Error("setup-required");
  }
}

export async function startDashboard({
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
  const child = spawnImpl("npm", ["run", "dashboard", ...args], {
    cwd: dashboardRoot,
    env: {
      ...env,
      SKILL_OBSERVATORY_RADAR_TEMPLATE_DIR: radarTemplateRoot,
    },
    stdio: "inherit",
  });
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`dashboard-terminated:${signal}`));
      } else if (code !== 0) {
        reject(new Error(`dashboard-exited:${code}`));
      } else {
        resolvePromise(0);
      }
    });
  });
}

if (isMainModule(import.meta.url)) {
  startDashboard({ args: process.argv.slice(2) }).catch((error) => {
    process.stderr.write(`${error.code ?? error.message}\n`);
    process.exitCode = 1;
  });
}
