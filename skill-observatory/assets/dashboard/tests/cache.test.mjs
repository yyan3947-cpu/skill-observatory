import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { atomicWriteJson } from "../lib/cache.mjs";

test("atomic JSON writes use collision-proof temporary files", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-observatory-atomic-cache-"));
  const cachePath = join(root, "cache.json");

  await Promise.all(Array.from({ length: 25 }, (_, value) => atomicWriteJson(cachePath, { value })));

  const cache = JSON.parse(await readFile(cachePath, "utf8"));
  assert.equal(Number.isInteger(cache.value), true);
  assert.equal(cache.value >= 0 && cache.value < 25, true);
  assert.equal((await stat(cachePath)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(root)).filter((name) => name.includes(".tmp-")), []);
});
