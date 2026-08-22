import type {
  GitHubRateLimit,
  GitHubRateLimits,
  GitHubRejectionReason,
  GitHubSearchStage,
  LocalMatchLevel,
} from "./catalog.ts";
import type { TaskSearchState } from "./task-search-controller.ts";

const LOCAL_EVIDENCE_CODES = new Set([
  "alias",
  "category",
  "description",
  "exact-name",
  "fuzzy-chinese",
  "fuzzy-name",
  "intent",
  "keywords",
  "name",
  "name-tokens",
]);

const SANITIZED_TERMS = new Set([
  "airtable",
  "analysis",
  "automation",
  "code",
  "content",
  "converter",
  "current affairs",
  "data management",
  "data validation",
  "debugging",
  "document",
  "extraction",
  "finance",
  "generator",
  "management",
  "market news",
  "monitoring",
  "news",
  "news analysis",
  "pdf",
  "powerpoint",
  "presentation",
  "publishing",
  "qr code",
  "research",
  "scheduling",
  "skill",
  "stock analysis",
  "summarization",
  "testing",
  "translation",
  "ui ux",
  "validation",
  "visualization",
  "web design",
  "xiaohongshu",
]);

const TASK_SEARCH_ERROR_CODES = new Set([
  "github-access-denied",
  "github-network-failed",
  "github-query-rejected",
  "github-rate-limited",
  "github-request-failed",
  "github-request-invalid",
  "github-request-timeout",
  "github-response-invalid",
  "github-suggestions-unavailable",
  "github-token-invalid",
  "github-token-missing",
  "local-match-available",
  "local-origin-forbidden",
  "local-query-too-long",
  "local-response-invalid",
  "local-service-unavailable",
  "raw-consent-required",
  "raw-consent-unavailable",
  "raw-revoke-error",
  "sanitized-query-unavailable",
]);

const GITHUB_SEARCH_STAGES = new Set<GitHubSearchStage>([
  "repository-search",
  "code-search",
  "candidate-validation",
  "complete",
]);

export const TASK_SEARCH_REJECTION_REASONS: readonly GitHubRejectionReason[] = Object.freeze([
  "invalid-structure",
  "invalid-content",
  "irrelevant",
  "duplicate",
  "unavailable",
]);

function read<T>(reader: () => T, fallback: T): T {
  try {
    return reader();
  } catch {
    return fallback;
  }
}

function safeCounter(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function safeNullableCounter(value: unknown) {
  return value === null ? null : safeCounter(value);
}

function safeTimestamp(value: unknown) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? value
    : null;
}

function safeRateLimit(value: unknown): GitHubRateLimit | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const remaining = read(() => (value as GitHubRateLimit).remaining, undefined);
  const reset = read(() => (value as GitHubRateLimit).reset, undefined);
  const retryAt = read(() => (value as GitHubRateLimit).retryAt, undefined);
  if (
    remaining !== null && (!Number.isSafeInteger(remaining) || Number(remaining) < 0) ||
    reset !== null && (!Number.isSafeInteger(reset) || Number(reset) < 0) ||
    retryAt !== null && safeTimestamp(retryAt) === null
  ) return null;
  return {
    remaining: safeNullableCounter(remaining),
    reset: safeNullableCounter(reset),
    retryAt: retryAt === null ? null : safeTimestamp(retryAt),
  };
}

function safeRateLimits(value: unknown): GitHubRateLimits {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { search: null, codeSearch: null };
  }
  return {
    search: safeRateLimit(read(() => (value as GitHubRateLimits).search, null)),
    codeSearch: safeRateLimit(read(() => (value as GitHubRateLimits).codeSearch, null)),
  };
}

export function getSafeLocalEvidence(state: TaskSearchState) {
  const results = read(() => state.results, null);
  if (!Array.isArray(results)) return [];
  const evidence = new Set<string>();
  for (const result of results) {
    const reasonCodes = read(() => result.reasonCodes, [] as string[]);
    if (!Array.isArray(reasonCodes)) continue;
    for (const reason of reasonCodes) {
      if (typeof reason === "string" && LOCAL_EVIDENCE_CODES.has(reason)) evidence.add(reason);
    }
  }
  return [...evidence].sort();
}

export function getSafeSanitizedTerms(state: TaskSearchState) {
  const terms = read(() => state.githubSearch?.terms, null);
  if (!Array.isArray(terms)) return [];
  return [...new Set(terms.filter((term) => (
    typeof term === "string" && SANITIZED_TERMS.has(term)
  )))].sort();
}

function rejectionCount(state: TaskSearchState, reason: GitHubRejectionReason) {
  const counts = read(() => state.githubDiagnostics?.rejectionCounts, null);
  if (!Array.isArray(counts)) return 0;
  const match = counts.find((item) => read(() => item.reason, null) === reason);
  return safeCounter(match ? read(() => match.count, null) : null);
}

function safeLocalMatchLevel(value: unknown): LocalMatchLevel | null {
  return value === "strong" || value === "weak" || value === "none" ? value : null;
}

function safeStage(value: unknown): GitHubSearchStage | null {
  return typeof value === "string" && GITHUB_SEARCH_STAGES.has(value as GitHubSearchStage)
    ? value as GitHubSearchStage
    : null;
}

export function didStartGitHubSearch(state: TaskSearchState) {
  if (read(() => state.githubDiagnostics, null)) return true;
  if (read(() => state.githubStatus?.state, null) !== "ready") return false;
  const phase = read(() => state.phase, "idle");
  return safeStage(read(() => state.githubStage, null)) !== null && [
    "sanitized-searching",
    "sanitized-error",
    "raw-consent",
    "raw-revoking",
    "raw-revoke-error",
    "raw-searching",
    "raw-error",
    "complete",
  ].includes(phase);
}

export function getSentSanitizedTerms(state: TaskSearchState) {
  return didStartGitHubSearch(state) ? getSafeSanitizedTerms(state) : [];
}

export function buildTaskSearchTestRecord(state: TaskSearchState) {
  const diagnostics = read(() => state.githubDiagnostics, null);
  const searchStarted = didStartGitHubSearch(state);
  const diagnosticRates = diagnostics ? read(() => diagnostics.rateLimits, null) : null;
  const statusRates = read(() => state.githubStatus?.rateLimits, null);
  const errorCodeValue = read(() => state.error?.code, null);
  const record = {
    localMatchLevel: safeLocalMatchLevel(read(() => state.localMatchLevel, null)),
    localEvidence: getSafeLocalEvidence(state),
    sanitizedTerms: getSentSanitizedTerms(state),
    stageReached: safeStage(
      diagnostics
        ? read(() => diagnostics.stageReached, null)
        : searchStarted
          ? read(() => state.githubStage, null)
          : null,
    ),
    repositoryHits: safeCounter(diagnostics ? read(() => diagnostics.repositoryHits, null) : null),
    codeHits: safeCounter(diagnostics ? read(() => diagnostics.codeHits, null) : null),
    validatedCandidates: safeCounter(
      diagnostics ? read(() => diagnostics.validatedCandidates, null) : null,
    ),
    rejectedCandidates: safeCounter(
      diagnostics ? read(() => diagnostics.rejectedCandidates, null) : null,
    ),
    deduplicatedCandidates: safeCounter(
      diagnostics ? read(() => diagnostics.deduplicatedCandidates, null) : null,
    ),
    rejectionCounts: TASK_SEARCH_REJECTION_REASONS.map((reason) => ({
      reason,
      count: rejectionCount(state, reason),
    })),
    cached: diagnostics ? read(() => diagnostics.cached, false) === true : false,
    incomplete: diagnostics
      ? read(() => diagnostics.incomplete, false) === true
      : read(() => state.githubIncomplete, false) === true,
    rateLimits: safeRateLimits(diagnosticRates ?? statusRates),
    errorCode: typeof errorCodeValue === "string" && TASK_SEARCH_ERROR_CODES.has(errorCodeValue)
      ? errorCodeValue
      : null,
  };
  return JSON.stringify(record, null, 2);
}

interface ClipboardWriter {
  writeText(value: string): Promise<void>;
}

export async function copyTaskSearchTestRecord(
  state: TaskSearchState,
  clipboard: ClipboardWriter | null | undefined,
): Promise<"copied" | "failed"> {
  const writeText = read(() => clipboard?.writeText, null);
  if (typeof writeText !== "function" || !clipboard) return "failed";
  try {
    const record = buildTaskSearchTestRecord(state);
    await writeText.call(clipboard, record);
    return "copied";
  } catch {
    return "failed";
  }
}

interface TaskMatcherLifecycleController {
  subscribe(listener: (state: TaskSearchState) => void): () => void;
  refreshGitHubStatus(): Promise<boolean>;
  dispose(): void;
}

type DeferDisposal = (callback: () => void) => void;

export function createTaskMatcherLifecycle(
  controller: TaskMatcherLifecycleController,
  onState: (state: TaskSearchState) => void,
  deferDisposal: DeferDisposal = (callback) => queueMicrotask(callback),
) {
  let mountGeneration = 0;
  return {
    mount() {
      const generation = ++mountGeneration;
      const unsubscribe = controller.subscribe(onState);
      void controller.refreshGitHubStatus();
      let cleanedUp = false;
      return () => {
        if (cleanedUp) return;
        cleanedUp = true;
        unsubscribe();
        deferDisposal(() => {
          if (mountGeneration === generation) controller.dispose();
        });
      };
    },
  };
}
