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
const MAX_OVERRIDE_BYTES = 1024 * 1024;
const FORBIDDEN_OVERRIDE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const OVERRIDE_STRING_FIELDS = new Set(["summaryZh", "category", "statusOverride"]);
const OVERRIDE_ARRAY_FIELDS = new Set(["aliases", "intentTags", "requiredEnvNames", "statusReasons"]);
const OVERRIDE_STATUS_VALUES = new Set(["ready", "needs-config", "abnormal", "unchecked"]);
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

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function containsUnsupportedOverrideControl(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === 0 || (codePoint < 32 && ![9, 10, 13].includes(codePoint)) || codePoint === 127) {
      return true;
    }
  }
  return false;
}

function validOverrideString(value, maximumLength) {
  return typeof value === "string"
    && value.length <= maximumLength
    && !containsUnsupportedOverrideControl(value);
}

function assertMigratableOverrideJson(source, errorCode) {
  if (source.length > MAX_OVERRIDE_BYTES) throw new Error(errorCode);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    throw new Error(errorCode);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(errorCode);
  }
  if (!isPlainRecord(parsed)) throw new Error(errorCode);
  for (const name of Object.keys(parsed)) {
    if (
      !validOverrideString(name, 256)
      || name.trim() !== name
      || name.length === 0
    ) {
      throw new Error(errorCode);
    }
    const entry = parsed[name];
    if (!isPlainRecord(entry)) throw new Error(errorCode);
    for (const key of Object.keys(entry)) {
      if (FORBIDDEN_OVERRIDE_KEYS.has(key)) throw new Error(errorCode);
      if (OVERRIDE_STRING_FIELDS.has(key)) {
        if (!validOverrideString(entry[key], key === "summaryZh" ? 4096 : 256)) {
          throw new Error(errorCode);
        }
        if (key === "statusOverride" && !OVERRIDE_STATUS_VALUES.has(entry[key])) {
          throw new Error(errorCode);
        }
        continue;
      }
      if (
        !OVERRIDE_ARRAY_FIELDS.has(key)
        || !Array.isArray(entry[key])
        || entry[key].length > 256
        || entry[key].some((item) => !validOverrideString(item, 1024))
      ) {
        throw new Error(errorCode);
      }
      if (
        (key === "intentTags" && entry[key].some((item) => !/^[a-z][a-z0-9-]{1,63}$/u.test(item)))
        || (key === "requiredEnvNames" && entry[key].some((item) => !/^[A-Z][A-Z0-9_]+$/u.test(item)))
      ) {
        throw new Error(errorCode);
      }
    }
  }
}

function sameOpenedFile(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function readStableOverrideFile(path, {
  fileErrorCode,
  jsonErrorCode,
  requirePrivateMode = false,
  missing = false,
}) {
  let handle;
  try {
    handle = await open(
      path,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW | fileConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (missing && error.code === "ENOENT") return null;
    throw new Error(fileErrorCode);
  }
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || before.size > MAX_OVERRIDE_BYTES
      || (requirePrivateMode && (before.mode & 0o777) !== 0o600)
    ) {
      throw new Error(fileErrorCode);
    }
    const data = await handle.readFile();
    const after = await handle.stat();
    if (!sameOpenedFile(before, after)) throw new Error(fileErrorCode);
    assertMigratableOverrideJson(data, jsonErrorCode);
    return { data, metadata: after };
  } finally {
    await handle.close().catch(() => {});
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

export async function migrateSkillOverrides({ sourcePath, destinationDirectory }) {
  if (!isAbsolute(sourcePath)) throw new Error("absolute-override-migration-source-required");
  await ensurePrivateRuntimeDirectory(destinationDirectory);
  const fileName = "skill-overrides.json";
  const destinationPath = join(destinationDirectory, fileName);
  const existing = await readStableOverrideFile(destinationPath, {
    fileErrorCode: "override-migration-destination-file-required",
    jsonErrorCode: "override-migration-destination-json-object-required",
    requirePrivateMode: true,
    missing: true,
  });
  if (existing) return { copied: [], skipped: [fileName] };

  const source = await readStableOverrideFile(sourcePath, {
    fileErrorCode: "override-migration-source-file-required",
    jsonErrorCode: "override-migration-json-object-required",
  });
  const temporaryPath = join(destinationDirectory, `.${fileName}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(source.data);
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
      await readStableOverrideFile(destinationPath, {
        fileErrorCode: "override-migration-destination-file-required",
        jsonErrorCode: "override-migration-destination-json-object-required",
        requirePrivateMode: true,
      });
      return { copied: [], skipped: [fileName] };
    }
    throw error;
  }
  try {
    const temporaryMetadata = await lstat(temporaryPath);
    const destinationMetadata = await lstat(destinationPath);
    if (
      !destinationMetadata.isFile()
      || destinationMetadata.isSymbolicLink()
      || temporaryMetadata.dev !== destinationMetadata.dev
      || temporaryMetadata.ino !== destinationMetadata.ino
      || (destinationMetadata.mode & 0o777) !== 0o600
    ) {
      throw new Error("override-migration-destination-file-required");
    }
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
  return { copied: [fileName], skipped: [] };
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
  let migrateOverridesFrom;
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
    if (argument === "--migrate-overrides-from") {
      migrateOverridesFrom = args[index + 1];
      if (!migrateOverridesFrom) throw new Error("missing-override-migration-source");
      index += 1;
      continue;
    }
    throw new Error(`unknown-argument:${argument}`);
  }
  if (migrateFrom && !isAbsolute(migrateFrom)) throw new Error("absolute-migration-source-required");
  if (migrateOverridesFrom && !isAbsolute(migrateOverridesFrom)) {
    throw new Error("absolute-override-migration-source-required");
  }
  return { dryRun, migrateFrom, migrateOverridesFrom };
}

export async function runSetup({
  skillRoot = resolveSkillRoot(),
  env = process.env,
  homeDirectory = homedir(),
  nodeVersion = process.versions.node,
  dryRun = false,
  migrateFrom,
  migrateOverridesFrom,
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
  if (migrateOverridesFrom && !isAbsolute(migrateOverridesFrom)) {
    throw new Error("absolute-override-migration-source-required");
  }

  const plan = {
    dashboardRoot,
    stateDirectory,
    radarTemplateRoot,
    radarDestinationRoot,
    migrateFrom,
    migrateOverridesFrom,
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
    if (migrateOverridesFrom) {
      const overrideMigration = await migrateSkillOverrides({
        sourcePath: migrateOverridesFrom,
        destinationDirectory: stateDirectory,
      });
      migration.copied.push(...overrideMigration.copied);
      migration.skipped.push(...overrideMigration.skipped);
    }
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
