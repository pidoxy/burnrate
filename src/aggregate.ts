import type { Config } from "./config.js";
import { PriceBook } from "./pricing.js";
import type { Agent, LimitHit, RateLimitSnapshot, SessionMeta, UsageEvent } from "./types.js";

export const BLOCK_MS = 5 * 3600_000;
const HOUR = 3600_000;
const DAY = 86400_000;

export interface Priced extends UsageEvent {
  cost: number; // 0 when unpriced
  priced: boolean;
  tokens: number;
}

export interface Block {
  start: number;
  end: number;
  cost: number;
  tokens: number;
  events: number;
  firstTs: number;
  lastTs: number;
}

export interface Summary {
  generatedAt: number;
  timezone: string;
  totals: {
    today: number;
    yesterday: number;
    last7: number;
    mtd: number;
    monthProjection: number;
    allTime: number;
    tokensToday: number;
    cacheSavings30d: number;
    firstEventTs: number | null;
  };
  plan: { name: string; monthlyUsd: number; valueMultiple: number | null } | null;
  block: null | {
    start: number;
    end: number;
    active: boolean;
    cost: number;
    tokens: number;
    burnPerHour: number;
    projected: number;
    budget: number | null;
    budgetSource: "user" | "learned" | null;
    percent: number | null;
    hitsBudgetAt: number | null;
    remainingMs: number;
    series: { t: number; cost: number }[]; // cumulative, 10-min buckets
  };
  week: { cost: number; budget: number | null; percent: number | null };
  month: { cost: number; budget: number | null; percent: number | null; projected: number };
  learnedCap: number | null;
  daily: { date: string; total: number; tokens: number; byAgent: Record<string, number> }[];
  agents: { agent: Agent; cost: number; tokens: number; events: number }[];
  models: { model: string; cost: number; input: number; output: number; cacheRead: number; cacheWrite: number; priced: boolean }[];
  projects: { project: string; cost: number; tokens: number; sessions: number; lastTs: number }[];
  sessions: { id: string; title: string | null; agent: Agent; project: string; cost: number; tokens: number; start: number; end: number; models: string[] }[];
  limits: (LimitHit & { blockCost: number | null })[];
  rateLimits: RateLimitSnapshot[];
  unpricedModels: string[];
  eventCount: number;
}

export function localDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function priceAll(events: UsageEvent[], prices: PriceBook): Priced[] {
  return events
    .map((e) => {
      const c = prices.cost(e);
      return {
        ...e,
        cost: c ?? 0,
        priced: c !== null,
        tokens: e.input + e.output + e.cacheRead + e.cacheWrite5m + e.cacheWrite1h,
      };
    })
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Splits activity into 5-hour blocks the way subscription windows work:
 * a block opens at the first message after the previous block ended (floored to the hour).
 */
export function computeBlocks(events: Priced[]): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  for (const e of events) {
    if (!cur || e.ts >= cur.end) {
      const start = Math.floor(e.ts / HOUR) * HOUR;
      cur = { start, end: start + BLOCK_MS, cost: 0, tokens: 0, events: 0, firstTs: e.ts, lastTs: e.ts };
      blocks.push(cur);
    }
    cur.cost += e.cost;
    cur.tokens += e.tokens;
    cur.events++;
    cur.lastTs = e.ts;
  }
  return blocks;
}

export function summarize(
  events: UsageEvent[],
  sessions: Record<string, SessionMeta>,
  limits: LimitHit[],
  rateLimits: Record<string, RateLimitSnapshot>,
  cfg: Config,
  prices: PriceBook,
  opts: { now?: number; days?: number } = {},
): Summary {
  const now = opts.now ?? Date.now();
  const days = opts.days ?? 30;
  const priced = priceAll(events, prices).filter((e) => e.ts <= now + 60_000);
  const today0 = startOfDay(now);
  const month0 = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime();
  const daysInMonth = new Date(new Date(now).getFullYear(), new Date(now).getMonth() + 1, 0).getDate();
  const dayOfMonth = new Date(now).getDate();

  let today = 0, yesterday = 0, last7 = 0, mtd = 0, allTime = 0, tokensToday = 0, savings = 0;
  const since30 = now - 30 * DAY;
  for (const e of priced) {
    allTime += e.cost;
    if (e.ts >= today0) {
      today += e.cost;
      tokensToday += e.tokens;
    } else if (e.ts >= today0 - DAY) yesterday += e.cost;
    if (e.ts >= now - 7 * DAY) last7 += e.cost;
    if (e.ts >= month0) mtd += e.cost;
    if (e.ts >= since30 && e.priced) {
      const p = prices.lookup(e.model)!;
      savings += (e.cacheRead * (p.input - p.cacheRead)) / 1e6;
    }
  }
  const avgDaily7 = last7 / 7;
  const monthProjection = mtd + avgDaily7 * (daysInMonth - dayOfMonth + (1 - (now - today0) / DAY));

  // Blocks & forecast
  const blocks = computeBlocks(priced);
  const learnedCaps: number[] = [];
  // The vendor's window isn't visible to us, so estimate the cap as spend in the 5 hours before the hit.
  const limitRows = limits.slice(-20).map((l) => {
    const window = priced.filter((e) => e.ts > l.ts - BLOCK_MS && e.ts <= l.ts);
    const blockCost = window.length ? window.reduce((s, e) => s + e.cost, 0) : null;
    if (blockCost && l.agent === "claude-code") learnedCaps.push(blockCost);
    return { ...l, blockCost };
  });
  // Conservative: the smallest observed cap among the most recent three hits.
  const learnedCap = learnedCaps.length ? Math.min(...learnedCaps.slice(-3)) : null;

  const last = blocks[blocks.length - 1];
  let block: Summary["block"] = null;
  if (last) {
    const active = now < last.end && now >= last.start;
    const blockEvents = priced.filter((e) => e.ts >= last.start && e.ts < last.end);
    const windowStart = Math.max(last.start, now - HOUR);
    const recent = blockEvents.filter((e) => e.ts >= windowStart).reduce((s, e) => s + e.cost, 0);
    const elapsedH = Math.max((now - windowStart) / HOUR, 1 / 6);
    const burnPerHour = active ? recent / elapsedH : 0;
    const remainingMs = active ? last.end - now : 0;
    const budget = cfg.budgets.blockUsd ?? learnedCap ?? null;
    const projected = last.cost + burnPerHour * (remainingMs / HOUR);
    let hitsBudgetAt: number | null = null;
    if (active && budget && burnPerHour > 0) {
      const t = last.cost >= budget ? now : now + ((budget - last.cost) / burnPerHour) * HOUR;
      if (t < last.end) hitsBudgetAt = t;
    }
    const series: { t: number; cost: number }[] = [];
    let cum = 0, idx = 0;
    const stop = active ? now : last.lastTs;
    for (let t = last.start; t <= stop + 10 * 60_000; t += 10 * 60_000) {
      while (idx < blockEvents.length && blockEvents[idx].ts < t) cum += blockEvents[idx++].cost;
      series.push({ t: Math.min(t, stop), cost: cum });
      if (t >= stop) break;
    }
    block = {
      start: last.start,
      end: last.end,
      active,
      cost: last.cost,
      tokens: last.tokens,
      burnPerHour,
      projected,
      budget,
      budgetSource: cfg.budgets.blockUsd ? "user" : learnedCap ? "learned" : null,
      percent: budget ? last.cost / budget : null,
      hitsBudgetAt,
      remainingMs,
      series,
    };
  }

  // Daily series
  const dayMap = new Map<string, { total: number; tokens: number; byAgent: Record<string, number> }>();
  for (let i = days - 1; i >= 0; i--) dayMap.set(localDate(now - i * DAY), { total: 0, tokens: 0, byAgent: {} });
  for (const e of priced) {
    const row = dayMap.get(localDate(e.ts));
    if (!row) continue;
    row.total += e.cost;
    row.tokens += e.tokens;
    row.byAgent[e.agent] = (row.byAgent[e.agent] ?? 0) + e.cost;
  }

  // Breakdown tables (within the selected range)
  const rangeStart = startOfDay(now - (days - 1) * DAY);
  const inRange = priced.filter((e) => e.ts >= rangeStart);
  const agents = new Map<Agent, { cost: number; tokens: number; events: number }>();
  const models = new Map<string, Summary["models"][number]>();
  const sess = new Map<string, Summary["sessions"][number] & { modelSet: Set<string> }>();
  for (const e of inRange) {
    const a = agents.get(e.agent) ?? { cost: 0, tokens: 0, events: 0 };
    a.cost += e.cost; a.tokens += e.tokens; a.events++;
    agents.set(e.agent, a);
    const m = models.get(e.model) ?? { model: e.model, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, priced: e.priced };
    m.cost += e.cost; m.input += e.input; m.output += e.output; m.cacheRead += e.cacheRead; m.cacheWrite += e.cacheWrite5m + e.cacheWrite1h;
    models.set(e.model, m);
    const meta = sessions[e.session];
    const s = sess.get(e.session) ?? {
      id: e.session, title: meta?.title ?? null, agent: e.agent, project: meta?.project || e.project,
      cost: 0, tokens: 0, start: e.ts, end: e.ts, models: [], modelSet: new Set<string>(),
    };
    s.cost += e.cost; s.tokens += e.tokens; s.end = Math.max(s.end, e.ts); s.start = Math.min(s.start, e.ts);
    s.modelSet.add(e.model);
    sess.set(e.session, s);
  }
  const sessionList = [...sess.values()].map(({ modelSet, ...s }) => ({ ...s, models: [...modelSet] }));
  const projects = new Map<string, Summary["projects"][number]>();
  for (const s of sessionList) {
    const p = projects.get(s.project) ?? { project: s.project, cost: 0, tokens: 0, sessions: 0, lastTs: 0 };
    p.cost += s.cost; p.tokens += s.tokens; p.sessions++; p.lastTs = Math.max(p.lastTs, s.end);
    projects.set(s.project, p);
  }

  const weekBudget = cfg.budgets.weekUsd ?? null;
  const monthBudget = cfg.budgets.monthUsd ?? null;
  const plan = cfg.plan
    ? { ...cfg.plan, valueMultiple: cfg.plan.monthlyUsd > 0 ? monthProjection / cfg.plan.monthlyUsd : null }
    : null;

  return {
    generatedAt: now,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    totals: {
      today, yesterday, last7, mtd, monthProjection, allTime, tokensToday,
      cacheSavings30d: savings,
      firstEventTs: priced[0]?.ts ?? null,
    },
    plan,
    block,
    week: { cost: last7, budget: weekBudget, percent: weekBudget ? last7 / weekBudget : null },
    month: { cost: mtd, budget: monthBudget, percent: monthBudget ? mtd / monthBudget : null, projected: monthProjection },
    learnedCap,
    daily: [...dayMap.entries()].map(([date, v]) => ({ date, ...v })),
    agents: [...agents.entries()].map(([agent, v]) => ({ agent, ...v })).sort((a, b) => b.cost - a.cost),
    models: [...models.values()].sort((a, b) => b.cost - a.cost),
    projects: [...projects.values()].sort((a, b) => b.cost - a.cost),
    sessions: sessionList.sort((a, b) => b.cost - a.cost).slice(0, 100),
    limits: limitRows.reverse(),
    rateLimits: Object.values(rateLimits),
    unpricedModels: [...new Set(priced.filter((e) => !e.priced).map((e) => e.model))],
    eventCount: priced.length,
  };
}
