# herdr-core-cliproxy

A **herdr-app mod** for monitoring [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) subscription quota without leaving your workspace. Inspired by t3code's **Usage → Limits** view.

Despite the repository name, this runs in **herdr-app**, not as a herdr-core plugin. Developed against herdr-app **0.1.15** and herdr-core **0.1.21**.

![Usage panel with Claude and Codex gauges, pace arrows, reset counts and expiry](screenshot.png)

*Screenshot uses local stub data, not real accounts.*

## Features

- **Claude and Codex gauges:** Session, Weekly, and model-scoped Claude windows such as **Weekly · Fable**, when reported by the hub.
- **Clean subscription sections:** a divider separates Claude and Codex; no redundant email, plan, percentage, or miniature quota rows beneath the gauges.
- **Pace indicators:** a white tick marks the even-spending target; hover over the arrow for an explanation.
- **Manual resets:** see banked Codex credits and Claude reset grants, including Fable/full resets when available, with remaining count and expiry.
- **Confirmation before spending:** **Use reset** identifies the account and asks before redeeming anything.
- **Automatic refresh every 15 minutes**, plus a **Refresh** button. Countdown text is calculated when the panel repaints, not by a second-by-second timer.

### Reading the pace indicator

Bars and percentages show quota **left**, not quota used.

| Indicator | Meaning |
| --- | --- |
| ↗ Ahead of pace | Spending faster than the window elapses; less quota remains than the even-spending target. |
| → On pace | Within **5 percentage points** of the even-spending target. |
| ↘ Behind pace | Spending slower than the window elapses; more quota remains than the target. |
| — Unavailable | The hub did not report a reset time, so pace cannot be calculated. |

The target is the percentage of time remaining in the window. For example, halfway through a window, the even-spending target is **50% quota left**.

## Requirements

- herdr-app with its bundled `confirm` mod.
- A CLIProxyAPI hub URL and **management key**.
- Hub support for `v0/management/auth-files` and `v0/management/api-call`; `v0/management/reset-quota` clears hub routing cooldowns after a successful reset.
- Accounts that report quota through the upstream Claude or Codex APIs. Reset availability depends on the account and provider, not just the mod.

## Install

### 1. Copy the mod

Clone this repository and copy the contents of `cliproxy-usage/` into `~/.config/herdr-app/mods/cliproxy-usage/`.

**PowerShell:**

```powershell
git clone https://github.com/AngDrew/herdr-core-cliproxy.git
cd herdr-core-cliproxy
$mod = Join-Path $HOME '.config/herdr-app/mods/cliproxy-usage'
New-Item -ItemType Directory -Force -Path $mod | Out-Null
Copy-Item ./cliproxy-usage/* -Destination $mod -Force
```

For updates, run `git pull` in the clone and repeat the copy command. The repository does not contain `config.json`, so copying its mod files does not overwrite your saved credentials.

### 2. Add the panel to your layout

Back up `~/.config/herdr-app/layouts/main.json`. If its root is a `row`, append this object to the root's `children` array to dock the panel on the right. Preserve your existing children and do not add a second `usage` column if one already exists.

```json
{
  "id": "usage",
  "type": "column",
  "size": { "px": 320 },
  "min": 220,
  "max": 600,
  "background": "chrome",
  "children": [
    {
      "id": "usage-body",
      "type": "block",
      "content": { "mod": "cliproxy-usage" }
    }
  ]
}
```

For a different layout structure, place the same column inside the row where you want it. The column is resizable between 220 and 600 pixels.

### 3. Connect your hub

Click **Set up**, enter the hub URL and management key, then **Save**. A URL ending in `management.html` is accepted. The optional label replaces the hub hostname in the header.

Use **Settings** to change the connection later. No keyboard binding is required or installed.

## Manual resets

### Codex

The panel counts available, unexpired `codex_rate_limits` credits and shows the earliest expiry. **Use reset** spends the earliest-expiring credit after confirmation. A deterministic request ID makes retries of that same credit idempotent.

### Claude

Claude uses a separate **`cedar_ember` reset-grant API**, following the [CLIProxyAPI management UI](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/main/src/services/api/claudeResetGrants.ts). Each grant shows its label, remaining resets, and expiry. The mod checks fresh eligibility, usability, expiry, cooldown, and limit requirements before submitting a claim.

An unavailable grant has no active spend button; hover **Unavailable** for the reason. Missing grant data is shown as **Claude reset grants unavailable**, rather than silently implying the account has no resets.

The CLI user-agent matters: an older or different surface can make Anthropic report `ineligible: surface` even for an account with grants. The mod uses the CLI header required by the management UI.

### Safety and ambiguous outcomes

- Polling and tests never redeem credits. A real redemption requires confirmation.
- A successful redemption is followed by a hub cooldown-clear request. If that fails, the panel warns that the reset succeeded but routing may remain blocked temporarily.
- Each Claude attempt is journaled locally in **`reset-operation.json`** before submission. If the response is ambiguous or times out, the mod **does not automatically retry**, and further Claude claims stay blocked across reloads.
- If that happens, check the provider/hub to establish whether the reset was spent. Only then clear or delete the local journal. This is deliberately a single Claude-operation lock across accounts, not a background retry system.

## Credentials and privacy

The management key is masked in Settings and stored in the installed mod's **`config.json`**. Treat that file as a secret; it is local plaintext, not an encrypted credential vault. herdr-app mods are trusted code.

`config.json`, `reset-operation.json`, and generated editor/type files are gitignored. Never publish your config, management key, account tokens, or screenshots containing private account information. The hub substitutes account tokens for the literal `Bearer $TOKEN$`; the mod does not need to extract them.

## Development

Use a Node.js version with built-in `fetch` (Node 18+). From the repository root:

```sh
node dev/hub.test.js
node dev/claude-reset.test.js
node dev/panel.test.js
```

These checks use fake responses and do not contact your hub or spend real resets.

For local fixture data:

```sh
node dev/stub-hub.mjs --port 8318
```

Connect the panel to `http://127.0.0.1:8318/` with management key `stub`. The stub includes Claude grants, Codex credits, and accounts without credits. `--fail-reset-quota` exercises the cooldown-clear warning. Restore your real hub settings after testing.

To validate an installed mod:

```sh
herdr-app check ~/.config/herdr-app/mods/cliproxy-usage
herdr-app status
```

## Known limits

- Multiple accounts are pooled by **simple average**, not capacity-weighted quota.
- Pace assumes five-hour session and seven-day weekly windows; nonstandard plan windows may differ.
- One hub at a time; Claude and Codex only.
- This is a native GPUI panel, not a pixel-for-pixel copy of t3code's web interface.

## Uninstall

Remove the `usage` column from your layout, then delete `~/.config/herdr-app/mods/cliproxy-usage/`. Deleting the folder also removes its saved credentials and local reset journal.
