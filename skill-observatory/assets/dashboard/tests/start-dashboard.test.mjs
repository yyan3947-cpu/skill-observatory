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
  assert.match(source, /findGitHubSkillSuggestionsFromOriginalQuery/u);
  assert.match(source, /inspectGitHubTokenEnvelope/u);
  assert.match(source, /createGitHubStatusService/u);
  assert.match(source, /const rawGitHubToken = process\.env\.GITHUB_TOKEN/u);
  assert.match(source, /const tokenEnvelope = inspectGitHubTokenEnvelope\(rawGitHubToken\)/u);
  assert.match(
    source,
    /const serverToken = tokenEnvelope\.state === "candidate" \? tokenEnvelope\.token : ""/u,
  );
  assert.doesNotMatch(source, /process\.env\.GITHUB_TOKEN\?\.trim|process\.env\.GITHUB_TOKEN\.trim/u);
  assert.equal((source.match(/process\.env\.GITHUB_TOKEN/gu) ?? []).length, 1);
  assert.match(source, /createGitHubStatusService\(\{[\s\S]*?token: serverToken,[\s\S]*?tokenState: tokenEnvelope\.state/u);
  assert.match(source, /getGitHubStatus:\s*\([^)]*\)\s*=>\s*githubStatusService\.getStatus\(/u);
  assert.match(source, /githubStatusService\.getStatus\(\{ force: true \}\)\.catch\(\(\) => \{\}\)/u);
  assert.match(source, /import \{ recommendSkillsWithLevel \} from "\.\.\/lib\/recommend\.mjs";/u);
  assert.match(source, /recommend:\s*recommendSkillsWithLevel/u);
  assert.doesNotMatch(source, /recommend:\s*recommendSkills[,\s]/u);

  const sanitizedWiring = source.match(
    /findGitHubSuggestions:\s*\(\{ query \}\)\s*=>\s*findGitHubSkillSuggestions\(\{(?<body>[\s\S]*?)\n\s*\}\),/u,
  )?.groups?.body;
  const originalWiring = source.match(
    /findOriginalGitHubSuggestions:\s*\(\{ query \}\)\s*=>\s*findGitHubSkillSuggestionsFromOriginalQuery\(\{(?<body>[\s\S]*?)\n\s*\}\),/u,
  )?.groups?.body;
  assert.ok(sanitizedWiring);
  assert.ok(originalWiring);
  assert.match(sanitizedWiring, /cachePath:\s*runtimePaths\.githubCachePath/u);
  assert.doesNotMatch(originalWiring, /cachePath|githubCachePath/u);
  assert.match(sanitizedWiring, /token:\s*serverToken/u);
  assert.match(originalWiring, /token:\s*serverToken/u);
  assert.doesNotMatch(`${sanitizedWiring}\n${originalWiring}`, /process\.env|GITHUB_TOKEN/u);
});
