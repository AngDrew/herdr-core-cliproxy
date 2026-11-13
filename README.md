# herdr-core-cliproxy

A [herdr-app](https://herdr.dev) mod that shows your [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) hub quota in a side panel, modelled on t3code's *Usage → Limits*.

![panel](screenshot.png)

- Codex + Claude pooled quota (Session, Weekly, Weekly · Fable) with an even-pace tick, a reset countdown and a pace arrow (↗ ahead of pace, → on pace, ↘ behind pace; hover for the explanation).
- Codex reset credits and Claude Fable/full reset grants: count, expiry, and **Use reset** (always behind a confirm dialog).
- Gauge-only subscription sections with dividers; no repeated account/plan/percentage rows.
- Refreshes every 15 minutes; Refresh button for manual.

## Install
1. Copy `cliproxy-usage/` to `~/.config/herdr-app/mods/cliproxy-usage/`.
2. Add a right column to `~/.config/herdr-app/layouts/main.json`:
   `{"id":"usage","size":{"px":320},"min":220,"max":600}` containing `{"mod":"cliproxy-usage"}`.
3. Click **Set up** in the panel and enter your hub URL and management key.

The key is stored only in the mod's `config.json` (gitignored). It needs a hub with `v0/management/api-call`.

## Dev
`node dev/hub.test.js`, `node dev/claude-reset.test.js`, and `node dev/panel.test.js` are network-free. `node dev/stub-hub.mjs` serves fixtures on `:8318` (key `stub`).

## Claude reset safety
Claude grants use Anthropic\'s `cedar_ember` API via the hub, following the [CLIProxyAPI management UI](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/main/src/services/api/claudeResetGrants.ts). The CLI user-agent matters: an older/different surface can make eligible grants appear unavailable.

Before redeeming, the mod checks fresh eligibility, expiry, cooldown, and usability. It journals each Claude attempt in local `reset-operation.json` (gitignored). If a claim times out or returns an ambiguous answer, **it is not automatically retried** and further Claude resets stay blocked across reloads. Check the provider/hub first; clear the journal only after confirming the outcome. No actual credit is spent during polling or tests.
