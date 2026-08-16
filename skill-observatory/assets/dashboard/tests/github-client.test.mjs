import assert from "node:assert/strict";
import test from "node:test";

import { createGitHubClient } from "../lib/github-client.mjs";
import { MAX_GITHUB_REPOSITORY_QUERY_CHARACTERS } from "../lib/github-query-contract.mjs";

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

  await client.getTree({ repository: "owner/repo", defaultBranch: "feature/a b" });
  await client.getTextContent({ repository: "owner/repo", skillPath: "skills/news skill/SKILL.md", defaultBranch: "feature/a b" });

  assert.match(calls[0], /\/repos\/owner\/repo\/git\/trees\/feature%2Fa%20b\?recursive=1$/);
  assert.equal(new URL(calls[1]).pathname, "/repos/owner/repo/contents/skills/news%20skill/SKILL.md");
  assert.equal(new URL(calls[1]).searchParams.get("ref"), "feature/a b");
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
  await client.getTree({ repository: "owner/repo", defaultBranch: "..." });
  assert.equal(new URL(calls.at(-1)).pathname, "/repos/owner/repo/git/trees/...");
  await assert.rejects(
    () => client.getTextContent({ repository: "owner/repo", skillPath: "../SKILL.md", defaultBranch: "main" }),
    /invalid-github-path/,
  );
  assert.equal(calls.length, 3);
});

test("GitHub client maps limits without exposing response bodies", async () => {
  const client = createGitHubClient({
    fetchImpl: async () => new Response("server-secret", {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1780000000" },
    }),
  });

  await assert.rejects(
    () => client.searchRepositories({ q: "news" }),
    (error) => {
      assert.equal(error.code, "github-rate-limited");
      assert.equal(error.status, 429);
      assert.equal(error.retryAt, new Date(1780000000 * 1000).toISOString());
      assert.doesNotMatch(error.message, /server-secret/);
      return true;
    },
  );
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
