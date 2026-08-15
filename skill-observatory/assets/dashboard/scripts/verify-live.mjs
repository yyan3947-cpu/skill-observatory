import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntimePaths } from "../lib/runtime-paths.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimePaths = resolveRuntimePaths({ projectRoot, homeDir: homedir(), env: process.env });
const dashboardUrl = process.argv[2] ?? "http://localhost:3000/";
const apiBase = "http://127.0.0.1:4318";

const [catalogResponse, recommendationResponse, dashboardResponse] = await Promise.all([
  fetch(`${apiBase}/api/catalog`),
  fetch(`${apiBase}/api/recommend`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: new URL(dashboardUrl).origin },
    body: JSON.stringify({ query: "分析A股并生成报告" }),
  }),
  fetch(dashboardUrl),
]);

assert.equal(catalogResponse.status, 200);
assert.equal(recommendationResponse.status, 200);
assert.equal(dashboardResponse.status, 200);

const catalog = await catalogResponse.json();
const recommendation = await recommendationResponse.json();
const html = await dashboardResponse.text();
assert.ok(catalog.metrics.installed > 0);
assert.ok(recommendation.results.length > 0 && recommendation.results.length <= 3);
assert.match(html, /Skill Observatory · 技能看台/);

const serialized = JSON.stringify(catalog);
const forbiddenKeys = new Set(["prompt", "response", "content", "toolOutput", "threadHash", "turnKey"]);
const unexpectedKeys = [];
function inspectKeys(value) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) inspectKeys(item);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) unexpectedKeys.push(key);
    inspectKeys(child);
  }
}
inspectKeys(catalog);
assert.deepEqual(unexpectedKeys, []);

let leakedSecretValueCount = 0;
for (const [name, value] of Object.entries(process.env)) {
  if (!/(?:KEY|TOKEN|SECRET|COOKIE|PASSWORD)/i.test(name) || String(value).length < 8) continue;
  if (serialized.includes(String(value))) leakedSecretValueCount += 1;
}
assert.equal(leakedSecretValueCount, 0);

const runtimeCatalogPath = runtimePaths.catalogPath;
const installedCatalogPath = join(runtimePaths.codexRoot, "skills", "skill-radar", "references", "catalog.json");
const runtimeMode = (await stat(runtimeCatalogPath)).mode & 0o777;
const installedMode = (await stat(installedCatalogPath)).mode & 0o777;
assert.equal(runtimeMode, 0o600);
assert.equal(installedMode, 0o600);
assert.equal(JSON.parse(await readFile(installedCatalogPath, "utf8")).schemaVersion, catalog.schemaVersion);

process.stdout.write(`${JSON.stringify({
  dashboardStatus: dashboardResponse.status,
  apiStatus: catalogResponse.status,
  metrics: catalog.metrics,
  sessionFileCount: catalog.sessionFileCount,
  warningTotal: catalog.warningTotal,
  recommendations: recommendation.results.map((item) => item.name),
  privacySchema: "pass",
  secretValueLeaks: leakedSecretValueCount,
  catalogModes: { runtime: runtimeMode.toString(8), installed: installedMode.toString(8) },
})}\n`);
