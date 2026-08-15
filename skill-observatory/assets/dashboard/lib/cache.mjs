import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readJsonFile(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

export async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const data = `${JSON.stringify(value, null, 2)}\n`;
  let renamed = false;
  try {
    await writeFile(tempPath, data, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(tempPath, 0o600);
    await rename(tempPath, path);
    renamed = true;
    await chmod(path, 0o600);
  } finally {
    if (!renamed) await unlink(tempPath).catch(() => {});
  }
}

export async function loadIncrementalCache(path) {
  const cache = await readJsonFile(path, { version: 1, files: {} });
  if (cache?.version !== 1 || typeof cache.files !== "object" || !cache.files) {
    return { version: 1, files: {} };
  }
  return cache;
}
