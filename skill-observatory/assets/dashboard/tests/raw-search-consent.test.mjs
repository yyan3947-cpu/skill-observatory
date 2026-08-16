import assert from "node:assert/strict";
import test from "node:test";

import { createRawSearchConsentStore } from "../lib/raw-search-consent.mjs";

test("issues an opaque consent bound to one exact task and destroys it on mismatch", () => {
  const store = createRawSearchConsentStore({
    now: () => Date.parse("2026-08-16T00:00:00Z"),
    monotonicNow: () => 0,
    createToken: () => "opaque-test-token",
  });

  const consent = store.issue("  检测 Acme 数据  ");

  assert.deepEqual(consent, {
    token: "opaque-test-token",
    expiresAt: "2026-08-16T00:05:00.000Z",
  });
  assert.doesNotMatch(JSON.stringify(consent), /检测|Acme|数据/u);
  assert.equal(store.consume({ token: consent.token, query: "不同任务" }), false);
  assert.equal(store.consume({ token: consent.token, query: "检测 Acme 数据" }), false);
});

test("consumes a matching canonical task exactly once", () => {
  const store = createRawSearchConsentStore({
    createToken: () => "1234567890abcdef",
  });
  const consent = store.issue("检测 Acme 数据");

  assert.equal(store.consume({ token: consent.token, query: "  检测 Acme 数据  " }), true);
  assert.equal(store.consume({ token: consent.token, query: "检测 Acme 数据" }), false);
});

test("expires consent at the boundary and purges expired entries before issue", () => {
  let milliseconds = 0;
  const store = createRawSearchConsentStore({
    ttlMilliseconds: 1_000,
    now: () => 0,
    monotonicNow: () => milliseconds,
    createToken: () => "expiring-token-value",
  });
  const first = store.issue("原始任务");

  milliseconds = 1_000;
  assert.equal(store.consume({ token: first.token, query: "原始任务" }), false);

  milliseconds = 2_001;
  const second = store.issue("第二个任务");
  milliseconds = 3_002;
  const third = store.issue("第三个任务");

  assert.equal(second.token, third.token);
  assert.equal(store.consume({ token: third.token, query: "第三个任务" }), true);
});

test("uses monotonic time for TTL despite wall-clock rollback or forward jumps", () => {
  let wallClock = Date.parse("2026-08-16T00:00:00Z");
  let monotonicClock = 10_000;
  let nextToken = 0;
  const store = createRawSearchConsentStore({
    ttlMilliseconds: 1_000,
    now: () => wallClock,
    monotonicNow: () => monotonicClock,
    createToken: () => `clock-independent-${nextToken += 1}`,
  });

  const expired = store.issue("回拨后的任务");
  wallClock -= 60 * 60 * 1000;
  monotonicClock = 11_000;
  assert.equal(store.consume({ token: expired.token, query: "回拨后的任务" }), false);

  monotonicClock = 20_000;
  const valid = store.issue("前跳后的任务");
  wallClock += 24 * 60 * 60 * 1000;
  monotonicClock = 20_999;
  assert.equal(store.consume({ token: valid.token, query: "前跳后的任务" }), true);
});

test("enforces capacity without overwriting and frees slots after consume or expiry", () => {
  let monotonicClock = 0;
  let nextToken = 0;
  const store = createRawSearchConsentStore({
    ttlMilliseconds: 1_000,
    maxPendingConsents: 2,
    now: () => 0,
    monotonicNow: () => monotonicClock,
    createToken: () => `capacity-token-${String(nextToken += 1).padStart(4, "0")}`,
  });
  const first = store.issue("任务 1");
  const second = store.issue("任务 2");

  assert.throws(
    () => store.issue("任务 3"),
    (error) => error.message === "consent-store-capacity",
  );
  assert.equal(store.consume({ token: first.token, query: "任务 1" }), true);
  const third = store.issue("任务 3");

  monotonicClock = 1_000;
  const fourth = store.issue("任务 4");
  assert.equal(store.consume({ token: second.token, query: "任务 2" }), false);
  assert.equal(store.consume({ token: third.token, query: "任务 3" }), false);
  assert.equal(store.consume({ token: fourth.token, query: "任务 4" }), true);
});

test("handles large consume churn with bounded pending capacity", () => {
  let nextToken = 0;
  let monotonicReads = 0;
  const store = createRawSearchConsentStore({
    maxPendingConsents: 2,
    now: () => 0,
    monotonicNow: () => {
      monotonicReads += 1;
      return 0;
    },
    createToken: () => `churn-token-${String(nextToken += 1).padStart(6, "0")}`,
  });
  const anchor = store.issue("长期任务");

  for (let index = 0; index < 5_000; index += 1) {
    const query = `短期任务 ${index}`;
    const consent = store.issue(query);
    assert.equal(store.consume({ token: consent.token, query }), true);
  }

  assert.equal(store.consume({ token: anchor.token, query: "长期任务" }), true);
  assert.equal(monotonicReads, 10_002);
});

test("rejects token collisions without overwriting the existing consent", () => {
  const store = createRawSearchConsentStore({
    createToken: () => "repeated-token-value",
  });
  const first = store.issue("原始任务");

  assert.throws(() => store.issue("其他任务"), /invalid-consent-token/);
  assert.equal(store.consume({ token: first.token, query: "原始任务" }), true);
});

test("fails closed for invalid token factories", () => {
  for (const createToken of [
    () => "too-short",
    () => "invalid:token:value",
    () => "invalid token value",
    () => "x".repeat(513),
    () => 1234567890123456,
    () => {
      throw new Error("factory-secret");
    },
  ]) {
    const store = createRawSearchConsentStore({ createToken });
    assert.throws(
      () => store.issue("原始任务"),
      (error) => error.message === "invalid-consent-token" &&
        !error.message.includes("factory-secret"),
    );
  }
});

test("rejects syntactically invalid tokens before lookup or revocation", () => {
  const store = createRawSearchConsentStore();
  for (const token of ["short", "invalid:token:value", "invalid token value", "x".repeat(513)]) {
    assert.equal(store.revoke(token), false);
    assert.equal(store.consume({ token, query: "原始任务" }), false);
  }
});

test("rejects invalid configuration and blank task values", () => {
  for (const ttlMilliseconds of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => createRawSearchConsentStore({ ttlMilliseconds }),
      /invalid-consent-store/,
    );
  }
  for (const maxPendingConsents of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => createRawSearchConsentStore({ maxPendingConsents }),
      /invalid-consent-store/,
    );
  }
  assert.throws(() => createRawSearchConsentStore({ now: 0 }), /invalid-consent-store/);
  assert.throws(
    () => createRawSearchConsentStore({ monotonicNow: 0 }),
    /invalid-consent-store/,
  );
  assert.throws(() => createRawSearchConsentStore({ createToken: null }), /invalid-consent-store/);

  const store = createRawSearchConsentStore();
  assert.throws(() => store.issue("   "), /invalid-consent-query/);
  assert.throws(() => store.issue(null), /invalid-consent-query/);
  assert.equal(store.consume({ token: "", query: "任务" }), false);
  assert.equal(store.consume({ token: "1234567890abcdef", query: "   " }), false);
  assert.equal(store.consume(), false);
});

test("fails closed for invalid wall-clock values and expiry overflow", () => {
  const invalidClock = createRawSearchConsentStore({
    now: () => Infinity,
    createToken: () => "invalid-clock-token",
  });
  assert.throws(() => invalidClock.issue("原始任务"), /invalid-consent-time/);

  const overflowingExpiry = createRawSearchConsentStore({
    ttlMilliseconds: 1,
    now: () => 8_640_000_000_000_000,
    createToken: () => "overflow-token-value",
  });
  assert.throws(() => overflowingExpiry.issue("原始任务"), /invalid-consent-expiry/);
});

test("fails closed and destroys known consent for invalid or regressing monotonic time", () => {
  const invalidClock = createRawSearchConsentStore({
    monotonicNow: () => Number.NaN,
    createToken: () => "invalid-monotonic-token",
  });
  assert.throws(
    () => invalidClock.issue("原始任务"),
    /invalid-consent-monotonic-time/,
  );

  let monotonicClock = 100;
  const regressingClock = createRawSearchConsentStore({
    now: () => 0,
    monotonicNow: () => monotonicClock,
    createToken: () => "regressing-clock-token",
  });
  const consent = regressingClock.issue("原始任务");

  monotonicClock = 99;
  assert.equal(
    regressingClock.consume({ token: consent.token, query: "原始任务" }),
    false,
  );
  monotonicClock = 101;
  assert.equal(
    regressingClock.consume({ token: consent.token, query: "原始任务" }),
    false,
  );
  assert.throws(
    () => {
      monotonicClock = 98;
      regressingClock.issue("新任务");
    },
    /invalid-consent-monotonic-time/,
  );
});

test("revokes an issued token exactly once and prevents later consumption", () => {
  const store = createRawSearchConsentStore({ createToken: () => "revocable-token-value" });
  const issued = store.issue("原始任务");

  assert.equal(store.revoke(issued.token), true);
  assert.equal(store.revoke(issued.token), false);
  assert.equal(store.consume({ token: issued.token, query: "原始任务" }), false);
  assert.equal(store.revoke(""), false);
  assert.equal(store.revoke(null), false);
});

test("revocation frees capacity and permits safe token reuse after collision", () => {
  const store = createRawSearchConsentStore({
    maxPendingConsents: 1,
    createToken: () => "reusable-revoke-token",
  });
  const first = store.issue("任务一");
  assert.throws(() => store.issue("任务二"), /consent-store-capacity/u);

  assert.equal(store.revoke(first.token), true);
  const second = store.issue("任务二");
  assert.equal(second.token, first.token);
  assert.equal(store.consume({ token: second.token, query: "任务二" }), true);
});

test("revocation returns false for expired tokens and destroys on invalid monotonic time", () => {
  let monotonicClock = 0;
  const expiredStore = createRawSearchConsentStore({
    ttlMilliseconds: 1,
    now: () => 0,
    monotonicNow: () => monotonicClock,
    createToken: () => "expired-revoke-token",
  });
  const expired = expiredStore.issue("过期任务");
  monotonicClock = 1;
  assert.equal(expiredStore.revoke(expired.token), false);
  assert.equal(expiredStore.revoke(expired.token), false);

  let validClock = true;
  const invalidClockStore = createRawSearchConsentStore({
    maxPendingConsents: 1,
    now: () => 0,
    monotonicNow: () => validClock ? 0 : Number.NaN,
    createToken: () => "clock-revoke-token",
  });
  const issued = invalidClockStore.issue("时钟任务");
  validClock = false;
  assert.equal(invalidClockStore.revoke(issued.token), false);
  validClock = true;
  assert.doesNotThrow(() => invalidClockStore.issue("释放容量后的任务"));
});
