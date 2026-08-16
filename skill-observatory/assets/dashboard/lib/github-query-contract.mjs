export const MAX_GITHUB_REPOSITORY_QUERY_CHARACTERS = 256;

export function createGitHubQueryRejectedError({ rateLimit } = {}) {
  const error = new Error("github-query-rejected");
  Object.defineProperty(error, "code", {
    value: "github-query-rejected",
    enumerable: true,
    configurable: true,
    writable: true,
  });
  error.status = 422;
  if (rateLimit) {
    error.rateLimit = rateLimit;
    error.retryAt = rateLimit.retryAt;
  }
  return error;
}

export function assertGitHubRepositoryQueryWithinLimit(query) {
  const value = String(query ?? "");
  if ([...value].length > MAX_GITHUB_REPOSITORY_QUERY_CHARACTERS) {
    throw createGitHubQueryRejectedError();
  }
  return value;
}
