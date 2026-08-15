import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { spawnSanitized } from "../lib/child-process.mjs";

test("npm and open child processes never inherit GITHUB_TOKEN", async () => {
  const calls = [];
  const environment = {
    GITHUB_TOKEN: "server-only-token",
    NO_AUTO_OPEN: "0",
    PATH: "/usr/bin:/bin",
  };
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return { unref() {} };
  };

  spawnSanitized("npm", ["run", "dev"], { stdio: "pipe" }, { environment, spawnImpl });
  spawnSanitized("/usr/bin/open", ["http://127.0.0.1:3000"], { stdio: "ignore" }, { environment, spawnImpl });

  assert.deepEqual(calls.map((call) => call.command), ["npm", "/usr/bin/open"]);
  assert.ok(calls.every((call) => !("GITHUB_TOKEN" in call.options.env)));
  assert.ok(calls.every((call) => call.options.env.PATH === environment.PATH));
  assert.equal(environment.GITHUB_TOKEN, "server-only-token");

  const source = await readFile(new URL("../scripts/start-dashboard.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from ["']node:child_process["']/u);
  assert.equal((source.match(/spawnSanitized\(/gu) ?? []).length, 2);
});
