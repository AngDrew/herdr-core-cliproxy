// CLIProxyAPI usage panel: one mod, two copies.
//
// The docked copy (no props) shows the hub's pooled quota, refreshed every 15 minutes and on the
// Refresh button. The settings dialog is the same mod opened with props().settings === true, so
// the fields, the file and the error wording all live in this one file.
//
// All hub reading is ./hub.js's job; this file only turns its result into elements and writes
// config.json. The management key is masked in the form, written only to config.json, and never
// logged or put in an error string: a fixed phrase carries every failure instead.
import { randomUUID } from "crypto";
import { View, div } from "gpui-kit";
import { h_flex, v_flex, Input, InputState } from "gpui-base";
import { appHome, closeOverlay, nextCommand, openOverlay, props, readTextFile, run, theme, writeTextFile } from "herdr";
import { claudeGrantBlocker, consumeClaudeResetGrant, consumeResetCredit, fetchAccounts, paceState, poolByProvider } from "./hub.js";

const MOD = "cliproxy-usage";
const CONFIG_FILE = "config.json";
// 15 minutes (plan A2) is the whole cadence: reset countdowns are read at paint time, so nothing
// here needs a repainting clock.
const REFRESH_MS = 900000;
const TIMEOUT_MS = 15000;

// Fixed outcome sentences; a hub body never becomes UI text.
const OUTCOME_TEXT = {
  reset: "Reset applied.",
  alreadyRedeemed: "That credit was already redeemed.",
  nothingToReset: "Nothing to reset right now.",
  noCredit: "No credit available on this account.",
  already_used: "That reset was already used.",
  not_limited: "Nothing to reset right now.",
  cooldown: "Claude reset cooldown is active.",
  ineligible: "This account is not eligible for that reset.",
  unavailable: "That Claude reset is unavailable.",
  unknown: "Claude reset outcome unknown. Check the hub before attempting another reset.",
};

// The mod's own folder, which the app makes and the person owns. `appHome()` is a host call, so
// this stays a function rather than a module-level constant.
function configPath() {
  const home = appHome();
  const separator = home.includes("\\") ? "\\" : "/";
  return [home, "mods", MOD, CONFIG_FILE].join(separator);
}

// A missing config.json is a first run, not a failure, and the runtime may report one either way:
// a null read or a rejected read. Both mean "no text yet", so neither can become a `problem`.
async function readConfigText(path) {
  try {
    const text = await readTextFile(path);
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  }
}

// `problem` is set only when the file exists and cannot be used, so the panel can tell that apart
// from a first run.
async function readConfig() {
  const text = await readConfigText(configPath());
  if (text === null) return { config: null, problem: null };
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  const url = typeof data?.url === "string" ? data.url.trim() : "";
  const managementKey = typeof data?.managementKey === "string" ? data.managementKey.trim() : "";
  if (!url || !managementKey) {
    return { config: null, problem: "The config file has no hub URL or management key." };
  }
  const label = typeof data.label === "string" && data.label.trim() ? data.label.trim() : null;
  return { config: { url, managementKey, label }, problem: null };
}

function closeSelf() {
  const overlay = props()?.overlay;
  if (overlay) closeOverlay(overlay);
}

function openSettings() {
  openOverlay({ mod: MOD, props: { settings: true }, kind: "dialog", width: 460, height: 320 });
}

const pad = (value) => String(value).padStart(2, "0");

function hostOf(url) {
  try {
    return new URL(String(url)).host || null;
  } catch {
    return null;
  }
}

function clockOf(iso) {
  const when = new Date(iso ?? NaN);
  return Number.isNaN(when.getTime()) ? null : `${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

// `resetsAt` is epoch milliseconds (hub.js normalises both providers), so this is a plain
// subtraction against the paint's own clock.
function countdown(resetsAt) {
  if (typeof resetsAt !== "number") return null;
  const left = resetsAt - Date.now();
  if (left <= 0) return "resetting";
  const minutes = Math.round(left / 60000);
  if (minutes < 60) return `in ${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `in ${hours}h ${minutes % 60}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export default class CliproxyUsage extends View {
  init(_props, cx) {
    this.config = null;
    this.problem = null;
    this.error = null;
    this.checkedAt = null;
    this.groups = [];
    this.busy = false;
    // The last reset outcome, and the account/credit a confirmation is armed for. Nothing is spent
    // until a "reset" command arrives, which only the confirm dialog sends.
    this.notice = null;
    this.pendingReset = null;
    this.resetBusy = false;
    // Until config.json has been read once, "no hub yet" would be a guess, so the panel says it is
    // still reading instead.
    this.ready = false;
    if (props()?.settings === true) {
      this.settingsInit(cx);
      return;
    }
    this.refreshNow(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refreshNow(cx));
    // The dialog is another copy. Saving it sends "refresh" here, so the panel shows the new hub
    // without waiting for the next tick; the tick would pick the file up anyway.
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          const command = await nextCommand();
          if (command === "reset") this.spendReset(cx);
          else this.refreshNow(cx);
        }
      } catch {
        // This copy closed, or its build was replaced: the loop is over.
      }
    });
  }

  settingsInit(cx) {
    this.formError = null;
    this.saving = false;
    this.focused = "";
    this.handle = cx.focus_handle();
    this.urlInput = InputState.new({ placeholder: "https://hub.example.com/" });
    this.keyInput = InputState.new({ placeholder: "management key" });
    // The key is only ever on screen as dots.
    this.keyInput.set_masked(true);
    this.labelInput = InputState.new({ placeholder: "defaults to the hub's host" });
    const inputs = [["url", this.urlInput], ["key", this.keyInput], ["label", this.labelInput]];
    for (const [name, input] of inputs) {
      input.on("focus", (_event, cx) => {
        this.focused = name;
        cx.notify();
      });
      input.on("blur", (_event, cx) => {
        if (this.focused !== name) return;
        this.focused = "";
        cx.notify();
      });
      input.on("submit", (_event, cx) => this.save(cx));
    }
    this.urlInput.focus();
    this.fillForm(cx);
  }

  // Opening Settings again starts from the saved hub, so a typo is a fix, not a retype.
  fillForm(cx) {
    cx.spawn(async (cx) => {
      try {
        const { config } = await readConfig();
        if (config) {
          this.urlInput.set_value(config.url);
          this.keyInput.set_value(config.managementKey);
          this.labelInput.set_value(config.label ?? "");
        }
        cx.notify();
      } catch {
        // The copy closed while the file was read: nothing left to fill in.
      }
    });
  }

  // Manual and timed refreshes share one in-flight guard: a click during a poll adds nothing.
  refreshNow(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => this.runRefresh(cx));
  }

  async runRefresh(cx) {
    try {
      const { config, problem } = await readConfig();
      this.problem = problem;
      this.ready = true;
      if (!config) {
        this.config = null;
        this.groups = [];
        this.error = null;
        return;
      }
      this.config = config;
      // The deadline is the mod's own timer, because the runtime's fetch has none.
      const result = await fetchAccounts({
        url: config.url,
        managementKey: config.managementKey,
        timeoutMs: TIMEOUT_MS,
        onTimeout: (callback, ms) => cx.timer.after(ms, callback),
      });
      this.groups = poolByProvider(result.accounts);
      this.error = result.error ?? null;
      this.checkedAt = result.checkedAt ?? null;
    } catch {
      this.error = "The usage panel could not read the hub.";
    } finally {
      this.busy = false;
      cx.notify();
    }
  }

  save(cx) {
    if (this.saving) return;
    const url = this.urlInput.value().trim();
    const managementKey = this.keyInput.value().trim();
    const label = this.labelInput.value().trim();
    if (!url || !managementKey) {
      this.formError = "A hub URL and a management key are both needed.";
      cx.notify();
      return;
    }
    this.formError = null;
    this.saving = true;
    cx.spawn(async (cx) => {
      try {
        const text = `${JSON.stringify({ url, managementKey, ...(label ? { label } : {}) }, null, 2)}\n`;
        const path = configPath();
        // `expected` is the exact text the file must still hold, and null means "create it": a first
        // save, or a read that failed, passes null instead of aborting the save.
        await writeTextFile(path, text, await readConfigText(path));
      } catch {
        this.formError = "The config file could not be saved.";
        this.saving = false;
        cx.notify();
        return;
      }
      this.saving = false;
      // Ask the panel copy to refresh now; without it the next 15-minute tick reads the file anyway.
      try {
        run(`${MOD}.refresh`);
      } catch {
        // No panel copy listening: the tick covers it.
      }
      closeSelf();
    });
  }

  // A click only arms the choice and asks; the confirm dialog's command is what spends.
  useReset(account, grant = null) {
    if (this.resetBusy || !this.config) return;
    const credits = account.resetCredits;
    if (grant ? claudeGrantBlocker(account.resetGrants, grant) : !credits?.nextCreditId) return;
    const email = account.email ?? account.id ?? "this account";
    this.pendingReset = {
      accountId: account.id, creditId: credits?.nextCreditId, grantId: grant?.id,
      provider: account.provider, config: this.config,
    };
    const count = grant
      ? `${grant.resetsLeft} ${grant.label || "Claude"} reset${grant.resetsLeft === 1 ? "" : "s"}`
      : `${credits.availableCount} banked Codex reset credit${credits.availableCount === 1 ? "" : "s"}`;
    openOverlay({
      mod: "confirm",
      props: {
        title: "Spend a reset credit?",
        detail: `This spends one of the ${count} on ${email}. It resets that account's current window at the provider and cannot be undone.`,
        command: { name: `${MOD}.reset` },
      },
      kind: "dialog",
      width: 460,
      height: 220,
    });
  }

  spendReset(cx) {
    const pending = this.pendingReset;
    this.pendingReset = null;
    if (!pending || this.resetBusy || !this.config || pending.config.url !== this.config.url ||
        pending.config.managementKey !== this.config.managementKey) return;
    this.resetBusy = true;
    cx.spawn(async (cx) => {
      this.notice = { text: "Spending a reset…", tone: "muted" };
      cx.notify();
      let text, journal;
      let tone = "done", uncertain = false;
      const journalPath = configPath().replace(/config\.json$/, "reset-operation.json");
      try {
        const options = {
          ...pending.config, accountId: pending.accountId, creditId: pending.creditId,
          grantId: pending.grantId, timeoutMs: TIMEOUT_MS,
          onTimeout: (callback, ms) => cx.timer.after(ms, callback),
        };
        if (pending.provider === "claude") {
          // ponytail: one durable Claude lock across accounts; per-account journals if needed.
          // An ambiguous POST stays locked even across reloads. Never automatically retry it.
          const previous = await readConfigText(journalPath);
          if (previous !== null && previous.trim() !== "{}") {
            throw new Error("A previous Claude reset is unresolved. Check the hub; clear reset-operation.json only after confirming its outcome.");
          }
          options.requestId = randomUUID();
          const record = JSON.stringify({ accountId: pending.accountId, grantId: pending.grantId, requestId: options.requestId });
          await writeTextFile(journalPath, record, previous);
          journal = record;
        }
        const result = await (pending.provider === "claude" ? consumeClaudeResetGrant(options) : consumeResetCredit(options));
        uncertain = result.outcome === "unknown";
        text = OUTCOME_TEXT[result.outcome] ?? "The reset did not go through.";
        if (result.warning && !uncertain) text = `${text} ${result.warning}`;
        if (result.outcome !== "reset" || result.warning) tone = "blocked";
      } catch (error) {
        text = error?.message || "The reset did not go through.";
        tone = "blocked";
      } finally {
        if (journal && !uncertain) {
          try { await writeTextFile(journalPath, "{}\n", journal); }
          catch { text = `${text} The reset journal could not be cleared; check the hub before trying again.`; tone = "blocked"; }
        }
        this.resetBusy = false;
        this.notice = { text, tone };
        this.refreshNow(cx);
        cx.notify();
      }
    });
  }

  render() {
    const t = theme();
    return props()?.settings === true ? this.settingsRender(t) : this.panel(t);
  }

  hubLabel() {
    if (!this.config) return "Usage";
    return this.config.label ?? hostOf(this.config.url) ?? "CLIProxyAPI hub";
  }

  button(t, id, text, primary, action) {
    return h_flex().id(id).h(24).px(8).flex_none().items_center().justify_center().rounded(6).border_1()
      .border_color(primary ? t.solid : t.border).bg(primary ? t.solid : t.background)
      .text_color(primary ? t.solid_foreground : t.muted).text_size(11).font_medium()
      .cursor_pointer().hover((style) => primary ? style.opacity(0.88) : style.bg(t.hover).text_color(t.foreground))
      .on_click(action).child(text);
  }

  panel(t) {
    const checked = this.busy
      ? "checking…"
      : this.checkedAt
        ? `checked ${clockOf(this.checkedAt) ?? "—"}`
        : "not checked yet";
    let body = v_flex().id("cpu-content").flex_1().min_h(0).gap(10).px(12).pb(12).overflow_y_scrollbar();
    if (!this.config) {
      if (!this.ready) {
        body = body.child(div().text_size(11.5).text_color(t.dim).child("Reading the hub settings…"));
      } else {
        body = body
          .child(
            div().text_size(11.5).text_color(this.problem ? t.blocked : t.muted).child(
              this.problem ?? "No hub yet. Add your CLIProxyAPI hub URL and management key to see pooled quota.",
            ),
          )
          .child(this.button(t, "cpu-setup", "Set up", true, () => openSettings()));
      }
    } else {
      if (this.error) body = body.child(div().text_size(11.5).text_color(t.blocked).child(this.error));
      if (!this.groups.length && !this.error && !this.busy) {
        body = body.child(div().text_size(11.5).text_color(t.dim).child("No Codex, Claude, Ollama or Token Plan monitor accounts on this hub yet."));
      }
      for (const [index, group] of this.groups.entries()) {
        if (index > 0) body = body.child(div().h(1).w_full().flex_none().my(6).bg(t.border));
        body = body.child(this.card(t, group));
      }
    }
    // Match the native Files/Changes frame, including the clipped radius and 42 px header.
    return v_flex().id("cliproxy-usage").size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(
        h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
          .child(div().flex_1().font_semibold().child("Usage"))
          .child(this.button(t, "cpu-refresh", this.busy ? "Checking…" : "Refresh", false, (_event, cx) => this.refreshNow(cx)))
          .child(this.button(t, "cpu-settings", "Settings", false, () => openSettings())),
      )
      .child(
        h_flex().flex_none().px(14).py(10).gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).tooltip(this.hubLabel())
            .child(this.config ? this.hubLabel() : "CLIProxyAPI hub"))
          .child(div().flex_none().text_size(10.5).text_color(t.dim).child(checked)),
      )
      .when(Boolean(this.notice), (el) =>
        el.child(
          h_flex().flex_none().px(12).pb(8).child(
            div().text_size(10.5)
              .text_color(this.notice?.tone === "blocked" ? t.blocked : this.notice?.tone === "done" ? t.done : t.muted)
              .child(this.notice?.text ?? ""),
          ),
        ),
      )
      .child(body);
  }

  card(t, group) {
    const many = group.accounts.length > 1;
    let card = v_flex().gap(6)
      .child(
        h_flex().gap(6).px(2).pt(4)
          .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(t.foreground).child(group.label))
          .child(div().flex_none().text_size(10.5).text_color(t.dim).child(`${group.accounts.length} account${many ? "s" : ""}`)),
      );
    for (const pooled of group.pool) card = card.child(this.pool(t, group, pooled));
    for (const account of group.accounts) {
      if (account.summary?.length) card = card.child(this.summary(t, account, many));
      card = card.child(this.resets(t, account, many));
    }
    return card;
  }

  summary(t, account, many) {
    let rows = v_flex().gap(4).px(2);
    if (many) rows = rows.child(div().text_size(10.5).text_color(t.dim).child(account.label || account.id));
    for (const metric of account.summary ?? []) {
      const value = metric.currency === "USD"
        ? `USD ${metric.value.toFixed(Math.abs(metric.value) < 1 && metric.value !== 0 ? 5 : 2)}`
        : metric.value.toFixed(0);
      rows = rows.child(h_flex().gap(6)
        .child(div().flex_1().text_size(10.5).text_color(t.muted).child(metric.label))
        .child(div().text_size(11).text_color(t.foreground).child(value)));
    }
    return rows;
  }

  // One row per pooled window, like t3code's Limits: the big number, a bar whose fill is what is
  // left, a contrasting tick where an even burn rate would be by now, and a chip with the reset
  // countdown.
  pool(t, group, pooled) {
    const left = Math.max(0, Math.min(100, Math.round(pooled.leftPercent)));
    const fill = left <= 15 ? t.blocked : left <= 40 ? t.working : t.accent;
    const windows = group.accounts.flatMap((a) => a.windows ?? []).filter((w) => w.key === pooled.key);
    const resetsAt = Math.min(...windows.map((w) => w.resetsAt).filter((v) => typeof v === "number"));
    const span = pooled.key === "session" ? 5 * 3600000 : pooled.key === "weekly" || pooled.key.startsWith("weekly_") ? 7 * 86400000 : null;
    // ponytail: fixed session/weekly spans; billing periods have no pace tick until their actual length is available.
    const pace = Number.isFinite(resetsAt) && span !== null ? Math.max(0, Math.min(100, ((resetsAt - Date.now()) / span) * 100)) : null;
    const chipText = Number.isFinite(resetsAt) ? `↻ ${(countdown(resetsAt) ?? "").replace(/^in /, "")}` : "";
    const label = pooled.key === "session" ? "Session" : pooled.label;
    const trend = {
      on: { glyph: "→", color: t.dim, tip: "On pace: spending about as fast as the window elapses" },
      ahead: { glyph: "↗", color: t.working, tip: "Ahead of pace: spending faster than the window elapses" },
      behind: { glyph: "↘", color: t.done, tip: "Behind pace: spending slower than the window elapses" },
      unknown: { glyph: "—", color: t.dim, tip: "Pace unavailable: no reset time or window duration reported" },
    }[paceState(left, pace)];
    // Slim 8 px track; the pace tick is taller than the track and uses the warm "working" color
    // (foreground when the fill itself is that color) so it never blends into the fill.
    const tick = fill === t.working ? t.foreground : t.working;
    let bar = div().relative().w_full().h(14)
      .child(
        div().absolute().left(0).top(3).w_full().h(8).rounded(4).bg(t.surface).overflow_hidden()
          .child(div().absolute().left(0).top(0).h(8).w(`${left}%`).bg(fill)),
      );
    if (pace !== null) bar = bar.child(div().absolute().top(0).left(`${pace}%`).w(3).h(14).rounded(1).bg(tick));
    return h_flex().gap(10).items_center().px(8).py(6).rounded(8).border_1().border_color(t.border).bg(t.raised)
      .child(
        h_flex().w(88).flex_none().gap(3).items_end()
          .child(div().text_size(20).font_semibold().text_color(t.foreground).child(`${left}%`))
          .child(div().pb(2).text_size(9.5).text_color(t.dim).child("left"))
          .child(div().pb(1).text_size(11).text_color(trend.color).tooltip(trend.tip).child(trend.glyph)),
      )
      .child(
        v_flex().flex_1().min_w(0).gap(1)
          .child(bar)
          .child(
            h_flex().gap(6).items_center()
              .child(div().flex_1().min_w(0).truncate().text_size(10.5).font_medium().text_color(t.foreground).child(label))
              .child(div().flex_none().text_size(10).text_color(t.muted).child(chipText)),
          ),
      );
  }

  resets(t, account, many) {
    let row = v_flex().gap(4).px(2);
    const identity = account.email ?? account.id;
    if (account.error) return row.child(div().text_size(10.5).text_color(t.blocked).tooltip(identity).child(account.error));
    const add = (label, id, blocker, action) => {
      row = row.child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).text_size(11).text_color(t.muted)
          .tooltip(many ? identity : label).child(label))
        .child(blocker
          ? div().text_size(10).text_color(t.dim).tooltip(blocker).child("Unavailable")
          : this.button(t, id, "Use reset", false, action).tooltip(identity)));
    };
    const credits = account.resetCredits;
    if (credits?.availableCount > 0 && credits.nextCreditId) {
      const when = countdown(credits.nextExpiresAt);
      add(`${credits.availableCount} banked${when ? ` · expires ${when}` : ""}`,
        `cpu-reset-${account.id}`, this.resetBusy ? "A reset is in progress" : null, () => this.useReset(account));
    }
    if (account.provider === "claude") {
      const grants = account.resetGrants?.grants.filter((g) => g.resetsLeft > 0 && (g.expiresAt === null || g.expiresAt > Date.now()));
      if (!grants?.length) row = row.child(div().text_size(10.5).text_color(t.dim).tooltip(identity)
        .child(account.resetGrants ? "No banked Claude resets" : "Claude reset grants unavailable"));
      for (const grant of grants ?? []) {
        const when = countdown(grant.expiresAt);
        add(`${grant.label || "Reset"} · ${grant.resetsLeft} left${when ? ` · expires ${when}` : ""}`,
          `cpu-reset-${account.id}-${grant.id}`, this.resetBusy ? "A reset is in progress" : claudeGrantBlocker(account.resetGrants, grant),
          () => this.useReset(account, grant));
      }
    }
    return row;
  }

  settingsRender(t) {
    const label = (text) => div().pt(14).pb(6).flex_none().text_size(11.5).text_color(t.dim).child(text);
    const field = (input, name) => Input.new(input).h(34).flex_none().px(10).rounded(9).border_1()
      .border_color(this.focused === name ? t.accent : t.input).bg(t.background)
      .text_size(12.5).text_color(t.foreground);
    return v_flex().id("cpu-settings").w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .track_focus(this.handle)
      .on_key_down((event, cx) => {
        if (event.key !== "escape") return;
        closeSelf();
        cx.stop_propagation();
      })
      .child(
        h_flex().flex_none()
          .child(div().flex_1().text_size(15).font_semibold().child("CLIProxyAPI hub"))
          .child(div().text_size(11).text_color(t.dim).child("Esc")),
      )
      .child(label("Hub URL"))
      .child(field(this.urlInput, "url"))
      .child(label("Management key"))
      .child(field(this.keyInput, "key"))
      .child(label("Label (optional)"))
      .child(field(this.labelInput, "label"))
      .when(Boolean(this.formError), (el) => el.child(div().pt(10).flex_none().text_size(11.5).text_color(t.blocked).child(this.formError)))
      .child(
        h_flex().pt(18).flex_none().gap(8).justify_end()
          .child(this.button(t, "cpu-cancel", "Cancel", false, () => closeSelf()))
          .child(this.button(t, "cpu-save", this.saving ? "Saving…" : "Save", true, (_event, cx) => this.save(cx))),
      );
  }
}
