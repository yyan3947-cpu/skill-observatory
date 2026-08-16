import { constants as fileConstants } from "node:fs";
import { open } from "node:fs/promises";

const MAX_OVERRIDE_BYTES = 1024 * 1024;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const STRING_FIELDS = new Set(["summaryZh", "category", "statusOverride"]);
const STRING_ARRAY_FIELDS = new Set([
  "aliases",
  "intentTags",
  "requiredEnvNames",
  "statusReasons",
]);
const STATUS_VALUES = new Set(["ready", "needs-config", "abnormal", "unchecked"]);

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidOverrideDocument(errorCode) {
  return new Error(errorCode);
}

function containsUnsupportedControl(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === 0 || (codePoint < 32 && ![9, 10, 13].includes(codePoint)) || codePoint === 127) {
      return true;
    }
  }
  return false;
}

function validateString(value, maximumLength) {
  return typeof value === "string" && value.length <= maximumLength && !containsUnsupportedControl(value);
}

export function validateSkillOverridesDocument(value, {
  errorCode = "skill-overrides-invalid",
  strictSemantics = false,
} = {}) {
  if (!isPlainRecord(value)) throw invalidOverrideDocument(errorCode);
  const result = Object.create(null);
  for (const name of Object.keys(value)) {
    if (
      !validateString(name, 256)
      || name.trim() !== name
      || name.length === 0
    ) {
      throw invalidOverrideDocument(errorCode);
    }
    const entry = value[name];
    if (!isPlainRecord(entry)) throw invalidOverrideDocument(errorCode);
    const normalized = Object.create(null);
    for (const key of Object.keys(entry)) {
      if (FORBIDDEN_KEYS.has(key)) throw invalidOverrideDocument(errorCode);
      if (STRING_FIELDS.has(key)) {
        if (!validateString(entry[key], key === "summaryZh" ? 4096 : 256)) {
          throw invalidOverrideDocument(errorCode);
        }
        if (key === "statusOverride" && !STATUS_VALUES.has(entry[key])) {
          throw invalidOverrideDocument(errorCode);
        }
        normalized[key] = entry[key];
        continue;
      }
      if (STRING_ARRAY_FIELDS.has(key)) {
        if (
          !Array.isArray(entry[key])
          || entry[key].length > 256
          || entry[key].some((item) => !validateString(item, 1024))
        ) {
          throw invalidOverrideDocument(errorCode);
        }
        if (strictSemantics && (
          (key === "intentTags" && entry[key].some((item) => !/^[a-z][a-z0-9-]{1,63}$/u.test(item)))
          || (key === "requiredEnvNames" && entry[key].some((item) => !/^[A-Z][A-Z0-9_]+$/u.test(item)))
        )) {
          throw invalidOverrideDocument(errorCode);
        }
        normalized[key] = [...entry[key]];
        continue;
      }
      throw invalidOverrideDocument(errorCode);
    }
    result[name] = normalized;
  }
  return result;
}

export function parseSkillOverridesJson(source, {
  errorCode = "skill-overrides-invalid",
  strictSemantics = false,
} = {}) {
  if (Buffer.byteLength(source, "utf8") > MAX_OVERRIDE_BYTES) {
    throw invalidOverrideDocument(errorCode);
  }
  let text;
  try {
    text = typeof source === "string"
      ? source
      : new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    throw invalidOverrideDocument(errorCode);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalidOverrideDocument(errorCode);
  }
  return validateSkillOverridesDocument(parsed, { errorCode, strictSemantics });
}

function sameFile(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

export async function readPrivateSkillOverrides(path) {
  let handle;
  try {
    handle = await open(
      path,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW | fileConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (error.code === "ENOENT") return Object.create(null);
    throw invalidOverrideDocument("private-skill-overrides-invalid");
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || (before.mode & 0o777) !== 0o600 || before.size > MAX_OVERRIDE_BYTES) {
      throw invalidOverrideDocument("private-skill-overrides-invalid");
    }
    const source = await handle.readFile();
    const after = await handle.stat();
    if (!sameFile(before, after)) throw invalidOverrideDocument("private-skill-overrides-invalid");
    return parseSkillOverridesJson(source, {
      errorCode: "private-skill-overrides-invalid",
      strictSemantics: true,
    });
  } catch (error) {
    if (error?.message === "private-skill-overrides-invalid") throw error;
    throw invalidOverrideDocument("private-skill-overrides-invalid");
  } finally {
    await handle.close().catch(() => {});
  }
}

export function mergeSkillOverrides(distributionOverrides, privateOverrides) {
  const result = Object.create(null);
  for (const [name, override] of Object.entries(distributionOverrides)) {
    result[name] = Object.assign(Object.create(null), override);
  }
  for (const [name, override] of Object.entries(privateOverrides)) {
    result[name] = Object.assign(Object.create(null), result[name] ?? {}, override);
  }
  return result;
}

export const SKILL_OVERRIDE_MAX_BYTES = MAX_OVERRIDE_BYTES;
