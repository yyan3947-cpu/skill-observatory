import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isValidConsentToken } from "./contracts.mjs";

const DEFAULT_TTL_MILLISECONDS = 5 * 60 * 1000;
const DEFAULT_MAX_PENDING_CONSENTS = 256;
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;
const MINIMUM_STALE_ENTRIES_BEFORE_COMPACTION = 64;

function consentError(code) {
  return new Error(code);
}

function digest(query) {
  return createHash("sha256").update(query).digest();
}

function isValidTimestamp(value) {
  return Number.isSafeInteger(value) && Math.abs(value) <= MAX_DATE_MILLISECONDS;
}

export function createRawSearchConsentStore(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw consentError("invalid-consent-store");
  }

  const {
    ttlMilliseconds = DEFAULT_TTL_MILLISECONDS,
    maxPendingConsents = DEFAULT_MAX_PENDING_CONSENTS,
    now = Date.now,
    monotonicNow = () => performance.now(),
    createToken = () => randomBytes(32).toString("base64url"),
  } = options;

  if (
    !Number.isSafeInteger(ttlMilliseconds) ||
    ttlMilliseconds < 1 ||
    !Number.isSafeInteger(maxPendingConsents) ||
    maxPendingConsents < 1 ||
    typeof now !== "function" ||
    typeof monotonicNow !== "function" ||
    typeof createToken !== "function"
  ) {
    throw consentError("invalid-consent-store");
  }

  const entries = new Map();
  let expiryQueue = [];
  let queueHead = 0;
  let staleQueueEntries = 0;
  let lastMonotonicTime = null;

  function readWallTime() {
    let current;
    try {
      current = now();
    } catch {
      throw consentError("invalid-consent-time");
    }
    if (!isValidTimestamp(current)) {
      throw consentError("invalid-consent-time");
    }
    return current;
  }

  function readMonotonicTime() {
    let current;
    try {
      current = monotonicNow();
    } catch {
      throw consentError("invalid-consent-monotonic-time");
    }
    if (
      typeof current !== "number" ||
      !Number.isFinite(current) ||
      current < 0 ||
      (lastMonotonicTime !== null && current < lastMonotonicTime)
    ) {
      throw consentError("invalid-consent-monotonic-time");
    }
    lastMonotonicTime = current;
    return current;
  }

  function compactQueueIfNeeded() {
    if (
      queueHead >= MINIMUM_STALE_ENTRIES_BEFORE_COMPACTION &&
      queueHead * 2 >= expiryQueue.length
    ) {
      expiryQueue = expiryQueue.slice(queueHead);
      queueHead = 0;
    }

    const queuedEntries = expiryQueue.length - queueHead;
    if (
      staleQueueEntries >= MINIMUM_STALE_ENTRIES_BEFORE_COMPACTION &&
      staleQueueEntries * 2 >= queuedEntries
    ) {
      expiryQueue = expiryQueue
        .slice(queueHead)
        .filter((entry) => entries.get(entry.token) === entry);
      queueHead = 0;
      staleQueueEntries = 0;
    }
  }

  function purgeExpired(currentMonotonic) {
    while (queueHead < expiryQueue.length) {
      const entry = expiryQueue[queueHead];
      if (entries.get(entry.token) !== entry) {
        queueHead += 1;
        staleQueueEntries -= 1;
        continue;
      }
      if (entry.expiresAtMonotonic > currentMonotonic) {
        break;
      }
      entries.delete(entry.token);
      queueHead += 1;
    }
    compactQueueIfNeeded();
  }

  function issue(query) {
    const canonical = typeof query === "string" ? query.trim() : "";
    if (!canonical) {
      throw consentError("invalid-consent-query");
    }

    const currentMonotonic = readMonotonicTime();
    const expiresAtMonotonic = currentMonotonic + ttlMilliseconds;
    if (!Number.isFinite(expiresAtMonotonic) || expiresAtMonotonic <= currentMonotonic) {
      throw consentError("invalid-consent-expiry");
    }

    const currentWallTime = readWallTime();
    const expiresAt = currentWallTime + ttlMilliseconds;
    if (!isValidTimestamp(expiresAt)) {
      throw consentError("invalid-consent-expiry");
    }
    const expiresAtIso = new Date(expiresAt).toISOString();

    purgeExpired(currentMonotonic);
    if (entries.size >= maxPendingConsents) {
      throw consentError("consent-store-capacity");
    }

    let token;
    try {
      token = createToken();
    } catch {
      throw consentError("invalid-consent-token");
    }
    if (
      !isValidConsentToken(token) ||
      entries.has(token)
    ) {
      throw consentError("invalid-consent-token");
    }

    const entry = {
      token,
      digest: digest(canonical),
      expiresAtMonotonic,
    };
    entries.set(token, entry);
    expiryQueue.push(entry);
    return { token, expiresAt: expiresAtIso };
  }

  function consume(input = {}) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return false;
    }

    const { token, query } = input;
    const canonical = typeof query === "string" ? query.trim() : "";
    if (!isValidConsentToken(token) || !canonical) {
      return false;
    }

    const entry = entries.get(token);
    if (!entry) {
      return false;
    }

    // Every attempt against a known token is destructive, including mismatch
    // and invalid-clock paths, so callers cannot probe or retry authorization.
    entries.delete(token);
    staleQueueEntries += 1;

    let currentMonotonic;
    try {
      currentMonotonic = readMonotonicTime();
    } catch {
      compactQueueIfNeeded();
      return false;
    }
    purgeExpired(currentMonotonic);
    if (entry.expiresAtMonotonic <= currentMonotonic) {
      return false;
    }

    return timingSafeEqual(entry.digest, digest(canonical));
  }

  function revoke(token) {
    if (!isValidConsentToken(token)) return false;
    const entry = entries.get(token);
    if (!entry) return false;

    // Revocation is destructive before reading the clock, matching consume's
    // fail-closed behavior and immediately releasing pending capacity.
    entries.delete(token);
    staleQueueEntries += 1;

    let currentMonotonic;
    try {
      currentMonotonic = readMonotonicTime();
    } catch {
      compactQueueIfNeeded();
      return false;
    }
    purgeExpired(currentMonotonic);
    return entry.expiresAtMonotonic > currentMonotonic;
  }

  return { issue, consume, revoke };
}
