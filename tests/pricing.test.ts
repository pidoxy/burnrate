import { describe, expect, it } from "vitest";
import { PriceBook } from "../src/pricing.js";
import type { UsageEvent } from "../src/types.js";

const ev = (p: Partial<UsageEvent>): UsageEvent => ({
  key: "k", agent: "claude-code", ts: 0, session: "s", project: "", model: "claude-opus-5-5",
  input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, reasoning: 0, webSearches: 0, ...p,
});

describe("pricing", () => {
  const book = new PriceBook();

  it("reproduces Claude Code's own recorded cost exactly (real session, Nov 2026)", () => {
    // Token totals from a real Claude Code `cost-state` record: costUSD 15.0607934 (Opus) + 1.1404568 (Haiku).
    const opus = book.cost(ev({ input: 318, output: 248623, cacheRead: 23353162, cacheWrite5m: 639393, cacheWrite1h: 277433 }));
    expect(opus).toBeCloseTo(15.0607934, 7);
    const haiku = book.cost(ev({ model: "claude-haiku-5-5", input: 1341628, output: 92588, webSearches: 96 }));
    expect(haiku).toBeCloseTo(1.1404568, 7);
  });

  it("matches dated and prefixed model ids, preferring the longest key", () => {
    expect(book.lookup("claude-sonnet-4-5-20250929")?.input).toBe(3);
    expect(book.lookup("us.anthropic.claude-opus-4-1")?.input).toBe(15);
    expect(book.lookup("gpt-5-codex")?.output).toBe(10);
    expect(book.lookup("gpt-5-mini-2025")?.input).toBe(0.25);
  });

  it("flags unknown models as unpriced and honours overrides", () => {
    expect(book.cost(ev({ model: "mystery-model", input: 1000 }))).toBeNull();
    const custom = new PriceBook({ "mystery-model": { input: 1, output: 2, cacheRead: 0.1 } });
    expect(custom.cost(ev({ model: "mystery-model", input: 1_000_000, output: 1_000_000 }))).toBe(3);
  });
});
