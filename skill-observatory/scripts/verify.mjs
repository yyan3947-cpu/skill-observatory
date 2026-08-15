import { spawn } from "node:child_process";
import { homedir } from "node:os";
import {
  resolveRadarTemplateRoot,
  resolveSkillRoot,
} from "./install-skill-radar.mjs";
import { isMainModule } from "./is-main.mjs";
import { resolveDashboardRoot, resolveRuntimeStateDirectory } from "./setup.mjs";
import { assertSetupCompleted } from "./start.mjs";

function run(command, args, options, spawnImpl) {
  const child = spawnImpl(command, args, options);
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`verification-terminated:${signal}`));
      else if (code !== 0) reject(new Error(`verification-failed:${command}:${code}`));
      else resolvePromise(0);
    });
  });
}

export async function verifyDashboard({
  skillRoot = resolveSkillRoot(),
  live = false,
  dashboardUrl,
  env = process.env,
  homeDirectory = homedir(),
  spawnImpl = spawn,
} = {}) {
  if (dashboardUrl && !live) throw new Error("dashboard-url-requires-live");
  const verifiedDashboardUrl = dashboardUrl ? validateDashboardUrl(dashboardUrl) : undefined;
  const dashboardRoot = resolveDashboardRoot(skillRoot);
  const radarTemplateRoot = resolveRadarTemplateRoot(skillRoot);
  await assertSetupCompleted({
    dashboardRoot,
    radarTemplateRoot,
    stateDirectory: resolveRuntimeStateDirectory({ env, homeDirectory }),
  });
  const childEnvironment = {
    ...env,
    SKILL_OBSERVATORY_RADAR_TEMPLATE_DIR: radarTemplateRoot,
  };
  delete childEnvironment.GITHUB_TOKEN;
  const options = { cwd: dashboardRoot, env: childEnvironment, stdio: "inherit" };
  await run("npm", ["run", "lint"], options, spawnImpl);
  await run("npm", ["test"], options, spawnImpl);
  if (live) {
    const arguments_ = ["scripts/verify-live.mjs"];
    if (verifiedDashboardUrl) arguments_.push(verifiedDashboardUrl);
    await run(process.execPath, arguments_, options, spawnImpl);
  }
  return { lint: "passed", tests: "passed", live: live ? "passed" : "skipped" };
}

export function validateDashboardUrl(value) {
  const input = String(value ?? "").trim();
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("local-dashboard-url-required");
  }
  const hasAllowedAuthority = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?(?:[/?#][^\s]*)?$/iu.test(input);
  if (
    parsed.protocol !== "http:"
    || !hasAllowedAuthority
    || parsed.username
    || parsed.password
    || !["localhost", "127.0.0.1"].includes(parsed.hostname.toLowerCase())
  ) {
    throw new Error("local-dashboard-url-required");
  }
  return parsed.href;
}

export function parseVerifyArguments(args) {
  let live = false;
  let dashboardUrl;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--live") {
      live = true;
      continue;
    }
    if (args[index] === "--dashboard-url") {
      const value = args[index + 1];
      if (!value) throw new Error("missing-dashboard-url");
      dashboardUrl = validateDashboardUrl(value);
      index += 1;
      continue;
    }
    throw new Error(`unknown-argument:${args[index]}`);
  }
  if (dashboardUrl && !live) throw new Error("dashboard-url-requires-live");
  return { live, dashboardUrl };
}

if (isMainModule(import.meta.url)) {
  Promise.resolve()
    .then(() => parseVerifyArguments(process.argv.slice(2)))
    .then((options) => verifyDashboard(options))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.code ?? error.message}\n`);
      process.exitCode = 1;
    });
}
