import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recommendSkills } from "./matcher.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const query = argument("--query");
  if (!query) throw new Error("missing-query");
  const catalogPath = resolve(argument("--catalog") ?? join(scriptDirectory, "..", "references", "catalog.json"));
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  process.stdout.write(`${JSON.stringify(recommendSkills(query, catalog))}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.code ?? error.message}\n`);
  process.exitCode = 1;
});
