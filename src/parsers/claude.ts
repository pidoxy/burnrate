import type { ParsedRecord } from "../types.js";

const LIMIT_RE = /(usage limit|limit reached|rate limit|limit will reset|out of extra usage)/i;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
      .join(" ");
  }
  return "";
}

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Parses one line of a Claude Code transcript (~/.claude/projects/**\/*.jsonl).
 * Claude Code writes one line per content block, all carrying the same `usage`,
 * so callers must de-duplicate by `key` (message id + request id).
 */
export function parseClaudeLine(line: string, file: string): ParsedRecord[] {
  let o: Record<string, any>;
  try {
    o = JSON.parse(line);
  } catch {
    return [];
  }
  if (!o || typeof o !== "object") return [];
  const out: ParsedRecord[] = [];
  const session: string = o.sessionId ?? file;
  const project: string = o.cwd ?? "";
  const ts = Date.parse(o.timestamp ?? "");

  if (o.type === "user" && !o.isSidechain && o.message?.role === "user" && !o.isMeta) {
    const text = textOf(o.message.content).trim();
    // Skip tool results, slash-command wrappers and system reminders.
    if (text && !text.startsWith("<") && !Array.isArray(o.toolUseResult) && o.toolUseResult === undefined) {
      out.push({
        kind: "session",
        session,
        meta: { agent: "claude-code", title: text.replace(/\s+/g, " ").slice(0, 80), project, firstTs: ts },
      });
    }
  }

  if (o.type === "assistant" && o.message) {
    const m = o.message;
    const text = textOf(m.content);
    if ((m.model === "<synthetic>" || o.isApiErrorMessage) && LIMIT_RE.test(text) && Number.isFinite(ts)) {
      out.push({ kind: "limit", hit: { agent: "claude-code", ts, message: text.slice(0, 200) } });
    }
    const u = m.usage;
    if (u && m.model && m.model !== "<synthetic>" && Number.isFinite(ts)) {
      const cc = u.cache_creation ?? {};
      const split = typeof cc.ephemeral_5m_input_tokens === "number" || typeof cc.ephemeral_1h_input_tokens === "number";
      const write5m = split ? n(cc.ephemeral_5m_input_tokens) : n(u.cache_creation_input_tokens);
      const write1h = split ? n(cc.ephemeral_1h_input_tokens) : 0;
      out.push({
        kind: "usage",
        event: {
          key: `cc:${m.id ?? o.uuid}:${o.requestId ?? ""}`,
          agent: "claude-code",
          ts,
          session,
          project,
          model: String(m.model),
          input: n(u.input_tokens),
          output: n(u.output_tokens),
          cacheRead: n(u.cache_read_input_tokens),
          cacheWrite5m: write5m,
          cacheWrite1h: write1h,
          reasoning: n(u.output_tokens_details?.thinking_tokens),
          webSearches: n(u.server_tool_use?.web_search_requests),
        },
      });
      out.push({ kind: "session", session, meta: { agent: "claude-code", project, firstTs: ts } });
    }
  }

  if (o.type === "system" && typeof o.content === "string" && LIMIT_RE.test(o.content) && Number.isFinite(ts)) {
    out.push({ kind: "limit", hit: { agent: "claude-code", ts, message: o.content.slice(0, 200) } });
  }
  return out;
}
