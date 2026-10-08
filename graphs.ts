// Pure SVG graph renderer — zero native addons, no memory leaks.
// SVG → PNG via `sharp` (pure wasm build, safe for bun --compile).
// Install: bun add sharp

import { dbSys, dbNet, parseStamp } from "./db";
import { monthCumulativeSeries, lastMonthPeak, readAllMonthPeaks } from "./quota";
import type { ClassicLevel } from "classic-level";

// ── Cache ─────────────────────────────────────────────────────────────────────
export const LAST_PNG: Record<string, Buffer> = {};

// ── TZ offset (UTC+3, same as original Python) ────────────────────────────────
const LOCAL_OFFSET_MS = 3 * 3600 * 1000;
function toLocal(d: Date): Date { return new Date(d.getTime() + LOCAL_OFFSET_MS); }

// ── Palette ───────────────────────────────────────────────────────────────────
const COLORS = ["#e05c5c", "#5c9be0", "#5ce09b", "#e0c45c"];
const BG     = "#1e1e2e";
const GRID   = "#2e2e42";
const TICK   = "#888888";
const TITLE_C = "#dddddd";

interface Series { label: string; values: number[]; dash?: boolean }

function escXml(s: string): string {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── Pure-JS SVG builder ───────────────────────────────────────────────────────
function buildSvg(times: Date[], series: Series[], title: string): string {
  const W = 1200, H = 420;
  const PAD = { top: 44, right: 24, bottom: 70, left: 64 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top  - PAD.bottom;

  if (times.length === 0) return "";

  const allVals = series.flatMap(s => s.values).filter(Number.isFinite);
  const minV = Math.min(0, ...allVals);
  const maxV = Math.max(...allVals) || 1;
  const rangeV = (maxV - minV) || 1;

  const minT = times[0].getTime();
  const maxT = (times[times.length - 1].getTime()) || (minT + 1);
  const rangeT = (maxT - minT) || 1;

  const xOf = (d: Date) => PAD.left + ((d.getTime() - minT) / rangeT) * plotW;
  const yOf = (v: number) => PAD.top  + plotH - ((v - minV) / rangeV) * plotH;

  // X ticks — aligned to clock boundaries (30min/1h/2h/3h/6h/12h/24h)
  const STEP_CANDIDATES_MS = [
    30 * 60_000,
    60 * 60_000,
    2  * 3600_000,
    3  * 3600_000,
    6  * 3600_000,
    12 * 3600_000,
    24 * 3600_000,
  ];
  const tickStepMs = STEP_CANDIDATES_MS.find(s => rangeT / s <= 14 && rangeT / s >= 4)
                  ?? STEP_CANDIDATES_MS[STEP_CANDIDATES_MS.length - 1];

  // first tick: round minT up to the nearest step boundary in local TZ
  const firstTickMs = Math.ceil((minT + LOCAL_OFFSET_MS) / tickStepMs) * tickStepMs - LOCAL_OFFSET_MS;

  const xTicksSvg: string[] = [];
  for (let t = firstTickMs; t <= maxT; t += tickStepMs) {
    const x = xOf(new Date(t));
    if (x < PAD.left + 10 || x > PAD.left + plotW - 10) continue;
    const local = toLocal(new Date(t));
    const hh = String(local.getUTCHours()).padStart(2,"0");
    const mm = String(local.getUTCMinutes()).padStart(2,"0");
    const dd = String(local.getUTCDate()).padStart(2,"0");
    const mo = String(local.getUTCMonth()+1).padStart(2,"0");
    const xs = x.toFixed(1);
    xTicksSvg.push(
      `<line x1="${xs}" y1="${PAD.top}" x2="${xs}" y2="${PAD.top+plotH}" stroke="${GRID}" stroke-width="1"/>`,
      `<text x="${xs}" y="${PAD.top+plotH+16}" fill="${TICK}" font-size="11" text-anchor="middle">${mo}-${dd}</text>`,
      `<text x="${xs}" y="${PAD.top+plotH+30}" fill="${TICK}" font-size="11" text-anchor="middle">${hh}:${mm}</text>`
    );
  }

  // Y ticks
  const Y_STEPS = 6;
  const yTicksSvg: string[] = [];
  for (let i = 0; i <= Y_STEPS; i++) {
    const v = minV + (rangeV * i) / Y_STEPS;
    const y = yOf(v).toFixed(1);
    yTicksSvg.push(
      `<line x1="${PAD.left}" y1="${y}" x2="${PAD.left+plotW}" y2="${y}" stroke="${GRID}" stroke-width="1"/>`,
      `<text x="${PAD.left-8}" y="${+y+4}" fill="${TICK}" font-size="11" text-anchor="end">${v.toFixed(1)}</text>`
    );
  }

  // Series polylines + legend
  const polylines: string[] = [];
  const legend: string[] = [];
  for (let si = 0; si < series.length; si++) {
    const s   = series[si];
    const col = COLORS[si % COLORS.length];
    const pts = s.values.map((v, i) => `${xOf(times[i]).toFixed(1)},${yOf(v).toFixed(1)}`).join(" ");
    polylines.push(
      `<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2"` +
      (s.dash ? ` stroke-dasharray="6,4"` : "") + `/>`
    );
    const lx = PAD.left + si * 200;
    const ly = H - 14;
    legend.push(
      `<line x1="${lx}" y1="${ly}" x2="${lx+22}" y2="${ly}" stroke="${col}" stroke-width="2"` +
      (s.dash ? ` stroke-dasharray="6,4"` : "") + `/>`,
      `<text x="${lx+28}" y="${ly+4}" fill="${TICK}" font-size="12">${escXml(s.label)}</text>`
    );
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DejaVu Sans,Liberation Sans,FreeSans,Arial,sans-serif">`,
    `<rect width="${W}" height="${H}" fill="${BG}"/>`,
    `<text x="${W/2}" y="26" fill="${TITLE_C}" font-size="15" font-weight="bold" text-anchor="middle">${escXml(title)}</text>`,
    ...yTicksSvg,
    ...xTicksSvg,
    `<rect x="${PAD.left}" y="${PAD.top}" width="${plotW}" height="${plotH}" fill="none" stroke="${GRID}"/>`,
    ...polylines,
    ...legend,
    `</svg>`
  ].join("\n");
}



// ── SVG → PNG (sharp, pure-wasm, no native node addon) ───────────────────────
let _sharp: any = null;
async function getSharp() {
  if (_sharp) return _sharp;
  if (!process.env.FONTCONFIG_PATH) {
    process.env.FONTCONFIG_PATH = "/etc/fonts";
  }
  _sharp = (await import("sharp")).default;
  return _sharp;
}

async function svgToPng(svg: string): Promise<Buffer> {
  const sharp = await getSharp();
  return sharp(Buffer.from(svg)).png().toBuffer() as Promise<Buffer>;
}

// ── Read metric series from LevelDB ──────────────────────────────────────────
async function readSeries(
  metric: string,
  db: ClassicLevel<string, string>,
  mode: "24h" | "month" | "day",
  dateStr?: string
): Promise<{ times: Date[]; vals: number[]; vals2: number[] }> {
  const now    = new Date();
  const cutoff = mode === "24h"
    ? new Date(now.getTime() - 24 * 3600_000)
    : new Date(now.getTime() - 30 * 24 * 3600_000);

  const prefix = `${metric}:`;
  const times: Date[] = [], vals: number[] = [], vals2: number[] = [];

  for await (const [k, v] of db.iterator({ gte: prefix, lt: `${metric};\x00` })) {
    try {
      const dt = parseStamp(k.slice(prefix.length));
      if (!dt) continue;

      if (mode === "day" && dateStr) {
        const local = toLocal(dt);
        const day = `${local.getUTCFullYear()}-${String(local.getUTCMonth()+1).padStart(2,"0")}-${String(local.getUTCDate()).padStart(2,"0")}`;
        if (day !== dateStr) continue;
      } else if (mode !== "day" && dt < cutoff) continue;

      const parts = v.split(",");
      if (metric === "total" && parts.length === 2) {
        const u = parseFloat(parts[0]), d = parseFloat(parts[1]);
        if (!isFinite(u) || !isFinite(d)) continue;
        times.push(dt); vals.push(u); vals2.push(d);
      } else {
        const val = parseFloat(parts[0]);
        if (!isFinite(val)) continue;
        times.push(dt); vals.push(val);
      }
    } catch {}
  }

  const idx = [...times.keys()].sort((a, b) => times[a].getTime() - times[b].getTime());
  return {
    times: idx.map(i => times[i]),
    vals:  idx.map(i => vals[i]),
    vals2: idx.map(i => vals2[i] ?? 0),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────
export async function buildGraph(
  metric: string,
  db: ClassicLevel<string, string>,
  mode: "24h" | "month" | "day" = "24h",
  dateStr?: string
): Promise<Buffer | null> {
  const { times, vals, vals2 } = await readSeries(metric, db, mode, dateStr);
  if (times.length === 0) return null;

  const suffix = mode === "month" ? "30 days" : mode === "day" ? (dateStr ?? "") : "24H";
  const title  = `${metric.toUpperCase()} ${suffix}`;

  const series: Series[] = metric === "total"
    ? [
        { label: "Upload (Mbit/s)",   values: vals  },
        { label: "Download (Mbit/s)", values: vals2, dash: true },
      ]
    : [{ label: metric.toUpperCase(), values: vals }];

  const svg = buildSvg(times, series, title);
  if (!svg) return null;
  return svgToPng(svg);
}

// ── Month traffic graph (current month + last month peak reference line) ──────
export async function buildMonthTrafficGraph(): Promise<Buffer | null> {
  const { times, upGB, downGB, totalGB } = await monthCumulativeSeries();
  if (times.length === 0) return null;

  const now   = new Date();
  const title = `Traffic (UTC) — ${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

  const series: Series[] = [
    { label: "Up (GB)",    values: upGB    },
    { label: "Down (GB)",  values: downGB  },
    { label: "Total (GB)", values: totalGB, dash: true },
  ];

  // Reference line from the dedicated peak store (written at month rollover)
  const prev = await lastMonthPeak(now);
  if (prev !== null) {
    const prevTotalGB = (prev.upB + prev.dnB) / 1e9;
    series.push({
      label: `Last month ${prev.ym} (${prevTotalGB.toFixed(2)} GB)`,
      values: new Array(times.length).fill(prevTotalGB),
      dash: true,
    });
  }

  const svg = buildSvg(times, series, title);
  if (!svg) return null;
  return svgToPng(svg);
}

// ── SVG builder with categorical month labels on X axis ──────────────────────
function buildMonthSvg(labels: string[], values: number[], title: string, curYm: string): string {
  const W = 1200, H = 420;
  const PAD = { top: 44, right: 24, bottom: 54, left: 72 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top  - PAD.bottom;

  const n = labels.length;
  if (n === 0) return "";

  const maxV  = Math.max(...values.filter(Number.isFinite)) || 1;
  const yOf   = (v: number) => PAD.top + plotH - (v / maxV) * plotH;
  const xOf   = (i: number) => PAD.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);

  // Y grid + ticks
  const Y_STEPS = 6;
  const yElems: string[] = [];
  for (let i = 0; i <= Y_STEPS; i++) {
    const v = (maxV * i) / Y_STEPS;
    const y = yOf(v).toFixed(1);
    yElems.push(
      `<line x1="${PAD.left}" y1="${y}" x2="${PAD.left + plotW}" y2="${y}" stroke="${GRID}" stroke-width="1"/>`,
      `<text x="${PAD.left - 8}" y="${+y + 4}" fill="${TICK}" font-size="11" text-anchor="end">${v.toFixed(2)}</text>`
    );
  }

  // X labels + vertical grid lines
  // Show every label if n≤12, otherwise thin out to avoid overlap
  const step = n <= 12 ? 1 : Math.ceil(n / 12);
  const xElems: string[] = [];
  for (let i = 0; i < n; i++) {
    const x  = xOf(i).toFixed(1);
    const isCur = labels[i] === curYm;
    xElems.push(
      `<line x1="${x}" y1="${PAD.top}" x2="${x}" y2="${PAD.top + plotH}" stroke="${GRID}" stroke-width="1"/>`
    );
    if (i % step === 0 || i === n - 1) {
      xElems.push(
        `<text x="${x}" y="${PAD.top + plotH + 18}" fill="${isCur ? "#e0c45c" : TICK}" font-size="11" text-anchor="middle" font-weight="${isCur ? "bold" : "normal"}">${escXml(labels[i])}</text>`
      );
    }
  }

  // Polyline
  const pts = values.map((v, i) => `${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(" ");

  // Dots on each point — highlight current month in yellow
  const dots = values.map((v, i) => {
    const isCur = labels[i] === curYm;
    const col   = isCur ? "#e0c45c" : COLORS[0];
    const r     = isCur ? 5 : 3;
    return `<circle cx="${xOf(i).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="${r}" fill="${col}"/>`;
  });

  // Value labels above dots (show for sparse data; hide when crowded)
  const valLabels = n <= 18
    ? values.map((v, i) => {
        const isCur = labels[i] === curYm;
        return `<text x="${xOf(i).toFixed(1)}" y="${(yOf(v) - 8).toFixed(1)}" fill="${isCur ? "#e0c45c" : TICK}" font-size="10" text-anchor="middle">${v.toFixed(2)}</text>`;
      })
    : [];

  // Legend
  const legendY = H - 14;
  const legend = [
    `<line x1="${PAD.left}" y1="${legendY}" x2="${PAD.left + 22}" y2="${legendY}" stroke="${COLORS[0]}" stroke-width="2"/>`,
    `<circle cx="${PAD.left + 11}" cy="${legendY}" r="3" fill="${COLORS[0]}"/>`,
    `<text x="${PAD.left + 28}" y="${legendY + 4}" fill="${TICK}" font-size="12">Total (GB)</text>`,
    `<circle cx="${PAD.left + 160}" cy="${legendY}" r="5" fill="#e0c45c"/>`,
    `<text x="${PAD.left + 172}" y="${legendY + 4}" fill="${TICK}" font-size="12">— current month</text>`,
  ];

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DejaVu Sans,Liberation Sans,FreeSans,Arial,sans-serif">`,
    `<rect width="${W}" height="${H}" fill="${BG}"/>`,
    `<text x="${W / 2}" y="26" fill="${TITLE_C}" font-size="15" font-weight="bold" text-anchor="middle">${escXml(title)}</text>`,
    ...yElems,
    ...xElems,
    `<rect x="${PAD.left}" y="${PAD.top}" width="${plotW}" height="${plotH}" fill="none" stroke="${GRID}"/>`,
    `<polyline points="${pts}" fill="none" stroke="${COLORS[0]}" stroke-width="2"/>`,
    ...dots,
    ...valLabels,
    ...legend,
    `</svg>`,
  ].join("\n");
}

// ── Monthly peaks line chart (Total GB per month) ─────────────────────────────
export async function buildMonthPeaksGraph(): Promise<Buffer | null> {
  const peaks = await readAllMonthPeaks();

  // Add current in-progress month using the latest cumulative total
  const now    = new Date();
  const { totalGB } = await monthCumulativeSeries();
  const curYm  = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const curTotalGB = totalGB[totalGB.length - 1] ?? 0;

  const allEntries = [
    ...peaks.filter(p => p.ym !== curYm),
    { ym: curYm, upB: curTotalGB * 1e9, dnB: 0 },   // dnB=0, total already in upB
  ].sort((a, b) => a.ym.localeCompare(b.ym)).slice(-24);

  if (allEntries.length === 0) return null;

  const labels = allEntries.map(e => e.ym);
  // Completed months: total = upB + dnB; current: upB already holds total GB * 1e9
  const values = allEntries.map(e =>
    e.ym === curYm ? e.upB / 1e9 : (e.upB + e.dnB) / 1e9
  );

  const svg = buildMonthSvg(labels, values, "Monthly Traffic Peaks (GB)", curYm);
  if (!svg) return null;
  return svgToPng(svg);
}

// ── Background refresher ──────────────────────────────────────────────────────
const METRICS = ["cpu", "load", "ram", "disk", "swap", "ioutil"];

export async function refreshAllGraphs() {
  for (const m of METRICS) {
    try {
      const b = await buildGraph(m, dbSys, "24h");
      delete LAST_PNG[m];
      if (b) LAST_PNG[m] = b;
    } catch (e) { console.error("[graph 24h]", m, e); }
  }
  for (const m of METRICS) {
    const key = `m_${m}`;
    try {
      const b = await buildGraph(m, dbSys, "month");
      delete LAST_PNG[key];
      if (b) LAST_PNG[key] = b;
    } catch (e) { console.error("[graph month]", m, e); }
  }
  try {
    const b = await buildMonthTrafficGraph();
    delete LAST_PNG["mtraffic"];
    if (b) LAST_PNG["mtraffic"] = b;
  } catch (e) { console.error("[graph mtraffic]", e); }

  try {
    const b = await buildMonthPeaksGraph();
    delete LAST_PNG["mpeaks"];
    if (b) LAST_PNG["mpeaks"] = b;
  } catch (e) { console.error("[graph mpeaks]", e); }
}

// Rebuild cached PNGs periodically. 5 min is plenty for a server monitor;
// on-demand commands fall back to building fresh when the cache is cold.
const REFRESH_MS = 5 * 60_000;
export function startGraphRefresher() {
  refreshAllGraphs().catch(console.error);
  setInterval(() => refreshAllGraphs().catch(console.error), REFRESH_MS);
}