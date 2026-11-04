import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { summarize } from "./aggregate.js";
import { loadConfig, PLAN_PRESETS, saveConfig, type Config } from "./config.js";
import { PriceBook } from "./pricing.js";
import { Store } from "./store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ASSETS: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/styles.css": "styles.css",
  "/favicon.svg": "favicon.svg",
};
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

function send(res: http.ServerResponse, status: number, body: string | Buffer, type = "application/json") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'",
    "Referrer-Policy": "no-referrer",
  });
  res.end(body);
}

function readBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

export function createServer(opts: { dataDir: string; extraPaths?: string[]; titles?: boolean; defaults?: boolean; port: number }) {
  const store = new Store(opts.dataDir).load();
  let lastScan = 0;
  const allowedHosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`, `[::1]:${opts.port}`]);

  return http.createServer(async (req, res) => {
    try {
      // DNS-rebinding protection: only answer to localhost host headers.
      if (!req.headers.host || !allowedHosts.has(req.headers.host)) return send(res, 403, '{"error":"forbidden host"}');
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (req.method === "GET" && ASSETS[url.pathname]) {
        const file = path.join(here, "dashboard", ASSETS[url.pathname]);
        return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)]);
      }

      if (req.method === "GET" && url.pathname === "/api/summary") {
        if (Date.now() - lastScan > 2000) {
          store.scan({ extraPaths: opts.extraPaths, titles: opts.titles, defaults: opts.defaults });
          lastScan = Date.now();
        }
        const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 30, 1), 365);
        const cfg = loadConfig(opts.dataDir);
        const s = summarize(store.events, store.meta.sessions, store.meta.limits, store.meta.rateLimits, cfg, PriceBook.load(opts.dataDir), { days });
        return send(res, 200, JSON.stringify({ ...s, config: cfg, planPresets: PLAN_PRESETS }));
      }

      if (req.method === "POST" && url.pathname === "/api/config") {
        // CSRF: require same-origin JSON.
        const origin = req.headers.origin;
        if (!origin || !allowedHosts.has(new URL(origin).host) || !String(req.headers["content-type"]).startsWith("application/json")) {
          return send(res, 403, '{"error":"forbidden"}');
        }
        const body = JSON.parse(await readBody(req));
        const cfg: Config = loadConfig(opts.dataDir);
        if (body.budgets && typeof body.budgets === "object") {
          cfg.budgets = { blockUsd: num(body.budgets.blockUsd), weekUsd: num(body.budgets.weekUsd), monthUsd: num(body.budgets.monthUsd) };
        }
        if ("plan" in body) {
          const p = body.plan;
          cfg.plan = p && typeof p.name === "string" && num(p.monthlyUsd) ? { name: p.name.slice(0, 40), monthlyUsd: num(p.monthlyUsd)! } : undefined;
        }
        saveConfig(opts.dataDir, cfg);
        return send(res, 200, JSON.stringify({ ok: true, config: cfg }));
      }

      send(res, 404, '{"error":"not found"}');
    } catch (err) {
      send(res, 500, JSON.stringify({ error: err instanceof Error ? err.message : "error" }));
    }
  });
}
