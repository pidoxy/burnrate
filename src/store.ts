import fs from "node:fs";
import path from "node:path";
import { parseClaudeLine } from "./parsers/claude.js";
import { parseCodexLine, type CodexState } from "./parsers/codex.js";
import { logRoots, type LogRoot } from "./paths.js";
import type { LimitHit, ParsedRecord, RateLimitSnapshot, SessionMeta, UsageEvent } from "./types.js";

interface FileState {
  size: number;
  mtimeMs: number;
  offset: number;
  codex?: CodexState;
}

interface Meta {
  sessions: Record<string, SessionMeta>;
  limits: LimitHit[];
  rateLimits: Record<string, RateLimitSnapshot>;
}

const STATE_VERSION = 1;

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

export interface ScanResult {
  filesScanned: number;
  newEvents: number;
  roots: { agent: string; dir: string; files: number }[];
}

/**
 * Append-only local store in ~/.burnrate:
 *   events.ndjson  one UsageEvent per line (unique by key)
 *   state.json     per-file byte offsets for incremental parsing
 *   meta.json      sessions, limit hits, latest rate-limit snapshots
 */
export class Store {
  readonly dir: string;
  private eventsFile: string;
  private stateFile: string;
  private metaFile: string;
  private files: Record<string, FileState> = {};
  meta: Meta = { sessions: {}, limits: [], rateLimits: {} };
  events: UsageEvent[] = [];
  private keys = new Set<string>();

  constructor(dir: string) {
    this.dir = dir;
    this.eventsFile = path.join(dir, "events.ndjson");
    this.stateFile = path.join(dir, "state.json");
    this.metaFile = path.join(dir, "meta.json");
  }

  load(): this {
    fs.mkdirSync(this.dir, { recursive: true });
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      if (s.version === STATE_VERSION) this.files = s.files ?? {};
    } catch {
      /* fresh */
    }
    try {
      this.meta = { sessions: {}, limits: [], rateLimits: {}, ...JSON.parse(fs.readFileSync(this.metaFile, "utf8")) };
    } catch {
      /* fresh */
    }
    if (!Object.keys(this.files).length) {
      // No state → rebuild events from scratch to stay consistent.
      fs.rmSync(this.eventsFile, { force: true });
      this.meta = { sessions: {}, limits: [], rateLimits: {} };
    }
    try {
      for (const line of fs.readFileSync(this.eventsFile, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const e = JSON.parse(line) as UsageEvent;
          if (!this.keys.has(e.key)) {
            this.keys.add(e.key);
            this.events.push(e);
          }
        } catch {
          /* skip torn line */
        }
      }
    } catch {
      /* no events yet */
    }
    return this;
  }

  private apply(rec: ParsedRecord, fresh: UsageEvent[]) {
    switch (rec.kind) {
      case "usage":
        if (!this.keys.has(rec.event.key)) {
          this.keys.add(rec.event.key);
          this.events.push(rec.event);
          fresh.push(rec.event);
        }
        break;
      case "session": {
        const cur = this.meta.sessions[rec.session];
        if (!cur) {
          this.meta.sessions[rec.session] = {
            agent: rec.meta.agent,
            title: rec.meta.title ?? null,
            project: rec.meta.project ?? "",
            firstTs: rec.meta.firstTs ?? Date.now(),
          };
        } else {
          if (!cur.title && rec.meta.title) cur.title = rec.meta.title;
          if (!cur.project && rec.meta.project) cur.project = rec.meta.project;
          if (rec.meta.firstTs && Number.isFinite(rec.meta.firstTs) && rec.meta.firstTs < cur.firstTs) cur.firstTs = rec.meta.firstTs;
        }
        break;
      }
      case "limit": {
        const dup = this.meta.limits.some((l) => l.agent === rec.hit.agent && Math.abs(l.ts - rec.hit.ts) < 60_000);
        if (!dup) this.meta.limits.push(rec.hit);
        break;
      }
      case "ratelimit": {
        const cur = this.meta.rateLimits[rec.snapshot.agent];
        if (!cur || rec.snapshot.ts >= cur.ts) this.meta.rateLimits[rec.snapshot.agent] = rec.snapshot;
        break;
      }
    }
  }

  private readFile(root: LogRoot, file: string, fresh: UsageEvent[], titles: boolean) {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return;
    }
    let fs0 = this.files[file];
    if (fs0 && st.size === fs0.size && st.mtimeMs === fs0.mtimeMs) return;
    if (!fs0 || st.size < fs0.offset) fs0 = { size: 0, mtimeMs: 0, offset: 0 };
    if (root.agent === "codex" && !fs0.codex) fs0.codex = { session: path.basename(file, ".jsonl"), project: "", model: "" };

    const fd = fs.openSync(file, "r");
    const CHUNK = 8 * 1024 * 1024;
    let offset = fs0.offset;
    let carry = Buffer.alloc(0);
    try {
      while (offset + carry.length < st.size) {
        const want = Math.min(CHUNK, st.size - offset - carry.length);
        const chunk = Buffer.alloc(want);
        const read = fs.readSync(fd, chunk, 0, want, offset + carry.length);
        if (read <= 0) break;
        const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, read)]) : chunk.subarray(0, read);
        const lastNl = buf.lastIndexOf(0x0a);
        if (lastNl === -1) {
          carry = buf;
          continue;
        }
        let pos = 0;
        while (pos <= lastNl) {
          const nl = buf.indexOf(0x0a, pos);
          const line = buf.subarray(pos, nl).toString("utf8");
          const lineOffset = offset + pos;
          pos = nl + 1;
          if (!line.trim()) continue;
          const recs =
            root.agent === "codex" ? parseCodexLine(line, file, lineOffset, fs0.codex!) : parseClaudeLine(line, file);
          for (const r of recs) {
            if (!titles && r.kind === "session") r.meta.title = undefined;
            this.apply(r, fresh);
          }
        }
        offset += lastNl + 1;
        carry = Buffer.from(buf.subarray(lastNl + 1));
      }
      // Only complete lines are consumed; a partial trailing line is re-read next scan.
      this.files[file] = { ...fs0, size: st.size, mtimeMs: st.mtimeMs, offset };
    } finally {
      fs.closeSync(fd);
    }
  }

  scan(opts: { extraPaths?: string[]; titles?: boolean; defaults?: boolean } = {}): ScanResult {
    const fresh: UsageEvent[] = [];
    const roots = logRoots(opts.extraPaths, opts.defaults !== false);
    const summary: ScanResult["roots"] = [];
    let filesScanned = 0;
    for (const root of roots) {
      const files = walk(root.dir);
      if (files.length) summary.push({ agent: root.agent, dir: root.dir, files: files.length });
      for (const f of files) {
        this.readFile(root, f, fresh, opts.titles !== false);
        filesScanned++;
      }
    }
    if (fresh.length) fs.appendFileSync(this.eventsFile, fresh.map((e) => JSON.stringify(e)).join("\n") + "\n");
    this.meta.limits.sort((a, b) => a.ts - b.ts);
    fs.writeFileSync(this.stateFile, JSON.stringify({ version: STATE_VERSION, files: this.files }));
    fs.writeFileSync(this.metaFile, JSON.stringify(this.meta));
    return { filesScanned, newEvents: fresh.length, roots: summary };
  }

  reset() {
    for (const f of [this.eventsFile, this.stateFile, this.metaFile]) fs.rmSync(f, { force: true });
    this.files = {};
    this.events = [];
    this.keys.clear();
    this.meta = { sessions: {}, limits: [], rateLimits: {} };
  }
}
