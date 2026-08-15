import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";

const GENERATED_CATALOG_PATH = "references/catalog.json";

export function resolveSkillRoot(metaUrl = import.meta.url) {
  return dirname(dirname(fileURLToPath(metaUrl)));
}

export function resolveRadarTemplateRoot(skillRoot) {
  return join(skillRoot, "assets", "skill-radar");
}

export function resolveCodexRoot({ env = process.env, homeDirectory = homedir() } = {}) {
  const configured = String(env.CODEX_HOME ?? "").trim();
  return configured ? resolve(configured) : join(homeDirectory, ".codex");
}

function portableRelativePath(root, path) {
  return relative(root, path).split(sep).join("/");
}

async function assertPlainDirectory(path, errorCode) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(errorCode);
}

export async function createSha256Manifest(root) {
  await assertPlainDirectory(root, "skill-radar-template-required");
  const manifest = new Map();

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = portableRelativePath(root, path);
      if (entry.isSymbolicLink()) throw new Error("skill-radar-symlink-not-allowed");
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) throw new Error("skill-radar-unsupported-entry");
      if (relativePath === GENERATED_CATALOG_PATH) continue;
      const digest = createHash("sha256").update(await readFile(path)).digest("hex");
      manifest.set(relativePath, digest);
    }
  }

  await visit(root);
  return manifest;
}

function manifestsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const [path, digest] of left) {
    if (right.get(path) !== digest) return false;
  }
  return true;
}

async function copyManifestFiles(templateRoot, stagingRoot, manifest) {
  for (const relativePath of manifest.keys()) {
    const sourcePath = join(templateRoot, ...relativePath.split("/"));
    const destinationPath = join(stagingRoot, ...relativePath.split("/"));
    await mkdir(dirname(destinationPath), { recursive: true, mode: 0o755 });
    await copyFile(sourcePath, destinationPath);
    const sourceMode = (await lstat(sourcePath)).mode & 0o777;
    await chmod(destinationPath, sourceMode || 0o644);
  }
}

export async function installSkillRadar({ templateRoot, destinationRoot }) {
  const templateManifest = await createSha256Manifest(templateRoot);

  try {
    await assertPlainDirectory(destinationRoot, "skill-radar-conflict");
    const destinationManifest = await createSha256Manifest(destinationRoot);
    if (manifestsEqual(templateManifest, destinationManifest)) return "unchanged";
    throw new Error("skill-radar-conflict");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const destinationParent = dirname(destinationRoot);
  await mkdir(destinationParent, { recursive: true, mode: 0o755 });
  const stagingRoot = join(destinationParent, `.skill-radar-${randomUUID()}.tmp`);
  await mkdir(stagingRoot, { mode: 0o755 });
  try {
    await copyManifestFiles(templateRoot, stagingRoot, templateManifest);
    await rename(stagingRoot, destinationRoot);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    if (error.code === "EEXIST" || error.code === "ENOTEMPTY") {
      throw new Error("skill-radar-conflict");
    }
    throw error;
  }
  return "installed";
}

export async function installBundledSkillRadar({
  skillRoot = resolveSkillRoot(),
  env = process.env,
  homeDirectory = homedir(),
} = {}) {
  const codexRoot = resolveCodexRoot({ env, homeDirectory });
  return installSkillRadar({
    templateRoot: resolveRadarTemplateRoot(skillRoot),
    destinationRoot: join(codexRoot, "skills", "skill-radar"),
  });
}

if (isMainModule(import.meta.url)) {
  if (process.argv.length > 2) {
    process.stderr.write("install-skill-radar does not accept arguments\n");
    process.exitCode = 1;
  } else {
    installBundledSkillRadar()
      .then((status) => process.stdout.write(`${status}\n`))
      .catch((error) => {
        process.stderr.write(`${error.code ?? error.message}\n`);
        process.exitCode = 1;
      });
  }
}
