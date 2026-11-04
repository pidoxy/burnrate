// Burnrate dashboard — vanilla JS, no dependencies. All labels inserted with textContent.
const $ = (id) => document.getElementById(id);
const SVGNS = "http://www.w3.org/2000/svg";
const AGENTS = { "claude-code": { name: "Claude Code", color: "var(--series-1)" }, codex: { name: "Codex", color: "var(--series-2)" } };
const agentInfo = (a) => AGENTS[a] ?? { name: a, color: "var(--series-3)" };

let days = 30;
try { days = Number(localStorage.getItem("burnrate.days")) || 30; } catch {}
let data = null;
let showTable = false;

// ───────── formatting ─────────
const usd = (n, precise = false) => {
  if (n == null || !Number.isFinite(n)) return "—";
  if (!precise && Math.abs(n) >= 10000) return `$${(n / 1000).toFixed(1)}K`;
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const compactUsd = (n) => (n >= 1000 ? `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : n >= 100 || n === 0 ? `$${Math.round(n)}` : `$${n.toFixed(n < 10 ? 2 : 1).replace(/\.?0+$/, "")}`);
const tok = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const dur = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
};
const when = (ts) => {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return `Today ${clock(ts)}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${clock(ts)}`;
  return d.toLocaleDateString([], { day: "numeric", month: "short" }) + " " + clock(ts);
};
const shortProject = (p) => (p ? p.split(/[\\/]/).filter(Boolean).slice(-2).join("/") || p : "(unknown)");
const dayLabel = (iso, long = false) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], long ? { weekday: "short", day: "numeric", month: "short" } : { day: "numeric", month: "short" });
};

// ───────── DOM helpers ─────────
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") Object.assign(el.style, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  for (const c of children.flat()) if (c) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const setText = (id, t) => ($(id).textContent = t);

// ───────── tooltip ─────────
const tip = $("tooltip");
function showTip(evt, title, rows) {
  tip.replaceChildren(
    h("div", { class: "tt-title" }, title),
    ...rows.map((r) =>
      h("div", { class: "tt-row" }, r.color ? h("span", { class: "tt-key", style: { background: r.color } }) : null, h("span", { class: "tt-val" }, r.value), h("span", { class: "tt-name" }, r.name ?? "")),
    ),
  );
  tip.hidden = false;
  const rect = evt.currentTarget?.getBoundingClientRect?.() ?? { left: evt.clientX, top: evt.clientY, width: 0 };
  const x = evt.clientX ?? rect.left + rect.width / 2;
  const y = evt.clientY ?? rect.top;
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  tip.style.left = `${Math.min(window.innerWidth - tw - 8, Math.max(8, x + 14))}px`;
  tip.style.top = `${Math.max(8, y - th - 12)}px`;
}
const hideTip = () => (tip.hidden = true);

// ───────── scales ─────────
function niceMax(v, ticks = 4) {
  if (v <= 0) return { max: 1, step: 0.25 };
  const raw = v / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  return { max: step * Math.ceil(v / step), step };
}

// ───────── charts ─────────
function dailyChart(el, daily) {
  const W = Math.max(el.clientWidth, 320), H = 220, P = { l: 48, r: 8, t: 10, b: 26 };
  const agents = Object.keys(AGENTS).filter((a) => daily.some((d) => d.byAgent[a]));
  for (const d of daily) for (const a of Object.keys(d.byAgent)) if (!agents.includes(a)) agents.push(a);
  const { max, step } = niceMax(Math.max(...daily.map((d) => d.total), 0));
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const band = iw / daily.length;
  const bw = Math.max(2, Math.min(24, band * 0.62));
  const y = (v) => P.t + ih - (v / max) * ih;
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Daily spend, last ${daily.length} days` });
  const grid = s("g", { class: "grid" });
  for (let v = 0; v <= max + 1e-9; v += step) {
    grid.append(s("line", { x1: P.l, x2: W - P.r, y1: y(v), y2: y(v) }));
    grid.append(s("text", { class: "axis-text", x: P.l - 8, y: y(v) + 4, "text-anchor": "end" }, compactUsd(v)));
  }
  svg.append(grid);
  const every = Math.ceil(daily.length / Math.floor(iw / 64));
  daily.forEach((d, i) => {
    const cx = P.l + band * i + band / 2;
    const g = s("g", { class: "col", tabindex: "0", "aria-label": `${dayLabel(d.date, true)}: ${usd(d.total)}` });
    let acc = 0;
    const segs = agents.filter((a) => d.byAgent[a] > 0);
    segs.forEach((a, si) => {
      const v = d.byAgent[a];
      const y0 = y(acc), y1 = y(acc + v);
      acc += v;
      const gap = si > 0 ? 2 : 0; // 2px surface gap between stacked segments
      const top = y1, bottom = y0 - gap;
      const hgt = Math.max(0, bottom - top);
      if (hgt <= 0) return;
      const r = si === segs.length - 1 ? Math.min(4, hgt, bw / 2) : 0; // rounded data-end only
      const x0 = cx - bw / 2, x1 = cx + bw / 2;
      const path = `M${x0},${bottom} L${x0},${top + r} Q${x0},${top} ${x0 + r},${top} L${x1 - r},${top} Q${x1},${top} ${x1},${top + r} L${x1},${bottom} Z`;
      g.append(s("path", { d: path, fill: agentInfo(a).color, class: "bar" }));
    });
    g.append(s("rect", { class: "hit", x: P.l + band * i, y: P.t, width: band, height: ih }));
    const rows = () => [
      { value: usd(d.total), name: "total" },
      ...agents.filter((a) => d.byAgent[a]).map((a) => ({ value: usd(d.byAgent[a]), name: agentInfo(a).name, color: agentInfo(a).color })),
    ];
    g.addEventListener("pointermove", (e) => showTip(e, dayLabel(d.date, true), rows()));
    g.addEventListener("pointerleave", hideTip);
    g.addEventListener("focus", (e) => showTip(e, dayLabel(d.date, true), rows()));
    g.addEventListener("blur", hideTip);
    svg.append(g);
    if (i % every === (daily.length - 1) % every) svg.append(s("text", { class: "axis-text", x: cx, y: H - 6, "text-anchor": "middle" }, dayLabel(d.date)));
  });
  svg.append(s("line", { class: "baseline", x1: P.l, x2: W - P.r, y1: y(0), y2: y(0) }));
  el.replaceChildren(svg);

  $("daily-legend").replaceChildren(
    ...(agents.length > 1 || agents.length === 1
      ? agents.map((a) => h("span", {}, h("span", { class: "key", style: { background: agentInfo(a).color } }), agentInfo(a).name))
      : []),
  );
}

function blockChart(el, b) {
  const W = Math.max(el.clientWidth, 320), H = 180, P = { l: 48, r: 14, t: 14, b: 24 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const top = Math.max(b.budget ?? 0, b.projected, b.cost, 0.01) * 1.08;
  const { max, step } = niceMax(top);
  const x = (t) => P.l + ((t - b.start) / (b.end - b.start)) * iw;
  const y = (v) => P.t + ih - (v / max) * ih;
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Spend this block: ${usd(b.cost)}` });
  const grid = s("g", { class: "grid" });
  for (let v = 0; v <= max + 1e-9; v += step) {
    grid.append(s("line", { x1: P.l, x2: W - P.r, y1: y(v), y2: y(v) }));
    grid.append(s("text", { class: "axis-text", x: P.l - 8, y: y(v) + 4, "text-anchor": "end" }, compactUsd(v)));
  }
  svg.append(grid);
  for (let t = b.start; t <= b.end; t += 3600_000) svg.append(s("text", { class: "axis-text", x: x(t), y: H - 6, "text-anchor": t === b.start ? "start" : t === b.end ? "end" : "middle" }, clock(t)));

  const pts = b.series.map((p) => [x(p.t), y(p.cost)]);
  if (pts.length) {
    const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    const last = pts[pts.length - 1];
    svg.append(s("path", { d: `${line} L${last[0]},${y(0)} L${pts[0][0]},${y(0)} Z`, fill: "var(--series-1)", "fill-opacity": "0.1" }));
    if (b.active && b.remainingMs > 0) {
      // Projection: same hue, recessive.
      svg.append(s("path", { d: `M${last[0]},${last[1]} L${x(b.end)},${y(b.projected)}`, stroke: "var(--series-1)", "stroke-opacity": "0.35", "stroke-width": 2, fill: "none", "stroke-linecap": "round" }));
      svg.append(s("text", { class: "axis-text", x: x(b.end) - 4, y: y(b.projected) - 8, "text-anchor": "end" }, `projected ${usd(b.projected)}`));
    }
    svg.append(s("path", { d: line, stroke: "var(--series-1)", "stroke-width": 2, fill: "none", "stroke-linejoin": "round", "stroke-linecap": "round" }));
    svg.append(s("circle", { cx: last[0], cy: last[1], r: 6, fill: "var(--surface)" }));
    svg.append(s("circle", { cx: last[0], cy: last[1], r: 4, fill: "var(--series-1)" }));
  }
  if (b.budget) {
    svg.append(s("line", { class: "ref-line", x1: P.l, x2: W - P.r, y1: y(b.budget), y2: y(b.budget) }));
    svg.append(s("text", { class: "ref-text", x: P.l + 6, y: y(b.budget) - 6 }, `${b.budgetSource === "learned" ? "Learned cap" : "Budget"} ${usd(b.budget)}`));
  }
  if (b.hitsBudgetAt) {
    svg.append(s("circle", { cx: x(b.hitsBudgetAt), cy: y(b.budget), r: 4, fill: "var(--critical)" }));
  }
  svg.append(s("line", { class: "baseline", x1: P.l, x2: W - P.r, y1: y(0), y2: y(0) }));

  // Crosshair + tooltip snapping to the nearest bucket.
  const cross = s("line", { class: "crosshair", y1: P.t, y2: P.t + ih, visibility: "hidden" });
  const hit = s("rect", { class: "hit", x: P.l, y: P.t, width: iw, height: ih });
  svg.append(cross, hit);
  hit.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = b.series[0], bd = Infinity;
    for (const p of b.series) {
      const d = Math.abs(x(p.t) - px);
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) return;
    cross.setAttribute("x1", x(best.t)); cross.setAttribute("x2", x(best.t)); cross.setAttribute("visibility", "visible");
    showTip(e, clock(best.t), [{ value: usd(best.cost), name: "spent so far", color: "var(--series-1)" }]);
  });
  hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); hideTip(); });
  el.replaceChildren(svg);
}

// ───────── tables ─────────
function table(el, columns, rows, initialSort) {
  let sort = initialSort;
  const render = () => {
    const sorted = [...rows].sort((a, b) => {
      const c = columns.find((c) => c.key === sort.key);
      const va = c.sortValue ? c.sortValue(a) : a[c.key], vb = c.sortValue ? c.sortValue(b) : b[c.key];
      return (va > vb ? 1 : va < vb ? -1 : 0) * (sort.dir === "asc" ? 1 : -1);
    });
    const head = h("tr", {}, columns.map((c) =>
      h("th", {
        class: c.num ? "num" : "",
        scope: "col",
        "aria-sort": sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : null,
        tabindex: "0",
        onclick: () => { sort = { key: c.key, dir: sort.key === c.key && sort.dir === "desc" ? "asc" : "desc" }; render(); },
        onkeydown: (e) => { if (e.key === "Enter") e.currentTarget.click(); },
      }, c.label),
    ));
    const cell = (r, c) => h("td", { class: c.num ? "num" : "" }, c.render ? c.render(r) : String(r[c.key] ?? ""));
    const body = sorted.map((r) => h("tr", {}, columns.map((c) => cell(r, c))));
    el.replaceChildren(h("table", {}, h("thead", {}, head), h("tbody", {}, body)));
  };
  render();
}

function costCell(v, max) {
  return h("div", { class: "cost-cell" }, h("span", { class: "inline-bar", style: { width: `${Math.max(2, (v / (max || 1)) * 60)}px` } }), usd(v));
}

// ───────── render ─────────
function render(d) {
  data = d;
  const t = d.totals;
  const empty = !d.eventCount;
  $("empty").hidden = !empty;
  document.querySelectorAll("main > :not(#empty)").forEach((n) => (n.hidden = empty));
  setText("updated", `Updated ${clock(d.generatedAt)}`);
  setText("footer-meta", `${d.eventCount.toLocaleString()} billed messages · ${d.timezone}`);
  if (empty) return;

  setText("today", usd(t.today));
  const diff = t.today - t.yesterday;
  $("today-sub").replaceChildren(
    `${tok(t.tokensToday)} tokens · `,
    t.yesterday > 0 ? h("span", { class: diff > 0 ? "delta-up" : "delta-down" }, `${diff > 0 ? "▲" : "▼"} ${usd(Math.abs(diff))} vs yesterday`) : "nothing yesterday",
  );
  setText("last7", usd(t.last7));
  setText("last7-sub", `avg ${usd(t.last7 / 7)}/day`);
  setText("mtd", usd(t.mtd));
  setText("mtd-sub", `on track for ~${usd(t.monthProjection)}${d.month.budget ? ` of ${usd(d.month.budget)}` : ""}`);
  if (d.plan?.valueMultiple) {
    setText("value-label", `${d.plan.name} value`);
    setText("value", `${d.plan.valueMultiple.toFixed(1)}×`);
    setText("value-sub", `~${usd(t.monthProjection)} of API usage for ${usd(d.plan.monthlyUsd)}/mo`);
  } else {
    setText("value-label", "Prompt caching saved");
    setText("value", usd(t.cacheSavings30d));
    setText("value-sub", "in the last 30 days");
  }

  // Block
  const b = d.block;
  const alertEl = $("block-alert");
  if (b) {
    setText("block-title", b.active ? "Current 5-hour block" : "Last 5-hour block");
    setText("block-range", `${when(b.start)} – ${clock(b.end)}${b.active ? ` · ${dur(b.remainingMs)} left` : " · ended"}`);
    $("block-stats").replaceChildren(
      h("div", { class: "stat" }, h("div", { class: "v" }, usd(b.cost)), h("div", { class: "k" }, "spent")),
      h("div", { class: "stat" }, h("div", { class: "v" }, b.active ? `${usd(b.burnPerHour)}/h` : "—"), h("div", { class: "k" }, "burn rate (last hour)")),
      h("div", { class: "stat" }, h("div", { class: "v" }, b.active ? usd(b.projected) : usd(b.cost)), h("div", { class: "k" }, b.active ? "projected at reset" : "total")),
      h("div", { class: "stat" }, h("div", { class: "v" }, tok(b.tokens)), h("div", { class: "k" }, "tokens")),
    );
    const icon = () => {
      const sv = s("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "aria-hidden": "true" });
      sv.append(s("path", { d: "M12 4 2.5 20h19z" }), s("path", { d: "M12 10v4.5M12 17.5v.01" }));
      return sv;
    };
    if (b.active && b.budget && b.percent >= 1) {
      alertEl.className = "alert critical";
      alertEl.replaceChildren(icon(), h("span", {}, h("strong", {}, "Over budget. "), `${usd(b.cost)} of ${usd(b.budget)} — the block resets at ${clock(b.end)}.`));
      alertEl.hidden = false;
    } else if (b.hitsBudgetAt) {
      alertEl.className = "alert warning";
      alertEl.replaceChildren(icon(), h("span", {}, "At ", h("strong", {}, `${usd(b.burnPerHour)}/h`), " you'll hit your ", b.budgetSource === "learned" ? "learned cap" : "budget", " at ", h("strong", {}, clock(b.hitsBudgetAt)), ` — ${dur(b.hitsBudgetAt - Date.now())} from now, ${dur(b.end - b.hitsBudgetAt)} before the reset.`));
      alertEl.hidden = false;
    } else if (b.active && b.budget) {
      alertEl.className = "alert good";
      alertEl.replaceChildren(h("span", {}, `On pace: projected ${usd(b.projected)} of ${usd(b.budget)} by ${clock(b.end)}.`));
      alertEl.hidden = false;
    } else alertEl.hidden = true;

    const mw = $("meter-wrap");
    if (b.budget) {
      mw.hidden = false;
      const pct = Math.min(100, (b.percent ?? 0) * 100);
      const fill = $("meter-fill");
      fill.style.width = `${pct}%`;
      fill.className = `meter-fill ${b.percent >= 1 ? "critical" : b.percent >= 0.8 ? "warning" : ""}`;
      $("meter").setAttribute("aria-valuenow", String(Math.round(pct)));
      setText("meter-label", `${Math.round((b.percent ?? 0) * 100)}% of ${b.budgetSource === "learned" ? "learned cap" : "block budget"} (${usd(b.budget)})`);
    } else mw.hidden = true;
    blockChart($("block-chart"), b);
  }
  // Codex-reported limits
  const rl = $("ratelimits");
  rl.replaceChildren();
  const rlItems = [];
  for (const r of d.rateLimits) {
    for (const [label, w] of [["5-hour window", r.primary], ["Weekly window", r.secondary]]) {
      if (!w) continue;
      const pct = Math.min(100, w.usedPercent);
      const fill = h("div", { class: `meter-fill ${pct >= 100 ? "critical" : pct >= 80 ? "warning" : ""}`, style: { width: `${pct}%` } });
      rlItems.push(h("div", { class: "rl-item" }, h("div", {}, h("strong", {}, agentInfo(r.agent).name), ` · ${label}`), h("div", { class: "meter", role: "meter", "aria-valuenow": String(Math.round(pct)), "aria-valuemin": "0", "aria-valuemax": "100" }, fill), h("div", { class: "sub" }, `${Math.round(w.usedPercent)}% used (reported)${w.resetsAt ? ` · resets ${when(w.resetsAt)}` : ""}`)));
    }
  }
  if (rlItems.length) rl.append(h("div", { class: "rl" }, rlItems));

  // Daily
  const total = d.daily.reduce((a, x) => a + x.total, 0);
  setText("daily-sub", `${usd(total)} over ${d.daily.length} days · ${d.agents.map((a) => `${agentInfo(a.agent).name} ${usd(a.cost)}`).join(" · ")}`);
  dailyChart($("daily-chart"), d.daily);
  table($("daily-table"), [
    { key: "date", label: "Day", render: (r) => dayLabel(r.date, true) },
    ...Object.keys(AGENTS).filter((a) => d.daily.some((x) => x.byAgent[a])).map((a) => ({ key: a, label: agentInfo(a).name, num: true, sortValue: (r) => r.byAgent[a] ?? 0, render: (r) => usd(r.byAgent[a] ?? 0) })),
    { key: "tokens", label: "Tokens", num: true, render: (r) => tok(r.tokens) },
    { key: "total", label: "Total", num: true, render: (r) => usd(r.total) },
  ], [...d.daily].reverse(), { key: "date", dir: "desc" });
  $("daily-chart").hidden = showTable;
  $("daily-table").hidden = !showTable;

  // Sessions
  const maxS = d.sessions[0]?.cost ?? 1;
  if (d.sessions.length) {
    table($("sessions"), [
      { key: "title", label: "Session", render: (r) => h("div", {}, h("span", { class: "title", title: r.title ?? r.id }, h("span", { class: "dot", style: { background: agentInfo(r.agent).color } }), r.title ?? `Session ${r.id.slice(0, 8)}`), h("span", { class: "meta" }, `${shortProject(r.project)} · ${when(r.start)} · ${dur(r.end - r.start)} · ${r.models.map((m) => m.replace(/^claude-/, "")).join(", ")}`)) },
      { key: "tokens", label: "Tokens", num: true, render: (r) => tok(r.tokens) },
      { key: "cost", label: "Cost", num: true, render: (r) => costCell(r.cost, maxS) },
    ], d.sessions.slice(0, 12), { key: "cost", dir: "desc" });
  } else $("sessions").replaceChildren(h("p", { class: "empty-note" }, "No sessions in this range."));

  const maxP = d.projects[0]?.cost ?? 1;
  table($("projects"), [
    { key: "project", label: "Project", render: (r) => h("span", { class: "title", title: r.project }, shortProject(r.project)) },
    { key: "sessions", label: "Sessions", num: true },
    { key: "cost", label: "Cost", num: true, render: (r) => costCell(r.cost, maxP) },
  ], d.projects.slice(0, 20), { key: "cost", dir: "desc" });

  table($("models"), [
    { key: "model", label: "Model", render: (r) => h("span", {}, r.model, r.priced ? null : [" ", h("span", { class: "pill warn", title: "Add a price in ~/.burnrate/prices.json" }, "unpriced")]) },
    { key: "input", label: "Input", num: true, render: (r) => tok(r.input) },
    { key: "output", label: "Output", num: true, render: (r) => tok(r.output) },
    { key: "cacheRead", label: "Cache read", num: true, render: (r) => tok(r.cacheRead) },
    { key: "cacheWrite", label: "Cache write", num: true, render: (r) => tok(r.cacheWrite) },
    { key: "cost", label: "Cost", num: true, render: (r) => usd(r.cost) },
  ], d.models, { key: "cost", dir: "desc" });

  const lim = $("limits");
  if (d.limits.length) {
    lim.replaceChildren(
      ...(d.learnedCap ? [h("p", { class: "sub" }, `Learned 5-hour cap: ~${usd(d.learnedCap)} (what you had spent in the 5 hours before a recent limit hit).`)] : []),
      ...d.limits.slice(0, 8).map((l) => h("div", { class: "limit-row" }, h("span", { class: "when" }, when(l.ts)), h("span", {}, h("strong", {}, agentInfo(l.agent).name), l.blockCost != null ? ` after ${usd(l.blockCost)} in the previous 5 hours` : "", h("br"), h("span", { class: "meta sub" }, l.message)))),
    );
  } else lim.replaceChildren(h("p", { class: "empty-note" }, "No limit hits recorded. When you hit one, Burnrate learns your real cap from it."));
}

async function load() {
  $("main").classList.add("loading");
  document.querySelectorAll(".seg").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.days) === days)));
  try {
    const res = await fetch(`/api/summary?days=${days}`);
    if (!res.ok) throw new Error(await res.text());
    render(await res.json());
  } catch (err) {
    setText("updated", `Couldn't refresh: ${err.message}`);
  } finally {
    $("main").classList.remove("loading");
  }
}

// ───────── events ─────────
document.querySelectorAll(".seg").forEach((b) =>
  b.addEventListener("click", () => {
    days = Number(b.dataset.days);
    try { localStorage.setItem("burnrate.days", String(days)); } catch {}
    load();
  }),
);
$("daily-table-btn").addEventListener("click", (e) => {
  showTable = !showTable;
  e.currentTarget.setAttribute("aria-pressed", String(showTable));
  $("daily-chart").hidden = showTable;
  $("daily-table").hidden = !showTable;
});

const dlg = $("settings");
$("settings-btn").addEventListener("click", () => {
  if (!data) return;
  const f = $("settings-form");
  const c = data.config;
  f.blockUsd.value = c.budgets.blockUsd ?? "";
  f.weekUsd.value = c.budgets.weekUsd ?? "";
  f.monthUsd.value = c.budgets.monthUsd ?? "";
  const sel = $("plan-preset");
  sel.replaceChildren(h("option", { value: "" }, "None / pay-as-you-go"), ...Object.entries(data.planPresets).map(([k, p]) => h("option", { value: k }, `${p.name} — $${p.monthlyUsd}/mo`)), h("option", { value: "custom" }, "Custom…"));
  const match = Object.entries(data.planPresets).find(([, p]) => c.plan && p.name === c.plan.name);
  sel.value = c.plan ? (match ? match[0] : "custom") : "";
  f.planUsd.value = c.plan?.monthlyUsd ?? "";
  setText("learned-hint", data.learnedCap ? `Learned from your last limit hit: ~${usd(data.learnedCap)}. Leave empty to use it.` : "Leave empty to learn it from your next limit hit.");
  dlg.showModal();
});
$("plan-preset").addEventListener("change", (e) => {
  const p = data.planPresets[e.target.value];
  if (p) $("settings-form").planUsd.value = p.monthlyUsd;
});
dlg.addEventListener("close", async () => {
  if (dlg.returnValue !== "save") return;
  const f = $("settings-form");
  const preset = data.planPresets[f.planPreset.value];
  const planUsd = Number(f.planUsd.value);
  const plan = f.planPreset.value === "" ? null : { name: preset ? preset.name : "Custom plan", monthlyUsd: planUsd || preset?.monthlyUsd || 0 };
  await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ budgets: { blockUsd: Number(f.blockUsd.value) || null, weekUsd: Number(f.weekUsd.value) || null, monthUsd: Number(f.monthUsd.value) || null }, plan }),
  });
  load();
});

let resizeT;
window.addEventListener("resize", () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => data && render(data), 150);
});
load();
setInterval(() => { if (!document.hidden) load(); }, 30_000);
