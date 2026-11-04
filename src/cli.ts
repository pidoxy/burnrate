#!/usr/bin/env node
import fs from "node:fs";
import { createRequire } from "node:module";
import { localDate, priceAll, summarize, type Summary } from "./aggregate.js";
import { loadConfig, PLAN_PRESETS, saveConfig } from "./config.js";
import { clock, duration, shortProject, tokens, usd, when } from "./format.js";
import { notify, openBrowser } from "./notify.js";
import { generateDemo } from "./demo.js";
import { dataDir } from "./paths.js";
import { PriceBook } from "./pricing.js";
import { createServer } from "./server.js";
import { Store } from "./store.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

// ───────────── args ─────────────
const argv = process.argv.slice(2);
const BOOL_FLAGS = new Set(["csv", "json", "clear", "open", "no-open", "no-titles", "no-color", "verbose", "help", "version", "demo", "no-plan"]);
const flags: Record<string, string | boolean> = {};
const positional: string[] = [];
const extraPaths: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const [k, v] = a.slice(2).split("=", 2);
    const next = argv[i + 1];
    const isBool = BOOL_FLAGS.has(k);
    const val = v ?? (!isBool && next !== undefined && !next.startsWith("--") ? (i++, next) : true);
    if (k === "path") extraPaths.push(String(val));
    else flags[k] = val;
  } else if (a === "-h") flags.help = true;
  else if (a === "-v") flags.version = true;
  else positional.push(a);
}
const cmd = positional[0] ?? "dashboard";
let DIR = typeof flags.home === "string" ? flags.home : dataDir();
let useDefaults = true;
const titles = !flags["no-titles"];

// ───────────── colour ─────────────
const useColor = process.stdout.isTTY && !process.env.NO_COLOR && !flags["no-color"];
const c = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c("1"), dim = c("2"), red = c("31"), green = c("32"), yellow = c("33"), orange = c("38;5;208"), cyan = c("36");

function meter(frac: number, width = 24): string {
  const f = Math.max(0, Math.min(1, frac));
  const full = Math.round(f * width);
  const col = f >= 1 ? red : f >= 0.8 ? yellow : green;
  return col("█".repeat(full)) + dim("░".repeat(width - full));
}

function load(opts: { quiet?: boolean } = {}) {
  const store = new Store(DIR).load();
  const res = store.scan({ extraPaths, titles, defaults: useDefaults });
  if (!opts.quiet && flags.verbose) console.error(dim(`scanned ${res.filesScanned} files, ${res.newEvents} new events`));
  return { store, res };
}

function summary(days = 30, now?: number): { s: Summary; store: Store } {
  const { store } = load({ quiet: true });
  const s = summarize(store.events, store.meta.sessions, store.meta.limits, store.meta.rateLimits, loadConfig(DIR), PriceBook.load(DIR), { days, now });
  return { s, store };
}

// ───────────── commands ─────────────
function help() {
  console.log(`${bold("burnrate")} ${dim("v" + pkg.version)} — what your coding agents cost, and when you'll hit the wall.

${bold("Usage")}
  burnrate                      scan logs and open the dashboard (http://127.0.0.1:4317)
  burnrate status               spend summary + current 5-hour block forecast
  burnrate statusline           one line for Claude Code's statusLine (reads its JSON on stdin)
  burnrate bar                  xbar / SwiftBar menu-bar plugin output
  burnrate sessions [--days 30] [--limit 20]   most expensive sessions
  burnrate export [--csv|--json] [--days 30]   per-message usage with cost
  burnrate budget [--block 40] [--week 300] [--month 1000] [--clear]
  burnrate plan <${Object.keys(PLAN_PRESETS).join("|")}> | --name X --usd N | --clear
  burnrate watch [--interval 60]               desktop alerts at 80% / 100% of budgets
  burnrate demo                 try it with 30 days of synthetic usage (your data is untouched)
  burnrate scan | reset | serve [--port 4317] [--no-open]

${bold("Options")}
  --path <dir>      extra log directory (prefix "codex:" for Codex logs); repeatable
  --home <dir>      data directory (default ~/.burnrate, or $BURNRATE_HOME)
  --no-titles       don't store session titles (first prompt)
  --no-color        plain output

Logs read: ~/.claude/projects (Claude Code, incl. subagents) and ~/.codex/sessions (Codex CLI).
Costs are API-equivalent estimates using public per-token prices; override in ~/.burnrate/prices.json.`);
}

function printStatus() {
  const { s } = summary(30);
  const b = s.block;
  console.log();
  console.log(`  ${orange("🔥")} ${bold("Today")} ${bold(usd(s.totals.today))}   ${dim("yesterday")} ${usd(s.totals.yesterday)}   ${dim("7d")} ${usd(s.totals.last7)}   ${dim("month")} ${usd(s.totals.mtd)} ${dim(`→ ~${usd(s.totals.monthProjection)}`)}`);
  if (s.plan?.valueMultiple) {
    console.log(`  ${dim("plan")} ${s.plan.name} ${usd(s.plan.monthlyUsd)}/mo ${dim("→")} ${green(`${s.plan.valueMultiple.toFixed(1)}× value`)} ${dim("(projected API-equivalent)")}`);
  }
  console.log();
  if (b && b.active) {
    console.log(`  ${bold("5-hour block")} ${dim(`${clock(b.start)}–${clock(b.end)} · ${duration(b.remainingMs)} left`)}`);
    if (b.budget) {
      console.log(`  ${meter(b.percent ?? 0)} ${bold(usd(b.cost))} ${dim("of")} ${usd(b.budget)} ${dim(b.budgetSource === "learned" ? "(learned cap)" : "")}`);
    } else {
      console.log(`  ${bold(usd(b.cost))} ${dim("spent · no block budget set (burnrate budget --block 40)")}`);
    }
    const rate = `${usd(b.burnPerHour)}/h`;
    if (b.hitsBudgetAt) console.log(`  ${red("▲")} At ${rate} you hit the budget at ${bold(clock(b.hitsBudgetAt))} ${dim(`(in ${duration(b.hitsBudgetAt - Date.now())})`)}`);
    else console.log(`  ${dim("burn")} ${rate} ${dim("· projected block total")} ${usd(b.projected)}`);
  } else {
    console.log(`  ${dim("No active 5-hour block.")}${b ? dim(` Last block ${when(b.start)}: ${usd(b.cost)}`) : ""}`);
  }
  for (const r of s.rateLimits) {
    const parts = [r.primary && `5h ${r.primary.usedPercent.toFixed(0)}%`, r.secondary && `week ${r.secondary.usedPercent.toFixed(0)}%`].filter(Boolean);
    if (parts.length) console.log(`  ${cyan(r.agent)} ${dim("reported limits:")} ${parts.join(dim(" · "))}${r.primary?.resetsAt ? dim(` · resets ${when(r.primary.resetsAt)}`) : ""}`);
  }
  if (s.week.budget) console.log(`  ${dim("7 days")}  ${meter(s.week.percent ?? 0, 16)} ${usd(s.week.cost)} / ${usd(s.week.budget)}`);
  if (s.month.budget) console.log(`  ${dim("month")}   ${meter(s.month.percent ?? 0, 16)} ${usd(s.month.cost)} / ${usd(s.month.budget)}`);
  console.log();
  const top = s.sessions.slice(0, 5);
  if (top.length) {
    console.log(`  ${bold("Top sessions")} ${dim("(30 days)")}`);
    for (const x of top) {
      console.log(`  ${usd(x.cost).padStart(9)}  ${(x.title ?? x.id.slice(0, 8)).slice(0, 52).padEnd(52)} ${dim(shortProject(x.project))}`);
    }
    console.log();
  }
  if (s.totals.cacheSavings30d > 1) console.log(`  ${dim("Prompt caching saved")} ${green(usd(s.totals.cacheSavings30d))} ${dim("in 30 days.")}`);
  if (s.unpricedModels.length) console.log(`  ${yellow("!")} ${dim("unpriced models (add to ~/.burnrate/prices.json):")} ${s.unpricedModels.join(", ")}`);
  if (!s.eventCount) console.log(dim("  No agent logs found yet. Run Claude Code or Codex, or pass --path <dir>."));
  console.log();
}

async function readStdin(timeoutMs = 300): Promise<string> {
  if (process.stdin.isTTY) return "";
  return new Promise((resolve) => {
    let data = "";
    const t = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (data += d));
    process.stdin.on("end", () => {
      clearTimeout(t);
      resolve(data);
    });
  });
}

async function statusline() {
  const raw = await readStdin();
  let sessionId: string | null = null;
  try {
    sessionId = JSON.parse(raw).session_id ?? null;
  } catch {
    /* not JSON */
  }
  const { s, store } = summary(1);
  const parts: string[] = [];
  if (sessionId) {
    const prices = PriceBook.load(DIR);
    const sc = store.events.filter((e) => e.session === sessionId).reduce((a, e) => a + (prices.cost(e) ?? 0), 0);
    parts.push(`${orange("◆")} ${usd(sc)} ${dim("session")}`);
  }
  parts.push(`${usd(s.totals.today)} ${dim("today")}`);
  const b = s.block;
  if (b?.active) {
    if (b.percent !== null) {
      const pct = Math.round(b.percent * 100);
      const col = b.percent >= 1 ? red : b.percent >= 0.8 ? yellow : green;
      parts.push(`${col(`${pct}%`)} ${dim("block")}`);
    }
    parts.push(`${usd(b.burnPerHour)}/h`);
    if (b.hitsBudgetAt) parts.push(red(`limit ~${clock(b.hitsBudgetAt)}`));
    else parts.push(dim(`resets ${clock(b.end)}`));
  }
  process.stdout.write(parts.join(dim(" · ")) + "\n");
}

function bar() {
  const { s } = summary(7);
  const b = s.block;
  const pct = b?.active && b.percent !== null ? ` ${Math.round(b.percent * 100)}%` : "";
  const warn = b?.hitsBudgetAt ? " ⚠︎" : "";
  console.log(`🔥 ${usd(s.totals.today)}${pct}${warn}`);
  console.log("---");
  console.log(`Today ${usd(s.totals.today)} · 7 days ${usd(s.totals.last7)} | font=Menlo`);
  console.log(`Month ${usd(s.totals.mtd)} → ~${usd(s.totals.monthProjection)} | font=Menlo`);
  if (b?.active) {
    console.log("---");
    console.log(`Block ${clock(b.start)}–${clock(b.end)}: ${usd(b.cost)}${b.budget ? ` of ${usd(b.budget)}` : ""}`);
    console.log(`Burn ${usd(b.burnPerHour)}/h · ${duration(b.remainingMs)} left`);
    if (b.hitsBudgetAt) console.log(`Hits budget at ${clock(b.hitsBudgetAt)} | color=#d03b3b`);
  }
  console.log("---");
  for (const x of s.sessions.slice(0, 5)) console.log(`${usd(x.cost)}  ${(x.title ?? x.id).slice(0, 40).replace(/\|/g, "/")} | font=Menlo size=12`);
  console.log("---");
  console.log("Open dashboard | href=http://127.0.0.1:4317");
}

function sessions() {
  const days = Number(flags.days) || 30;
  const limit = Number(flags.limit) || 20;
  const { s } = summary(days);
  console.log(`\n  ${bold(`Most expensive sessions — last ${days} days`)}\n`);
  for (const x of s.sessions.slice(0, limit)) {
    console.log(
      `  ${bold(usd(x.cost).padStart(9))}  ${dim(when(x.start).padEnd(10))} ${(x.title ?? x.id.slice(0, 8)).slice(0, 56).padEnd(56)} ${dim(`${shortProject(x.project)} · ${tokens(x.tokens)} tok`)}`,
    );
  }
  console.log();
}

function exportData() {
  const days = Number(flags.days) || 30;
  const { store } = load({ quiet: true });
  const since = Date.now() - days * 86400_000;
  const rows = priceAll(store.events, PriceBook.load(DIR)).filter((e) => e.ts >= since);
  if (flags.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return;
  }
  const cols = ["timestamp", "date", "agent", "session", "title", "project", "model", "input", "output", "cache_read", "cache_write_5m", "cache_write_1h", "web_searches", "cost_usd"];
  const q = (v: unknown) => {
    const str = String(v ?? "");
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const out = [cols.join(",")];
  for (const e of rows) {
    out.push(
      [new Date(e.ts).toISOString(), localDate(e.ts), e.agent, e.session, store.meta.sessions[e.session]?.title ?? "", e.project, e.model, e.input, e.output, e.cacheRead, e.cacheWrite5m, e.cacheWrite1h, e.webSearches, e.priced ? e.cost.toFixed(6) : ""]
        .map(q)
        .join(","),
    );
  }
  process.stdout.write(out.join("\n") + "\n");
}

function budget() {
  const cfg = loadConfig(DIR);
  if (flags.clear) cfg.budgets = {};
  const set = (k: "blockUsd" | "weekUsd" | "monthUsd", f: string) => {
    if (flags[f] !== undefined) {
      const v = Number(flags[f]);
      cfg.budgets[k] = v > 0 ? v : undefined;
    }
  };
  set("blockUsd", "block");
  set("weekUsd", "week");
  set("monthUsd", "month");
  saveConfig(DIR, cfg);
  const b = cfg.budgets;
  console.log(`Budgets — 5h block: ${usd(b.blockUsd ?? null)} · 7 days: ${usd(b.weekUsd ?? null)} · month: ${usd(b.monthUsd ?? null)}`);
  if (!b.blockUsd) console.log(dim("Tip: without a block budget, Burnrate uses the cap it learned from your last limit hit (if any)."));
}

function plan() {
  const cfg = loadConfig(DIR);
  const preset = positional[1];
  if (flags.clear) cfg.plan = undefined;
  else if (preset && PLAN_PRESETS[preset]) cfg.plan = PLAN_PRESETS[preset];
  else if (flags.usd) cfg.plan = { name: String(flags.name ?? "My plan"), monthlyUsd: Number(flags.usd) };
  else if (preset) {
    console.error(`Unknown plan "${preset}". Presets: ${Object.keys(PLAN_PRESETS).join(", ")}`);
    process.exit(1);
  }
  saveConfig(DIR, cfg);
  console.log(cfg.plan ? `Plan: ${cfg.plan.name} (${usd(cfg.plan.monthlyUsd)}/month)` : "No plan set.");
}

async function watch() {
  const interval = Math.max(Number(flags.interval) || 60, 10) * 1000;
  const fired = new Set<string>();
  console.log(dim(`Watching every ${interval / 1000}s. Ctrl+C to stop.`));
  const tick = () => {
    const { s } = summary(7);
    const cfg = loadConfig(DIR);
    const checks: [string, number | null, string][] = [
      [`block:${s.block?.start}`, s.block?.active ? s.block.percent : null, "5-hour block"],
      [`week`, s.week.percent, "7-day budget"],
      [`month:${new Date().getMonth()}`, s.month.percent, "monthly budget"],
    ];
    for (const [key, pct, label] of checks) {
      if (pct === null) continue;
      for (const t of cfg.alertAt) {
        const k = `${key}:${t}`;
        if (pct >= t && !fired.has(k)) {
          fired.add(k);
          const extra = label === "5-hour block" && s.block?.hitsBudgetAt ? ` Limit ~${clock(s.block.hitsBudgetAt)}.` : "";
          notify(`Burnrate: ${Math.round(pct * 100)}% of ${label}`, `${usd(label === "5-hour block" ? s.block!.cost : label === "7-day budget" ? s.week.cost : s.month.cost)} spent.${extra}`);
        }
      }
    }
  };
  tick();
  setInterval(tick, interval);
}

function serve(open: boolean) {
  const port = Number(flags.port) || 4317;
  const { res } = load();
  const server = createServer({ dataDir: DIR, extraPaths, titles, defaults: useDefaults, port });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.log(`Burnrate is already running → http://127.0.0.1:${port}`);
      if (open) openBrowser(`http://127.0.0.1:${port}`);
      process.exit(0);
    }
    throw err;
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`\n  ${orange("🔥")} ${bold("Burnrate")} ${dim("v" + pkg.version)}  ${url}`);
    for (const r of res.roots) console.log(dim(`     ${r.agent.padEnd(12)} ${r.files} log files  ${r.dir}`));
    if (!res.roots.length) console.log(yellow("     No Claude Code or Codex logs found yet."));
    console.log(dim("     Ctrl+C to stop\n"));
    if (open) openBrowser(url);
  });
}

async function main() {
  if (flags.version) return console.log(pkg.version);
  if (flags.help || cmd === "help") return help();
  if (cmd === "demo" || flags.demo) {
    // Synthetic 30-day history in a temp dir — never touches your real data.
    const demo = generateDemo(Number(flags.days) || 30);
    DIR = `${demo.root}/home`;
    useDefaults = false;
    extraPaths.push(demo.claude, `codex:${demo.codex}`);
    if (!flags["no-plan"]) saveConfig(DIR, { budgets: { blockUsd: 28, monthUsd: 600 }, plan: PLAN_PRESETS["claude-max-20x"], alertAt: [0.8, 1] });
    if (cmd === "demo") return serve(!flags["no-open"]);
  }
  switch (cmd) {
    case "dashboard":
      return serve(!flags["no-open"]);
    case "serve":
      return serve(Boolean(flags.open));
    case "status":
      return printStatus();
    case "statusline":
      return statusline();
    case "bar":
      return bar();
    case "sessions":
      return sessions();
    case "export":
      return exportData();
    case "budget":
      return budget();
    case "plan":
      return plan();
    case "watch":
      return watch();
    case "scan": {
      const { res, store } = load();
      for (const r of res.roots) console.log(`${r.agent.padEnd(12)} ${String(r.files).padStart(5)} files  ${r.dir}`);
      console.log(`${store.events.length} usage events (${res.newEvents} new) · data in ${DIR}`);
      return;
    }
    case "reset":
      new Store(DIR).reset();
      fs.rmSync(DIR + "/events.ndjson", { force: true });
      return console.log(`Cleared cached usage in ${DIR} (config kept).`);
    default:
      console.error(`Unknown command "${cmd}". Run burnrate --help.`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(red(String(err?.stack ?? err)));
  process.exit(1);
});
