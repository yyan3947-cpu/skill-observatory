import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) {
    throw new Error("private-runtime-directory-required");
  }
  return path;
}

export function resolveRuntimePaths({ projectRoot, homeDir, env = process.env }) {
  const configuredCodexHome = String(env.CODEX_HOME ?? "").trim();
  const codexRoot = configuredCodexHome ? resolve(configuredCodexHome) : join(homeDir, ".codex");
  const configuredDataDirectory = String(env.SKILL_OBSERVATORY_DATA_DIR ?? "").trim();
  if (configuredDataDirectory && !isAbsolute(configuredDataDirectory)) {
    throw new Error("absolute-runtime-state-required");
  }
  const dataDirectory = configuredDataDirectory
    ? resolve(configuredDataDirectory)
    : join(codexRoot, "state", "skill-observatory");
  const configuredRadarTemplate = String(env.SKILL_OBSERVATORY_RADAR_TEMPLATE_DIR ?? "").trim();
  if (configuredRadarTemplate && !isAbsolute(configuredRadarTemplate)) {
    throw new Error("absolute-radar-template-required");
  }
  return {
    projectRoot,
    codexRoot,
    dataDirectory,
    catalogPath: join(dataDirectory, "catalog.json"),
    validationRegistryPath: join(dataDirectory, "skill-validations.json"),
    historyCachePath: join(dataDirectory, "history-cache.json"),
    githubCachePath: join(dataDirectory, "github-suggestions-cache.json"),
    radarTemplateDirectory: configuredRadarTemplate
      ? resolve(configuredRadarTemplate)
      : join(projectRoot, "skill-radar"),
  };
}
