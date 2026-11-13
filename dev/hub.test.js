// Network-free test for the CLIProxyAPI hub client.
// Run from the repository root: node dev/hub.test.js
// Every hub call uses a fake `fetchImpl`; nothing leaves the machine.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  managementBase,
  describeFailure,
  fetchAccounts,
  poolByProvider,
  paceState,
  consumeResetCredit,
  creditRedeemRequestId,
  sha1Hex,
} from "../cliproxy-usage/hub.js";

let asserts = 0;
const ok = (value, label) => {
  asserts += 1;
  assert.ok(value, label);
};
const is = (actual, expected, label) => {
  asserts += 1;
  assert.equal(actual, expected, label);
};
const deep = (actual, expected, label) => {
  asserts += 1;
  assert.deepEqual(actual, expected, label);
};
const includes = (haystack, needle, label) => {
  asserts += 1;
  assert.ok(haystack.includes(needle), `${label}: expected ${needle} in ${haystack}`);
};
const rejectsWith = async (promise, message, label) => {
  asserts += 1;
  await assert.rejects(promise, { message }, label);
};

const HUB_URL = "https://hub.example.com/";
const MANAGEMENT_KEY = "test-management-key";
const SECRET = "SECRET-BODY-CONTENT";
const ISO_1 = "2025-01-02T03:04:05Z";
const ISO_2 = "2025-01-02T08:00:00Z";
const ISO_3 = "2025-01-08T00:00:00Z";
const CREDIT_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CREDIT_SOON = "2099-01-15T00:00:00Z";
const CREDIT_LATE = "2099-03-01T00:00:00Z";

// One credits payload covering every filter: another bucket, redeemed, expired, and two usable
// credits listed out of order so the sort is observable.
const CREDITS = [
  { id: "credit-late", reset_type: "codex_rate_limits", status: "available", expires_at: CREDIT_LATE },
  { id: "credit-soon", reset_type: "codex_rate_limits", status: "available", expires_at: CREDIT_SOON },
  {
    id: "credit-other-bucket",
    reset_type: "claude_five_hour",
    status: "available",
    expires_at: CREDIT_SOON,
  },
  { id: "credit-redeemed", reset_type: "codex_rate_limits", status: "redeemed", expires_at: CREDIT_SOON },
  {
    id: "credit-expired",
    reset_type: "codex_rate_limits",
    status: "available",
    expires_at: "2020-01-01T00:00:00Z",
  },
];

// A separate auth-files list for the consume tests; AUTH_FILES' shape is pinned by the older asserts.
const CREDIT_FILES = [
  {
    id: "codex-1",
    auth_index: "a-codex",
    provider: "codex",
    id_token: { chatgpt_account_id: "acct-123" },
  },
  { id: "codex-plain", auth_index: "a-codex-plain", provider: "codex" },
  { id: "codex-off", auth_index: "a-codex-off", provider: "codex", disabled: true },
  { id: "claude-1", auth_index: "a-claude-1", provider: "claude" },
];

// The same UUIDv5 built with node:crypto, so the hand-written SHA-1 has an independent oracle.
const REDEEM_NAMESPACE = Buffer.from("6f1c2a9e2d4b4c1e9a7f3b8d5e0c1a42", "hex");
function uuidV5(name) {
  const digest = createHash("sha1")
    .update(Buffer.concat([REDEEM_NAMESPACE, Buffer.from(name, "utf8")]))
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// One auth-files payload covering both providers, five skip/failure cases.
const AUTH_FILES = [
  {
    id: "codex-1",
    auth_index: "a-codex",
    provider: "codex",
    email: "one@example.com",
    id_token: { chatgpt_account_id: "acct-123", plan_type: "plus" },
  },
  { id: "claude-1", auth_index: "a-claude-1", provider: "claude", email: "two@example.com" },
  { id: "claude-2", auth_index: "a-claude-2", provider: "claude", email: "three@example.com" },
  { id: "claude-3", auth_index: "a-claude-3", provider: "claude", email: "four@example.com" },
  { id: "claude-off", auth_index: "a-claude-off", provider: "claude", disabled: true },
  { id: "gemini-1", auth_index: "a-gemini", provider: "gemini" },
];

const PROVIDER_REPLIES = {
  "a-codex": {
    status_code: 200,
    body: JSON.stringify({
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 12.5, reset_at: 1700000000, limit_window_seconds: 18000 },
        secondary_window: {
          used_percent: 90,
          reset_at: 1700604800,
          limit_window_seconds: 604800,
        },
      },
    }),
  },
  "a-claude-1": {
    status_code: 200,
    body: JSON.stringify({ five_hour: { utilization: 40, resets_at: ISO_1 }, seven_day: null }),
  },
  // A failing account whose body must never surface: hub bodies can hold credentials.
  "a-claude-2": { status_code: 401, body: `{"error":"${SECRET}"}` },
  "a-claude-3": {
    status_code: 200,
    body: JSON.stringify({
      five_hour: { utilization: 20, resets_at: ISO_2 },
      seven_day: { utilization: 50, resets_at: ISO_3 },
    }),
  },
};

function fakeHub({ files = AUTH_FILES, replies = PROVIDER_REPLIES, status = 200, body, log = [] }) {
  return async (url, init = {}) => {
    log.push({
      url,
      method: init.method,
      headers: init.headers ?? {},
      body: init.body,
    });
    if (url.endsWith("/auth-files")) {
      return {
        status,
        text: async () => body ?? JSON.stringify({ files }),
      };
    }
    if (url.endsWith("/api-call")) {
      const request = JSON.parse(init.body);
      const reply = replies[request.auth_index] ?? {
        status_code: 500,
        body: JSON.stringify({ error: SECRET }),
      };
      return { status: 200, text: async () => JSON.stringify(reply) };
    }
    return { status: 404, text: async () => "" };
  };
}

// A hub that also serves the reset-credit endpoints, routed by the api-call url like the real one.
function fakeCreditHub({
  files = AUTH_FILES,
  credits = [],
  creditsStatus = 200,
  consumeBody = JSON.stringify({ code: "reset" }),
  consumeStatus = 200,
  resetQuotaStatus = 200,
  log = [],
} = {}) {
  return async (url, init = {}) => {
    log.push({ url, method: init.method, headers: init.headers ?? {}, body: init.body });
    if (url.endsWith("/auth-files")) {
      return { status: 200, text: async () => JSON.stringify({ files }) };
    }
    if (url.endsWith("/reset-quota")) {
      return {
        status: resetQuotaStatus,
        text: async () => JSON.stringify({ ok: resetQuotaStatus === 200 }),
      };
    }
    if (url.endsWith("/api-call")) {
      const request = JSON.parse(init.body);
      if (request.url.endsWith("/rate-limit-reset-credits")) {
        return {
          status: 200,
          text: async () =>
            JSON.stringify({ status_code: creditsStatus, body: JSON.stringify({ credits }) }),
        };
      }
      if (request.url.endsWith("/rate-limit-reset-credits/consume")) {
        return {
          status: 200,
          text: async () => JSON.stringify({ status_code: consumeStatus, body: consumeBody }),
        };
      }
      const reply = PROVIDER_REPLIES[request.auth_index] ?? {
        status_code: 500,
        body: JSON.stringify({ error: SECRET }),
      };
      return { status: 200, text: async () => JSON.stringify(reply) };
    }
    return { status: 404, text: async () => "" };
  };
}

async function main() {
  // --- base URL normalisation -------------------------------------------------------------
  is(
    managementBase("https://hub.example.com/management.html"),
    "https://hub.example.com/v0/management/",
    "management.html stripped",
  );
  is(
    managementBase("https://hub.example.com"),
    "https://hub.example.com/v0/management/",
    "bare origin gains the management base",
  );
  is(
    managementBase("https://hub.example.com/"),
    "https://hub.example.com/v0/management/",
    "trailing slash is not doubled",
  );
  is(
    managementBase("https://hub.example.com/sub/management.html"),
    "https://hub.example.com/sub/v0/management/",
    "a sub-path keeps its prefix",
  );
  is(
    managementBase("http://127.0.0.1:8318/"),
    "http://127.0.0.1:8318/v0/management/",
    "a plain http hub keeps its port",
  );
  assert.throws(() => managementBase("not a url"), /The hub URL is not valid\./);
  asserts += 1;

  const invalid = await fetchAccounts({ url: "hub.example.com", managementKey: MANAGEMENT_KEY });
  is(invalid.error, "The hub URL is not valid.", "an invalid hub URL is reported, not thrown");
  is(invalid.accounts.length, 0, "an invalid hub URL yields no accounts");

  // --- headers: management key on the management request, $TOKEN$ in the api-call ----------
  const log = [];
  const result = await fetchAccounts({
    url: HUB_URL,
    managementKey: MANAGEMENT_KEY,
    fetchImpl: fakeHub({ log }),
  });

  const listed = log.find((entry) => entry.url.endsWith("/auth-files"));
  is(listed.method, "GET", "auth-files is a GET");
  is(
    listed.url,
    "https://hub.example.com/v0/management/auth-files",
    "auth-files is under v0/management",
  );
  is(
    listed.headers.Authorization,
    `Bearer ${MANAGEMENT_KEY}`,
    "the management request carries the management key as a Bearer token",
  );

  const calls = log.filter((entry) => entry.url.endsWith("/api-call"));
  const apiCalls = calls.map((call) => JSON.parse(call.body));
  const usageCalls = calls.filter((call, index) => !apiCalls[index].url.endsWith("/rate-limit-reset-credits"));
  const creditCalls = calls.filter((call, index) => apiCalls[index].url.endsWith("/rate-limit-reset-credits"));
  is(usageCalls.length, 4, "one usage api-call per kept account");
  is(creditCalls.length, 1, "one credits api-call for the one codex account");
  for (const call of calls) {
    is(call.method, "POST", "api-call is a POST");
    is(
      call.headers.Authorization,
      `Bearer ${MANAGEMENT_KEY}`,
      "api-call is authenticated with the management key",
    );
  }
  const bodies = new Map(usageCalls.map((call) => [JSON.parse(call.body).auth_index, call.body]));
  const codexCall = JSON.parse(bodies.get("a-codex"));
  is(codexCall.auth_index, "a-codex", "api-call names the account by auth_index");
  is(codexCall.method, "GET", "api-call asks the hub for a GET");
  is(codexCall.url, "https://chatgpt.com/backend-api/wham/usage", "codex usage URL");
  is(
    codexCall.header.Authorization,
    "Bearer $TOKEN$",
    "$TOKEN$ is passed through unchanged for the hub to substitute",
  );
  is(
    codexCall.header["Chatgpt-Account-Id"],
    "acct-123",
    "codex forwards chatgpt_account_id",
  );
  is(codexCall.header.Originator, "Codex Desktop", "codex originator header");
  const claudeCall = JSON.parse(bodies.get("a-claude-1"));
  is(claudeCall.url, "https://api.anthropic.com/api/oauth/usage", "claude usage URL");
  is(
    claudeCall.header.Authorization,
    "Bearer $TOKEN$",
    "$TOKEN$ is passed through unchanged for claude too",
  );
  is(claudeCall.header["anthropic-beta"], "oauth-2025-04-20", "claude beta header");
  is(
    claudeCall.header["User-Agent"],
    "claude-code/2.1.273",
    "claude sends a Claude Code user agent",
  );
  includes(bodies.get("a-codex"), "$TOKEN$", "the api-call body holds the literal $TOKEN$");

  // --- filtering, windows, and per-account isolation ---------------------------------------
  is(result.error, undefined, "a healthy hub reports no top-level error");
  is(result.accounts.length, 4, "disabled and unknown-provider accounts are excluded");
  deep(
    result.accounts.map((account) => account.id),
    ["codex-1", "claude-1", "claude-2", "claude-3"],
    "kept accounts keep the auth-files order",
  );
  ok(
    !result.accounts.some((account) => account.id === "claude-off"),
    "disabled:true is filtered out",
  );
  ok(
    !result.accounts.some((account) => account.provider === "gemini"),
    'provider "gemini" is filtered out',
  );
  is(typeof result.checkedAt, "string", "checkedAt is an ISO string");
  ok(!Number.isNaN(Date.parse(result.checkedAt)), "checkedAt parses as a date");

  const codex = result.accounts[0];
  is(codex.email, "one@example.com", "the account email is carried through");
  is(codex.plan, "plus", "the codex plan comes from the usage body");
  deep(
    codex.windows,
    [
      { key: "session", label: "5-hour", usedPercent: 12.5, resetsAt: 1700000000000 },
      { key: "weekly", label: "Weekly", usedPercent: 90, resetsAt: 1700604800000 },
    ],
    "codex used_percent/reset_at/limit_window_seconds map to {key,label,usedPercent,resetsAt} in ms",
  );
  is(
    codex.resetCredits,
    undefined,
    "a credits answer that is not a credits list omits resetCredits and keeps the row",
  );

  const claudeOne = result.accounts[1];
  deep(
    claudeOne.windows,
    [{ key: "session", label: "5-hour", usedPercent: 40, resetsAt: Date.parse(ISO_1) }],
    "claude five_hour utilization/resets_at map to usedPercent/resetsAt numbers",
  );
  is(typeof claudeOne.windows[0].resetsAt, "number", "claude resets_at becomes a number");
  const claudeThree = result.accounts[3];
  deep(
    claudeThree.windows,
    [
      { key: "session", label: "5-hour", usedPercent: 20, resetsAt: Date.parse(ISO_2) },
      { key: "weekly", label: "Weekly", usedPercent: 50, resetsAt: Date.parse(ISO_3) },
    ],
    "claude seven_day maps to the weekly window",
  );
  is(claudeOne.plan, "Claude Subscription", "claude accounts report a plan label");

  const failed = result.accounts[2];
  is(
    failed.error,
    "The provider refused the hub request (HTTP 401).",
    "one failing account carries its own error",
  );
  is(failed.windows.length, 0, "a failing account reports no windows");
  is(failed.email, "three@example.com", "a failing account keeps its identity");
  ok(!failed.error.includes(SECRET), "a provider body never appears in an account error");
  ok(
    !result.accounts.filter((account) => account.id !== "claude-2").some((account) => account.error),
    "only the failing account carries an error",
  );
  ok(codex.windows.length > 0 && claudeOne.windows.length > 0, "the other accounts still report");

  // --- pooling -----------------------------------------------------------------------------
  const groups = poolByProvider(result.accounts);
  deep(
    groups.map((group) => group.provider),
    ["codex", "claude"],
    "one group per provider, in first-appearance order",
  );
  deep(
    groups.map((group) => group.label),
    ["Codex", "Claude"],
    "groups carry their provider label",
  );
  deep(
    groups[0].pool,
    [
      { key: "session", label: "5-hour", leftPercent: 87.5 },
      { key: "weekly", label: "Weekly", leftPercent: 10 },
    ],
    "the codex pool is left percent per window",
  );
  deep(
    groups[1].pool,
    [
      { key: "session", label: "5-hour", leftPercent: 70 },
      { key: "weekly", label: "Weekly", leftPercent: 50 },
    ],
    "the claude pool averages only the accounts that report that window",
  );
  is(groups[1].accounts.length, 3, "the group lists every account of the provider");

  deep(
    poolByProvider([
      { provider: "claude", windows: [{ key: "session", label: "5-hour", usedPercent: 100, resetsAt: null }] },
      { provider: "claude", windows: [] },
      { provider: "claude", windows: [{ key: "session", label: "5-hour", usedPercent: null, resetsAt: null }] },
      { provider: "claude", error: "probe failed", windows: [] },
    ])[0].pool,
    [{ key: "session", label: "5-hour", leftPercent: 0 }],
    "an account with no usable window does not drag the average",
  );
  deep(poolByProvider([]), [], "no accounts means no groups");

  // --- HTTP status mapping and body silence ------------------------------------------------
  const refused = await fetchAccounts({
    url: HUB_URL,
    managementKey: MANAGEMENT_KEY,
    fetchImpl: fakeHub({ status: 401, body: `${SECRET} unauthorized` }),
  });
  is(refused.error, "The hub answered with HTTP 401.", "a 401 maps to the HTTP phrase");
  is(refused.accounts.length, 0, "a refused management call yields no accounts");
  ok(!refused.error.includes(SECRET), "the hub body never appears in the error");
  ok(!refused.error.includes(MANAGEMENT_KEY), "the management key never appears in the error");

  const notJson = await fetchAccounts({
    url: HUB_URL,
    managementKey: MANAGEMENT_KEY,
    fetchImpl: fakeHub({ body: `${SECRET} not json` }),
  });
  is(
    notJson.error,
    "The hub's answer was not readable.",
    "an unreadable hub answer gets a fixed phrase",
  );
  ok(!notJson.error.includes(SECRET), "an unreadable body is not echoed");

  const transportFailure = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(`connect ECONNREFUSED ${SECRET}`), { code: "ECONNREFUSED" }),
  });
  const unreachable = await fetchAccounts({
    url: HUB_URL,
    managementKey: MANAGEMENT_KEY,
    fetchImpl: async () => {
      throw transportFailure;
    },
  });
  is(
    unreachable.error,
    "The hub request failed (ECONNREFUSED).",
    "a transport failure reports the Node code",
  );
  ok(!unreachable.error.includes(SECRET), "a transport message is not echoed");

  // --- describeFailure, the only place a phrase is chosen ----------------------------------
  is(describeFailure(undefined, 401), "The hub answered with HTTP 401.", "status becomes a phrase");
  is(
    describeFailure({ status: 500 }),
    "The hub answered with HTTP 500.",
    "an error's own status becomes a phrase",
  );
  includes(
    describeFailure({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
    "The hub's TLS certificate is not trusted (DEPTH_ZERO_SELF_SIGNED_CERT).",
    "a TLS code names the certificate problem",
  );
  includes(
    describeFailure({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
    "NODE_EXTRA_CA_CERTS",
    "a TLS code names the fix",
  );
  is(
    describeFailure({ code: "ENOTFOUND" }),
    "The hub request failed (ENOTFOUND).",
    "any other transport code is reported",
  );
  is(
    describeFailure(new Error(`boom ${SECRET}`)),
    "The hub management request failed.",
    "an unknown failure never echoes its message",
  );

  // --- the 15 s deadline comes from the injected onTimeout --------------------------------
  let fireTimeout;
  let registeredMs;
  const hanging = fetchAccounts({
    url: HUB_URL,
    managementKey: MANAGEMENT_KEY,
    fetchImpl: () => new Promise(() => {}),
    onTimeout: (callback, timeoutMs) => {
      fireTimeout = callback;
      registeredMs = timeoutMs;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  is(registeredMs, 15000, "the deadline defaults to 15 s");
  ok(typeof fireTimeout === "function", "the mod's timer gets a callback to fire");
  fireTimeout();
  const timedOut = await hanging;
  is(
    timedOut.error,
    "The hub did not answer within 15 seconds.",
    "the deadline maps to the timeout phrase",
  );
  is(timedOut.accounts.length, 0, "a timed-out hub yields no accounts");

  // --- SHA-1 and the redeem request id -----------------------------------------------------
  is(sha1Hex("abc"), "a9993e364706816aba3e25717850c26c9cd0d89d", 'SHA-1 known answer for "abc"');
  is(
    sha1Hex(""),
    "da39a3ee5e6b4b0d3255bfef95601890afd80709",
    "SHA-1 known answer for the empty string",
  );
  is(
    sha1Hex("a".repeat(1000)),
    createHash("sha1").update("a".repeat(1000)).digest("hex"),
    "SHA-1 agrees with node:crypto across a multi-block message",
  );

  const redeemId = creditRedeemRequestId("acct-123", "credit-a");
  ok(
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(redeemId),
    `a redeem id is an 8-4-4-4-12 v5 UUID with the RFC 4122 variant: ${redeemId}`,
  );
  is(
    creditRedeemRequestId("acct-123", "credit-a"),
    redeemId,
    "the same account and credit always yield the same id",
  );
  ok(
    creditRedeemRequestId("acct-123", "credit-b") !== redeemId,
    "a different credit yields a different id",
  );
  ok(
    creditRedeemRequestId("acct-999", "credit-a") !== redeemId,
    "a different account yields a different id",
  );
  is(redeemId, uuidV5("acct-123:credit-a"), "the id matches node:crypto's UUIDv5 over namespace + name");
  is(
    creditRedeemRequestId("acct-ü", "credit-a"),
    uuidV5("acct-ü:credit-a"),
    "the hand-written UTF-8 encoder matches node:crypto for a non-ASCII name",
  );

  // --- codex reset credits: filtering, order and shape -------------------------------------
  const creditLog = [];
  const withCredits = await fetchAccounts({
    url: HUB_URL,
    managementKey: MANAGEMENT_KEY,
    fetchImpl: fakeCreditHub({ credits: CREDITS, log: creditLog }),
  });
  const creditCodex = withCredits.accounts.find((account) => account.id === "codex-1");
  const creditClaude = withCredits.accounts.find((account) => account.id === "claude-1");
  const SOON_EXPIRY = Date.parse(CREDIT_SOON);
  const LATE_EXPIRY = Date.parse(CREDIT_LATE);

  deep(
    creditCodex.resetCredits.credits,
    [
      { id: "credit-soon", expiresAt: SOON_EXPIRY },
      { id: "credit-late", expiresAt: LATE_EXPIRY },
    ],
    "only codex_rate_limits + available + unexpired credits survive, soonest expiry first",
  );
  is(creditCodex.resetCredits.availableCount, 2, "availableCount counts only the spendable credits");
  is(
    creditCodex.resetCredits.credits.length,
    creditCodex.resetCredits.availableCount,
    "credits.length equals availableCount",
  );
  is(creditCodex.resetCredits.nextCreditId, "credit-soon", "nextCreditId is the soonest credit");
  is(creditCodex.resetCredits.nextExpiresAt, SOON_EXPIRY, "nextExpiresAt is the soonest expiry");
  is(typeof creditCodex.resetCredits.nextExpiresAt, "number", "nextExpiresAt is epoch milliseconds");
  ok(
    creditCodex.resetCredits.credits.every(
      (credit) => typeof credit.expiresAt === "number" && credit.expiresAt > Date.now(),
    ),
    "every credit expiry is epoch milliseconds in the future",
  );
  ok(
    creditCodex.resetCredits.credits.every(
      (credit, index, all) => index === 0 || all[index - 1].expiresAt <= credit.expiresAt,
    ),
    "the credits array is sorted by expiry ascending",
  );
  is(
    creditCodex.resetCredits.nextCreditId,
    creditCodex.resetCredits.credits[0].id,
    "nextCreditId equals credits[0].id",
  );
  ok(!("resetCredits" in creditClaude), "a non-codex account has no resetCredits");
  is(creditCodex.windows.length, 2, "the codex row still carries its windows");

  const creditsRequest = creditLog
    .filter((entry) => entry.url.endsWith("/api-call"))
    .map((entry) => JSON.parse(entry.body))
    .find((request) => request.url.endsWith("/rate-limit-reset-credits"));
  is(creditsRequest.url, CREDIT_URL, "the credits read uses CREDIT_URL through api-call");
  is(creditsRequest.method, "GET", "the credits read asks the hub for a GET");
  is(
    creditsRequest.header.Authorization,
    "Bearer $TOKEN$",
    "the credits read reuses the codex $TOKEN$ header",
  );
  is(
    creditsRequest.header["Chatgpt-Account-Id"],
    "acct-123",
    "the credits read reuses the codex account header",
  );

  const creditsFailed = await fetchAccounts({
    url: HUB_URL,
    managementKey: MANAGEMENT_KEY,
    fetchImpl: fakeCreditHub({ creditsStatus: 500 }),
  });
  const creditsFailedRow = creditsFailed.accounts.find((account) => account.id === "codex-1");
  is(creditsFailedRow.resetCredits, undefined, "a failed credits call omits resetCredits");
  is(creditsFailedRow.error, undefined, "a failed credits call does not fail the account row");
  is(creditsFailedRow.windows.length, 2, "a failed credits call keeps that row's usage windows");
  ok(!("resetCredits" in creditsFailedRow), "the omitted resetCredits key is absent, not null");

  const creditsEmpty = await fetchAccounts({
    url: HUB_URL,
    managementKey: MANAGEMENT_KEY,
    fetchImpl: fakeCreditHub({ credits: [] }),
  });
  deep(
    creditsEmpty.accounts.find((account) => account.id === "codex-1").resetCredits,
    { availableCount: 0, credits: [], nextCreditId: null, nextExpiresAt: null },
    "an account with no banked credits still reports an empty resetCredits",
  );

  // --- consuming a reset credit ------------------------------------------------------------
  const consumeLog = [];
  const granted = await consumeResetCredit({
    url: HUB_URL,
    managementKey: MANAGEMENT_KEY,
    accountId: "codex-1",
    creditId: "credit-soon",
    fetchImpl: fakeCreditHub({ files: CREDIT_FILES, log: consumeLog }),
  });
  deep(granted, { outcome: "reset" }, "a reset code maps to outcome reset with no warning");

  const consumeRequest = consumeLog
    .filter((entry) => entry.url.endsWith("/api-call"))
    .map((entry) => JSON.parse(entry.body))
    .find((request) => request.url.endsWith("/consume"));
  is(consumeRequest.method, "POST", "the consume api-call asks the hub for a POST");
  is(consumeRequest.url, `${CREDIT_URL}/consume`, "the consume call is CREDIT_URL + /consume");
  is(
    consumeRequest.header.Authorization,
    "Bearer $TOKEN$",
    "the consume call reuses the codex $TOKEN$ header",
  );
  is(typeof consumeRequest.data, "string", "the api-call data field is a JSON string, not an object");
  deep(
    JSON.parse(consumeRequest.data),
    { redeem_request_id: creditRedeemRequestId("acct-123", "credit-soon"), credit_id: "credit-soon" },
    "data carries the derived redeem id and the chosen credit id",
  );

  const resetQuotaCalls = consumeLog.filter((entry) => entry.url.endsWith("/reset-quota"));
  is(resetQuotaCalls.length, 1, "a reset clears the hub cooldown once");
  is(resetQuotaCalls[0].method, "POST", "reset-quota is a POST");
  is(
    resetQuotaCalls[0].url,
    "https://hub.example.com/v0/management/reset-quota",
    "reset-quota lives under v0/management",
  );
  deep(
    JSON.parse(resetQuotaCalls[0].body),
    { auth_index: "a-codex" },
    "reset-quota names the account by auth_index",
  );

  const redeemedLog = [];
  const redeemed = await consumeResetCredit({
    url: HUB_URL,
    managementKey: MANAGEMENT_KEY,
    accountId: "codex-1",
    creditId: "credit-soon",
    fetchImpl: fakeCreditHub({
      files: CREDIT_FILES,
      consumeBody: JSON.stringify({ code: "already_redeemed" }),
      log: redeemedLog,
    }),
  });
  deep(redeemed, { outcome: "alreadyRedeemed" }, "already_redeemed maps through without a warning");
  is(
    redeemedLog.filter((entry) => entry.url.endsWith("/reset-quota")).length,
    1,
    "already_redeemed also clears the cooldown",
  );

  for (const [code, outcome] of [
    ["nothing_to_reset", "nothingToReset"],
    ["no_credit", "noCredit"],
  ]) {
    const skippedLog = [];
    const skipped = await consumeResetCredit({
      url: HUB_URL,
      managementKey: MANAGEMENT_KEY,
      accountId: "codex-1",
      creditId: "credit-soon",
      fetchImpl: fakeCreditHub({
        files: CREDIT_FILES,
        consumeBody: JSON.stringify({ code }),
        log: skippedLog,
      }),
    });
    is(skipped.outcome, outcome, `${code} maps to ${outcome}`);
    is(skipped.warning, undefined, `${code} carries no warning`);
    is(
      skippedLog.filter((entry) => entry.url.endsWith("/reset-quota")).length,
      0,
      `${outcome} does not touch reset-quota`,
    );
  }

  const unblocked = await consumeResetCredit({
    url: HUB_URL,
    managementKey: MANAGEMENT_KEY,
    accountId: "codex-1",
    creditId: "credit-soon",
    fetchImpl: fakeCreditHub({ files: CREDIT_FILES, resetQuotaStatus: 500 }),
  });
  is(unblocked.outcome, "reset", "a failing cooldown clear keeps outcome reset");
  is(
    unblocked.warning,
    "Credit redeemed, but the hub cooldown could not be cleared. Routing may resume after its cooldown expires.",
    "a failing cooldown clear adds the warning",
  );

  await rejectsWith(
    consumeResetCredit({
      url: HUB_URL,
      managementKey: MANAGEMENT_KEY,
      accountId: "codex-1",
      creditId: "credit-soon",
      fetchImpl: fakeCreditHub({
        files: CREDIT_FILES,
        consumeBody: JSON.stringify({ code: "surprise" }),
      }),
    }),
    "The hub returned an unexpected reset-credit response.",
    "an unknown hub code throws the unexpected-response phrase",
  );
  await rejectsWith(
    consumeResetCredit({
      url: HUB_URL,
      managementKey: MANAGEMENT_KEY,
      accountId: "codex-1",
      creditId: "credit-soon",
      fetchImpl: fakeCreditHub({ files: CREDIT_FILES, consumeBody: "not json" }),
    }),
    "The hub returned an unexpected reset-credit response.",
    "an unparsable consume body throws the unexpected-response phrase",
  );

  for (const [accountId, label] of [
    ["codex-missing", "a missing account"],
    ["codex-off", "a disabled account"],
    ["claude-1", "a non-codex account"],
  ]) {
    await rejectsWith(
      consumeResetCredit({
        url: HUB_URL,
        managementKey: MANAGEMENT_KEY,
        accountId,
        creditId: "credit-soon",
        fetchImpl: fakeCreditHub({ files: CREDIT_FILES }),
      }),
      "The Codex hub account is missing or disabled.",
      `${label} throws the missing-or-disabled phrase`,
    );
  }

  const plainLog = [];
  await consumeResetCredit({
    url: HUB_URL,
    managementKey: MANAGEMENT_KEY,
    accountId: "codex-plain",
    creditId: "credit-a",
    fetchImpl: fakeCreditHub({ files: CREDIT_FILES, log: plainLog }),
  });
  const plainData = JSON.parse(
    plainLog
      .filter((entry) => entry.url.endsWith("/api-call"))
      .map((entry) => JSON.parse(entry.body))
      .find((request) => request.url.endsWith("/consume")).data,
  );
  is(
    plainData.redeem_request_id,
    creditRedeemRequestId("codex-plain", "credit-a"),
    "without chatgpt_account_id the redeem id falls back to the account id",
  );

  // Model-scoped weekly limit ("Weekly · Fable") rides along as its own pooled window.
  {
    const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    const fake = async (url) =>
      String(url).endsWith("auth-files")
        ? json({ files: [{ id: "c1", auth_index: "c1", provider: "claude" }] })
        : json({
            status_code: 200,
            body: JSON.stringify({
              five_hour: { utilization: 10, resets_at: null },
              limits: [
                { kind: "weekly_scoped", percent: 0, resets_at: "2026-11-19T11:00:00Z", scope: { model: { display_name: "Fable" } } },
                { kind: "other", percent: 5 },
              ],
            }),
          });
    const { accounts } = await fetchAccounts({ url: "https://hub.test/", managementKey: "k", fetchImpl: fake });
    const windows = accounts[0]?.windows ?? [];
    const fable = windows.find((window) => window.label === "Weekly · Fable");
    ok(windows.length === 2 && fable?.usedPercent === 0 && fable.resetsAt === Date.parse("2026-11-19T11:00:00Z"), "weekly_scoped limit becomes a Fable window, other kinds ignored");
  }

  is(paceState(20, 60), "ahead", "less quota left than even burn means spending too fast");
  is(paceState(80, 60), "behind", "more quota left than even burn means spending slower");
  is(paceState(60, 60), "on", "equal to even burn is on pace");
  is(paceState(55, 60), "on", "five points below the tick is within tolerance");
  is(paceState(65, 60), "on", "five points above the tick is within tolerance");
  is(paceState(0, null), "unknown", "missing reset time must not claim on pace");
  is(paceState(NaN, 60), "unknown", "invalid quota must not claim on pace");

  console.log(`hub.test.js: ${asserts} asserts passed`);
}

await main();
