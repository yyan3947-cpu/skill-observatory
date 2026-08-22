import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  hasLatinTypoMatch,
  matchedLatinTypoQueryTokens,
  maxChineseBigramDice,
} from "../lib/fuzzy-match.mjs";

test("accepts bounded Latin substitutions and transpositions", () => {
  assert.equal(hasLatinTypoMatch("build a presentaton deck", ["presentation deck"]), true);
  assert.equal(hasLatinTypoMatch("use markte news analysis", ["market news analyst"]), true);
  assert.equal(hasLatinTypoMatch("use presxxxxxx deck", ["presentation deck"]), false);
});

test("normalizes NFKC, case, and punctuation before applying exact distance limits", () => {
  assert.equal(hasLatinTypoMatch("ＰＲＥＳＥＮＴＡＴＯＮ！", ["Presentation."]), true);
  assert.equal(hasLatinTypoMatch("abcdefg", ["abxdxfg"]), false);
  assert.equal(hasLatinTypoMatch("abcdefgh", ["abxdxfgh"]), true);
  assert.equal(hasLatinTypoMatch("abcdefgh", ["abxdxfgx"]), false);
});

test("does not fuzzy-match short generic Latin tokens", () => {
  assert.equal(hasLatinTypoMatch("ui ux pdf", ["ui", "ux", "ppt"]), false);
  assert.deepEqual(matchedLatinTypoQueryTokens("abc abdc", ["acb", "abcd"]), ["abdc"]);
});

test("ignores numeric-only and generic action tokens for fuzzy-name evidence", () => {
  assert.equal(hasLatinTypoMatch("2025", ["2026"]), false);
  assert.equal(hasLatinTypoMatch("make a report", ["bake images"]), false);
  assert.equal(hasLatinTypoMatch("process a file", ["tile converter"]), false);
  assert.equal(hasLatinTypoMatch("inspect data", ["date parser"]), false);
  assert.equal(hasLatinTypoMatch("perform analysis", ["analyst tool"]), false);
});

test("bounds catalog token length before edit-distance work", () => {
  assert.equal(hasLatinTypoMatch("a".repeat(64), [`${"a".repeat(63)}b`]), true);
  assert.equal(hasLatinTypoMatch("a".repeat(65), [`${"a".repeat(64)}b`]), false);
  assert.equal(hasLatinTypoMatch("presentaton", ["x".repeat(100_000)]), false);
});

test("keeps distance-one transpositions invariant under query-token permutations", () => {
  const queryNoise = Array.from(
    { length: 453 },
    (_, index) => `mmm${index.toString(26).padStart(5, "m")}`,
  );
  const candidateNoise = Array.from(
    { length: 144 },
    (_, index) => `aa${index.toString(36).padStart(2, "0")}`,
  );
  const candidates = [...candidateNoise, "abcd"];
  const permutations = [
    ["acbd", ...queryNoise],
    [...queryNoise.slice(0, 226), "acbd", ...queryNoise.slice(226)],
    [...queryNoise, "acbd"],
  ];

  for (const [index, tokens] of permutations.entries()) {
    assert.deepEqual(
      matchedLatinTypoQueryTokens(tokens.join(" "), candidates),
      ["acbd"],
      `permutation ${index}`,
    );
  }
});

test("keeps distance-two qgram collisions invariant under query-token permutations", () => {
  const alphabet = "mnopqrstuvwxyz";
  const queryNoise = Array.from({ length: 453 }, (_, index) => {
    let value = index;
    let suffix = "";
    for (let offset = 0; offset < 5; offset += 1) {
      suffix = `${alphabet[value % alphabet.length]}${suffix}`;
      value = Math.floor(value / alphabet.length);
    }
    return `zzz${suffix}`;
  });
  const candidateNoise = Array.from(
    { length: 1_200 },
    (_, index) => `aaaaaaaa${index.toString().padStart(4, "0")}`,
  );
  const candidateValues = [
    ...Array.from(
      { length: 16 },
      (_, group) => candidateNoise.slice(group * 75, (group + 1) * 75).join(" "),
    ),
    "aaaaaaaaaabb",
  ];
  const permutations = [
    ["aaaaaaaaaaaa", ...queryNoise],
    [...queryNoise.slice(0, 226), "aaaaaaaaaaaa", ...queryNoise.slice(226)],
    [...queryNoise, "aaaaaaaaaaaa"],
  ];

  assert.equal(permutations[0].join(" ").length, 4089);
  assert.ok(candidateValues.every((value) => value.length <= 1024));
  for (const [index, tokens] of permutations.entries()) {
    assert.deepEqual(
      matchedLatinTypoQueryTokens(tokens.join(" "), candidateValues),
      ["aaaaaaaaaaaa"],
      `permutation ${index}`,
    );
  }
});

test("caps edit-distance work for a maximum-size matcher candidate", async () => {
  const source = await readFile(new URL("../lib/fuzzy-match.mjs", import.meta.url), "utf8");
  const marker = "function damerauLevenshtein(left, right, ceiling) {";
  assert.equal(source.split(marker).length, 2);
  const probeMarker = "remainingIndexProbes -= 1;";
  assert.equal(source.split(probeMarker).length, 2);
  const comparisonCounter = "__skillObservatoryFuzzyComparisons";
  const probeCounter = "__skillObservatoryFuzzyIndexProbes";
  const instrumentedSource = source
    .replace(marker, `${marker}\n  globalThis.${comparisonCounter} += 1;`)
    .replace(probeMarker, `${probeMarker}\n          globalThis.${probeCounter} += 1;`);
  globalThis[comparisonCounter] = 0;
  globalThis[probeCounter] = 0;
  try {
    const instrumented = await import(
      `data:text/javascript;base64,${Buffer.from(instrumentedSource).toString("base64")}`
    );
    const tokens = (prefix, offset, count) => Array.from(
      { length: count },
      (_, index) => `${prefix}${(offset + index).toString(36).padStart(5, "0")}`,
    );
    const query = tokens("aaa", 0, 455).join(" ");
    const aliases = Array.from(
      { length: 256 },
      (_, group) => tokens("zzz", group * 113, 113).join(" "),
    );

    assert.equal(query.length, 4094);
    assert.ok(aliases.every((alias) => alias.length === 1016));
    assert.deepEqual(
      instrumented.matchedLatinTypoQueryTokens(query, ["zzz00000", ...aliases]),
      [],
    );
    assert.equal(globalThis[comparisonCounter], 65_536);
    assert.ok(globalThis[probeCounter] <= 524_288);
  } finally {
    delete globalThis[comparisonCounter];
    delete globalThis[probeCounter];
  }
});

test("computes Chinese bigram Dice without treating one character as evidence", () => {
  assert.ok(maxChineseBigramDice("数据检测", ["检测数据"]) >= 0.5);
  assert.equal(maxChineseBigramDice("分", ["分析报告"]), 0);
  assert.equal(maxChineseBigramDice("天气", ["股票分析"]), 0);
});

test("bounds and precomputes adversarial Chinese runs", { timeout: 5_000 }, () => {
  const noisyValues = Array.from({ length: 600 }, (_, index) => `甲乙-${index}-丙丁`);
  assert.equal(maxChineseBigramDice("数据检测", ["数据检测", ...noisyValues]), 1);
  assert.equal(maxChineseBigramDice("数据检测", [...noisyValues.slice(0, 512), "数据检测"]), 0);
  assert.equal(maxChineseBigramDice("数据检测", [`${"甲-".repeat(40_000)}数据检测`]), 0);
});
