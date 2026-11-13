// Small UI safety check without GPUI or network: node dev/panel.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { claudeGrantBlocker, paceState } from "../cliproxy-usage/hub.js";

const journal = new Map(), tasks = [], overlays = [];
let claims = 0, answer = "unknown";
function element() {
  const node = { styles: {}, items: [], child(v) { this.items.push(v); return proxy; }, children(v) { this.items.push(...v); return proxy; } };
  const proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    if (key === "when") return (test, fn) => test ? fn(proxy) : proxy;
    return (...args) => { node.styles[key] = args; return proxy; };
  } });
  return proxy;
}
const context = vm.createContext({
  View: class {}, div: element, h_flex: element, v_flex: element, randomUUID, claudeGrantBlocker, paceState,
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
// The native panel frame and quota colors must follow the supplied theme, not fixed hex colors.
function nodes(node) { return typeof node === "string" ? [] : [node, ...(node?.items ?? []).flatMap(nodes)]; }
for (const background of ["#151b18", "#fafafa"]) {
  const t = { background, foreground: background === "#fafafa" ? "#202020" : "#eeeeee",
    border: "#556677", surface: "#334455", raised: "#445566", accent: "#abcdef", working: "#efabcd", blocked: "#cdefab" };
  p.groups = []; p.busy = false; p.notice = null;
  const frame = p.panel(t);
  assert.equal(frame.styles.id[0], "cliproxy-usage");
  assert.equal(frame.styles.rounded[0], 10);
  assert.ok(frame.styles.border_1 && frame.styles.overflow_hidden);
  assert.equal(frame.styles.border_color[0], t.border);
  assert.equal(frame.styles.bg[0], background);
  assert.equal(frame.items[0].styles.h[0], 42, "same header height as Files/Changes");
  assert.equal(frame.items[0].styles.border_color[0], t.border);
  for (const [leftPercent, color] of [[80, t.accent], [30, t.working], [0, t.blocked]]) {
    const gauge = p.pool(t, { accounts: [{ windows: [{ key: "session", resetsAt: Date.now() + 3600000 }] }] }, { key: "session", leftPercent });
    const backgrounds = nodes(gauge).map((n) => n.styles.bg?.[0]);
    assert.ok(backgrounds.includes(color), "quota fill uses the theme's semantic color");
    assert.ok(backgrounds.includes(t.foreground), "pace tick contrasts in dark and light themes");
  }
}
assert.ok(!/#[0-9a-f]{3,8}\b/i.test(source), "no hard-coded color literals in the view");
console.log("panel.test.js: passed");
