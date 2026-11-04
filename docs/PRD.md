# Burnrate — Product Requirements Document

**Status:** v1.0 (MVP) · **Owner:** Emmanuel Idoko · **Last updated:** 2026-11-04

> Burnrate shows developers what their coding agents really cost and when they will hit their limits. It runs locally, reads the logs Claude Code and Codex already write, and covers every agent in one view instead of one vendor dashboard each.

---

## 1. Problem

Developers now run several coding agents at once. They pay through a mix of flat subscriptions with **unpublished, rolling limits** (e.g. Claude's 5-hour windows and weekly caps) and **usage-based billing** (API keys, and Copilot since June 2026). Three things go wrong:

1. **The wall.** You hit a usage limit mid-refactor with no warning. The quota is opaque, so you can't pace yourself.
2. **No attribution.** You know the monthly total, not that one runaway session cost $14.20 or that one repo costs 3× the others.
3. **Wrong numbers.** Logs record each streamed message several times. Naively summing them over-counts, often by 2× or more. Prompt-cache writes are priced differently for 5-minute and 1-hour TTLs, which most calculators ignore.

**Evidence (Nov 2026 research):** opaque Claude Code quotas, a quota-burning caching bug that forced a limit reset (Feb 2026), Copilot's move to usage-based billing (Jun 2026), developers reporting $200–400/month across agents "with zero visibility", and a Splunk/Cisco survey (Oct 2026) in which more than half of 2,050 organisations said they cannot control AI costs. Existing tools (usagebar, ccusage-style CLIs) show demand but are single-agent or terminal-only.

## 2. Goals & non-goals

### Goals (MVP)
1. **Accurate:** cost per message matches the vendor's own accounting. Validated: our engine reproduces Claude Code's recorded `cost-state` exactly ($15.0607934 on a real session).
2. **Forecast the wall:** for the current 5-hour block, show spend, burn rate ($/h) and "at this rate you hit your budget at 15:40".
3. **Attribute:** cost per session (titled by its first prompt), project, model, agent and day.
4. **Zero setup:** `npx burnrate` finds the logs, opens a dashboard, and needs no account, API key or network.
5. **Live in your flow:** a Claude Code status line, a terminal summary, and an xbar/SwiftBar menu-bar plugin.
6. **Value check:** for subscribers, "your $200 plan delivered $1,240 of API-equivalent usage this month".
7. **Private:** reads local files only. Nothing leaves the machine and there's no telemetry.

### Non-goals (MVP)
- Reading vendor billing APIs (needs credentials; v1.1 via admin keys).
- Exact subscription quotas, which vendors don't publish. We use user-set budgets plus **learned caps** from observed limit hits.
- A team server (v2).
- Native menu-bar app (the xbar/SwiftBar plugin covers macOS; a native app is v1.2).

## 3. Users

| Persona | Situation | Job to be done |
|---|---|---|
| **Indie dev on Max** | Hits the 5h wall twice a week | "Warn me before the wall, and tell me when it resets." |
| **Contractor on API keys** | Bills clients for agent time | "What did client A's repo cost this month?" |
| **Tool-hopper** | Uses Claude Code and Codex | "One number for everything, and which agent is cheaper for me." |

## 4. User stories

- US-1 `npx burnrate` scans known log locations and opens a local dashboard.
- US-2 I see today / 7 days / month-to-date spend and a month-end projection.
- US-3 I see the current 5-hour block: spend, burn rate, time left, a forecast against my budget, and a meter.
- US-4 I see daily spend for the last 7/30/90 days, stacked by agent, with a hover tooltip and a table view.
- US-5 I see top sessions (titled by first prompt), projects, and models, each sortable by cost.
- US-6 I can set budgets for the 5h block, the week and the month (`burnrate budget …` or in the dashboard).
- US-7 When a limit hit appears in my logs, Burnrate records the block spend at that moment and suggests it as my budget ("learned cap").
- US-8 For Codex, which logs its own rate-limit percentages, I see the real used % and reset time.
- US-9 `burnrate statusline` prints a one-line summary for Claude Code's `statusLine` (this session's cost, today's total, block forecast).
- US-10 `burnrate bar` prints xbar/SwiftBar output for the macOS menu bar.
- US-11 `burnrate status` prints a terminal summary, and `burnrate sessions` / `burnrate export --csv` cover the rest.
- US-12 `burnrate watch` sends a desktop notification at 80% and 100% of a budget.
- US-13 I can override prices (`~/.burnrate/prices.json`) and set my plan price to see the value multiple.

## 5. Functional requirements

### 5.1 Ingestion
- **Sources:**
  - **Claude Code:** `~/.claude/projects/**/*.jsonl` (plus `$CLAUDE_CONFIG_DIR`), subagent transcripts included.
  - **Codex CLI:** `~/.codex/sessions/**/*.jsonl` (plus `$CODEX_HOME`).
  - **Extra roots:** `--path` or `BURNRATE_PATHS`.
- **Incremental:** remember byte offset, size and mtime per file. Parse only appended complete lines; re-scan from 0 if a file shrinks.
- **Dedupe:** Claude by `message.id + requestId`; Codex by file and byte offset. Synthetic or error messages carry no cost.
- **Stored per event:** agent, timestamp, session, project (cwd), model, input, output, cache read, 5-minute cache write, 1-hour cache write, reasoning tokens, web searches.
- **Session titles:** the first human prompt, truncated to 80 characters and stored locally only.

### 5.2 Pricing
- Built-in table per model: input, output, cache read, cache write at 5 minutes (1.25× input) and 1 hour (2× input), plus web search at $10 per 1,000.
- Prefix matching for dated or variant model IDs; unknown models are counted as tokens and flagged "unpriced".
- Prices apply at aggregation time, so changing a price re-costs history.
- OpenAI convention: `input_tokens` includes cached tokens, so cost is `(input − cached) × in + cached × cached_rate + output × out`.

### 5.3 Blocks & forecast
- **Blocks:** a block starts at the first event after the previous block ended, floored to the hour, and lasts 5 hours.
- **Burn rate:** cost over the last 60 minutes of the active block, or since block start if that's shorter, in $/h.
- **Forecasts:**
  - Projected block total = spent + rate × remaining time.
  - Time to budget = now + (budget − spent) / rate.
  - Month-end projection = month-to-date + 7-day daily average × days left.

### 5.4 Limits
- **Claude:** a limit hit is an assistant/system text matching `/usage limit|limit reached|rate limit/i`. Record the hit time and the spend in the 5 hours before it. That spend is the learned cap; the smallest of the last three is used.
- **Codex:** keep the latest `rate_limits` snapshot (primary and secondary used %, window, reset time).

### 5.5 Surfaces
- **Dashboard:** `http://127.0.0.1:4317`, bound to localhost only. It re-scans on each refresh and auto-refreshes every 30 seconds.
- **CLI:** `status`, `statusline`, `bar`, `sessions`, `export`, `budget`, `plan`, `watch`, `scan`, `serve`.

## 6. Design principles
1. **The number first.** The hero is today's spend; everything else supports a decision.
2. **Honest estimates.** Costs are labelled "API-equivalent". Unknown prices are flagged, never guessed silently.
3. **Developer-quiet.** System font, hairlines, one accent, dark and light themes; charts follow the dataviz method (validated palette, thin marks, tooltips, table view).

## 7. Success metrics
| Metric | Target |
|---|---|
| Cost accuracy vs vendor-recorded cost | ±0.5% (achieved: exact match on the reference session) |
| Time from `npx burnrate` to dashboard | < 5 s for 100 MB of logs |
| Day-7 retention (statusline still configured) | ≥ 40% |
| GitHub stars in 30 days | 1,000 |

## 8. Architecture
- **Node ≥ 20, TypeScript, zero runtime dependencies.** `node:http` for the server, `node:fs` streams for ingestion, plain HTML/CSS/JS for the dashboard with hand-built SVG charts.
- **Storage:** `~/.burnrate/` holds `events.ndjson` (append-only), `state.json` (file offsets), `meta.json` (sessions and limits) and `config.json` (budgets, plan).
- **Distribution:** npm (`npx burnrate`), GitHub Actions CI, and a release workflow that publishes on tag.

## 9. Release plan
| Phase | Scope |
|---|---|
| MVP | Everything above |
| v1.1 | Gemini CLI, Cursor and Copilot usage-export import; Anthropic and OpenAI admin-API reconciliation |
| v1.2 | Native macOS menu-bar app; per-project budgets |
| v2 | Opt-in team rollup server; Slack alerts; integration with the "agent seatbelt" policy layer |

## 10. Risks
| Risk | Mitigation |
|---|---|
| Log formats change without notice | Defensive parsers, fixture tests from real logs, unknown-field tolerance, fast releases |
| Price table goes stale | User overrides; prices dated in source; "unpriced" flag |
| Quotas aren't published | Budgets plus learned caps from real limit hits; Codex's own percentages where available |
| Privacy concerns about prompts | Only the first 80 characters of the first prompt; local only; `--no-titles` flag |
