# herdr-core-cliproxy

A [herdr-app](https://herdr.dev) mod that shows your [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) hub quota in a side panel, modelled on t3code's *Usage → Limits*.

![panel](screenshot.png)

- Codex + Claude pooled quota (Session, Weekly, Weekly · Fable) with an even-pace tick, a reset countdown and a pace arrow (↗ ahead of pace, → on pace, ↘ behind pace; hover for the explanation).
- Banked Codex reset credits: count, expiry, and **Use reset** (always behind a confirm dialog).
- Refreshes every 15 minutes; Refresh button for manual.

## Install
1. Copy `cliproxy-usage/` to `~/.config/herdr-app/mods/cliproxy-usage/`.
2. Add a right column to `~/.config/herdr-app/layouts/main.json`:
   `{"id":"usage","size":{"px":320},"min":220,"max":600}` containing `{"mod":"cliproxy-usage"}`.
3. Click **Set up** in the panel and enter your hub URL and management key.

The key is stored only in the mod's `config.json` (gitignored). It needs a hub with `v0/management/api-call`.

## Dev
`node dev/hub.test.js` (network-free) · `node dev/stub-hub.mjs` serves fixtures on `:8318` (key `stub`).
