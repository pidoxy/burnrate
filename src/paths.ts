import os from "node:os";
import path from "node:path";
import type { Agent } from "./types.js";

export function dataDir(): string {
  return process.env.BURNRATE_HOME || path.join(os.homedir(), ".burnrate");
}

export interface LogRoot {
  agent: Agent;
  dir: string;
}

export function logRoots(extra: string[] = [], includeDefaults = true): LogRoot[] {
  const home = os.homedir();
  const roots: LogRoot[] = [];
  const envPaths: string[] = [];
  if (includeDefaults) {
    const claudeDirs = new Set<string>([path.join(home, ".claude", "projects"), path.join(home, ".config", "claude", "projects")]);
    for (const d of (process.env.CLAUDE_CONFIG_DIR ?? "").split(",").filter(Boolean)) claudeDirs.add(path.join(d, "projects"));
    for (const dir of claudeDirs) roots.push({ agent: "claude-code", dir });
    const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
    roots.push({ agent: "codex", dir: path.join(codexHome, "sessions") });
    envPaths.push(...(process.env.BURNRATE_PATHS ?? "").split(path.delimiter).filter(Boolean));
  }
  for (const spec of [...extra, ...envPaths]) {
    // "codex:/path" or "/path" (Claude Code format by default)
    const m = spec.match(/^(claude-code|claude|codex):(.*)$/);
    roots.push(m ? { agent: m[1] === "codex" ? "codex" : "claude-code", dir: path.resolve(m[2]) } : { agent: "claude-code", dir: path.resolve(spec) });
  }
  return roots;
}
