import fs from "node:fs";
import path from "node:path";

export interface Config {
  budgets: {
    blockUsd?: number; // per 5-hour block
    weekUsd?: number; // rolling 7 days
    monthUsd?: number; // calendar month
  };
  plan?: { name: string; monthlyUsd: number };
  /** Notification thresholds as fractions of a budget. */
  alertAt: number[];
}

export const DEFAULT_CONFIG: Config = { budgets: {}, alertAt: [0.8, 1] };

export function loadConfig(dir: string): Config {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    return { ...DEFAULT_CONFIG, ...raw, budgets: { ...raw.budgets } };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(dir: string, cfg: Config) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(cfg, null, 2) + "\n");
}

export const PLAN_PRESETS: Record<string, { name: string; monthlyUsd: number }> = {
  "claude-pro": { name: "Claude Pro", monthlyUsd: 20 },
  "claude-max-5x": { name: "Claude Max 5x", monthlyUsd: 100 },
  "claude-max-20x": { name: "Claude Max 20x", monthlyUsd: 200 },
  "chatgpt-plus": { name: "ChatGPT Plus", monthlyUsd: 20 },
  "chatgpt-pro": { name: "ChatGPT Pro", monthlyUsd: 200 },
};
