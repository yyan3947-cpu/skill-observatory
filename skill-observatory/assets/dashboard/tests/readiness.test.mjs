import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { assessReadiness } from "../lib/readiness.mjs";

test("reports only requirement names and checks explicit commands conservatively", async () => {
  const bin = await mkdtemp(join(tmpdir(), "skill-observatory-bin-"));
  await writeFile(join(bin, "available-cli"), "fixture", "utf8");
  const result = await assessReadiness({
    description: "Requires DEMO_API_KEY for API access.",
    body: "The `available-cli` command is required. The `missing-cli` executable is required.",
    warnings: [],
    env: { DEMO_API_KEY: "super-secret-value" },
    pathValue: [bin, "/not/a/real/path"].join(delimiter),
  });

  assert.equal(result.status, "needs-config");
  assert.deepEqual(result.requiredEnvNames, ["DEMO_API_KEY"]);
  assert.deepEqual(result.missingEnvNames, []);
  assert.deepEqual(result.missingExecutableNames, ["missing-cli"]);
  assert.doesNotMatch(JSON.stringify(result), /super-secret-value/);
});

test("gives malformed structure precedence over external checks", async () => {
  const result = await assessReadiness({
    description: "Requires MISSING_TOKEN for API access.",
    warnings: ["missing-frontmatter"],
    env: {},
    pathValue: "",
  });
  assert.equal(result.status, "abnormal");
  assert.deepEqual(result.statusReasons, ["missing-frontmatter"]);
});
