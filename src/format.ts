export function usd(n: number | null | undefined, opts: { precise?: boolean } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (!opts.precise && abs >= 10_000) return `$${(n / 1000).toFixed(1)}K`;
  if (abs > 0 && abs < 0.01) return "<$0.01";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function tokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

export function duration(ms: number): string {
  if (ms <= 0) return "0m";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** "15:40" today, "Thu 15:40" within a week, else a date. */
export function when(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (sameDay) return clock(ts);
  if (Math.abs(ts - now) < 6 * 86400_000) return `${d.toLocaleDateString("en-GB", { weekday: "short" })} ${clock(ts)}`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function shortProject(p: string): string {
  if (!p) return "(unknown)";
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/") || p;
}
