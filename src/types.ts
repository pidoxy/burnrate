export type Agent = "claude-code" | "codex";

/** One billed model response. Token counts are already de-duplicated. */
export interface UsageEvent {
  key: string;
  agent: Agent;
  ts: number; // epoch ms
  session: string;
  project: string; // working directory
  model: string;
  input: number; // uncached input tokens
  output: number; // includes reasoning/thinking tokens
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  reasoning: number; // informational subset of output
  webSearches: number;
}

export interface SessionMeta {
  agent: Agent;
  title: string | null;
  project: string;
  firstTs: number;
}

export interface LimitHit {
  agent: Agent;
  ts: number;
  message: string;
}

export interface RateLimitWindow {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: number | null; // epoch ms
}

export interface RateLimitSnapshot {
  agent: Agent;
  ts: number;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
}

/** What a parser yields while reading a log. */
export type ParsedRecord =
  | { kind: "usage"; event: UsageEvent }
  | { kind: "session"; session: string; meta: Partial<SessionMeta> & { agent: Agent } }
  | { kind: "limit"; hit: LimitHit }
  | { kind: "ratelimit"; snapshot: RateLimitSnapshot };
