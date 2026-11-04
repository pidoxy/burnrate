import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { computeBlocks, priceAll, summarize } from "../src/aggregate.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { generateDemo } from "../src/demo.js";
import { PriceBook } from "../src/pricing.js";
import { Store } from "../src/store.js";
import type { UsageEvent } from "../src/types.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "br-test-"));
const line = (id: string, ts: string, out = 1000) =>
  JSON.stringify({ type: "assistant", sessionId: "s1", cwd: "/repo", requestId: `r${id}`, timestamp: ts, message: { id, model: "claude-opus-5-5", content: [{ type: "text" }], usage: { input_tokens: 0, output_tokens: out } } }) + "\n";

describe("store", () => {
  it("dedupes repeated blocks, reads incrementally, and waits for complete lines", () => {
    const logs = tmp(), home = tmp();
    const f = path.join(logs, "a.jsonl");
    fs.writeFileSync(f, line("m1", "2026-11-04T10:00:00Z") + line("m1", "2026-11-04T10:00:00Z") + line("m2", "2026-11-04T10:01:00Z"));
    const s1 = new Store(home).load();
    expect(s1.scan({ extraPaths: [logs], defaults: false }).newEvents).toBe(2);

    // Append a full line plus a partial one.
    fs.appendFileSync(f, line("m3", "2026-11-04T10:02:00Z") + line("m4", "2026-11-04T10:03:00Z").slice(0, 40));
    const s2 = new Store(home).load();
    expect(s2.events).toHaveLength(2);
    expect(s2.scan({ extraPaths: [logs], defaults: false }).newEvents).toBe(1);

    // Complete the partial line.
    fs.appendFileSync(f, line("m4", "2026-11-04T10:03:00Z").slice(40));
    const s3 = new Store(home).load();
    expect(s3.scan({ extraPaths: [logs], defaults: false }).newEvents).toBe(1);
    expect(s3.events.map((e) => e.key)).toEqual(["cc:m1:rm1", "cc:m2:rm2", "cc:m3:rm3", "cc:m4:rm4"]);
    // Re-scan without changes reads nothing.
    expect(s3.scan({ extraPaths: [logs], defaults: false }).newEvents).toBe(0);
  });

  it("ingests the generated demo (both agents) consistently", () => {
    const demo = generateDemo(10);
    const st = new Store(tmp()).load();
    st.scan({ extraPaths: [demo.claude, `codex:${demo.codex}`], defaults: false });
    const agents = new Set(st.events.map((e) => e.agent));
    expect(agents).toEqual(new Set(["claude-code", "codex"]));
    expect(new Set(st.events.map((e) => e.key)).size).toBe(st.events.length);
    expect(st.meta.limits).toHaveLength(1);
    expect(st.meta.rateLimits.codex?.primary?.windowMinutes).toBe(300);
  });
});

const E = (ts: number, output: number): UsageEvent => ({
  key: `k${ts}`, agent: "claude-code", ts, session: "s", project: "/p", model: "claude-opus-5-5",
  input: 0, output, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, reasoning: 0, webSearches: 0,
});

describe("blocks & forecast", () => {
  const H = 3600_000;
  const t0 = Date.UTC(2026, 10, 4, 13, 20); // 13:20 → block 13:00–18:00
  it("opens 5-hour blocks floored to the hour", () => {
    const blocks = computeBlocks(priceAll([E(t0, 1), E(t0 + 4 * H, 1), E(t0 + 5 * H, 1)], new PriceBook()));
    expect(blocks.map((b) => new Date(b.start).toISOString())).toEqual(["2026-11-04T13:00:00.000Z", "2026-11-04T18:00:00.000Z"]);
  });

  it("forecasts when the budget will be hit from the last hour's burn rate", () => {
    // $20/MTok output → 50k tokens = $1. Spend $1 every 10 minutes from 14:00 to 15:00 → $6/h, $7 total.
    const events = [E(t0, 50_000)];
    for (let i = 0; i <= 5; i++) events.push(E(Date.UTC(2026, 10, 4, 14, i * 10), 50_000));
    const now = Date.UTC(2026, 10, 4, 15, 0);
    const s = summarize(events, {}, [], {}, { ...DEFAULT_CONFIG, budgets: { blockUsd: 10 } }, new PriceBook(), { now, days: 7 });
    expect(s.block?.active).toBe(true);
    expect(s.block?.cost).toBeCloseTo(7, 6);
    expect(s.block?.burnPerHour).toBeCloseTo(6, 6);
    // $3 left at $6/h → 30 minutes.
    expect(new Date(s.block!.hitsBudgetAt!).toISOString()).toBe("2026-11-04T15:30:00.000Z");
    expect(s.block?.projected).toBeCloseTo(7 + 6 * 3, 6);
  });

  it("learns a cap from limit hits", () => {
    const events = [E(t0, 500_000), E(t0 + H, 500_000)]; // $20 by 14:20
    const s = summarize(events, {}, [{ agent: "claude-code", ts: t0 + H + 60_000, message: "limit reached" }], {}, DEFAULT_CONFIG, new PriceBook(), { now: t0 + 2 * H, days: 7 });
    expect(s.learnedCap).toBeCloseTo(20, 6);
    expect(s.block?.budgetSource).toBe("learned");
  });
});
