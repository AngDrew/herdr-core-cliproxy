// Small UI safety check without GPUI or network: node dev/panel.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { claudeGrantBlocker } from "../cliproxy-usage/hub.js";

const journal = new Map(), tasks = [], overlays = [];
let claims = 0, answer = "unknown";
function element() {
  const node = { items: [], child(v) { this.items.push(v); return proxy; }, children(v) { this.items.push(...v); return proxy; } };
  const proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    if (key === "when") return (test, fn) => test ? fn(proxy) : proxy;
    return () => proxy;
  } });
  return proxy;
}
const context = vm.createContext({
  View: class {}, div: element, h_flex: element, v_flex: element, randomUUID, claudeGrantBlocker,
  consumeClaudeResetGrant: async () => { claims++; return { outcome: answer }; },
  appHome: () => "/test", openOverlay: (o) => overlays.push(o),
  readTextFile: async (p) => journal.get(p) ?? null,
  writeTextFile: async (p, text, expected) => {
    assert.equal(journal.get(p) ?? null, expected, "journal write is compare-and-swap");
    journal.set(p, text);
  },
});
let source = fs.readFileSync(new URL("../cliproxy-usage/main.js", import.meta.url), "utf8");
source = source.replace(/^import .*;\r?$/gm, "").replace("export default class CliproxyUsage", "globalThis.Panel = class CliproxyUsage");
vm.runInContext(source, context);
const config = { url: "https://hub.example/", managementKey: "test-key" };
const grant = { id: "fable", label: "Fable reset", resetsLeft: 1, startsAt: null, expiresAt: null, usableNow: true, requiresLimit: false };
const account = { id: "c1", provider: "claude", email: "hidden@example.com", plan: "Claude Subscription", windows: [],
  resetGrants: { eligible: true, atLimit: false, cooldownUntil: null, grants: [grant] } };
const cx = { notify() {}, timer: { after() {} }, spawn(fn) { tasks.push(fn(cx)); } };
function panel() {
  const p = new context.Panel();
  Object.assign(p, { config, resetBusy: false, refreshNow() {} });
  return p;
}
function text(node) { return typeof node === "string" ? node : (node?.items ?? []).map(text).join(" "); }
const p = panel();
const output = text(p.resets({}, account, false));
assert.ok(output.includes("Fable reset") && output.includes("1 left"));
assert.ok(!output.includes(account.email) && !output.includes(account.plan), "no redundant identity or plan rows");
p.useReset(account, grant);
assert.equal(claims, 0, "click alone only opens confirmation");
assert.equal(overlays[0].props.command.name, "cliproxy-usage.reset");
assert.ok(overlays[0].props.detail.includes(account.email), "confirmation identifies the account");
p.spendReset(cx);
await tasks.shift();
assert.equal(claims, 1);
assert.ok([...journal.values()][0].includes("requestId"), "unknown outcome retains journal");
const reload = panel();
reload.useReset(account, grant);
reload.spendReset(cx);
await tasks.shift();
assert.equal(claims, 1, "reload cannot spend again while outcome is unknown");
assert.ok(reload.notice.text.includes("unresolved"));
journal.clear(); answer = "reset";
reload.useReset(account, grant);
reload.spendReset(cx);
reload.spendReset(cx);
await tasks.shift();
assert.equal(claims, 2, "double command only sends one new claim");
assert.equal([...journal.values()][0].trim(), "{}", "terminal outcome clears journal");
assert.equal(reload.notice.text, "Reset applied.");
assert.equal(reload.resetBusy, false);
console.log("panel.test.js: passed");
