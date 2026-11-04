import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Deterministic PRNG so demo screenshots are stable. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

const PROJECTS = ["~/code/checkout-api", "~/code/marketing-site", "~/code/mobile-app", "~/code/infra", "~/code/data-pipeline"];
const PROMPTS = [
  "Refactor the payment retry logic into a state machine",
  "Add dark mode to the settings screen",
  "Why is the nightly ETL job timing out?",
  "Write integration tests for the webhook handler",
  "Migrate auth from sessions to JWT",
  "Fix flaky e2e test on the checkout page",
  "Upgrade Next.js and fix the build errors",
  "Draft a Terraform module for the queue workers",
  "Explain this stack trace and propose a fix",
  "Add pagination to the orders endpoint",
  "Port the CSV importer to streaming",
  "Review this PR for security issues",
];

/**
 * Writes realistic Claude Code + Codex logs for the last `days` days into a temp dir.
 * Returns the directory; pass it with --path / codex:--path.
 */
export function generateDemo(days = 30, now = Date.now()): { root: string; claude: string; codex: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "burnrate-demo-"));
  const claude = path.join(root, "claude", "projects");
  const codex = path.join(root, "codex", "sessions");
  const r = rng(42);
  let msgN = 0;
  let limitTs = now - 3 * 86400_000;

  for (let d = days - 1; d >= 0; d--) {
    const day = new Date(now - d * 86400_000);
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    const nSessions = d === 0 ? 3 : weekend ? Math.floor(r() * 2) : 2 + Math.floor(r() * 4);
    for (let sIdx = 0; sIdx < nSessions; sIdx++) {
      const isCodex = d === 0 && sIdx === nSessions - 1 ? false : r() < 0.28;
      const project = PROJECTS[Math.floor(r() * PROJECTS.length)].replace("~", os.homedir());
      const prompt = PROMPTS[Math.floor(r() * PROMPTS.length)];
      const startHour = 9 + Math.floor(r() * 9);
      let ts = new Date(day.getFullYear(), day.getMonth(), day.getDate(), startHour, Math.floor(r() * 60)).getTime();
      if (d === 0) ts = now - 2.6 * 3600_000 + sIdx * 25 * 60_000; // today: sessions inside the active block
      const turns = d === 0 && sIdx === nSessions - 1 ? 1000 : 20 + Math.floor(r() * (isCodex ? 50 : 110)); // today's last session runs until now
      const sessionId = `${(0x10000000 + Math.floor(r() * 0xefffffff)).toString(16)}-demo-${d}-${sIdx}`;
      const lines: string[] = [];
      const model = isCodex ? "gpt-5-codex" : r() < 0.75 ? "claude-opus-5-5" : "claude-sonnet-5-5";

      if (isCodex) {
        lines.push(JSON.stringify({ timestamp: new Date(ts).toISOString(), type: "session_meta", payload: { id: sessionId, cwd: project } }));
        lines.push(JSON.stringify({ timestamp: new Date(ts).toISOString(), type: "turn_context", payload: { model, cwd: project } }));
        lines.push(JSON.stringify({ timestamp: new Date(ts).toISOString(), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } }));
      } else {
        lines.push(JSON.stringify({ type: "user", sessionId, cwd: project, timestamp: new Date(ts).toISOString(), message: { role: "user", content: prompt }, uuid: `u-${sessionId}` }));
      }

      let ctx = 12_000;
      for (let t = 0; t < turns; t++) {
        ts += (20 + r() * 90) * 1000;
        if (ts > now - 60_000) break;
        ctx += 1500 + r() * 6000;
        const out = 200 + Math.floor(r() * 2500);
        if (isCodex) {
          const input = Math.floor(ctx);
          lines.push(JSON.stringify({
            timestamp: new Date(ts).toISOString(), type: "event_msg",
            payload: {
              type: "token_count",
              info: { last_token_usage: { input_tokens: input, cached_input_tokens: Math.floor(input * 0.85), output_tokens: out, reasoning_output_tokens: Math.floor(out * 0.4) } },
              rate_limits: {
                primary: { used_percent: Math.min(100, 18 + (turns ? (t / turns) * 40 : 0)), window_minutes: 300, resets_in_seconds: 3 * 3600 },
                secondary: { used_percent: 46, window_minutes: 10080, resets_in_seconds: 3 * 86400 },
              },
            },
          }));
        } else {
          const id = `msg_demo_${++msgN}`;
          const write = t === 0 ? Math.floor(ctx) : Math.floor(1500 + r() * 6000);
          const usage = {
            input_tokens: 3 + Math.floor(r() * 20),
            cache_creation_input_tokens: write,
            cache_read_input_tokens: Math.floor(ctx - write),
            output_tokens: out,
            cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write },
            server_tool_use: { web_search_requests: r() < 0.03 ? 1 : 0 },
          };
          // Claude Code writes one line per content block with identical usage — duplicates on purpose.
          for (const block of ["thinking", "text", "tool_use"].slice(0, 1 + Math.floor(r() * 3))) {
            lines.push(JSON.stringify({
              type: "assistant", sessionId, cwd: project, requestId: `req_demo_${msgN}`, timestamp: new Date(ts).toISOString(),
              message: { id, model, role: "assistant", content: [{ type: block, text: "" }], usage },
            }));
          }
        }
      }

      if (d >= 2 && !isCodex) limitTs = Math.max(limitTs, ts + 30_000);
      if (isCodex) {
        const dt = new Date(ts);
        const dir = path.join(codex, String(dt.getFullYear()), String(dt.getMonth() + 1).padStart(2, "0"), String(dt.getDate()).padStart(2, "0"));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `rollout-${sessionId}.jsonl`), lines.join("\n") + "\n");
      } else {
        const dir = path.join(claude, project.replace(/[\\/:]/g, "-"));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
      }
    }
  }

  // One limit hit right after the last Claude Code message two or more days ago.
  const hitTs = limitTs;
  const dir = path.join(claude, "demo-limit");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "limit.jsonl"),
    JSON.stringify({ type: "assistant", isApiErrorMessage: true, sessionId: "demo-limit", cwd: "", timestamp: new Date(hitTs).toISOString(), message: { id: "msg_limit", model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "5-hour limit reached ∙ resets 7pm" }], usage: { input_tokens: 0, output_tokens: 0 } } }) + "\n",
  );
  return { root, claude, codex };
}
