import assert from "node:assert/strict";
import test from "node:test";

import { createGitHubClient } from "../lib/github-client.mjs";
import {
  MAX_GITHUB_CODE_QUERY_CHARACTERS,
  MAX_GITHUB_REPOSITORY_QUERY_CHARACTERS,
} from "../lib/github-query-contract.mjs";

function codeSearchItem(overrides = {}) {
  return {
    name: "SKILL.md",
    path: "skills/qr-code/SKILL.md",
    sha: "a".repeat(40),
    repository: {
      full_name: "owner/repo",
      attacker: "ignored",
    },
    attacker: "ignored",
    ...overrides,
  };
}

function repositoryMetadata(overrides = {}) {
  return {
    full_name: "owner/repo",
    default_branch: "main",
    stargazers_count: 42,
    pushed_at: "2026-08-18T01:02:03Z",
    license: { spdx_id: "MIT", attacker: "ignored" },
    html_url: "https://github.com/owner/repo",
    attacker: "ignored",
    ...overrides,
  };
}

function rateLimitStatusPayload() {
  return {
    resources: {
      search: { limit: 30, remaining: 29, reset: 1780000000, used: 1, resource: "search" },
      code_search: { limit: 10, remaining: 8, reset: 1780000060, used: 2, resource: "code_search" },
    },
  };
}

function unsafeOptions(requiredKey, requiredValue) {
  const counters = { getterCalls: 0, trapCalls: 0 };
  const target = requiredKey === null ? {} : { [requiredKey]: requiredValue };
  const proxied = new Proxy(target, {
    get(targetValue, key, receiver) {
      counters.trapCalls += 1;
      return Reflect.get(targetValue, key, receiver);
    },
    getPrototypeOf() {
      counters.trapCalls += 1;
      return Object.prototype;
    },
  });
  const accessor = {};
  Object.defineProperty(accessor, requiredKey ?? "extra", {
    enumerable: true,
    get() {
      counters.getterCalls += 1;
      return requiredValue ?? true;
    },
  });
  const unsafePrototype = Object.assign(
    Object.create({ inherited: "secret" }),
    requiredKey === null ? {} : { [requiredKey]: requiredValue },
  );
  const extra = requiredKey === null
    ? { extra: true }
    : { [requiredKey]: requiredValue, extra: true };
  return { counters, values: [proxied, accessor, unsafePrototype, extra] };
}

test("defines client error codes without inherited getters or setters", () => {
  const previousCodeDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "code");
  let getterCalls = 0;
  let setterCalls = 0;
  let caught;
  Object.defineProperty(Object.prototype, "code", {
    configurable: true,
    get() {
      getterCalls += 1;
      return "polluted-error-code";
    },
    set() {
      setterCalls += 1;
    },
  });
  try {
    createGitHubClient({ fetchImpl: null });
  } catch (error) {
    caught = error;
  } finally {
    if (previousCodeDescriptor) {
      Object.defineProperty(Object.prototype, "code", previousCodeDescriptor);
    } else {
      delete Object.prototype.code;
    }
  }
  assert.equal(getterCalls, 0);
  assert.equal(setterCalls, 0);
  assert.equal(Object.hasOwn(caught, "code"), true);
  assert.equal(caught.code, "invalid-github-client");
});

test("GitHub client only calls api.github.com and exposes rate limits", async () => {
  const calls = [];
  const client = createGitHubClient({
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ items: [], incomplete_results: false }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": "9",
          "x-ratelimit-reset": "1780000000",
        },
      });
    },
    token: "test-token",
    apiVersion: "2026-03-10",
  });

  const response = await client.searchRepositories({ q: "news", perPage: 10 });

  assert.equal(new URL(calls[0].url).origin, "https://api.github.com");
  assert.equal(new URL(calls[0].url).pathname, "/search/repositories");
  assert.equal(calls[0].options.headers.authorization, ["Bearer", "test-token"].join(" "));
  assert.equal(calls[0].options.headers["x-github-api-version"], "2026-03-10");
  assert.equal(response.rateLimit.remaining, 9);
  assert.equal(response.rateLimit.reset, 1780000000);
  assert.equal(response.rateLimit.resource, null);
});

test("code search uses only the fixed endpoint and encodes the complete query", async () => {
  const calls = [];
  const query = '"qr code" generator filename:SKILL.md & per_page=100';
  const client = createGitHubClient({
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ items: [codeSearchItem()], incomplete_results: false }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": "7",
          "x-ratelimit-reset": "1780000000",
          "x-ratelimit-resource": "code_search",
        },
      });
    },
  });

  const response = await client.searchCode({ q: query });
  const url = new URL(calls[0]);

  assert.equal(url.origin, "https://api.github.com");
  assert.equal(url.pathname, "/search/code");
  assert.deepEqual([...url.searchParams.keys()].sort(), ["per_page", "q"]);
  assert.equal(url.searchParams.get("q"), query);
  assert.equal(url.searchParams.get("per_page"), "12");
  assert.deepEqual(response, {
    items: [{
      name: "SKILL.md",
      path: "skills/qr-code/SKILL.md",
      sha: "a".repeat(40),
      repository: "owner/repo",
    }],
    incomplete: false,
    rateLimit: {
      remaining: 7,
      reset: 1780000000,
      retryAt: new Date(1780000000 * 1000).toISOString(),
      resource: "code_search",
    },
  });
});

test("code search enforces its Unicode query boundary before network access", async () => {
  const calls = [];
  const client = createGitHubClient({
    fetchImpl: async (url) => {
      calls.push(String(url));
      return Response.json({ items: [], incomplete_results: false });
    },
  });
  const accepted = "😀".repeat(MAX_GITHUB_CODE_QUERY_CHARACTERS);
  await client.searchCode({ q: accepted });
  assert.equal(new URL(calls[0]).searchParams.get("q"), accepted);

  const rejected = `${accepted}😀`;
  await assert.rejects(
    () => client.searchCode({ q: rejected }),
    (error) => error.code === "github-query-rejected" &&
      error.status === 422 &&
      !error.message.includes("😀"),
  );
  assert.equal(calls.length, 1);
});

test("code search snapshots exact plain options before reading them", async () => {
  let networkCalls = 0;
  const client = createGitHubClient({
    fetchImpl: async () => {
      networkCalls += 1;
      return Response.json({ items: [codeSearchItem()], incomplete_results: false });
    },
  });
  const { counters, values } = unsafeOptions("q", "generator filename:SKILL.md");

  for (const value of values) {
    await assert.rejects(
      () => client.searchCode(value),
      (error) => error.code === "invalid-github-request",
    );
  }
  assert.equal(counters.trapCalls, 0);
  assert.equal(counters.getterCalls, 0);
  assert.equal(networkCalls, 0);
});

test("code search validates and snapshots every returned item", async () => {
  let trapCalls = 0;
  let getterCalls = 0;
  const proxied = new Proxy(codeSearchItem(), {
    get(target, key, receiver) {
      trapCalls += 1;
      return Reflect.get(target, key, receiver);
    },
    getPrototypeOf() {
      trapCalls += 1;
      return Object.prototype;
    },
  });
  const accessor = codeSearchItem();
  Object.defineProperty(accessor, "path", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "skills/qr-code/SKILL.md";
    },
  });
  const unsafePrototype = Object.assign(
    Object.create({ inherited: "secret" }),
    codeSearchItem(),
  );

  for (const item of [proxied, accessor, unsafePrototype]) {
    const client = createGitHubClient({
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        headers: new Headers(),
        async json() {
          return { items: [item], incomplete_results: false };
        },
      }),
    });
    await assert.rejects(
      () => client.searchCode({ q: "generator filename:SKILL.md" }),
      (error) => error.code === "github-request-failed" && error.status === 200,
    );
  }
  assert.equal(trapCalls, 0);
  assert.equal(getterCalls, 0);
});

test("repository metadata uses a fixed endpoint and returns an exact validated shape", async () => {
  const calls = [];
  const client = createGitHubClient({
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify(repositoryMetadata()), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": "4999",
          "x-ratelimit-reset": "1780000000",
          "x-ratelimit-resource": "core",
        },
      });
    },
  });

  const metadata = await client.getRepositoryMetadata({ repository: "owner/repo" });

  assert.equal(new URL(calls[0]).origin, "https://api.github.com");
  assert.equal(new URL(calls[0]).pathname, "/repos/owner/repo");
  assert.equal(new URL(calls[0]).search, "");
  assert.deepEqual(metadata, {
    repository: "owner/repo",
    defaultBranch: "main",
    stars: 42,
    pushedAt: "2026-08-18T01:02:03Z",
    license: "MIT",
    repositoryUrl: "https://github.com/owner/repo",
    rateLimit: {
      remaining: 4999,
      reset: 1780000000,
      retryAt: new Date(1780000000 * 1000).toISOString(),
      resource: "core",
    },
  });
});

test("repository metadata snapshots exact plain options before reading them", async () => {
  let networkCalls = 0;
  const client = createGitHubClient({
    fetchImpl: async () => {
      networkCalls += 1;
      return Response.json(repositoryMetadata());
    },
  });
  const { counters, values } = unsafeOptions("repository", "owner/repo");

  for (const value of values) {
    await assert.rejects(
      () => client.getRepositoryMetadata(value),
      (error) => error.code === "invalid-github-request",
    );
  }
  assert.equal(counters.trapCalls, 0);
  assert.equal(counters.getterCalls, 0);
  assert.equal(networkCalls, 0);
});

test("repository metadata enforces complete Git ref rules", async () => {
  const invalidRefs = [
    ".hidden",
    "feature/../main",
    "feature/~main",
    "feature^main",
    "feature:main",
    "feature?main",
    "feature*main",
    "feature[main",
    String.raw`feature\main`,
    "feature\u0000main",
    "feature/main.",
    "feature/topic.lock",
    "feature/@{main",
    "feature//main",
    "@",
  ];

  for (const defaultBranch of invalidRefs) {
    const client = createGitHubClient({
      fetchImpl: async () => Response.json(repositoryMetadata({ default_branch: defaultBranch })),
    });
    await assert.rejects(
      () => client.getRepositoryMetadata({ repository: "owner/repo" }),
      (error) => error.code === "github-request-failed" && error.status === 200,
    );
  }
});

test("repository metadata requires canonical GitHub timestamps and SPDX identifiers", async () => {
  const invalidTimestamps = [
    "2026-02-30T00:00:00Z",
    "2026-08-18T01:02:03.000Z",
    "2026-08-18 01:02:03Z",
    "2026-08-18T01:02:03+00:00",
  ];
  const invalidLicenses = [
    "MIT OR Apache-2.0",
    "../../MIT",
    "许可证",
    `MIT-${"x".repeat(61)}`,
  ];

  for (const pushedAt of invalidTimestamps) {
    const client = createGitHubClient({
      fetchImpl: async () => Response.json(repositoryMetadata({ pushed_at: pushedAt })),
    });
    await assert.rejects(
      () => client.getRepositoryMetadata({ repository: "owner/repo" }),
      (error) => error.code === "github-request-failed" && error.status === 200,
    );
  }
  for (const spdxId of invalidLicenses) {
    const client = createGitHubClient({
      fetchImpl: async () => Response.json(repositoryMetadata({ license: { spdx_id: spdxId } })),
    });
    await assert.rejects(
      () => client.getRepositoryMetadata({ repository: "owner/repo" }),
      (error) => error.code === "github-request-failed" && error.status === 200,
    );
  }

  const nullLicenseClient = createGitHubClient({
    fetchImpl: async () => Response.json(repositoryMetadata({ license: null })),
  });
  const metadata = await nullLicenseClient.getRepositoryMetadata({ repository: "owner/repo" });
  assert.equal(metadata.license, null);
});

test("repository metadata rejects Proxy, accessor, and unsafe-prototype payloads", async () => {
  let trapCalls = 0;
  let getterCalls = 0;
  const proxied = new Proxy({}, {
    get(_target, key) {
      if (key === "then") return undefined;
      trapCalls += 1;
      return "owner/repo";
    },
    getPrototypeOf() {
      trapCalls += 1;
      return Object.prototype;
    },
  });
  const accessor = {
    default_branch: "main",
    stargazers_count: 1,
    pushed_at: "2026-08-18T01:02:03Z",
    license: null,
    html_url: "https://github.com/owner/repo",
  };
  Object.defineProperty(accessor, "full_name", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "owner/repo";
    },
  });
  const unsafePrototype = Object.assign(Object.create({ inherited: "secret" }), {
    full_name: "owner/repo",
    default_branch: "main",
    stargazers_count: 1,
    pushed_at: "2026-08-18T01:02:03Z",
    license: null,
    html_url: "https://github.com/owner/repo",
  });

  for (const payload of [proxied, accessor, unsafePrototype]) {
    const client = createGitHubClient({
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        headers: new Headers(),
        async json() {
          return payload;
        },
      }),
    });
    await assert.rejects(
      () => client.getRepositoryMetadata({ repository: "owner/repo" }),
      (error) => error.code === "github-request-failed" && error.status === 200,
    );
  }
  assert.equal(trapCalls, 0);
  assert.equal(getterCalls, 0);
});

test("rate-limit status uses only the fixed endpoint and exposes two exact buckets", async () => {
  const calls = [];
  const client = createGitHubClient({
    fetchImpl: async (url) => {
      calls.push(String(url));
      return Response.json({
        resources: {
          search: { limit: 30, remaining: 29, reset: 1780000000, used: 1, resource: "search" },
          code_search: { limit: 10, remaining: 8, reset: 1780000060, used: 2, resource: "code_search" },
          core: { remaining: 4999, reset: 1780000000, resource: "core" },
        },
        rate: { remaining: 4999 },
      });
    },
  });

  const status = await client.getRateLimitStatus();

  assert.equal(new URL(calls[0]).origin, "https://api.github.com");
  assert.equal(new URL(calls[0]).pathname, "/rate_limit");
  assert.equal(new URL(calls[0]).search, "");
  assert.deepEqual(status, {
    search: {
      remaining: 29,
      reset: 1780000000,
      retryAt: new Date(1780000000 * 1000).toISOString(),
      resource: "search",
    },
    codeSearch: {
      remaining: 8,
      reset: 1780000060,
      retryAt: new Date(1780000060 * 1000).toISOString(),
      resource: "code_search",
    },
  });
});

test("rate-limit status rejects accessor and unsafe-prototype buckets", async () => {
  let getterCalls = 0;
  const accessorBucket = { reset: 1780000000, resource: "search" };
  Object.defineProperty(accessorBucket, "remaining", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 30;
    },
  });
  const unsafeBucket = Object.assign(Object.create({ inherited: "secret" }), {
    remaining: 10,
    reset: 1780000000,
    resource: "code_search",
  });
  const client = createGitHubClient({
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      headers: new Headers(),
      async json() {
        return { resources: { search: accessorBucket, code_search: unsafeBucket } };
      },
    }),
  });

  await assert.rejects(
    () => client.getRateLimitStatus(),
    (error) => error.code === "github-request-failed" && error.status === 200,
  );
  assert.equal(getterCalls, 0);
});

test("rate-limit status snapshots exact plain options before network access", async () => {
  let networkCalls = 0;
  const client = createGitHubClient({
    fetchImpl: async () => {
      networkCalls += 1;
      return Response.json(rateLimitStatusPayload());
    },
  });
  const { counters, values } = unsafeOptions(null, null);

  for (const value of values) {
    await assert.rejects(
      () => client.getRateLimitStatus(value),
      (error) => error.code === "invalid-github-request",
    );
  }
  assert.equal(counters.trapCalls, 0);
  assert.equal(counters.getterCalls, 0);
  assert.equal(networkCalls, 0);
});

test("new client methods accept exact null-prototype option records", async () => {
  let requestCount = 0;
  const client = createGitHubClient({
    fetchImpl: async (url) => {
      requestCount += 1;
      const path = new URL(url).pathname;
      if (path === "/search/code") {
        return Response.json({ items: [codeSearchItem()], incomplete_results: false });
      }
      if (path === "/repos/owner/repo") return Response.json(repositoryMetadata());
      return Response.json(rateLimitStatusPayload());
    },
  });
  const codeOptions = Object.assign(Object.create(null), {
    q: "generator filename:SKILL.md",
    perPage: 12,
  });
  const metadataOptions = Object.assign(Object.create(null), { repository: "owner/repo" });
  const statusOptions = Object.create(null);

  await client.searchCode(codeOptions);
  await client.getRepositoryMetadata(metadataOptions);
  await client.getRateLimitStatus(statusOptions);
  assert.equal(requestCount, 3);
});

test("GitHub client validates identifiers and encodes repository paths and refs", async () => {
  const calls = [];
  const client = createGitHubClient({
    fetchImpl: async (url) => {
      calls.push(String(url));
      const parsed = new URL(url);
      if (parsed.pathname.includes("/git/trees/")) {
        return Response.json({ tree: [], truncated: false });
      }
      return Response.json({ encoding: "base64", content: Buffer.from("hello").toString("base64"), size: 5 });
    },
  });

  await client.getTree({ repository: "owner/repo", defaultBranch: "feature/a+b" });
  await client.getTextContent({ repository: "owner/repo", skillPath: "skills/news skill/SKILL.md", defaultBranch: "feature/a+b" });

  assert.match(calls[0], /\/repos\/owner\/repo\/git\/trees\/feature%2Fa%2Bb\?recursive=1$/);
  assert.equal(new URL(calls[1]).pathname, "/repos/owner/repo/contents/skills/news%20skill/SKILL.md");
  assert.equal(new URL(calls[1]).searchParams.get("ref"), "feature/a+b");
  await assert.rejects(
    () => client.getTree({ repository: "owner/repo/extra", defaultBranch: "main" }),
    /invalid-github-repository/,
  );
  await assert.rejects(
    () => client.getTree({ repository: "../repo", defaultBranch: "main" }),
    /invalid-github-repository/,
  );
  await assert.rejects(
    () => client.getTree({ repository: "owner/..", defaultBranch: "main" }),
    /invalid-github-repository/,
  );
  await assert.rejects(
    () => client.getTree({ repository: "owner/repo", defaultBranch: "." }),
    /invalid-github-ref/,
  );
  await assert.rejects(
    () => client.getTree({ repository: "owner/repo", defaultBranch: ".." }),
    /invalid-github-ref/,
  );
  await assert.rejects(
    () => client.getTree({ repository: "owner/repo", defaultBranch: "..." }),
    /invalid-github-ref/,
  );
  await assert.rejects(
    () => client.getTextContent({ repository: "owner/repo", skillPath: "../SKILL.md", defaultBranch: "main" }),
    /invalid-github-path/,
  );
  assert.equal(calls.length, 2);
});

test("classifies authentication, access, and rate failures without reading response bodies", async () => {
  const cases = [
    { status: 401, headers: {}, code: "github-token-invalid", publicStatus: 401 },
    {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1780000000" },
      code: "github-rate-limited",
      publicStatus: 429,
    },
    { status: 403, headers: {}, code: "github-access-denied", publicStatus: 403 },
    { status: 429, headers: {}, code: "github-rate-limited", publicStatus: 429 },
    {
      status: 403,
      headers: { "retry-after": "Wed, 21 Oct 2037 07:28:00 GMT" },
      code: "github-rate-limited",
      publicStatus: 429,
      retryAt: "2037-10-21T07:28:00.000Z",
    },
  ];
  let bodyReads = 0;

  for (const item of cases) {
    const client = createGitHubClient({
      fetchImpl: async () => ({
        status: item.status,
        ok: false,
        headers: new Headers(item.headers),
        async json() {
          bodyReads += 1;
          return { message: "remote-body-secret" };
        },
      }),
    });
    await assert.rejects(
      () => client.searchCode({ q: "generator filename:SKILL.md" }),
      (error) => {
        assert.equal(error.code, item.code);
        assert.equal(error.status, item.publicStatus);
        if (item.retryAt) assert.equal(error.retryAt, item.retryAt);
        assert.doesNotMatch(error.message, /remote-body-secret/);
        return true;
      },
    );
  }
  assert.equal(bodyReads, 0);
});

test("rejects ambiguous exhausted-rate header syntax as ordinary access denial", async () => {
  const invalidValues = ["0junk", "0.5", "0x10", "+0", "-1", "1.5"];
  let bodyReads = 0;

  for (const remaining of invalidValues) {
    const client = createGitHubClient({
      fetchImpl: async () => ({
        status: 403,
        ok: false,
        headers: new Headers({ "x-ratelimit-remaining": remaining }),
        async json() {
          bodyReads += 1;
          return { message: "remote-body-secret" };
        },
      }),
    });
    await assert.rejects(
      () => client.searchCode({ q: "generator filename:SKILL.md" }),
      (error) => {
        assert.equal(error.code, "github-access-denied");
        assert.equal(error.status, 403);
        assert.equal(error.rateLimit.remaining, null);
        return true;
      },
    );
  }
  assert.equal(bodyReads, 0);
});

test("rejects ambiguous Retry-After syntax and invalid calendar dates", async () => {
  const invalidValues = [
    "0junk",
    "0.5",
    "0x10",
    "+0",
    "-1",
    "1.5",
    "2026-02-30",
    "Thu, 21 Oct 2037 07:28:00 GMT",
    "Thursday, 21-Oct-37 07:28:00 GMT",
    "Thu Oct 21 07:28:00 2037",
    "Wed, 31 Apr 2037 07:28:00 GMT",
    "Wednesday, 31-Apr-37 07:28:00 GMT",
    "Wed Apr 31 07:28:00 2037",
    "Wed, 21 Foo 2037 07:28:00 GMT",
    "Wednesday, 21-Foo-37 07:28:00 GMT",
    "Wed Foo 21 07:28:00 2037",
    "Wed, 21 Oct 2037 07:28:00 UTC",
    "Wednesday, 21-Oct-37 07:28:00 UTC",
    "Wed Oct 21 07:28:00 2037 GMT",
    "Wed, 21 Oct 2037 24:00:00 GMT",
    "Wednesday, 21-Oct-37 07:60:00 GMT",
    "Wed Oct 21 07:28:60 2037",
  ];
  let bodyReads = 0;

  for (const retryAfter of invalidValues) {
    const client = createGitHubClient({
      fetchImpl: async () => ({
        status: 403,
        ok: false,
        headers: new Headers({ "retry-after": retryAfter }),
        async json() {
          bodyReads += 1;
          return { message: "remote-body-secret" };
        },
      }),
    });
    await assert.rejects(
      () => client.searchCode({ q: "generator filename:SKILL.md" }),
      (error) => {
        assert.equal(error.code, "github-access-denied");
        assert.equal(error.status, 403);
        assert.equal(error.retryAt, null);
        return true;
      },
    );
  }
  assert.equal(bodyReads, 0);
});

test("accepts every strict HTTP-date Retry-After form and validates leap days", async () => {
  const cases = [
    ["Wed, 21 Oct 2037 07:28:00 GMT", "2037-10-21T07:28:00.000Z"],
    ["Wednesday, 21-Oct-37 07:28:00 GMT", "2037-10-21T07:28:00.000Z"],
    ["Wed Oct 21 07:28:00 2037", "2037-10-21T07:28:00.000Z"],
    ["Tue, 29 Feb 2000 07:28:00 GMT", "2000-02-29T07:28:00.000Z"],
    ["Tuesday, 29-Feb-00 07:28:00 GMT", "2000-02-29T07:28:00.000Z"],
    ["Tue Feb 29 07:28:00 2000", "2000-02-29T07:28:00.000Z"],
  ];
  let bodyReads = 0;

  for (const [retryAfter, retryAt] of cases) {
    const client = createGitHubClient({
      now: () => Date.UTC(2026, 7, 19),
      fetchImpl: async () => ({
        status: 403,
        ok: false,
        headers: new Headers({ "retry-after": retryAfter }),
        async json() {
          bodyReads += 1;
          return { message: "remote-body-secret" };
        },
      }),
    });
    await assert.rejects(
      () => client.searchCode({ q: "generator filename:SKILL.md" }),
      (error) => {
        assert.equal(error.code, "github-rate-limited");
        assert.equal(error.status, 429);
        assert.equal(error.retryAt, retryAt);
        return true;
      },
    );
  }
  assert.equal(bodyReads, 0);
});

test("resolves RFC850 two-digit years against a fixed current year", async () => {
  const cases = [
    [
      "Thursday, 21-Oct-76 07:28:00 GMT",
      "1976-10-21T07:28:00.000Z",
      Date.UTC(2026, 9, 20, 7, 28, 0),
    ],
    [
      "Wednesday, 21-Oct-76 07:28:00 GMT",
      "2076-10-21T07:28:00.000Z",
      Date.UTC(2026, 9, 22, 7, 28, 0),
    ],
    [
      "Friday, 21-Oct-77 07:28:00 GMT",
      "1977-10-21T07:28:00.000Z",
      Date.UTC(2026, 0, 1),
    ],
  ];

  for (const [retryAfter, retryAt, now] of cases) {
    const client = createGitHubClient({
      now: () => now,
      fetchImpl: async () => ({
        status: 403,
        ok: false,
        headers: new Headers({ "retry-after": retryAfter }),
        async json() {
          throw new Error("response body must not be read");
        },
      }),
    });
    await assert.rejects(
      () => client.searchCode({ q: "generator filename:SKILL.md" }),
      (error) => {
        assert.equal(error.code, "github-rate-limited");
        assert.equal(error.retryAt, retryAt);
        return true;
      },
    );
  }
});

test("error metadata ignores inherited setters during rate-limit classification", async () => {
  const keys = ["status", "rateLimit", "retryAt"];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(Object.prototype, key)]));
  let setterCalls = 0;
  try {
    for (const key of keys) {
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        set() {
          setterCalls += 1;
        },
      });
    }
    const client = createGitHubClient({
      fetchImpl: async () => ({
        status: 403,
        ok: false,
        headers: new Headers({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1780000000",
        }),
        async json() {
          return { message: "remote-body-secret" };
        },
      }),
    });
    await assert.rejects(
      () => client.searchCode({ q: "generator filename:SKILL.md" }),
      (error) => {
        assert.equal(Object.hasOwn(error, "status"), true);
        assert.equal(Object.hasOwn(error, "rateLimit"), true);
        assert.equal(Object.hasOwn(error, "retryAt"), true);
        return true;
      },
    );
  } finally {
    for (const key of keys) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
      else delete Object.prototype[key];
    }
  }
  assert.equal(setterCalls, 0);
});

test("maps GitHub query rejection without reading the remote body", async () => {
  let bodyReads = 0;
  const client = createGitHubClient({
    fetchImpl: async () => ({
      status: 422,
      ok: false,
      headers: new Headers(),
      async json() {
        bodyReads += 1;
        return { message: "remote-body-secret" };
      },
    }),
  });
  await assert.rejects(
    () => client.searchRepositories({ q: "valid query" }),
    (error) => error.code === "github-query-rejected" &&
      error.status === 422 &&
      !error.message.includes("remote-body-secret"),
  );
  assert.equal(bodyReads, 0);
});

test("maps code-search query rejection without reading the remote body", async () => {
  let bodyReads = 0;
  const client = createGitHubClient({
    fetchImpl: async () => ({
      status: 422,
      ok: false,
      headers: new Headers(),
      async json() {
        bodyReads += 1;
        return { message: "code-search-body-secret" };
      },
    }),
  });
  await assert.rejects(
    () => client.searchCode({ q: "generator filename:SKILL.md" }),
    (error) => error.code === "github-query-rejected" &&
      error.status === 422 &&
      !error.message.includes("code-search-body-secret"),
  );
  assert.equal(bodyReads, 0);
});

test("keeps Git tree HTTP 422 as a generic request failure", async () => {
  let bodyReads = 0;
  const client = createGitHubClient({
    fetchImpl: async () => ({
      status: 422,
      ok: false,
      headers: new Headers(),
      async json() {
        bodyReads += 1;
        return { message: "tree-body-secret" };
      },
    }),
  });
  await assert.rejects(
    () => client.getTree({ repository: "owner/repo", defaultBranch: "main" }),
    (error) => error.code === "github-request-failed" &&
      error.status === 422 &&
      !error.message.includes("tree-body-secret"),
  );
  assert.equal(bodyReads, 0);
});

test("keeps content HTTP 422 as a generic request failure", async () => {
  let bodyReads = 0;
  const client = createGitHubClient({
    fetchImpl: async () => ({
      status: 422,
      ok: false,
      headers: new Headers(),
      async json() {
        bodyReads += 1;
        return { message: "content-body-secret" };
      },
    }),
  });
  await assert.rejects(
    () => client.getTextContent({
      repository: "owner/repo",
      skillPath: "skill/SKILL.md",
      defaultBranch: "main",
    }),
    (error) => error.code === "github-request-failed" &&
      error.status === 422 &&
      !error.message.includes("content-body-secret"),
  );
  assert.equal(bodyReads, 0);
});

test("enforces the repository query limit by Unicode code points", async () => {
  const calls = [];
  const client = createGitHubClient({
    fetchImpl: async (url) => {
      calls.push(String(url));
      return Response.json({ items: [], incomplete_results: false });
    },
  });
  const accepted = "😀".repeat(MAX_GITHUB_REPOSITORY_QUERY_CHARACTERS);
  await client.searchRepositories({ q: accepted });
  assert.equal(new URL(calls[0]).searchParams.get("q"), accepted);

  const acceptedAfterTrimming = `${accepted}\u2003`;
  assert.equal([...acceptedAfterTrimming].length, MAX_GITHUB_REPOSITORY_QUERY_CHARACTERS + 1);
  await client.searchRepositories({ q: acceptedAfterTrimming });
  assert.equal(new URL(calls[1]).searchParams.get("q"), accepted);

  const rejected = "😀".repeat(MAX_GITHUB_REPOSITORY_QUERY_CHARACTERS + 1);
  await assert.rejects(
    () => client.searchRepositories({ q: rejected }),
    (error) => error.code === "github-query-rejected" &&
      error.status === 422 &&
      !error.message.includes("😀"),
  );
  assert.equal(calls.length, 2);
});

test("GitHub client refuses oversized decoded text", async () => {
  const content = Buffer.alloc(32, "a").toString("base64");
  const client = createGitHubClient({
    fetchImpl: async () => Response.json({ encoding: "base64", content, size: 32 }),
  });

  await assert.rejects(
    () => client.getTextContent({
      repository: "owner/repo",
      skillPath: "skill/SKILL.md",
      defaultBranch: "main",
      maxBytes: 16,
    }),
    (error) => error.code === "github-content-too-large",
  );
});

test("GitHub client preserves a UTF-8 BOM for exact frontmatter validation", async () => {
  const content = "\uFEFF---\nname: news-skill\n---\n";
  const client = createGitHubClient({
    fetchImpl: async () => Response.json({
      encoding: "base64",
      content: Buffer.from(content).toString("base64"),
      size: Buffer.byteLength(content),
    }),
  });

  const response = await client.getTextContent({
    repository: "owner/repo",
    skillPath: "news-skill/SKILL.md",
    defaultBranch: "main",
  });

  assert.equal(response.text.startsWith("\uFEFF---\n"), true);
});

test("GitHub client enforces a bounded timeout even when fetch ignores abort", async () => {
  const client = createGitHubClient({
    token: "client-token-secret",
    requestTimeoutMilliseconds: 5,
    fetchImpl: async () => new Promise(() => {}),
  });

  await assert.rejects(
    () => client.searchRepositories({ q: "news" }),
    (error) => {
      assert.equal(error.code, "github-request-timeout");
      assert.equal(error.message, "github-request-timeout");
      assert.doesNotMatch(String(error.stack), /client-token-secret/);
      return true;
    },
  );
});
