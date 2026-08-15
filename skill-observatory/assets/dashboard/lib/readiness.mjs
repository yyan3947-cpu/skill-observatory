import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { SKILL_STATUSES } from "./contracts.mjs";

const ENV_NAME_RE = /\b[A-Z][A-Z0-9_]*(?:_API_KEY|_TOKEN|_SECRET|_COOKIE)\b/g;
const EXTERNAL_MARKER_RE = /\b(?:api|mcp|cli|cookie|oauth|browser|connector|token)\b|接口|登录|连接器|浏览器/i;
const REQUIRED_MARKER_RE = /\brequired\b|\brequires\b|\bmust set\b|必须|必需|需要配置|需要设置/i;

function extractRequirements(text, env, pathValue) {
  const required = new Set();
  for (const match of text.matchAll(ENV_NAME_RE)) {
    const start = Math.max(0, match.index - 120);
    const end = Math.min(text.length, match.index + match[0].length + 120);
    if (REQUIRED_MARKER_RE.test(text.slice(start, end))) required.add(match[0]);
  }
  const requiredEnvNames = [...required].sort();
  const missingEnvNames = requiredEnvNames.filter((name) => !env[name]);

  const executableNames = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!REQUIRED_MARKER_RE.test(line) || !/(?:\bcli\b|\bcommand\b|\bbinary\b|\bexecutable\b|命令|可执行文件)/i.test(line)) {
      continue;
    }
    for (const match of line.matchAll(/`([a-zA-Z][a-zA-Z0-9._-]{1,40})`/g)) {
      executableNames.add(match[1]);
    }
  }
  return {
    requiredEnvNames,
    missingEnvNames,
    executableNames: [...executableNames],
    pathDirectories: (pathValue ?? "").split(delimiter).filter(Boolean),
  };
}

async function findMissingExecutables(names, pathDirectories) {
  const missing = [];
  for (const name of names) {
    let found = false;
    for (const directory of pathDirectories) {
      try {
        await access(join(directory, name));
        found = true;
        break;
      } catch {
        // Try the next PATH directory.
      }
    }
    if (!found) missing.push(name);
  }
  return missing;
}

export async function assessReadiness({ description = "", body = "", warnings = [], env = process.env, pathValue = process.env.PATH ?? "" }) {
  const text = `${description}\n${body}`;
  const requirements = extractRequirements(text, env, pathValue);
  const missingExecutableNames = await findMissingExecutables(
    requirements.executableNames,
    requirements.pathDirectories,
  );

  let status = SKILL_STATUSES.READY;
  const statusReasons = [];
  if (warnings.length) {
    status = SKILL_STATUSES.ABNORMAL;
    statusReasons.push(...warnings);
  } else if (requirements.missingEnvNames.length || missingExecutableNames.length) {
    status = SKILL_STATUSES.NEEDS_CONFIG;
    statusReasons.push(
      ...requirements.missingEnvNames.map((name) => `missing-env:${name}`),
      ...missingExecutableNames.map((name) => `missing-executable:${name}`),
    );
  } else if (EXTERNAL_MARKER_RE.test(text)) {
    status = SKILL_STATUSES.UNCHECKED;
    statusReasons.push("external-runtime-not-probed");
  } else {
    statusReasons.push("structure-valid");
  }

  return {
    status,
    statusReasons,
    requiredEnvNames: requirements.requiredEnvNames,
    missingEnvNames: requirements.missingEnvNames,
    missingExecutableNames,
  };
}
