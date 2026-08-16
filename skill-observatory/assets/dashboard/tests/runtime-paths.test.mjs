import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensurePrivateDirectory, resolveRuntimePaths } from "../lib/runtime-paths.mjs";

test("uses CODEX_HOME state directory without writing into the project", () => {
  const testerHome = join("/", "Users", "tester");
  const paths = resolveRuntimePaths({
    projectRoot: "/workspace/skill-observatory",
    homeDir: testerHome,
    env: { CODEX_HOME: "/tmp/codex-home" },
  });
  assert.equal(paths.dataDirectory, "/tmp/codex-home/state/skill-observatory");
  assert.equal(paths.catalogPath, "/tmp/codex-home/state/skill-observatory/catalog.json");
  assert.equal(paths.validationRegistryPath, "/tmp/codex-home/state/skill-observatory/skill-validations.json");
  assert.equal(paths.historyCachePath, "/tmp/codex-home/state/skill-observatory/history-cache.json");
  assert.equal(paths.githubCachePath, "/tmp/codex-home/state/skill-observatory/github-suggestions-cache.json");
  assert.equal(paths.skillOverridesPath, "/tmp/codex-home/state/skill-observatory/skill-overrides.json");
  assert.equal(paths.radarTemplateDirectory, "/workspace/skill-observatory/skill-radar");
});

test("falls back to ~/.codex and accepts only an absolute override", () => {
  const testerHome = join("/", "Users", "tester");
  assert.equal(resolveRuntimePaths({
    projectRoot: "/workspace/app",
    homeDir: testerHome,
    env: {},
  }).dataDirectory, join(testerHome, ".codex", "state", "skill-observatory"));
  assert.throws(() => resolveRuntimePaths({
    projectRoot: "/workspace/app",
    homeDir: testerHome,
    env: { SKILL_OBSERVATORY_DATA_DIR: "relative/state" },
  }), /absolute-runtime-state-required/);
  assert.equal(resolveRuntimePaths({
    projectRoot: "/workspace/app",
    homeDir: testerHome,
    env: { SKILL_OBSERVATORY_RADAR_TEMPLATE_DIR: "/opt/skill-observatory/assets/skill-radar" },
  }).radarTemplateDirectory, "/opt/skill-observatory/assets/skill-radar");
  assert.throws(() => resolveRuntimePaths({
    projectRoot: "/workspace/app",
    homeDir: testerHome,
    env: { SKILL_OBSERVATORY_RADAR_TEMPLATE_DIR: "relative/skill-radar" },
  }), /absolute-radar-template-required/);
});

test("creates private runtime directories and rejects insecure existing targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-observatory-runtime-paths-"));
  const privateDirectory = join(root, "state", "skill-observatory");
  await ensurePrivateDirectory(privateDirectory);
  assert.equal((await stat(privateDirectory)).mode & 0o777, 0o700);

  const insecureDirectory = join(root, "shared-state");
  await mkdir(insecureDirectory);
  await chmod(insecureDirectory, 0o755);
  await assert.rejects(
    ensurePrivateDirectory(insecureDirectory),
    /private-runtime-directory-required/,
  );

  const acceptedDirectory = join(root, "private-state");
  await mkdir(acceptedDirectory, { mode: 0o700 });
  await ensurePrivateDirectory(acceptedDirectory);
  assert.equal((await stat(acceptedDirectory)).mode & 0o777, 0o700);

  for (const mode of [0o600, 0o500]) {
    const unusableDirectory = join(root, `unusable-${mode.toString(8)}`);
    await mkdir(unusableDirectory, { mode: 0o700 });
    await chmod(unusableDirectory, mode);
    await assert.rejects(
      ensurePrivateDirectory(unusableDirectory),
      /private-runtime-directory-required/,
    );
  }
});
