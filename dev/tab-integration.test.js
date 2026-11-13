// Verify the exact panel-enabling code shipped in the patch: node dev/tab-integration.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const patch = fs.readFileSync(new URL("../integration/tabs.patch", import.meta.url), "utf8");
const setup = patch.split("\n").filter((line) => line.startsWith("+    ")).slice(0, 2).map((line) => line.slice(1)).join("\n");
function enabled(body, chosen) {
  return Array.from(vm.runInNewContext(`(() => { ${setup}; return enabled; })()`, { body, shared: () => chosen }));
}
const body = { children: [{ id: "files" }, { id: "changes" }, { id: "usage" }] };
const chosen = ["files"];
assert.deepEqual(enabled(body, chosen), ["files", "usage"]);
assert.deepEqual(chosen, ["files"], "do not mutate the person\'s shared panel choices");
assert.deepEqual(enabled(body, ["usage"]), ["usage"], "never duplicate Usage");
assert.deepEqual(enabled(body, undefined), ["files", "changes", "usage"]);
assert.deepEqual(enabled({ children: [] }, ["changes"]), ["changes"], "no Usage button without its layout child");
assert.deepEqual(enabled(undefined, []), []);
assert.ok(patch.indexOf('panelButton("usage"') < patch.indexOf('.when(w?.buttons'), "Usage precedes window controls");
console.log("tab-integration.test.js: passed");
