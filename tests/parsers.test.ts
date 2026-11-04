import { describe, expect, it } from "vitest";
import { parseClaudeLine } from "../src/parsers/claude.js";
import { parseCodexLine } from "../src/parsers/codex.js";

const assistant = (block: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "assistant", sessionId: "s1", cwd: "/repo", requestId: "req_1", timestamp: "2026-11-04T15:25:46.039Z",
    message: {
      id: "msg_1", model: "claude-opus-5-5", role: "assistant", content: [{ type: block }],
      usage: {
        input_tokens: 2, cache_creation_input_tokens: 20304, cache_read_input_tokens: 49262, output_tokens: 431,
        output_tokens_details: { thinking_tokens: 227 }, server_tool_use: { web_search_requests: 1 },
        cache_creation: { ephemeral_1h_input_tokens: 20304, ephemeral_5m_input_tokens: 0 },
      },
    },
    ...extra,
  });

describe("Claude Code parser", () => {
  it("extracts usage with the 5m/1h cache split and a stable dedupe key", () => {
    const a = parseClaudeLine(assistant("thinking"), "f").find((r) => r.kind === "usage");
    const b = parseClaudeLine(assistant("text"), "f").find((r) => r.kind === "usage");
    expect(a && a.kind === "usage" && a.event).toMatchObject({
      input: 2, output: 431, cacheRead: 49262, cacheWrite5m: 0, cacheWrite1h: 20304, reasoning: 227, webSearches: 1, project: "/repo", session: "s1",
    });
    // Claude Code writes one line per content block with the same usage → same key.
    expect(a && a.kind === "usage" && a.event.key).toBe(b && b.kind === "usage" && b.event.key);
  });

  it("falls back to cache_creation_input_tokens as a 5m write for older logs", () => {
    const line = JSON.stringify({ type: "assistant", sessionId: "s", timestamp: "2025-06-01T10:00:00Z", requestId: "r", message: { id: "m", model: "claude-sonnet-4-5", usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100 } } });
    const r = parseClaudeLine(line, "f").find((x) => x.kind === "usage");
    expect(r && r.kind === "usage" && [r.event.cacheWrite5m, r.event.cacheWrite1h]).toEqual([100, 0]);
  });

  it("titles sessions from the first human prompt, ignoring tool results", () => {
    const user = JSON.stringify({ type: "user", sessionId: "s", cwd: "/r", timestamp: "2026-11-04T10:00:00Z", message: { role: "user", content: "Refactor   the\nretry logic" } });
    const tool = JSON.stringify({ type: "user", sessionId: "s", timestamp: "2026-11-04T10:00:01Z", toolUseResult: { ok: 1 }, message: { role: "user", content: [{ type: "tool_result" }] } });
    expect(parseClaudeLine(user, "f")[0]).toMatchObject({ kind: "session", meta: { title: "Refactor the retry logic" } });
    expect(parseClaudeLine(tool, "f")).toEqual([]);
  });

  it("records limit hits from synthetic error messages and never bills them", () => {
    const line = JSON.stringify({ type: "assistant", isApiErrorMessage: true, sessionId: "s", timestamp: "2026-11-01T16:20:00Z", message: { id: "x", model: "<synthetic>", content: [{ type: "text", text: "5-hour limit reached ∙ resets 7pm" }], usage: { input_tokens: 0, output_tokens: 0 } } });
    const recs = parseClaudeLine(line, "f");
    expect(recs.map((r) => r.kind)).toEqual(["limit"]);
  });

  it("ignores garbage lines", () => {
    expect(parseClaudeLine("{not json", "f")).toEqual([]);
  });
});

describe("Codex parser", () => {
  it("subtracts cached tokens from input and keeps rate-limit snapshots", () => {
    const st = { session: "file", project: "", model: "" };
    parseCodexLine(JSON.stringify({ timestamp: "2026-11-04T10:00:00Z", type: "session_meta", payload: { id: "sess-1", cwd: "/repo" } }), "f", 0, st);
    parseCodexLine(JSON.stringify({ timestamp: "2026-11-04T10:00:00Z", type: "turn_context", payload: { model: "gpt-5-codex" } }), "f", 50, st);
    const recs = parseCodexLine(JSON.stringify({
      timestamp: "2026-11-04T10:01:00Z", type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10000, cached_input_tokens: 8000, output_tokens: 500, reasoning_output_tokens: 200 } },
        rate_limits: { primary: { used_percent: 42, window_minutes: 300, resets_in_seconds: 3600 }, secondary: { used_percent: 100, window_minutes: 10080 } } },
    }), "f", 100, st);
    const usage = recs.find((r) => r.kind === "usage");
    expect(usage && usage.kind === "usage" && usage.event).toMatchObject({ session: "sess-1", project: "/repo", model: "gpt-5-codex", input: 2000, cacheRead: 8000, output: 500, key: "cx:f:100" });
    const rl = recs.find((r) => r.kind === "ratelimit");
    expect(rl && rl.kind === "ratelimit" && rl.snapshot.primary).toMatchObject({ usedPercent: 42, windowMinutes: 300, resetsAt: Date.parse("2026-11-04T11:01:00Z") });
    expect(recs.some((r) => r.kind === "limit")).toBe(true); // secondary at 100%
  });
});
