import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson } from "../lib/cache.mjs";
import { spawnSanitized } from "../lib/child-process.mjs";
import { readCatalog, syncCatalog } from "../lib/catalog.mjs";
import { DEFAULT_API_HOST, DEFAULT_API_PORT } from "../lib/contracts.mjs";
import { createLocalApi } from "../lib/local-api.mjs";
import { buildGitHubSearchPreview } from "../lib/github-query.mjs";
import {
  createGitHubStatusService,
  inspectGitHubTokenEnvelope,
} from "../lib/github-token-status.mjs";
import {
  findGitHubSkillSuggestions,
  findGitHubSkillSuggestionsFromOriginalQuery,
} from "../lib/github-suggestions.mjs";
import { recommendSkillsWithLevel } from "../lib/recommend.mjs";
import { resolveRuntimePaths } from "../lib/runtime-paths.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimePaths = resolveRuntimePaths({ projectRoot, homeDir: homedir(), env: process.env });
const stagedCatalogPath = join(runtimePaths.radarTemplateDirectory, "references", "catalog.json");
const installedSkillPath = join(runtimePaths.codexRoot, "skills", "skill-radar", "SKILL.md");
const installedCatalogPath = join(runtimePaths.codexRoot, "skills", "skill-radar", "references", "catalog.json");
const rawGitHubToken = process.env.GITHUB_TOKEN;
const tokenEnvelope = inspectGitHubTokenEnvelope(rawGitHubToken);
const serverToken = tokenEnvelope.state === "candidate" ? tokenEnvelope.token : "";
const githubStatusService = createGitHubStatusService({
  token: serverToken,
  tokenState: tokenEnvelope.state,
});
let child;
let api;
let shuttingDown = false;

function stripAnsiColors(value) {
  return value
    .split(String.fromCharCode(27))
    .map((segment, index) => index === 0 ? segment : segment.replace(/^\[[0-9;]*m/, ""))
    .join("");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function performSync() {
  const catalog = await syncCatalog({
    projectRoot,
    homeDir: homedir(),
    codexRoot: runtimePaths.codexRoot,
    cwd: projectRoot,
    dataDirectory: runtimePaths.dataDirectory,
    reminderCatalogPath: await exists(join(runtimePaths.radarTemplateDirectory, "SKILL.md"))
      ? stagedCatalogPath
      : undefined,
  });
  if (await exists(installedSkillPath)) {
    await atomicWriteJson(installedCatalogPath, catalog);
  }
  return catalog;
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (child && !child.killed) child.kill("SIGTERM");
  if (api) {
    try {
      await api.close();
    } catch {
      // The server may already be closed.
    }
  }
  process.exitCode = code;
}

async function main() {
  githubStatusService.getStatus({ force: true }).catch(() => {});
  await performSync();
  api = createLocalApi({
    host: DEFAULT_API_HOST,
    port: DEFAULT_API_PORT,
    syncCatalog: performSync,
    getCatalog: () => readCatalog(runtimePaths.dataDirectory),
    recommend: recommendSkillsWithLevel,
    getGitHubStatus: () => githubStatusService.getStatus(),
    previewGitHubSearch: buildGitHubSearchPreview,
    findGitHubSuggestions: ({ query }) => findGitHubSkillSuggestions({
      query,
      cachePath: runtimePaths.githubCachePath,
      token: serverToken,
    }),
    findOriginalGitHubSuggestions: ({ query }) => findGitHubSkillSuggestionsFromOriginalQuery({
      query,
      token: serverToken,
    }),
  });

  try {
    await api.listen();
  } catch (error) {
    if (error.code === "EADDRINUSE") {
      process.stderr.write("技能看台已在运行，或端口 4318 被其他程序占用。\n");
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  process.stdout.write(`Skill API: http://${DEFAULT_API_HOST}:${DEFAULT_API_PORT}\n`);

  child = spawnSanitized("npm", ["run", "dev", "--", "--host", DEFAULT_API_HOST], {
    cwd: projectRoot,
    stdio: ["inherit", "pipe", "pipe"],
  });

  let opened = false;
  const forward = (stream, target) => {
    stream.on("data", (chunk) => {
      const text = chunk.toString();
      target.write(text);
      if (!opened) {
        const match = stripAnsiColors(text).match(/Local:\s+(http:\/\/[^\s]+)/);
        if (match) {
          opened = true;
          process.stdout.write(`Dashboard: ${match[1]}\n`);
          if (process.env.NO_AUTO_OPEN !== "1") {
            const opener = spawnSanitized("/usr/bin/open", [match[1]], { stdio: "ignore" });
            opener.unref();
          }
        }
      }
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  child.on("exit", async (code) => shutdown(code ?? 0));
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

main().catch(async (error) => {
  process.stderr.write(`启动失败：${error.code ?? error.message}\n`);
  await shutdown(1);
});
