// Run: node dev/tokenplan.test.js — no network, API keys, cookies or reset operations.
import assert from "node:assert/strict";
import fs from "node:fs";
import { fetchAccounts, poolByProvider } from "../cliproxy-usage/hub.js";

const quota = JSON.parse(fs.readFileSync(new URL("./fixtures/tokenplan-1.json", import.meta.url), "utf8"));
const monitor = { id: "tokenplan-monitor.json", auth_index: "tp-1", provider: "tokenplan-usage", supports_quota: true };
const secret = "DO-NOT-RENDER";
let payload = quota, status = 200;
const fake = async (url, init) => {
  assert.equal(init.headers.Authorization, "Bearer hub-key");
  if (url.endsWith("/auth-files")) return { status: 200, text: async () => JSON.stringify({ files: [monitor, { ...monitor, id: "off", disabled: true }, { id: "other", provider: "unrelated-plugin" }] }) };
  assert.ok(url.endsWith("/v0/management/quota/fetch"), "use the normalized quota endpoint only");
  assert.deepEqual(JSON.parse(init.body), { auth_index: "tp-1", plugin_id: "tokenplan-usage" });
  return { status, text: async () => JSON.stringify(payload) };
};
const options = { url: "https://hub.example/", managementKey: "hub-key", fetchImpl: fake };

const result = await fetchAccounts(options);
assert.equal(result.accounts.length, 1);
const account = result.accounts[0];
assert.equal(account.error, undefined);
assert.equal(account.plan, "Token Plan · essential");
assert.equal(account.windows[0].key, "monthly");
assert.ok(Math.abs(account.windows[0].usedPercent - 25) < 1e-9);
assert.equal(account.windows[0].resetsAt, Date.parse("2099-01-01T16:00:00Z"));
const group = poolByProvider(result.accounts)[0];
assert.equal(group.label, "Token Plan");
assert.equal(group.pool[0].leftPercent, 75);

payload = { groups: [{ buckets: [
  { window: "5h", remainingFraction: 0.9, resetTime: "2099-01-01T01:00:00Z" },
  { window: "7d", remainingFraction: 0.4, resetTime: "2099-01-07T01:00:00Z" },
] }] };
const multi = (await fetchAccounts(options)).accounts[0];
assert.deepEqual(multi.windows.map((w) => w.key), ["session", "weekly"]);
assert.equal(multi.plan, "Token Plan");

payload = { ...quota, subscription: { plan: secret } };
assert.ok(!JSON.stringify((await fetchAccounts(options)).accounts).includes(secret), "ignore untrusted plan text");

for (const bad of [{}, { groups: [] }, { groups: [{ buckets: [{ window: "1mo", remainingFraction: 2 }] }] }, { groups: [{ buckets: [{ window: "1mo", remainingFraction: "x" }] }] }, { groups: [{ buckets: [{ window: "1mo", remainingFraction: 0.5, resetTime: "nope" }] }] }]) {
  payload = bad;
  assert.ok((await fetchAccounts(options)).accounts[0].error, "malformed quota is an error, not 100% left");
}
status = 502; payload = { error: secret };
const failed = (await fetchAccounts(options)).accounts[0];
assert.ok(failed.error.includes("502") && !JSON.stringify(failed).includes(secret));
status = 200; payload = quota;
assert.equal((await fetchAccounts({ ...options, providers: ["claude", "codex"] })).accounts.length, 0, "explicit provider filters remain respected");
console.log("tokenplan.test.js: passed");
