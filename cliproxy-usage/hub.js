// CLIProxyAPI hub client for the Usage panel mod.
//
// Plain ESM with no imports: the runtime supplies `fetch`, the mod injects its own timer, and
// tests inject their own `fetchImpl`. No UI toolkit, no app module, no node builtins.
//
//   fetchAccounts({ url, managementKey, fetchImpl?, providers?, timeoutMs?, onTimeout? })
//     -> { accounts: Account[], error?: string, checkedAt }   checkedAt is an ISO 8601 string
//   Account = { id, provider, email?, plan?, disabled, windows: Window[], resetCredits?, resetGrants?, error? }
//   resetGrants: Claude cedar_ember status, or null if unavailable. Grants carry label, resetsLeft,
//                startsAt/expiresAt (epoch ms), usability and limit requirements.
//   Window  = { key: "session" | "weekly", label: string, usedPercent: number | null,
//               resetsAt: number | null }
//   ResetCredits = { availableCount: number, credits: { id, expiresAt }[],
//                    nextCreditId: string | null, nextExpiresAt: number | null }
//                  codex accounts only, and absent when the credits read failed; expiresAt and
//                  nextExpiresAt are epoch MILLISECONDS, soonest first
//   poolByProvider(accounts) -> [{ provider, label, pool: {key,label,leftPercent}[], accounts }]
//   consumeResetCredit({ url, managementKey, accountId, creditId, fetchImpl?, timeoutMs?, onTimeout? })
//     -> { outcome: "reset" | "alreadyRedeemed" | "nothingToReset" | "noCredit", warning?: string }
//   creditRedeemRequestId(accountKey, creditId) -> UUIDv5 string, stable per account+credit
//   sha1Hex(text) -> lowercase hex SHA-1 (exposed for the known-answer test)
//
// `onTimeout(callback, timeoutMs)` registers `callback` on the caller's timer (cx.timer.after);
// `timeoutMs` is also the number in the timeout phrase. Without `onTimeout` there is no deadline.
//
// `resetsAt` is epoch MILLISECONDS for both providers (codex `reset_at` is seconds, claude
// `resets_at` is an ISO string), so a countdown is `resetsAt - Date.now()`.
//
// Errors are a fixed phrase, an HTTP status or a transport code only: a hub body can carry
// credentials, so no response text ever reaches an error string. `url` and `managementKey` are
// arguments only; nothing here stores, logs or echoes them.

const SESSION_KEY = "session";
const WEEKLY_KEY = "weekly";
const SESSION_LABEL = "5-hour";
const WEEKLY_LABEL = "Weekly";
const DEFAULT_TIMEOUT_MS = 15000;
const ACCOUNT_CONCURRENCY = 4;

// Codex banked-reset credits. The list and the consume call share one endpoint; the hub substitutes
// the account's token for the literal "Bearer $TOKEN$" exactly as it does for usage.
const CREDIT_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1";
const CREDIT_RESET_TYPE = "codex_rate_limits";
const CREDIT_STATUS_AVAILABLE = "available";
// The hub's answer code -> the outcome the panel reports.
const REDEEM_OUTCOMES = {
  reset: "reset",
  nothing_to_reset: "nothingToReset",
  no_credit: "noCredit",
  already_redeemed: "alreadyRedeemed",
};
// Only these outcomes leave the account worth un-blocking in the hub's routing table.
const RESET_QUOTA_OUTCOMES = new Set(["reset", "alreadyRedeemed"]);
const RESET_QUOTA_WARNING =
  "Credit redeemed, but the hub cooldown could not be cleared. Routing may resume after its cooldown expires.";
const MISSING_CREDIT_ACCOUNT_PHRASE = "The Codex hub account is missing or disabled.";
const UNEXPECTED_CREDIT_PHRASE = "The hub returned an unexpected reset-credit response.";
const CREDITS_UNREADABLE_PHRASE = "The hub could not read this account's reset credits.";
// UUIDv5 namespace for a redeem request id. Fixed, so the same account+credit always hashes to the
// same id and a retry cannot spend a second credit.
const CREDIT_REDEEM_NAMESPACE = new Uint8Array([
  0x6f, 0x1c, 0x2a, 0x9e, 0x2d, 0x4b, 0x4c, 0x1e, 0x9a, 0x7f, 0x3b, 0x8d, 0x5e, 0x0c, 0x1a, 0x42,
]);

// A self-signed or incomplete chain is the one transport failure with a fix the person can apply.
const UNTRUSTED_CERTIFICATE_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

// Keyed by the auth-files `provider`; accounts of any other provider are skipped.
// `header()` carries the literal "Bearer $TOKEN$" that the hub replaces with that account's token.
const PROVIDER_READERS = {
  codex: {
    label: "Codex",
    url: "https://chatgpt.com/backend-api/wham/usage",
    // The credits read and the consume call send this same header object.
    header: codexHeader,
    read: (usage, file) => ({
      plan:
        usage?.plan_type ??
        file.id_token?.plan_type ??
        file.id_token?.chatgpt_plan_type,
      windows: [
        codexWindow(usage?.rate_limit?.primary_window, SESSION_KEY, SESSION_LABEL),
        codexWindow(usage?.rate_limit?.secondary_window, WEEKLY_KEY, WEEKLY_LABEL),
      ].filter(Boolean),
    }),
  },
  claude: {
    label: "Claude",
    url: CLAUDE_USAGE_URL,
    header: () => ({
      Authorization: "Bearer $TOKEN$",
      "anthropic-beta": "oauth-2025-04-20",
      // Match the management UI: cedar_ember eligibility is gated on the CLI surface/version.
      "User-Agent": "claude-cli/2.1.280 (external, cli)",
      "Content-Type": "application/json",
    }),
    read: (usage) => ({
      plan: "Claude Subscription",
      resetGrants: parseClaudeResetGrants(usage?.cedar_ember),
      windows: [
        claudeWindow(usage?.five_hour, SESSION_KEY, SESSION_LABEL),
        claudeWindow(usage?.seven_day, WEEKLY_KEY, WEEKLY_LABEL),
        ...claudeScopedWindows(usage?.limits),
      ].filter(Boolean),
    }),
  },
};

// Pasting the hub's web panel URL (…/management.html) is the common case.
export function managementBase(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? "").trim());
  } catch {
    throw new Error("The hub URL is not valid.");
  }
  parsed.pathname = parsed.pathname.replace(/(\/management\.html)?\/?$/i, "/");
  // A string base, not the URL object: the mod runtime's URL refuses an object base.
  return new URL("v0/management/", parsed.toString()).toString();
}

export function describeFailure(error, status) {
  const httpStatus =
    typeof status === "number"
      ? status
      : typeof error?.status === "number"
        ? error.status
        : undefined;
  if (httpStatus !== undefined) return `The hub answered with HTTP ${httpStatus}.`;
  const code = nodeErrorCode(error);
  if (code !== undefined && UNTRUSTED_CERTIFICATE_CODES.has(code)) {
    return `The hub's TLS certificate is not trusted (${code}). If it comes from a private CA, add that CA to NODE_EXTRA_CA_CERTS.`;
  }
  if (code !== undefined) return `The hub request failed (${code}).`;
  return "The hub management request failed.";
}

export async function fetchAccounts(input = {}) {
  const {
    url,
    managementKey,
    fetchImpl = defaultFetch,
    providers = ["codex", "claude", "ollama-usage"],
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onTimeout,
  } = input;

  const checkedAt = new Date().toISOString();

  let base;
  try {
    base = managementBase(url);
  } catch {
    return { accounts: [], error: "The hub URL is not valid.", checkedAt };
  }

  const allowed = new Set(providers);
  const options = { base, managementKey, fetchImpl, timeoutMs, onTimeout };

  let files;
  try {
    const listed = await managementRequest({ ...options, path: "auth-files" });
    if (!Array.isArray(listed?.files)) throw phraseFailure("The hub could not list accounts.");
    files = listed.files;
  } catch (error) {
    return { accounts: [], error: failureText(error), checkedAt };
  }

  const kept = files.filter(
    (file) => file && allowed.has(file.provider) && file.disabled !== true,
  );
  const accounts = await mapWithConcurrency(kept, ACCOUNT_CONCURRENCY, (file) =>
    readAccount({ ...options, file }),
  );

  return { accounts, checkedAt };
}

// Five percentage points around the even-burn tick counts as on pace.
export function paceState(leftPercent, expectedLeftPercent) {
  if (!Number.isFinite(leftPercent) || !Number.isFinite(expectedLeftPercent)) return "unknown";
  const gap = expectedLeftPercent - leftPercent;
  return Math.abs(gap) <= 5 ? "on" : gap > 0 ? "ahead" : "behind";
}

export function poolByProvider(accounts) {
  const groups = new Map();
  for (const account of accounts ?? []) {
    if (!groups.has(account.provider)) {
      groups.set(account.provider, {
        provider: account.provider,
        label: account.provider === "ollama-usage" ? "Ollama" : PROVIDER_READERS[account.provider]?.label ?? account.provider,
        accounts: [],
        sums: new Map(),
      });
    }
    const group = groups.get(account.provider);
    group.accounts.push(account);
    // ponytail: average, not weighted — swap in per-account quotas when the hub reports them.
    for (const window of account.windows ?? []) {
      if (typeof window.usedPercent !== "number") continue;
      const sum = group.sums.get(window.key) ?? {
        key: window.key,
        label: window.label,
        left: 0,
        count: 0,
      };
      sum.left += 100 - window.usedPercent;
      sum.count += 1;
      group.sums.set(window.key, sum);
    }
  }
  return [...groups.values()].map((group) => ({
    provider: group.provider,
    label: group.label,
    pool: [...group.sums.values()].map((sum) => ({
      key: sum.key,
      label: sum.label,
      leftPercent: sum.left / sum.count,
    })),
    accounts: group.accounts,
  }));
}

// Spend one banked Codex reset credit, then clear the hub cooldown so routing resumes.
// t3code's algorithm: find the account, POST the consume call with a derived redeem id, map the
// hub's code, and POST reset-quota only for an outcome that leaves the account worth resuming.
export async function consumeResetCredit(input = {}) {
  const {
    url,
    managementKey,
    accountId,
    creditId,
    fetchImpl = defaultFetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onTimeout,
  } = input;

  let base;
  try {
    base = managementBase(url);
  } catch {
    throw phraseFailure("The hub URL is not valid.");
  }
  const options = { base, managementKey, fetchImpl, timeoutMs, onTimeout };

  let listed;
  try {
    listed = await managementRequest({ ...options, path: "auth-files" });
  } catch (error) {
    throw phraseFailure(failureText(error));
  }
  const files = Array.isArray(listed?.files) ? listed.files : [];
  const file = files.find((entry) => entry && entry.id === accountId);
  if (!file || file.disabled === true || file.provider !== "codex") {
    throw phraseFailure(MISSING_CREDIT_ACCOUNT_PHRASE);
  }

  // Derived, not random: a retry of the same credit sends the same id, so the hub answers
  // "already_redeemed" instead of spending a second credit.
  const data = JSON.stringify({
    redeem_request_id: creditRedeemRequestId(
      file.id_token?.chatgpt_account_id ?? file.id,
      creditId,
    ),
    credit_id: creditId,
  });

  let answer;
  try {
    answer = await apiCall({
      ...options,
      file,
      method: "POST",
      url: `${CREDIT_URL}/consume`,
      header: codexHeader(file),
      data,
    });
  } catch (error) {
    throw phraseFailure(failureText(error));
  }
  const outcome = resetCreditOutcome(answer);

  if (RESET_QUOTA_OUTCOMES.has(outcome)) {
    try {
      await managementRequest({
        ...options,
        path: "reset-quota",
        body: { auth_index: file.auth_index },
      });
    } catch {
      // The credit is spent either way, so the outcome stands and the warning explains the rest.
      return { outcome, warning: RESET_QUOTA_WARNING };
    }
  }
  return { outcome };
}

// Claude's grants are not Codex credits: eligibility, scope, cooldown and per-grant limits
// come from cedar_ember. Reject malformed blocks rather than offering an unsafe spend.
export function parseClaudeResetGrants(raw) {
  if (!raw || typeof raw.eligible !== "boolean" || !Array.isArray(raw.grants ?? [])) return null;
  const timestamp = (v) => v == null ? null : typeof v === "string" ? Date.parse(v) : NaN;
  const cooldownUntil = timestamp(raw.cooldown_until);
  if (cooldownUntil !== null && !Number.isFinite(cooldownUntil)) return null;
  if (raw.at_limit != null && typeof raw.at_limit !== "boolean") return null;
  const grants = [];
  for (const g of raw.grants ?? []) {
    if (!g || typeof g.id !== "string" || !/^[a-z0-9_-]{1,40}$/.test(g.id) || grants.some((v) => v.id === g.id)) return null;
    if (![g.resets_total, g.resets_left].every((v) => Number.isInteger(v) && v >= 0) || g.resets_left > g.resets_total) return null;
    if (["paused", "usable_now", "use_requires_limit", "gives_back_weekly"].some((key) => g[key] != null && typeof g[key] !== "boolean")) return null;
    const startsAt = timestamp(g.starts_at), expiresAt = timestamp(g.ends_at);
    if ([startsAt, expiresAt].some((v) => v !== null && !Number.isFinite(v))) return null;
    const percentUsed = g.percent_used && typeof g.percent_used === "object" && !Array.isArray(g.percent_used)
      ? Object.values(g.percent_used) : [];
    const noUsage = g.gives_back_weekly === true && percentUsed.length > 0 && percentUsed.every((v) => v === 0);
    grants.push({
      id: g.id,
      label: /fable/i.test(String(g.label ?? "")) ? "Fable reset"
        : g.type === "full" ? "Full reset" : g.type === "session" ? "Session reset"
        : typeof g.label === "string" ? g.label.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, 120) : "Reset",
      resetsLeft: g.resets_left,
      startsAt, expiresAt,
      paused: g.paused === true,
      usableNow: g.usable_now === true,
      requiresLimit: g.use_requires_limit !== false,
      noUsage,
    });
  }
  return { eligible: raw.eligible, atLimit: raw.at_limit === true, cooldownUntil, grants };
}

export function claudeGrantBlocker(status, grant, now = Date.now()) {
  if (!status || !grant) return "Reset status unavailable";
  if (!status.eligible) return "Account not eligible";
  if (grant.resetsLeft <= 0) return "No resets left";
  if (grant.paused) return "Reset paused";
  if (grant.startsAt !== null && grant.startsAt > now) return "Not started yet";
  if (grant.expiresAt !== null && grant.expiresAt <= now) return "Reset expired";
  if (status.cooldownUntil !== null && status.cooldownUntil > now) return "Reset cooldown active";
  if (!grant.usableNow) return "Not usable right now";
  if (grant.requiresLimit && !status.atLimit) return "Available when this account reaches its limit";
  if (grant.noUsage) return "Nothing to reset right now";
  return null;
}

// No automatic retry: once a claim may have reached Anthropic, an ambiguous answer must keep
// the caller's operation journal locked. requestId identifies ONE spend, not a reusable grant.
export async function consumeClaudeResetGrant(input = {}) {
  const { url, managementKey, accountId, grantId, requestId, fetchImpl = defaultFetch,
    timeoutMs = DEFAULT_TIMEOUT_MS, onTimeout } = input;
  if (typeof grantId !== "string" || !/^[a-z0-9_-]{1,40}$/.test(grantId) ||
      typeof requestId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) {
    throw phraseFailure("The Claude reset request is not valid.");
  }
  const options = { base: managementBase(url), managementKey, fetchImpl, timeoutMs, onTimeout };
  const listed = await managementRequest({ ...options, path: "auth-files" }).catch((e) => { throw phraseFailure(failureText(e)); });
  const files = Array.isArray(listed?.files) ? listed.files : [];
  const file = files.find((v) => v?.id === accountId && v.provider === "claude" && v.disabled !== true);
  if (!file) throw phraseFailure("The Claude hub account is missing or disabled.");
  const header = { ...PROVIDER_READERS.claude.header(file), "Content-Type": "application/json" };
  let status, organization;
  try {
    const usage = parseProviderBody(await apiCall({ ...options, file, header, method: "GET", url: CLAUDE_USAGE_URL }));
    status = parseClaudeResetGrants(usage?.cedar_ember);
    const blocker = claudeGrantBlocker(status, status?.grants.find((g) => g.id === grantId));
    if (blocker) throw phraseFailure(blocker);
    const profile = parseProviderBody(await apiCall({ ...options, file, header, method: "GET", url: "https://api.anthropic.com/api/oauth/profile" }));
    organization = profile?.organization?.uuid;
    if (typeof organization !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(organization)) {
      throw phraseFailure("The hub could not read the Claude organization.");
    }
  } catch (e) { throw phraseFailure(failureText(e)); }
  let outcome;
  try {
    const body = parseProviderBody(await apiCall({
      ...options, timeoutMs: Math.max(timeoutMs, 25000), file, header, method: "POST",
      url: `https://api.anthropic.com/api/organizations/${organization}/reset_rate_limits`,
      data: JSON.stringify({ program: "cedar_ember", grant_id: grantId, request_id: requestId }),
    }));
    outcome = body?.result;
    if (!["reset", "already_used", "not_limited", "cooldown", "ineligible", "unavailable"].includes(outcome)) throw new Error();
  } catch {
    return { outcome: "unknown", warning: "Claude reset outcome unknown. Check the hub before attempting another reset." };
  }
  if (outcome === "reset" || outcome === "already_used") {
    try { await managementRequest({ ...options, path: "reset-quota", body: { auth_index: file.auth_index } }); }
    catch { return { outcome, warning: RESET_QUOTA_WARNING }; }
  }
  return { outcome };
}

export function creditRedeemRequestId(accountKey, creditId) {
  const name = `${accountKey ?? ""}:${creditId ?? ""}`;
  const digest = sha1Digest(concatBytes(CREDIT_REDEEM_NAMESPACE, utf8Bytes(name)));
  // RFC 4122: version 5 in the high nibble of byte 6, variant 10xx in byte 8.
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = toHex(digest);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// Exposed only so the test can pin SHA-1 against its published known answers.
export function sha1Hex(text) {
  return toHex(sha1Digest(utf8Bytes(String(text ?? ""))));
}

// SHA-1 by hand: this module may not import node:crypto, and a redeem id has to be reproducible.
function sha1Digest(bytes) {
  const padded = new Uint8Array((bytes.length + 9 + 63) & ~63);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = bytes.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const words = new Uint32Array(80);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 80; index += 1) {
      const mixed = words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16];
      words[index] = (mixed << 1) | (mixed >>> 31);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let index = 0; index < 80; index += 1) {
      let f;
      let k;
      if (index < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (index < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (index < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const next = (((a << 5) | (a >>> 27)) + f + e + k + words[index]) >>> 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = next;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const digest = new Uint8Array(20);
  const out = new DataView(digest.buffer);
  out.setUint32(0, h0);
  out.setUint32(4, h1);
  out.setUint32(8, h2);
  out.setUint32(12, h3);
  out.setUint32(16, h4);
  return digest;
}

function concatBytes(left, right) {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);
  return joined;
}

function utf8Bytes(text) {
  const bytes = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.codePointAt(index);
    if (code > 0xffff) index += 1;
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

function toHex(bytes) {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

// Wrapping keeps `globalThis` as the receiver: a host fetch taken off the global can refuse an
// unbound call.
function defaultFetch(...args) {
  return globalThis.fetch(...args);
}

// One management call. The deadline covers the whole round trip (fetch, status, body), because
// the runtime's fetch has no timeout option; `onTimeout(cb, timeoutMs)` registers `cb` on the
// mod's timer. A timer that fires after the call settled rejects a settled race and does nothing.
async function managementRequest({
  base,
  path,
  managementKey,
  fetchImpl,
  timeoutMs,
  onTimeout,
  body,
}) {
  const init = {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${managementKey}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  const requestUrl = new URL(path, base).toString();

  const work = (async () => {
    const response = await fetchImpl(requestUrl, init);
    if (!response || typeof response.status !== "number") {
      throw phraseFailure("The hub's answer was not readable.");
    }
    if (response.status < 200 || response.status >= 300) {
      throw Object.assign(new Error("The hub refused the request."), {
        status: response.status,
      });
    }
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw phraseFailure("The hub's answer was not readable.");
    }
  })();

  return withTimeout(work, timeoutMs, onTimeout);
}

function withTimeout(pending, timeoutMs, onTimeout) {
  if (typeof onTimeout !== "function") return pending;
  const expired = new Promise((_, reject) => {
    onTimeout(
      () =>
        reject(
          phraseFailure(`The hub did not answer within ${Math.round(timeoutMs / 1000)} seconds.`),
        ),
      timeoutMs,
    );
  });
  return Promise.race([pending, expired]);
}

async function readAccount({ file, base, managementKey, fetchImpl, timeoutMs, onTimeout }) {
  const identity = {
    id: file.id,
    provider: file.provider,
    ...(file.email ? { email: file.email } : {}),
    disabled: file.disabled === true,
  };
  const provider = PROVIDER_READERS[file.provider];
  const options = { base, managementKey, fetchImpl, timeoutMs, onTimeout };
  if (file.provider === "ollama-usage") {
    try {
      if (typeof file.auth_index !== "string" || !file.auth_index.trim()) {
        throw phraseFailure("The Ollama monitor has no credential index.");
      }
      const payload = await managementRequest({
        ...options,
        timeoutMs: Math.max(timeoutMs, 25000),
        path: "quota/fetch",
        body: { auth_index: file.auth_index, plugin_id: "ollama-usage" },
      });
      return { ...identity, label: file.label || file.name || file.id, ...readOllamaQuota(payload) };
    } catch (error) {
      return { ...identity, windows: [], error: failureText(error) };
    }
  }
  // A missing credits read never fails the row: a hub without the endpoint, or an answer that is
  // not a credits list, simply omits `resetCredits`.
  const resetCredits =
    file.provider === "codex"
      ? await readResetCredits({ ...options, file }).catch(() => null)
      : null;
  const known = { ...identity, ...(resetCredits ? { resetCredits } : {}) };
  try {
    const body = await apiCall({
      ...options,
      file,
      method: "GET",
      url: provider.url,
      header: provider.header(file),
    });
    const usage = parseProviderBody(body);
    const read = provider.read(usage, file);
    return {
      ...known,
      ...(read.plan ? { plan: read.plan } : {}),
      windows: read.windows,
      ...(file.provider === "claude" ? { resetGrants: read.resetGrants } : {}),
    };
  } catch (error) {
    // One unreadable account keeps its own "probe failed" row; the other accounts still report.
    return { ...known, windows: [], error: failureText(error) };
  }
}

// Only known numeric metrics leave the plugin boundary: never render arbitrary response text.
const OLLAMA_METRICS = {
  included_balance_usd: ["Included balance", true],
  included_allowance_usd: ["Period allowance", true],
  purchased_balance_usd: ["Purchased balance", true],
  usage_usd_24h: ["Spend · 24h", true],
  request_count_24h: ["Requests · 24h", false],
  input_tokens_24h: ["Input tokens · 24h", false],
  cached_input_tokens_24h: ["Cached input tokens · 24h", false],
  output_tokens_24h: ["Output tokens · 24h", false],
};

function readOllamaQuota(payload) {
  const fail = () => { throw phraseFailure("The Ollama plugin returned an unreadable quota response."); };
  if (!Array.isArray(payload?.groups) || !Array.isArray(payload?.summary)) return fail();
  const windows = [];
  const names = { "5h": ["session", SESSION_LABEL], "7d": ["weekly", WEEKLY_LABEL], "Billing period": ["billing", "Billing period"] };
  for (const group of payload.groups) {
    if (!Array.isArray(group?.buckets)) return fail();
    for (const bucket of group.buckets) {
      const name = names[bucket?.window];
      if (!Array.isArray(name)) continue;
      const fraction = bucket.remainingFraction;
      const reset = bucket.resetTime == null || bucket.resetTime === "" ? null : Date.parse(bucket.resetTime);
      if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1 ||
          (reset !== null && !Number.isFinite(reset)) || windows.some((w) => w.key === name[0])) return fail();
      windows.push({ key: name[0], label: name[1], usedPercent: (1 - fraction) * 100, resetsAt: reset });
    }
  }
  const summary = [];
  for (const metric of payload.summary) {
    const known = OLLAMA_METRICS[metric?.key];
    if (!Array.isArray(known)) continue;
    if (!Number.isFinite(metric.value) || summary.some((m) => m.key === metric.key) ||
        (known[1] && metric.currency !== "USD") ||
        (!known[1] && (metric.value < 0 || !Number.isInteger(metric.value)))) return fail();
    summary.push({ key: metric.key, label: known[0], value: metric.value, currency: known[1] ? "USD" : null });
  }
  if (!windows.length && !summary.length) return fail();
  return { plan: "Ollama Cloud", windows, summary };
}

// One provider call through the hub. `header` carries the literal "Bearer $TOKEN$" the hub
// replaces with that account's token; `data` is the JSON *string* the real hub expects on a POST.
async function apiCall({ file, method, url, header, data, ...options }) {
  const call = await managementRequest({
    ...options,
    path: "api-call",
    body: {
      auth_index: file.auth_index,
      method,
      url,
      header,
      ...(data === undefined ? {} : { data }),
    },
  });
  if (!call || typeof call.status_code !== "number" || typeof call.body !== "string") {
    throw phraseFailure("The hub could not read this account's usage.");
  }
  if (call.status_code < 200 || call.status_code >= 300) {
    throw phraseFailure(`The provider refused the hub request (HTTP ${call.status_code}).`);
  }
  return call.body;
}

async function readResetCredits({ file, ...options }) {
  const body = await apiCall({
    ...options,
    file,
    method: "GET",
    url: CREDIT_URL,
    header: codexHeader(file),
  });
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw phraseFailure(CREDITS_UNREADABLE_PHRASE);
  }
  if (!Array.isArray(payload?.credits)) throw phraseFailure(CREDITS_UNREADABLE_PHRASE);
  return resetCreditsFrom(payload.credits);
}

// Only resets that can actually be spent now: the codex bucket, still available, not expired.
function resetCreditsFrom(rawCredits) {
  const now = Date.now();
  const credits = rawCredits
    .filter(
      (credit) =>
        credit &&
        credit.reset_type === CREDIT_RESET_TYPE &&
        credit.status === CREDIT_STATUS_AVAILABLE,
    )
    .map((credit) => ({
      id: credit.id,
      expiresAt: typeof credit.expires_at === "string" ? Date.parse(credit.expires_at) : NaN,
    }))
    .filter(
      (credit) =>
        typeof credit.id === "string" &&
        credit.id !== "" &&
        Number.isFinite(credit.expiresAt) &&
        credit.expiresAt > now,
    )
    .sort((left, right) => left.expiresAt - right.expiresAt);
  const soonest = credits.length > 0 ? credits[0] : null;
  return {
    availableCount: credits.length,
    credits,
    nextCreditId: soonest ? soonest.id : null,
    nextExpiresAt: soonest ? soonest.expiresAt : null,
  };
}

function resetCreditOutcome(body) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw phraseFailure(UNEXPECTED_CREDIT_PHRASE);
  }
  const code = payload?.code;
  const outcome = typeof code === "string" ? REDEEM_OUTCOMES[code] : undefined;
  if (typeof outcome !== "string") throw phraseFailure(UNEXPECTED_CREDIT_PHRASE);
  return outcome;
}

function codexHeader(file) {
  return {
    Authorization: "Bearer $TOKEN$",
    "Content-Type": "application/json",
    "OpenAI-Beta": "codex-1",
    Originator: "Codex Desktop",
    ...(file.id_token?.chatgpt_account_id
      ? { "Chatgpt-Account-Id": file.id_token.chatgpt_account_id }
      : {}),
  };
}

function parseProviderBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw phraseFailure("The hub could not read this account's usage.");
  }
}

function codexWindow(raw, key, fallbackLabel) {
  if (!raw || typeof raw !== "object") return null;
  return {
    key,
    label: durationLabel(raw.limit_window_seconds, fallbackLabel),
    usedPercent: typeof raw.used_percent === "number" ? raw.used_percent : null,
    resetsAt: typeof raw.reset_at === "number" ? raw.reset_at * 1000 : null,
  };
}

// Model-scoped weekly limits ("Weekly · Fable"): `limits[]` entries of kind weekly_scoped.
// `percent` is the used share, like `utilization` on the two plain windows.
function claudeScopedWindows(limits) {
  if (!Array.isArray(limits)) return [];
  return limits.flatMap((limit) => {
    const name = limit?.scope?.model?.display_name;
    if (limit?.kind !== "weekly_scoped" || typeof name !== "string" || typeof limit.percent !== "number") return [];
    const resetsAt = typeof limit.resets_at === "string" ? Date.parse(limit.resets_at) : NaN;
    return [
      {
        key: `${WEEKLY_KEY}_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
        label: `${WEEKLY_LABEL} · ${name}`,
        usedPercent: limit.percent,
        resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
      },
    ];
  });
}

function claudeWindow(raw, key, label) {
  if (!raw || typeof raw !== "object") return null;
  const resetsAt = typeof raw.resets_at === "string" ? Date.parse(raw.resets_at) : NaN;
  return {
    key,
    label,
    usedPercent: typeof raw.utilization === "number" ? raw.utilization : null,
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
  };
}

function durationLabel(seconds, fallback) {
  if (typeof seconds !== "number" || !(seconds > 0)) return fallback;
  if (seconds >= 86400) {
    const days = Math.round(seconds / 86400);
    return days === 7 ? WEEKLY_LABEL : `${days}-day`;
  }
  return `${Math.max(1, Math.round(seconds / 3600))}-hour`;
}

async function mapWithConcurrency(items, limit, run) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

// A phrase is the whole message: it is written here, never built from a response.
function phraseFailure(phrase) {
  return Object.assign(new Error(phrase), { phrase });
}

function failureText(error) {
  if (typeof error?.phrase === "string") return error.phrase;
  return describeFailure(error, error?.status);
}

// fetch wraps a transport failure in a generic TypeError and keeps the code on the cause.
function nodeErrorCode(error) {
  for (let current = error, depth = 0; current !== null && current !== undefined && depth < 3; depth += 1) {
    const code = current.code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
    current = current.cause;
  }
  return undefined;
}
