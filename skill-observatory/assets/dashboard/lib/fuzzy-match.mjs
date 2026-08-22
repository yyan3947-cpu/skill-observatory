function normalized(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase();
}

const MAX_FUZZY_TOKEN_LENGTH = 64;
const MAX_FUZZY_VALUE_LENGTH = 4096;
const MAX_FUZZY_CANDIDATE_VALUES = 512;
const MAX_FUZZY_COMPARISONS = 65_536;
const MAX_FUZZY_INDEX_PROBES = MAX_FUZZY_COMPARISONS * 8;
const MAX_CHINESE_VALUE_LENGTH = 65_536;
const MAX_CHINESE_RUNS_PER_VALUE = 32_768;
const MAX_CHINESE_RUN_LENGTH = 65_536;
const MAX_CHINESE_PROFILES = 262_144;

export const GENERIC_FUZZY_TOKENS = Object.freeze([
  "analyze", "analyse", "build", "create", "edit", "find", "generate",
  "make", "read", "run", "search", "use", "write",
  "analysis", "content", "data", "file",
]);
const GENERIC_FUZZY_TOKEN_SET = new Set(GENERIC_FUZZY_TOKENS);

function boundedNormalized(value, maximumLength) {
  return normalized(String(value ?? "").slice(0, maximumLength)).slice(0, maximumLength);
}

function latinTokens(value) {
  return (boundedNormalized(value, MAX_FUZZY_VALUE_LENGTH).match(/[a-z0-9]+/gu) ?? []).filter((token) => (
    token.length <= MAX_FUZZY_TOKEN_LENGTH &&
    /[a-z]/u.test(token) &&
    !GENERIC_FUZZY_TOKEN_SET.has(token)
  ));
}

function maximumDistance(left, right) {
  const length = Math.max(left.length, right.length);
  if (Math.min(left.length, right.length) < 4) return -1;
  return length <= 7 ? 1 : 2;
}

function compareTokens(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function characterSignature(token) {
  return [...token].sort(compareTokens).join("");
}

function candidateLengthsFor(queryToken) {
  return [
    queryToken.length,
    queryToken.length - 1,
    queryToken.length + 1,
    queryToken.length - 2,
    queryToken.length + 2,
  ].filter((length) => {
    if (length < 1) return false;
    const shorterLength = Math.min(queryToken.length, length);
    const ceiling = shorterLength < 4 ? -1 : Math.max(queryToken.length, length) <= 7 ? 1 : 2;
    return ceiling >= 0 && Math.abs(queryToken.length - length) <= ceiling;
  });
}

function damerauLevenshtein(left, right, ceiling) {
  if (Math.abs(left.length - right.length) > ceiling) return ceiling + 1;
  const beyondCeiling = ceiling + 1;
  let previousPrevious = new Map();
  let previous = new Map();
  for (let column = 0; column <= Math.min(right.length, ceiling); column += 1) {
    previous.set(column, column);
  }
  for (let row = 1; row <= left.length; row += 1) {
    const current = new Map();
    if (row <= ceiling) current.set(0, row);
    const firstColumn = Math.max(1, row - ceiling);
    const lastColumn = Math.min(right.length, row + ceiling);
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      let value = Math.min(
        (previous.get(column) ?? beyondCeiling) + 1,
        (current.get(column - 1) ?? beyondCeiling) + 1,
        (previous.get(column - 1) ?? beyondCeiling) + cost,
      );
      if (
        row > 1 && column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      ) {
        value = Math.min(value, (previousPrevious.get(column - 2) ?? beyondCeiling) + 1);
      }
      if (value <= ceiling) current.set(column, value);
    }
    previousPrevious = previous;
    previous = current;
  }
  return previous.get(right.length) ?? beyondCeiling;
}

export function matchedLatinTypoQueryTokens(queryValue, candidateValues) {
  const queryTokens = [...new Set(latinTokens(queryValue))];
  const candidateTokens = new Set();
  const candidatesByLength = new Map();
  for (const value of candidateValues.slice(0, MAX_FUZZY_CANDIDATE_VALUES)) {
    for (const token of latinTokens(value)) {
      if (candidateTokens.has(token)) continue;
      candidateTokens.add(token);
      const tokens = candidatesByLength.get(token.length) ?? [];
      tokens.push(token);
      candidatesByLength.set(token.length, tokens);
    }
  }
  const candidatesByBigramAndLength = new Map();
  const candidateTokensBySignatureAndLength = new Map();
  for (const [length, tokens] of candidatesByLength) {
    tokens.sort(compareTokens);
    const tokensBySignature = new Map();
    for (const token of tokens) {
      const signature = characterSignature(token);
      const signatureTokens = tokensBySignature.get(signature) ?? [];
      signatureTokens.push(token);
      tokensBySignature.set(signature, signatureTokens);
      for (const bigram of bigrams(token)) {
        const byLength = candidatesByBigramAndLength.get(bigram) ?? new Map();
        const indexedTokens = byLength.get(length) ?? [];
        indexedTokens.push(token);
        byLength.set(length, indexedTokens);
        candidatesByBigramAndLength.set(bigram, byLength);
      }
    }
    candidateTokensBySignatureAndLength.set(length, tokensBySignature);
  }

  const queryScheduleScore = (queryToken) => {
    const candidateLengths = candidateLengthsFor(queryToken);
    const exactCharacterSignature = candidateTokensBySignatureAndLength
      .get(queryToken.length)
      ?.has(characterSignature(queryToken)) ? 1 : 0;
    const qgramPostingCount = [...bigrams(queryToken)].reduce((total, bigram) => (
      total + candidateLengths.reduce((count, length) => (
        count + (candidatesByBigramAndLength.get(bigram)?.get(length)?.length ?? 0)
      ), 0)
    ), 0);
    return exactCharacterSignature + qgramPostingCount;
  };
  const queryScheduleScores = new Map(
    queryTokens.map((token) => [token, queryScheduleScore(token)]),
  );
  queryTokens.sort((left, right) => (
    queryScheduleScores.get(left) - queryScheduleScores.get(right) || compareTokens(left, right)
  ));

  const matches = [];
  let remainingComparisons = MAX_FUZZY_COMPARISONS;
  let remainingIndexProbes = MAX_FUZZY_INDEX_PROBES;
  for (const [queryIndex, queryToken] of queryTokens.entries()) {
    const remainingQueries = queryTokens.length - queryIndex;
    let queryComparisons = Math.floor(remainingComparisons / remainingQueries);
    let queryIndexProbes = Math.floor(remainingIndexProbes / remainingQueries);
    let matched = false;
    const candidateLengths = candidateLengthsFor(queryToken);
    const comparedCandidates = new Set();
    const compareCandidate = (candidateToken) => {
      if (comparedCandidates.has(candidateToken)) return false;
      comparedCandidates.add(candidateToken);
      if (candidateToken === queryToken || queryComparisons <= 0) return false;
      const ceiling = maximumDistance(queryToken, candidateToken);
      queryComparisons -= 1;
      remainingComparisons -= 1;
      return damerauLevenshtein(queryToken, candidateToken, ceiling) <= ceiling;
    };
    const signatureCandidates = candidateLengths.includes(queryToken.length)
      ? candidateTokensBySignatureAndLength
        .get(queryToken.length)
        ?.get(characterSignature(queryToken)) ?? []
      : [];
    for (const candidateToken of signatureCandidates) {
      if (compareCandidate(candidateToken)) {
        matches.push(queryToken);
        matched = true;
        break;
      }
      if (queryComparisons <= 0) break;
    }
    if (matched || queryComparisons <= 0) continue;
    const queryBigrams = [...bigrams(queryToken)].sort((left, right) => {
      const postingCount = (bigram) => candidateLengths.reduce((count, length) => (
        count + (candidatesByBigramAndLength.get(bigram)?.get(length)?.length ?? 0)
      ), 0);
      return postingCount(left) - postingCount(right) || compareTokens(left, right);
    });
    const overlapCounts = new Map();
    indexSearch:
    for (const bigram of queryBigrams) {
      const byLength = candidatesByBigramAndLength.get(bigram);
      for (const length of candidateLengths) {
        for (const candidateToken of byLength?.get(length) ?? []) {
          if (queryIndexProbes <= 0) break indexSearch;
          queryIndexProbes -= 1;
          remainingIndexProbes -= 1;
          overlapCounts.set(candidateToken, (overlapCounts.get(candidateToken) ?? 0) + 1);
        }
      }
    }
    const rankedCandidates = [...overlapCounts]
      .sort(([left, leftOverlap], [right, rightOverlap]) => (
        rightOverlap - leftOverlap ||
        Math.abs(queryToken.length - left.length) - Math.abs(queryToken.length - right.length) ||
        compareTokens(left, right)
      ))
      .map(([token]) => token);
    for (const candidateToken of rankedCandidates) {
      if (compareCandidate(candidateToken)) {
        matches.push(queryToken);
        matched = true;
        break;
      }
      if (queryComparisons <= 0) break;
    }
    for (const length of candidateLengths) {
      if (matched || queryComparisons <= 0) break;
      for (const candidateToken of candidatesByLength.get(length) ?? []) {
        if (candidateToken === queryToken) continue;
        if (compareCandidate(candidateToken)) {
          matches.push(queryToken);
          matched = true;
          break;
        }
      }
    }
  }
  return matches;
}

export function hasLatinTypoMatch(queryValue, candidateValues) {
  return matchedLatinTypoQueryTokens(queryValue, candidateValues).length > 0;
}

function chineseRuns(value) {
  return (boundedNormalized(value, MAX_CHINESE_VALUE_LENGTH).match(/[\u3400-\u9fff]{2,}/gu) ?? [])
    .slice(0, MAX_CHINESE_RUNS_PER_VALUE)
    .map((run) => run.slice(0, MAX_CHINESE_RUN_LENGTH));
}

function bigrams(value) {
  const output = new Set();
  for (let index = 0; index < value.length - 1; index += 1) output.add(value.slice(index, index + 2));
  return output;
}

function chineseProfiles(values) {
  const profiles = [];
  for (const value of values.slice(0, MAX_FUZZY_CANDIDATE_VALUES)) {
    for (const run of chineseRuns(value)) {
      profiles.push(bigrams(run));
      if (profiles.length >= MAX_CHINESE_PROFILES) return profiles;
    }
  }
  return profiles;
}

export function maxChineseBigramDice(queryValue, candidateValues) {
  const queryProfiles = chineseRuns(queryValue).map(bigrams);
  const candidateProfiles = chineseProfiles(candidateValues);
  const candidateIndexes = new Map();
  for (let index = 0; index < candidateProfiles.length; index += 1) {
    for (const bigram of candidateProfiles[index]) {
      const indexes = candidateIndexes.get(bigram) ?? [];
      indexes.push(index);
      candidateIndexes.set(bigram, indexes);
    }
  }
  let maximum = 0;
  for (const query of queryProfiles) {
    const sharedByCandidate = new Map();
    for (const bigram of query) {
      for (const index of candidateIndexes.get(bigram) ?? []) {
        sharedByCandidate.set(index, (sharedByCandidate.get(index) ?? 0) + 1);
      }
    }
    for (const [index, shared] of sharedByCandidate) {
      maximum = Math.max(
        maximum,
        (2 * shared) / (query.size + candidateProfiles[index].size),
      );
    }
  }
  return maximum;
}
