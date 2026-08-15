import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverSkills } from "../lib/discover.mjs";

async function skill(root, folder, frontmatter, body = "") {
  const directory = join(root, folder);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `${frontmatter}\n${body}\n`, "utf8");
  return directory;
}

test("discovers, deduplicates, and preserves abnormal Skills without leaking values", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-observatory-discover-"));
  const alpha = await skill(root, "alpha", "---\nname: alpha\ndescription: Local writing helper.\n---");
  await skill(root, "duplicate-a", "---\nname: duplicate\ndescription: First copy.\n---");
  await skill(root, "duplicate-b", "---\nname: duplicate\ndescription: Second copy.\n---");
  await skill(root, "requires-key", "---\nname: requires-key\ndescription: Requires SAMPLE_API_KEY for API access.\n---");
  await skill(root, "broken", "name: broken\ndescription: no delimiters");
  await symlink(alpha, join(root, "linked-alpha"));
  await symlink(join(root, "missing-target"), join(root, "broken-link"));
  const outside = await mkdtemp(join(tmpdir(), "skill-observatory-outside-"));
  await skill(outside, "external", "---\nname: external\ndescription: Must remain outside the scan root.\n---");
  await symlink(join(outside, "external"), join(root, "outside-link"));

  const result = await discoverSkills({
    roots: [{ path: root, sourceType: "user", label: "fixture" }],
    env: { SAMPLE_API_KEY: "super-secret-value" },
    pathValue: "",
  });

  assert.equal(result.skills.filter((item) => item.name === "alpha").length, 1);
  assert.equal(result.skills.some((item) => item.name === "external"), false);
  assert.equal(result.skills.filter((item) => item.name === "duplicate").length, 2);
  assert.equal(result.skills.find((item) => item.name === "broken").status, "abnormal");
  assert.ok(result.skills.filter((item) => item.name === "duplicate").every((item) => item.warnings.includes("duplicate-name")));
  assert.ok(result.warnings.some((warning) => warning.code === "broken-symlink"));
  assert.ok(result.warnings.some((warning) => warning.code === "symlink-outside-root"));
  assert.doesNotMatch(JSON.stringify(result), /super-secret-value/);
  assert.ok(result.skills.every((item) => /^[a-f0-9]{64}$/.test(item.contentHash)));
});

test("content hashes change when a Skill document changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-observatory-hash-"));
  const directory = await skill(root, "alpha", "---\nname: alpha\ndescription: First version.\n---");
  const first = await discoverSkills({
    roots: [{ path: root, sourceType: "user", label: "fixture" }],
    env: {},
    pathValue: "",
  });
  await writeFile(join(directory, "SKILL.md"), "---\nname: alpha\ndescription: Second version.\n---\n", "utf8");
  const second = await discoverSkills({
    roots: [{ path: root, sourceType: "user", label: "fixture" }],
    env: {},
    pathValue: "",
  });
  assert.notEqual(first.skills[0].contentHash, second.skills[0].contentHash);
});
