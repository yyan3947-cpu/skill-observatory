export const MAX_GITHUB_CODE_QUERY_CHARACTERS = 256;
export const MAX_GITHUB_REPOSITORY_QUERY_CHARACTERS = 256;

export function createGitHubQueryRejectedError({ rateLimit } = {}) {
  const error = new Error("github-query-rejected");
  const properties = Object.create(null);
  properties.code = {
    value: "github-query-rejected",
    enumerable: true,
    configurable: true,
    writable: true,
  };
  properties.status = {
    value: 422,
    enumerable: true,
    configurable: true,
    writable: true,
  };
  if (rateLimit) {
    properties.rateLimit = {
      value: rateLimit,
      enumerable: true,
      configurable: true,
      writable: true,
    };
    properties.retryAt = {
      value: rateLimit.retryAt,
      enumerable: true,
      configurable: true,
      writable: true,
    };
  }
  Object.defineProperties(error, properties);
  return error;
}

export function assertGitHubCodeQueryWithinLimit(query) {
  if (typeof query !== "string") {
    throw createGitHubQueryRejectedError();
  }
  const length = [...query].length;
  if (!length || length > MAX_GITHUB_CODE_QUERY_CHARACTERS) {
    throw createGitHubQueryRejectedError();
  }
  return query;
}

export function assertGitHubRepositoryQueryWithinLimit(query) {
  const value = String(query ?? "");
  if ([...value].length > MAX_GITHUB_REPOSITORY_QUERY_CHARACTERS) {
    throw createGitHubQueryRejectedError();
  }
  return value;
}
