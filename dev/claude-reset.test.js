// No network and no real grants spent: node dev/claude-reset.test.js
import assert from "node:assert/strict";
import { claudeGrantBlocker, consumeClaudeResetGrant, fetchAccounts, parseClaudeResetGrants } from "../cliproxy-usage/hub.js";

const grant = {
  id: "fable", label: "Fable reset", resets_total: 2, resets_left: 1,
  starts_at: "2026-01-01T00:00:00Z", ends_at: "2099-01-01T00:00:00Z",
  usable_now: true, use_requires_limit: false, paused: false,
  gives_back_weekly: true, percent_used: { seven_day_overage_included: 40 },
};
const block = { eligible: true, at_limit: false, grants: [grant] };
const status = parseClaudeResetGrants(block);
assert.equal(status.grants[0].resetsLeft, 1);
assert.equal(parseClaudeResetGrants({ ...block, grants: [{ ...grant, type: "full" }] }).grants[0].label, "Fable reset", "Fable launch grant keeps its scoped display label even when type is full");
assert.equal(status.grants[0].expiresAt, Date.parse(grant.ends_at));
assert.equal(claudeGrantBlocker(status, status.grants[0]), null);
for (const patch of [
  { paused: true }, { usableNow: false }, { resetsLeft: 0 },
  { startsAt: Date.now() + 60000 }, { expiresAt: Date.now() - 60000 },
  { requiresLimit: true }, { noUsage: true },
]) assert.ok(claudeGrantBlocker(status, { ...status.grants[0], ...patch }));
assert.ok(claudeGrantBlocker({ ...status, eligible: false }, status.grants[0]));
assert.ok(claudeGrantBlocker({ ...status, cooldownUntil: Date.now() + 60000 }, status.grants[0]));
assert.equal(parseClaudeResetGrants({ ...block, grants: [grant, grant] }), null);
assert.equal(parseClaudeResetGrants({ ...block, grants: [{ ...grant, id: "../bad" }] }), null);
assert.equal(parseClaudeResetGrants({ ...block, grants: [{ ...grant, ends_at: "nonsense" }] }), null);
assert.equal(parseClaudeResetGrants({ ...block, grants: [{ ...grant, resets_left: 3 }] }), null);
const refusing = parseClaudeResetGrants({ ...block, grants: [{ ...grant, usable_now: undefined }] });
assert.ok(claudeGrantBlocker(refusing, refusing.grants[0]), "missing usability fails closed");

const org = "11111111-2222-3333-4444-555555555555";
function fake({ payload = block, code = "reset", unknown = false, failClear = false, disabled = false, profile = org } = {}) {
  const calls = [];
  const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
  const fetchImpl = async (url, init) => {
    if (url.endsWith("auth-files")) return response({ files: [{ id: "c1", auth_index: "claude-1", provider: "claude", disabled }] });
    const call = JSON.parse(init.body);
    calls.push({ path: url, ...call });
    if (url.endsWith("reset-quota")) return response({ ok: !failClear }, failClear ? 500 : 200);
    assert.equal(call.header.Authorization, "Bearer $TOKEN$");
    let body;
    if (call.url.includes("/usage?")) body = { five_hour: { utilization: 30, resets_at: null }, cedar_ember: payload };
    else if (call.url.endsWith("/profile")) body = { organization: { uuid: profile } };
    else if (call.url.endsWith("/reset_rate_limits")) {
      if (unknown) throw new Error("SECRET FROM UPSTREAM");
      body = { result: code };
    } else throw new Error("unexpected route");
    return response({ status_code: 200, body: JSON.stringify(body) });
  };
  return { calls, fetchImpl };
}
const options = { url: "https://hub.example/", managementKey: "TEST-SECRET", accountId: "c1", grantId: "fable", requestId: "request-1" };
for (const code of ["reset", "already_used", "not_limited", "cooldown", "ineligible", "unavailable"]) {
  const f = fake({ code });
  assert.equal((await consumeClaudeResetGrant({ ...options, fetchImpl: f.fetchImpl })).outcome, code);
  const claim = f.calls.find((v) => v.url?.endsWith("/reset_rate_limits"));
  assert.equal(claim.method, "POST");
  assert.equal(claim.url, `https://api.anthropic.com/api/organizations/${org}/reset_rate_limits`);
  assert.deepEqual(JSON.parse(claim.data), { program: "cedar_ember", grant_id: "fable", request_id: "request-1" });
  assert.equal(f.calls.some((v) => v.path.endsWith("reset-quota")), ["reset", "already_used"].includes(code));
}
for (const scenario of [
  { payload: { ...block, eligible: false } },
  { payload: { ...block, grants: [{ ...grant, paused: true }] } },
  { payload: { ...block, grants: [{ ...grant, resets_left: 0 }] } },
  { payload: { ...block, cooldown_until: "2099-01-01T00:00:00Z" } },
  { profile: "../invalid" }, { disabled: true },
]) {
  const f = fake(scenario);
  await assert.rejects(consumeClaudeResetGrant({ ...options, fetchImpl: f.fetchImpl }));
  assert.equal(f.calls.some((v) => v.url?.endsWith("/reset_rate_limits")), false, "failed preflight must not send a claim");
}
const ambiguous = fake({ unknown: true });
const result = await consumeClaudeResetGrant({ ...options, fetchImpl: ambiguous.fetchImpl });
assert.equal(result.outcome, "unknown");
assert.ok(!JSON.stringify(result).includes("SECRET"));
assert.equal(ambiguous.calls.filter((v) => v.url?.endsWith("/reset_rate_limits")).length, 1, "no automatic retry");
assert.ok(!ambiguous.calls.some((v) => v.path.endsWith("reset-quota")));
const badAnswer = fake({ code: "SECRET FROM BODY" });
assert.equal((await consumeClaudeResetGrant({ ...options, fetchImpl: badAnswer.fetchImpl })).outcome, "unknown");
const clear = fake({ failClear: true });
const clearResult = await consumeClaudeResetGrant({ ...options, fetchImpl: clear.fetchImpl });
assert.equal(clearResult.outcome, "reset");
assert.ok(clearResult.warning.includes("cooldown"));
const read = fake();
const accounts = await fetchAccounts({ ...options, fetchImpl: read.fetchImpl });
assert.equal(accounts.accounts[0].resetGrants.grants[0].label, "Fable reset");
assert.equal(read.calls.some((v) => v.method === "POST"), false, "polling never spends");
console.log("claude-reset.test.js: passed");
