import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import test from "node:test";

test("staged reminder packages the exact dashboard matcher", async () => {
  const configuredTemplate = String(process.env.SKILL_OBSERVATORY_RADAR_TEMPLATE_DIR ?? "").trim();
  if (configuredTemplate && !isAbsolute(configuredTemplate)) {
    throw new Error("absolute-radar-template-required");
  }
  const reminderPath = configuredTemplate
    ? join(configuredTemplate, "scripts", "matcher.mjs")
    : new URL("../skill-radar/scripts/matcher.mjs", import.meta.url);
  const [dashboard, reminder] = await Promise.all([
    readFile(new URL("../lib/recommend.mjs", import.meta.url), "utf8"),
    readFile(reminderPath, "utf8"),
  ]);
  assert.equal(reminder, dashboard);
});
