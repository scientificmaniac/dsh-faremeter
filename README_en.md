<div align="center">

# dsh-faremeter — A Fare Meter for AI Chats

Token fares across the official tiers with peak/off-peak hours — and from Nov 1, 2026, per-request web Search/Fetch billing (¥5 per 1,000). Per turn · per session · per workspace, always in CNY.

[简体中文](README.md) · **English**

![DSH Plugin](https://img.shields.io/badge/DSH-Plugin-3B82F6)
![DeepSeek API Pricing](https://img.shields.io/badge/DeepSeek-API_Pricing-4D6BFE)
![Peak/Off-peak](https://img.shields.io/badge/pricing-peak%2Foff--peak-F59E0B)
![Search·Fetch per-request](https://img.shields.io/badge/Search%C2%B7Fetch_per--request-22C55E)
![tests](https://img.shields.io/badge/tests-72_passed-2EA44F)
![License](https://img.shields.io/badge/license-MIT-8A8F98)

<img src="assets/banner.png" alt="dsh-faremeter promo: three display surfaces with CNY amounts" width="720">

</div>

It displays costs in three places:

| Location | What it shows |
|---|---|
| Action row of each assistant reply (next to the token-usage pill) | Cost of that turn |
| Composer dock (next to the official stats pill) | This session / all sessions cumulative |
| End of each workspace row in the sidebar | Cumulative per workspace (across sessions) |

Amounts follow **DeepSeek's official API prices**, in two independent billing dimensions:

**① Token billing** (three token buckets, two day-part tiers):

| Billing bucket | Price tier |
|---|---|
| Cache-hit input (`cacheReadTokens`) | Cache-hit price |
| Cache-miss input (`uncachedInputTokens`) | Cache-miss price |
| Output (`outputTokens`, reasoning included) | Output price |

**Peak/off-peak**: peak hours = **Mon–Fri 9:00–12:00 and 14:00–18:00 Beijing time** (excluding Chinese public holidays); peak price = off-peak price × 2. Everything else — weekends, make-up workdays that fall on weekends, and public holidays all day — is off-peak.

Current token prices (CNY per million tokens, `[off-peak, peak]`):

| Model | Cache hit | Cache miss | Output |
|---|---|---|---|
| `deepseek-flash` | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
| `deepseek-v4-pro` | 0.15 / 0.30 | 4.5 / 9 | 13.5 / 27 |

**② Search / Fetch per-request billing** (official announcement 2026-10-25; **effective 2026-11-01 00:00 Beijing time** — earlier calls are free; no peak/off-peak distinction):

| API | Billing unit | Price |
|---|---|---|
| Search (server-side `web_search`) | per 1,000 successful requests | ¥5 |
| Fetch (server-side `web_fetch`) | per 1,000 successful requests | ¥5 |

How "one successful request" is determined from session logs: a `web_fetch` whose `tool/result` has no `isError`/`error` counts as one; a single `web_search` call with N sub-queries counts as N requests (verified on real logs: 35 calls / 59 sub-queries = 59 request events, an exact match). The effective-date gate uses the **request initiation time**.

> Price snapshot: token prices verified 2026-09-19; Search/Fetch prices from the official announcement of 2026-10-25. When DeepSeek adjusts prices again, update `FLASH_PRICE` / `PRO_PRICE` / `WEB_REQUEST_UNITS` in **both** `lib/client.js` and `lib/cost-core.mjs` (tests keep the two implementations bit-identical).

---

## UI

```
Per turn (next to token usage):
  Copy  Feedback  Branch  1.6M tokens used  ¥0.920  21:50
                                     └─ this plugin

Composer dock (next to the official stats pill):
  … 12 turns · 3 steps · 42 tok/s   1.6M tokens · 92% cached   ¥3.84

Sidebar workspaces:
  ▼ price-display-plugin                ¥1.23
      session-9cc5451a…
  ▼ ssh-plugin                          ¥18.46
      session-3611dbc7…
```

- The per-turn pill shows a `▲` marker during peak hours; click it for the full breakdown (model, day-part, cache-hit ratio, the three unit prices, per-bucket amounts and total; turns with search/fetch get extra per-request rows).
- The dock pill opens: this session / this workspace / all sessions / search & fetch breakdown / ledger scan status.
- Workspace amounts use `pointer-events:none`, so they never block the row's collapse/expand click.
- Uninstalling the plugin fully restores the DOM — no leftover nodes.

## Where the three numbers come from

| Number | Data source | Coverage |
|---|---|---|
| Per-turn amount | Client: `useChat` → `tokenUsage` of the `turn-tail` node | Turns currently loaded |
| Session / all-time / workspace | Host: scans every session log under `~/.dsh/sessions` | **Includes historical sessions from before the plugin was installed** |

The host ledger treats **session log files as the single source of truth**: DSH persists events in real time, so file contents are always current. The plugin re-scans incrementally every 15 seconds (only files whose mtime/size changed); the initial full scan runs asynchronously in slices 1.2 s after startup (measured on this machine: 52 sessions / ~30 MB of compressed logs → **1.8 s**).

Session logs are a multi-frame format — one JSON object per line, each line compressed into its own zstd frame — and `zstdDecompressSync` only inflates the first frame. `lib/session-scan.mjs` ports the frame-scanning logic from the official `dsh-session-persistence-jsonl` package (pure JS, no Node private APIs) to decompress frame by frame.

Workspace attribution: the `cwd` in the `session` header event; the host then maps `workspaceId ↔ path` via the `workspaceRegistry` service and publishes `byWorkspaceId`, which the client matches directly against `data-row-key="workspace:<id>"` rows.

## Billing details (matching the official rules)

- **Cache hits are priced separately**: hit input is charged at the hit price and missed input at the miss price, multiplied and summed — never blended into an average.
- **`cacheWriteTokens` is not billed separately**: DeepSeek has only hit / miss / output tiers; cache-write cost is already included in missed input. Copying Anthropic's `cacheWrite × 1.25` would overstate the cost.
- **`reasoningTokens` is not billed twice**: DSH's `outputTokens` already includes reasoning tokens.
- **Peak/off-peak is judged at the turn's request time** (the turn's ending time), converted to UTC+8 before comparison — so a different host timezone can never skew the result.
- **Search/Fetch is billed per successful request** (¥0.005 each, no peak/off-peak), gated by the effective date: the request initiation time is compared against Beijing 2026-11-01 00:00; earlier calls are free. Failed requests (results carrying `isError`/`error`) and calls without a result are not counted.
- **A Search's "request count" = its sub-query count**: a `web_search` call issues one Search API request per entry in its `queries` array (measured to match the `web/deepseek-search-llm-request` event count in host logs exactly). The client cannot see those events, so both sides count sub-queries; the raw event count is kept as a live-ledger cross-check.
- **Amounts accumulate in integer fixed-point**: internally everything sums as integers in units of 1e-8 CNY (`tokens × price × 100`), converted only for display — no floating-point drift, so "total = sum of parts" always holds. Search/Fetch uses the same scaling (500,000 units per request).
- **Unrecognized models are estimated at Flash prices**, clearly stated in the panel — never pretending to be exact.

## Install

```powershell
# Preview what will change (no writes)
pwsh -File install-profile.ps1 -WhatIf

# Install into the desktop profile
pwsh -File install-profile.ps1

# Uninstall
pwsh -File install-profile.ps1 -Uninstall
```

The script: backs up the profile's `package.json` → adds a `link:` dependency → appends `dsh-faremeter` to `dsh.profile.bundles` → creates a junction under the profile's `node_modules`.

**After installing you must fully quit and restart DSH Desktop** (closing the window is not enough — the process must exit) so the client bundle gets compiled into `window.__DSH_BOOT__`.

## Host shapes this plugin relies on

| Item | Value |
|---|---|
| Slots | `conversation.chat.assistant-actions` (list, session scope, `order: 20`) |
| Entry id | `faremeter` |
| Data source | slot standard props' `useChat` → `turn-tail` node's `data.tokenUsage` / `data.closing.time` |
| Injected services | `slots` only |

Where the pill lands: it first renders an invisible anchor to learn its position inside the official action row, then walks up to `[data-clock="end"]` (the action row of a completed turn), takes that row's last child (the span holding the usage pill and clock), and portals the cost pill into a container inserted **after the usage pill, before the clock** via `ReactDOM.createPortal`.

**If placement fails the pill does not vanish — it falls back to its original slot position**: when the DOM shape changes or the row has no usage pill, the pill renders in the slot's own position (right of the copy button). That way "plugin not working" and "anchor not matched" never look identical.

**Data extraction**: in the real host, `snapshot.nodes` is a `MutableChatNodeStore` (has `get(key)` and `values()`, **no `forEach`**) — a trap we hit once: an early version iterated with `forEach`, silently found nothing, and the pill never appeared. `nodeListOf()` now accepts store / Map / plain-object shapes, pinned by a regression test.

## Packaging & distribution

```powershell
pwsh -File pack.ps1
```

Artifacts land in `dist\`:

| File | Purpose |
|---|---|
| `dsh-faremeter-<version>.tgz` | Standard npm package — this is what DSH plugin installation consumes. Contents strictly follow the `files` whitelist in `package.json`; **no tests or build scripts** |
| `dsh-faremeter-<version>.zip` | Source distribution: unzip to get the complete plugin directory and run `install-profile.ps1` directly; tests included for review |

The script runs **all four test groups first** — a failing test aborts the build. After packing it also: verifies the tgz entry list (required files present; no tests/deps/build scripts leaked in), unpacks the tgz into a temp directory and **really runs it** (loads `lib/index.js`, calls `apply()`, asserts routes register without throwing and client bundle markers are present), then produces the zip and prints its SHA256.

> Packing pins the npm cache to `.npm-cache\` (instead of the user's global cache) for reproducible builds without pollution.

## Troubleshooting

If the pill doesn't appear, open the browser console (Ctrl+Shift+I) and **type by hand**:

```js
__DSH_FAREMETER__
```

It returns a diagnostics object:

| Field | What to look at |
|---|---|
| `applies` | 0 = the client plugin was never applied (bundle not loaded) |
| `entries` | empty = entries never rendered; `hasUseChat:false` = host didn't provide `useChat`; `hasUsage:false` = no usage for this turn |
| `entries[].propKeys` | actual field list of the slot's standard props |
| `placements` | `endInfo:false` = the "after the usage pill" anchor wasn't found; the pill falls back to the action row's own position |
| `notes[0].nodeStore` | actual capabilities of the host's `snapshot.nodes` (`hasValues` / `hasForEach`…) |

Note: DevTools blocks *pasting*; typing is unaffected.

## Changing prices

Edit the price table at the top of `lib/client.js`:

```js
var FLASH_PRICE = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] };  // [off-peak, peak]
var PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] };
var PRICING = { "deepseek-flash": FLASH_PRICE, ... };
// Search / Fetch per-request billing (units per successful request; ¥5/1000 = 500,000)
var WEB_REQUEST_UNITS = 500000;
var WEB_BILLING_EFFECTIVE_MS = Date.UTC(2026, 10, 1) - 8 * 3600000;  // Beijing 2026-11-01 00:00
```

`lib/cost-core.mjs` contains the same constants — both copies must be updated together (`test/cost-core.test.mjs` will catch a mismatch). Restart DSH Desktop to apply.

**Every November**, once the State Council publishes next year's holiday schedule, add the new year's holidays to `HOLIDAY_VALLEY` — otherwise Chinese public holidays in the new year get billed at peak prices (double, all day). When out of date, the panel shows "holiday table not covering this year".

## Known limitations

- **Per-turn amounts judge peak/off-peak at the turn's end time** (a turn usually finishes within minutes, so boundary crossings are rare); **the host ledger prices each `assistant/message` individually by its own `time`**, making session/workspace totals more accurate than the per-turn figure.
- **When a turn switches models mid-flight**, the client's `tokenUsage` is only a turn-wide aggregate; the per-turn amount is estimated with the first model (noted in the panel). The host ledger prices each call by its actual model.
- **Search/Fetch "success" is a log-level approximation**: the official wording bills successful requests, but logs don't record per-request outcomes — Fetch uses the `tool/result`'s `isError`/`error` (same failure semantics as the official client-ui-chat); a successful `web_search` counts all its sub-queries. Server-side retries of individual sub-queries are invisible, so the estimate may run slightly low.
- **web_search / web_fetch calls issued inside subagents** as sub-calls are not counted yet (sub-calls have a different log shape, and the client can't see other sessions' nodes either).
- **Workspace amounts depend on the official internal attribute `data-row-key="workspace:<id>"`** — the only stable anchor given there is no workspace-row slot. If an official update breaks the anchor, amounts **silently disappear** (fail-open) without breaking the sidebar.
- In **single-column / search / narrow-sidebar** modes the sidebar doesn't render workspace groups, so workspace amounts don't show — expected behavior.
- Amounts are **book values computed from the official price table**, not invoices; actual charges are whatever DeepSeek bills.

## Tests

```powershell
npm test                 # four groups: pricing-core parity / session scan & ledger / client / host routes
node test/live-ledger.mjs --limit 5   # smoke test on real local sessions: workspace ranking, Search/Fetch cross-check, self-consistency
python test/expected_cost.py --check  # 42 independent baseline vectors
```

| Test | What it pins down |
|---|---|
| `test/cost-core.test.mjs` | The **two pricing implementations** (host & client) agree bit-for-bit on the same vectors (prevents "per-turn sums ≠ session totals"), plus Search/Fetch constants, the effective-date gate, and per-request pricing |
| `test/session-scan.test.mjs` | zstd multi-frame scanning, torn-frame tolerance, same-(turn,step) replacement, `llm/retry-started` accumulation, Search/Fetch counting (success/failure/effective date/sub-queries), ledger aggregation and incremental re-scan |
| `test/client.test.mjs` | DOM placement, real component execution, dock cumulative pill, workspace row injection, both slot registrations |
| `test/host.test.mjs` | Route registration, loopback checks, method limits, JSON shape and cross-consistency of the three scopes |
| `test/expected_cost.py` | An independent Python implementation generating the 42 baseline vectors |

The 42 vectors in `test/vectors.json` cover 8 peak-boundary moments, weekends / public holidays / make-up workdays, timezone conversion for UTC and other offsets, every token-bucket combination, and large/small magnitudes. The JS side compares with 1e-9 tolerance — two independent implementations reaching the same numbers is what makes them trustworthy.

`test/harness.mjs` is an offline test bench (fake DOM + stateful React stub + fake module loader) that actually executes `lib/client.js` and renders components, so "did the pill land next to the usage pill", "does clicking open the panel", and "did the workspace row get its amount" are all verified by real execution, not by reading code.

## Directory layout

```
lib/index.js        Host: cordis entry + read-only ledger route + workspace id mapping
lib/ledger.mjs      Ledger: session scanning, incremental re-scan, per-session/workspace aggregation
lib/session-scan.mjs Session logs: zstd multi-frame scanning & per-frame decompression, event folding
lib/cost-core.mjs   Pricing core (host side; kept identical to the client copy by tests)
lib/client.js       Client: per-turn pill / dock cumulative / workspace amount injection
cordis.patch.yml    bundle patch
install-profile.ps1 Installer
test/               Four test groups + offline test bench + independent baseline vectors (Python)
docs/pricing-notes.md   Price & peak/off-peak verification notes (with credibility grading and sources)
docs/host-api-notes.md  Host API research (ledger/routes/workspace attribution)
docs/workspace-ui-notes.md  Workspace UI insertion-point research (anchors and fallback ladder)
```
