import type { ParsedRecord, RateLimitWindow } from "../types.js";

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export interface CodexState {
  session: string;
  project: string;
  model: string;
}

function windowOf(w: any, ts: number): RateLimitWindow | null {
  if (!w || typeof w !== "object") return null;
  const used = typeof w.used_percent === "number" ? w.used_percent : null;
  if (used === null) return null;
  const resetsIn = typeof w.resets_in_seconds === "number" ? w.resets_in_seconds : null;
  const resetsAt = typeof w.resets_at === "number" ? w.resets_at * (w.resets_at < 1e12 ? 1000 : 1) : null;
  return {
    usedPercent: used,
    windowMinutes: typeof w.window_minutes === "number" ? w.window_minutes : null,
    resetsAt: resetsAt ?? (resetsIn !== null ? ts + resetsIn * 1000 : null),
  };
}

/**
 * Parses one line of a Codex CLI rollout (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl).
 * Usage comes from `event_msg` → `token_count` events; `last_token_usage` is the per-turn delta.
 * OpenAI counts cached tokens inside `input_tokens`, so we subtract them.
 */
export function parseCodexLine(line: string, file: string, offset: number, state: CodexState): ParsedRecord[] {
  let o: Record<string, any>;
  try {
    o = JSON.parse(line);
  } catch {
    return [];
  }
  const ts = Date.parse(o.timestamp ?? "") || Date.now();
  const p = o.payload ?? {};
  const out: ParsedRecord[] = [];

  if (o.type === "session_meta") {
    state.session = p.id ?? state.session;
    state.project = p.cwd ?? state.project;
    if (p.model) state.model = p.model;
    out.push({ kind: "session", session: state.session, meta: { agent: "codex", project: state.project, firstTs: ts } });
  } else if (o.type === "turn_context") {
    if (p.model) state.model = p.model;
    if (p.cwd) state.project = p.cwd;
  } else if (o.type === "response_item" && p.type === "message" && p.role === "user") {
    const text = Array.isArray(p.content)
      ? p.content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join(" ").trim()
      : "";
    if (text && !text.startsWith("<")) {
      out.push({ kind: "session", session: state.session, meta: { agent: "codex", title: text.replace(/\s+/g, " ").slice(0, 80), project: state.project, firstTs: ts } });
    }
  } else if (o.type === "event_msg" && p.type === "token_count") {
    const last = p.info?.last_token_usage;
    if (last) {
      const input = n(last.input_tokens);
      const cached = Math.min(n(last.cached_input_tokens), input);
      if (input + n(last.output_tokens) > 0) {
        out.push({
          kind: "usage",
          event: {
            key: `cx:${file}:${offset}`,
            agent: "codex",
            ts,
            session: state.session,
            project: state.project,
            model: state.model || "gpt-5-codex",
            input: input - cached,
            output: n(last.output_tokens),
            cacheRead: cached,
            cacheWrite5m: 0,
            cacheWrite1h: 0,
            reasoning: n(last.reasoning_output_tokens),
            webSearches: 0,
          },
        });
      }
    }
    const rl = p.rate_limits ?? p.info?.rate_limits;
    if (rl) {
      out.push({
        kind: "ratelimit",
        snapshot: { agent: "codex", ts, primary: windowOf(rl.primary, ts), secondary: windowOf(rl.secondary, ts) },
      });
      for (const w of [rl.primary, rl.secondary]) {
        if (w && typeof w.used_percent === "number" && w.used_percent >= 100) {
          out.push({ kind: "limit", hit: { agent: "codex", ts, message: `Codex ${w.window_minutes ?? "?"}-minute limit reached` } });
        }
      }
    }
  }
  return out;
}
