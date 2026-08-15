import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { accessSync, constants as fileConstants } from "node:fs";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import {
  createSha256Manifest,
  installSkillRadar,
  resolveCodexRoot,
  resolveRadarTemplateRoot,
  resolveSkillRoot,
} from "./install-skill-radar.mjs";
import { isMainModule } from "./is-main.mjs";

const MINIMUM_NODE_VERSION = Object.freeze([22, 13, 0]);
const MIGRATED_FILES = Object.freeze([
  "catalog.json",
  "history-cache.json",
  "skill-validations.json",
]);
export const SETUP_MARKER_NAME = "setup-complete.json";

export { installSkillRadar, resolveSkillRoot };

export function resolveDashboardRoot(skillRoot) {
  return join(skillRoot, "assets", "dashboard");
}

export async function createSetupFingerprint({ dashboardRoot, radarTemplateRoot }) {
  const digest = createHash("sha256");
  digest.update(await readFile(join(dashboardRoot, "package-lock.json")));
  const radarManifest = await createSha256Manifest(radarTemplateRoot);
  for (const [path, hash] of radarManifest) digest.update(`\0${path}\0${hash}`);
  return digest.digest("hex");
}

export function checkNodeVersion(version) {
  const match = String(version ?? "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u);
  if (!match) return { ok: false, minimum: "22.13.0", actual: String(version ?? "") };
  const actual = match.slice(1).map(Number);
  for (let index = 0; index < MINIMUM_NODE_VERSION.length; index += 1) {
    if (actual[index] > MINIMUM_NODE_VERSION[index]) {
      return { ok: true, minimum: "22.13.0", actual: actual.join(".") };
    }
    if (actual[index] < MINIMUM_NODE_VERSION[index]) {
      return { ok: false, minimum: "22.13.0", actual: actual.join(".") };
    }
  }
  return { ok: true, minimum: "22.13.0", actual: actual.join(".") };
}

export function resolveRuntimeStateDirectory({ env = process.env, homeDirectory = homedir() } = {}) {
  const configuredState = String(env.SKILL_OBSERVATORY_DATA_DIR ?? "").trim();
  if (configuredState) {
    if (!isAbsolute(configuredState)) throw new Error("absolute-runtime-state-required");
    return resolve(configuredState);
  }
  return join(resolveCodexRoot({ env, homeDirectory }), "state", "skill-observatory");
}

export async function ensurePrivateRuntimeDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) {
    throw new Error("private-runtime-directory-required");
  }
  return path;
}

export async function removeSetupMarker(stateDirectory) {
  const markerPath = join(stateDirectory, SETUP_MARKER_NAME);
  let metadata;
  try {
    metadata = await lstat(markerPath);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("setup-marker-regular-file-required");
  }
  try {
    await unlink(markerPath);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  return true;
}

async function writePrivateJson(path, value) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } catch (error) {
    await handle.close();
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  await handle.close();
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function migrateRuntimeState({ sourceDirectory, destinationDirectory }) {
  if (!isAbsolute(sourceDirectory)) throw new Error("absolute-migration-source-required");
  const sourceMetadata = await lstat(sourceDirectory);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    throw new Error("migration-source-directory-required");
  }
  await ensurePrivateRuntimeDirectory(destinationDirectory);
  const copied = [];
  const skipped = [];

  for (const fileName of MIGRATED_FILES) {
    const sourcePath = join(sourceDirectory, fileName);
    const destinationPath = join(destinationDirectory, fileName);
    if (await pathExists(destinationPath)) {
      skipped.push(fileName);
      continue;
    }
    let sourceFileMetadata;
    try {
      sourceFileMetadata = await lstat(sourcePath);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!sourceFileMetadata.isFile() || sourceFileMetadata.isSymbolicLink()) {
      throw new Error(`migration-source-file-required:${fileName}`);
    }
    const data = await readFile(sourcePath);
    const temporaryPath = join(destinationDirectory, `.${fileName}.${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(data);
    } catch (error) {
      await handle.close();
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
    await handle.close();
    await chmod(temporaryPath, 0o600);
    try {
      await link(temporaryPath, destinationPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      if (error.code === "EEXIST") {
        skipped.push(fileName);
        continue;
      }
      throw error;
    }
    await unlink(temporaryPath).catch(() => {});
    await chmod(destinationPath, 0o600);
    copied.push(fileName);
  }
  return { copied, skipped };
}

export function checkNpmAvailability({ env = process.env, accessSyncImpl = accessSync } = {}) {
  const executable = String(env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, "npm"))
    .find((candidate) => {
      try {
        accessSyncImpl(candidate, fileConstants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  return { ok: Boolean(executable), executable };
}

export function runNpmCi(dashboardRoot, { spawnSyncImpl = spawnSync, env = process.env } = {}) {
  const childEnvironment = { ...env };
  delete childEnvironment.GITHUB_TOKEN;
  const result = spawnSyncImpl("npm", ["ci"], {
    cwd: dashboardRoot,
    env: childEnvironment,
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    const error = new Error("npm-ci-failed");
    error.cause = result.error;
    throw error;
  }
}

export function parseSetupArguments(args) {
  let dryRun = false;
  let migrateFrom;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--migrate-from") {
      migrateFrom = args[index + 1];
      if (!migrateFrom) throw new Error("missing-migration-source");
      index += 1;
      continue;
    }
    throw new Error(`unknown-argument:${argument}`);
  }
  if (migrateFrom && !isAbsolute(migrateFrom)) throw new Error("absolute-migration-source-required");
  return { dryRun, migrateFrom };
}

export async function runSetup({
  skillRoot = resolveSkillRoot(),
  env = process.env,
  homeDirectory = homedir(),
  nodeVersion = process.versions.node,
  dryRun = false,
  migrateFrom,
  npmCheck = checkNpmAvailability,
  installDependencies = runNpmCi,
  radarInstaller = installSkillRadar,
} = {}) {
  const versionCheck = checkNodeVersion(nodeVersion);
  if (!versionCheck.ok) throw new Error(`node-22.13.0-required:${versionCheck.actual}`);
  const npm = npmCheck({ env });
  if (!npm.ok) throw new Error("npm-required");

  const dashboardRoot = resolveDashboardRoot(skillRoot);
  const radarTemplateRoot = resolveRadarTemplateRoot(skillRoot);
  const codexRoot = resolveCodexRoot({ env, homeDirectory });
  const stateDirectory = resolveRuntimeStateDirectory({ env, homeDirectory });
  const radarDestinationRoot = join(codexRoot, "skills", "skill-radar");
  if (migrateFrom && !isAbsolute(migrateFrom)) throw new Error("absolute-migration-source-required");

  const plan = {
    dashboardRoot,
    stateDirectory,
    radarTemplateRoot,
    radarDestinationRoot,
    migrateFrom,
    nodeVersion: versionCheck.actual,
    npmExecutable: npm.executable,
  };
  if (dryRun) return { status: "dry-run", ...plan };

  await access(join(dashboardRoot, "package.json"));
  await access(join(dashboardRoot, "package-lock.json"));
  await access(join(radarTemplateRoot, "SKILL.md"));
  await ensurePrivateRuntimeDirectory(stateDirectory);
  await removeSetupMarker(stateDirectory);
  try {
    const migration = migrateFrom
      ? await migrateRuntimeState({ sourceDirectory: migrateFrom, destinationDirectory: stateDirectory })
      : { copied: [], skipped: [] };
    await installDependencies(dashboardRoot, { env });
    const radarStatus = await radarInstaller({
      templateRoot: radarTemplateRoot,
      destinationRoot: radarDestinationRoot,
    });
    const fingerprint = await createSetupFingerprint({ dashboardRoot, radarTemplateRoot });
    await writePrivateJson(join(stateDirectory, SETUP_MARKER_NAME), {
      schemaVersion: 1,
      fingerprint,
    });
    return { status: "complete", radarStatus, migration, ...plan };
  } catch (error) {
    try {
      await removeSetupMarker(stateDirectory);
    } catch (cleanupError) {
      if (error && typeof error === "object") error.cleanupError = cleanupError;
    }
    throw error;
  }
}

async function main() {
  const options = parseSetupArguments(process.argv.slice(2));
  const result = await runSetup(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.code ?? error.message}\n`);
    process.exitCode = 1;
  });
}
