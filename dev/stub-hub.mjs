// Stand-in CLIProxyAPI hub for rendering the usage panel without a real hub, network or secrets.
//
//   node stub-hub.mjs [--port 8318]
//
// Serves the two management endpoints the panel uses (plan.md §2.1), from ./fixtures/:
//   GET  /v0/management/auth-files  -> the auth-files fixture as-is
//   POST /v0/management/api-call    -> { status_code, body } where body is a JSON *string* of the
//                                      usage fixture named by the request's auth_index
// Every management request must send exactly "Authorization: Bearer stub"; anything else is 401.
// Fixtures are read per request, so editing one and refreshing the panel is enough — no restart.
// Read-only: this server never writes a file.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 8318;
const EXPECTED_AUTHORIZATION = "Bearer stub";
const FIXTURES = new URL("./fixtures/", import.meta.url);
const MAX_BODY_BYTES = 1_000_000;
// An auth_index names a fixture file, so only a plain file name may reach the filesystem.
const AUTH_INDEX_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

const port = readPort(process.argv.slice(2));
const failResetQuota = process.argv.slice(2).includes("--fail-reset-quota");
let consumes = 0;
let resetQuotas = 0;

const server = createServer((request, response) => {
  handle(request, response).catch((error) => {
    console.error(`stub-hub: ${error?.stack ?? error}`);
    if (!response.headersSent) sendJson(response, 500, { error: "stub hub failure" });
  });
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(
      `stub-hub: port ${port} is already in use on ${HOST}; stop that process or pass --port <n>.`,
    );
  } else {
    console.error(`stub-hub: cannot listen on ${HOST}:${port} (${error?.code ?? error})`);
  }
  process.exit(1);
});

server.listen(port, HOST, () => {
  console.log(`stub-hub: listening on http://${HOST}:${port}/v0/management/`);
  console.log(`stub-hub: Authorization must be "${EXPECTED_AUTHORIZATION}"; fixtures in ./fixtures/`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(
      `stub-hub: ${consumes} credit consume(s), ${resetQuotas} reset-quota call(s) in this run`,
    );
    server.close();
    server.closeAllConnections();
  });
}

async function handle(request, response) {
  const path = new URL(request.url ?? "/", `http://${HOST}:${port}`).pathname.replace(/\/+$/, "");
  let authIndex;
  let status;
  let payload;
  let providerStatus;

  if (path === "/v0/management/auth-files" && request.method === "GET") {
    if (authorised(request)) {
      status = 200;
      payload = await readFixture("auth-files.json");
    } else {
      status = 401;
      payload = { error: "management key required" };
    }
  } else if (path === "/v0/management/api-call" && request.method === "POST") {
    let call;
    try {
      call = await readJsonBody(request);
    } catch (error) {
      console.log(`POST ${path} -> 400`);
      sendJson(response, 400, { error: error.message });
      return;
    }
    if (typeof call?.auth_index === "string") authIndex = call.auth_index;
    if (!authorised(request)) {
      status = 401;
      payload = { error: "management key required" };
    } else {
      status = 200;
      ({ payload, providerStatus } = await callProvider(authIndex, call));
    }
  } else if (path === "/v0/management/quota/fetch" && request.method === "POST") {
    if (!authorised(request)) {
      status = 401;
      payload = { error: "management key required" };
    } else {
      const call = await readJsonBody(request);
      const matched = call?.plugin_id === "ollama-usage" && call?.auth_index === "ollama-1";
      status = matched ? 200 : 404;
      payload = matched ? await readFixture("ollama-1.json") : { error: "no such Ollama monitor" };
    }
  } else if (path === "/v0/management/reset-quota" && request.method === "POST") {
    if (!authorised(request)) {
      status = 401;
      payload = { error: "management key required" };
    } else if (failResetQuota) {
      status = 500;
      payload = { error: "stub refuses reset-quota" };
      resetQuotas += 1;
      console.log(`POST ${path} -> 500 (--fail-reset-quota)`);
      sendJson(response, status, payload);
      return;
    } else {
      status = 200;
      payload = { ok: true };
      resetQuotas += 1;
    }
  } else {
    status = 404;
    payload = { error: "no such stub endpoint" };
  }

  sendJson(response, status, payload);
  console.log(
    `${request.method} ${path}${authIndex ? ` auth_index=${loggable(authIndex)}` : ""} -> ${status}` +
      (providerStatus === undefined ? "" : ` status_code=${providerStatus}`),
  );
}

// The hub answers HTTP 200 with the provider's own status inside the envelope; only the panel's
// per-account failure row depends on that split.
async function callProvider(authIndex, call) {
  const url = typeof call?.url === "string" ? call.url : "";
  if (url.endsWith("/profile")) return { payload: { status_code: 200, body: JSON.stringify({ organization: { uuid: "11111111-2222-3333-4444-555555555555" } }) } };
  if (url.endsWith("/reset_rate_limits")) {
    consumes += 1;
    return { payload: { status_code: 200, body: JSON.stringify({ result: "reset" }) } };
  }
  // A Codex reset credit being spent: answer what a real hub answers and log which credit it was.
  if (url.endsWith("/rate-limit-reset-credits/consume")) {
    let sent = {};
    try {
      sent = JSON.parse(call?.data ?? "{}");
    } catch {
      sent = {};
    }
    consumes += 1;
    console.log(
      `  consume credit_id=${JSON.stringify(String(sent?.credit_id ?? ""))}` +
        ` redeem_request_id=${JSON.stringify(String(sent?.redeem_request_id ?? ""))}`,
    );
    return { payload: { status_code: 200, body: JSON.stringify({ code: "reset" }) } };
  }
  // The banked-credit list for that account; an account with none answers an empty list.
  if (url.endsWith("/rate-limit-reset-credits")) {
    const credits = await readFixture(`${authIndex}.credits.json`, { missingOk: true });
    return {
      payload: { status_code: 200, body: JSON.stringify(credits ?? { credits: [] }) },
    };
  }
  if (typeof authIndex !== "string" || !AUTH_INDEX_PATTERN.test(authIndex)) {
    return { payload: { status_code: 404, body: "{}" }, providerStatus: 404 };
  }
  const usage = await readFixture(`${authIndex}.json`, { missingOk: true });
  if (usage === undefined) return { payload: { status_code: 404, body: "{}" }, providerStatus: 404 };
  return { payload: { status_code: 200, body: JSON.stringify(usage) } };
}

function authorised(request) {
  return request.headers.authorization === EXPECTED_AUTHORIZATION;
}

// `missingOk` distinguishes "no such account" (an ordinary answer for api-call) from a broken or
// absent auth-files fixture, which must fail loudly instead of looking like an empty hub.
async function readFixture(name, { missingOk = false } = {}) {
  try {
    return JSON.parse(await readFile(new URL(name, FIXTURES), "utf8"));
  } catch (error) {
    if (missingOk && error?.code === "ENOENT") return undefined;
    throw Object.assign(new Error(`fixture ${name} is unreadable: ${error?.message ?? error}`), {
      code: error?.code,
    });
  }
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body over ${MAX_BODY_BYTES} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim() === "") {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("request body is not JSON"));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload ?? {});
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

// A body-supplied value must not be able to forge or split a log line.
function loggable(value) {
  return AUTH_INDEX_PATTERN.test(value) ? value : JSON.stringify(value);
}

function readPort(argv) {
  const index = argv.indexOf("--port");
  if (index === -1) return DEFAULT_PORT;
  const value = argv[index + 1];
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`stub-hub: --port needs a port number 1-65535, got ${JSON.stringify(value)}`);
    process.exit(1);
  }
  return port;
}
