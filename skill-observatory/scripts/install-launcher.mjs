import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  link,
  mkdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { resolveSkillRoot } from "./install-skill-radar.mjs";
import { isMainModule } from "./is-main.mjs";

export const DEFAULT_LAUNCHER_NAME = "技能看台.command";

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function renderLauncher({ skillRoot }) {
  const startScript = join(skillRoot, "scripts", "start.mjs");
  return `#!/bin/zsh
set -euo pipefail

readonly START_SCRIPT=${shellSingleQuote(startScript)}
readonly DASHBOARD_URL="http://localhost:3000/"
readonly API_URL="http://127.0.0.1:4318/api/catalog"

dashboard_is_ready() {
  /usr/bin/curl --fail --silent --max-time 2 "$API_URL" >/dev/null 2>&1 &&
    /usr/bin/curl --fail --silent --max-time 2 "$DASHBOARD_URL" >/dev/null 2>&1
}

fail_and_wait() {
  print -u2 -- "启动技能看台失败：$1"
  read -r "?按回车键关闭窗口……"
  exit 1
}

if dashboard_is_ready; then
  /usr/bin/open "$DASHBOARD_URL"
  exit 0
fi

[[ -f "$START_SCRIPT" ]] || fail_and_wait "找不到已安装的 Skill Observatory。"
command -v node >/dev/null 2>&1 || fail_and_wait "找不到 Node.js，请先安装 22.13.0 或更高版本。"
exec node "$START_SCRIPT"
`;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function installLauncher({
  targetDirectory,
  skillRoot = resolveSkillRoot(),
  replace = false,
  fileName = DEFAULT_LAUNCHER_NAME,
} = {}) {
  if (!targetDirectory || !isAbsolute(targetDirectory)) {
    throw new Error("absolute-launcher-target-required");
  }
  if (!fileName.endsWith(".command") || fileName.includes("/") || fileName.includes("\\")) {
    throw new Error("invalid-launcher-name");
  }
  const targetPath = join(targetDirectory, fileName);
  if (!replace && await exists(targetPath)) throw new Error("launcher-exists");

  await mkdir(targetDirectory, { recursive: true, mode: 0o755 });
  const temporaryPath = join(targetDirectory, `.${fileName}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, renderLauncher({ skillRoot }), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o755,
  });
  await chmod(temporaryPath, 0o755);
  try {
    if (replace) {
      await rename(temporaryPath, targetPath);
    } else {
      await link(temporaryPath, targetPath);
      await unlink(temporaryPath);
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    if (error.code === "EEXIST") throw new Error("launcher-exists");
    throw error;
  }
  await chmod(targetPath, 0o755);
  return targetPath;
}

export function parseLauncherArguments(args) {
  let targetDirectory;
  let replace = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--target") {
      targetDirectory = args[index + 1];
      if (!targetDirectory) throw new Error("missing-launcher-target");
      index += 1;
      continue;
    }
    if (args[index] === "--replace") {
      replace = true;
      continue;
    }
    throw new Error(`unknown-argument:${args[index]}`);
  }
  if (!targetDirectory || !isAbsolute(targetDirectory)) {
    throw new Error("absolute-launcher-target-required");
  }
  return { targetDirectory, replace };
}

if (isMainModule(import.meta.url)) {
  Promise.resolve()
    .then(() => parseLauncherArguments(process.argv.slice(2)))
    .then((options) => installLauncher(options))
    .then((targetPath) => process.stdout.write(`${targetPath}\n`))
    .catch((error) => {
      process.stderr.write(`${error.code ?? error.message}\n`);
      process.exitCode = 1;
    });
}
