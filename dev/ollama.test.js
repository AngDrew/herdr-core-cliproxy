// Run: node dev/ollama.test.js — no network, API keys or reset operations.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fetchAccounts, poolByProvider, paceState } from "../cliproxy-usage/hub.js";

const quota = JSON.parse(fs.readFileSync(new URL("./fixtures/ollama-1.json", import.meta.url), "utf8"));
const monitor = { id: "ollama-monitor.json", auth_index: "ollama-1", provider: "ollama-usage", supports_quota: true };
const secret = "DO-NOT-RENDER";
const calls = [];
let payload = quota, status = 200;
const fake = async (url, init) => {
  calls.push({ url, init });
  assert.equal(init.headers.Authorization, "Bearer hub-key");
  if (url.endsWith("/auth-files")) return { status:200, text:async () => JSON.stringify({files:[monitor, {...monitor, id:"disabled", disabled:true}, {id:"other", provider:"unrelated-plugin"}]}) };
  assert.ok(url.endsWith("/v0/management/quota/fetch"), "use normalized quota endpoint, never API-call or direct Ollama access");
  assert.deepEqual(JSON.parse(init.body), { auth_index:"ollama-1", plugin_id:"ollama-usage" });
  return { status, text:async () => JSON.stringify(payload) };
};
const options = { url:"https://hub.example/", managementKey:"hub-key", fetchImpl:fake };
const result = await fetchAccounts(options);
assert.equal(result.accounts.length, 1);
const account = result.accounts[0];
assert.equal(account.error, undefined);
assert.ok(Math.abs(account.windows[0].usedPercent - 27.5) < 1e-9);
assert.equal(account.windows[0].key, "billing");
assert.equal(account.summary.find((m) => m.key === "usage_usd_24h").value, .01718);
assert.equal(poolByProvider(result.accounts)[0].label, "Ollama");
assert.equal(poolByProvider(result.accounts)[0].pool[0].leftPercent, 72.5);

payload = {...quota, groups:[{buckets:[
  {window:"5h", remainingFraction:.75, resetTime:"2099-01-01T01:00:00Z"},
  {window:"7d", remainingFraction:.4, resetTime:"2099-01-07T01:00:00Z"},
]}]};
const legacy = (await fetchAccounts(options)).accounts[0];
assert.deepEqual(legacy.windows.map((w) => w.usedPercent), [25, 60]);
payload = {...quota, summary:[{key:"usage_usd_24h",label:secret,value:.01,currency:"USD"},{key:"unrecognized",label:secret,value:0}]};
assert.ok(!JSON.stringify((await fetchAccounts(options)).accounts).includes(secret), "ignore untrusted labels and currency");
for (const bad of [{}, {groups:[],summary:[]}, {...quota,groups:[{buckets:[{window:"5h",remainingFraction:2}]}]}, {...quota,summary:[{key:"usage_usd_24h",value:"1"}]}, {...quota,summary:[{key:"usage_usd_24h",value:1,currency:"EUR"}]}, {...quota,summary:[{key:"request_count_24h",value:-1}]}]) {
  payload = bad;
  assert.ok((await fetchAccounts(options)).accounts[0].error, "malformed quota is an error, not 100% left");
}
status = 502; payload = {error:secret};
const failed = (await fetchAccounts(options)).accounts[0];
assert.ok(failed.error.includes("502") && !JSON.stringify(failed).includes(secret));
status = 200; payload = quota;
const filtered = await fetchAccounts({...options,providers:["claude","codex"]});
assert.equal(filtered.accounts.length, 0, "explicit provider filters remain respected");

function element() {
  const node = {items:[], styles:[], child(v){this.items.push(v);return proxy;}};
  const proxy = new Proxy(node,{get(target,key){
    if (key in target) return target[key];
    if (key === "when") return (test,fn) => test ? fn(proxy) : proxy;
    return (...args) => {target.styles.push([key,...args]);return proxy;};
  }});
  return proxy;
}
const context = vm.createContext({View:class{},div:element,h_flex:element,v_flex:element,paceState});
let source = fs.readFileSync(new URL("../cliproxy-usage/main.js",import.meta.url),"utf8")
  .replace(/^import .*;\r?$/gm,"").replace("export default class CliproxyUsage","globalThis.Panel = class CliproxyUsage");
vm.runInContext(source,context);
const panel = new context.Panel();
const text = (n) => typeof n === "string" ? n : (n?.items ?? []).map(text).join(" ");
const rendered = text(panel.card({},poolByProvider(result.accounts)[0]));
assert.ok(rendered.includes("Ollama") && rendered.includes("USD 72.50") && rendered.includes("USD 0.01718") && rendered.includes("Requests · 24h"));
assert.ok(!rendered.includes("Use reset"), "Ollama is read-only");
const styles = (n) => [...(n?.styles ?? []), ...(n?.items ?? []).flatMap(styles)];
const monthly = panel.pool({},poolByProvider(result.accounts)[0],poolByProvider(result.accounts)[0].pool[0]);
assert.ok(!styles(monthly).some(([key,value]) => key === "w" && value === 2), "never assume a seven-day pace for monthly credits");
console.log("ollama.test.js: passed");
