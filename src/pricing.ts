import fs from "node:fs";
import path from "node:path";
import type { UsageEvent } from "./types.js";

/**
 * USD per million tokens. Prices as published by vendors (checked 2026-11).
 * cacheWrite5m / cacheWrite1h default to 1.25x / 2x input (Anthropic prompt caching).
 * Validated: reproduces Claude Code's own recorded session cost to the cent.
 */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  /** OpenAI-style: input_tokens already includes cached tokens. Handled at parse time. */
}

export const WEB_SEARCH_USD = 10 / 1000;

export const BUILTIN_PRICES: Record<string, Price> = {
  // Anthropic — Claude 5 family
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-mythos-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  // Anthropic — Claude 4 family
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-1": { input: 15, output: 75, cacheRead: 1.5 },
  "claude-opus-4": { input: 15, output: 75, cacheRead: 1.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-3-7-sonnet": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
  "claude-3-5-haiku": { input: 0.8, output: 4, cacheRead: 0.08 },
  // OpenAI — models used by Codex CLI (cached input = cacheRead)
  "gpt-5-codex": { input: 1.25, output: 10, cacheRead: 0.125 },
  "gpt-5.1-codex": { input: 1.25, output: 10, cacheRead: 0.125 },
  "gpt-5.1": { input: 1.25, output: 10, cacheRead: 0.125 },
  "gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025 },
  "gpt-5-nano": { input: 0.05, output: 0.4, cacheRead: 0.005 },
  "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125 },
  "o4-mini": { input: 1.1, output: 4.4, cacheRead: 0.275 },
  "o3": { input: 2, output: 8, cacheRead: 0.5 },
  "gpt-4.1": { input: 2, output: 8, cacheRead: 0.5 },
};

export class PriceBook {
  private table: Record<string, Price>;
  private keys: string[];
  private cache = new Map<string, Price | null>();

  constructor(overrides: Record<string, Price> = {}) {
    this.table = { ...BUILTIN_PRICES, ...overrides };
    // Longest key first so "gpt-5-codex" wins over "gpt-5".
    this.keys = Object.keys(this.table).sort((a, b) => b.length - a.length);
  }

  static load(dir: string): PriceBook {
    const file = path.join(dir, "prices.json");
    try {
      return new PriceBook(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      return new PriceBook();
    }
  }

  lookup(model: string): Price | null {
    if (this.cache.has(model)) return this.cache.get(model)!;
    const m = model.toLowerCase().replace(/^(anthropic\.|us\.anthropic\.|openai\/)/, "").replace(/@.*$/, "");
    let found: Price | null = this.table[m] ?? null;
    if (!found) {
      const k = this.keys.find((key) => m.startsWith(key) || m.startsWith(key + "-"));
      found = k ? this.table[k] : null;
    }
    this.cache.set(model, found);
    return found;
  }

  /** USD cost of one event; null when the model is unpriced. */
  cost(e: UsageEvent): number | null {
    const p = this.lookup(e.model);
    if (!p) return null;
    const w5 = p.cacheWrite5m ?? p.input * 1.25;
    const w1h = p.cacheWrite1h ?? p.input * 2;
    return (
      (e.input * p.input +
        e.output * p.output +
        e.cacheRead * p.cacheRead +
        e.cacheWrite5m * w5 +
        e.cacheWrite1h * w1h) /
        1e6 +
      e.webSearches * WEB_SEARCH_USD
    );
  }
}
