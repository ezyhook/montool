import { dbNet, formatStamp, parseStamp } from "./db";

// ── Key helpers ──────────────────────────────────────────────────────────────
function monthKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `mt:${y}-${m}`;
}
function baseKey(d: Date, ifn: string): string {
  return `${monthKey(d)}:base:${ifn}`;
}
function lastAbsKey(ifn: string): string {
  return `mt:last_abs:${ifn}`;
}
function activeKey(): string { return "mtc:active"; }
function monthStr(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;
}

// ── Peak key: "mtp:YYYY-MM" ───────────────────────────────────────────────────
// Stores the final (maximum) traffic bytes for a completed month,
// written exactly once — right before the month counters are reset.
function peakKey(ym: string): string {
  return `mtp:${ym}`;
}

// ── Pair int helpers ─────────────────────────────────────────────────────────
async function dbGetPairInt(key: string): Promise<[number, number]> {
  try {
    const v = await dbNet.get(key);
    const [a, b] = v.split(",");
    return [parseInt(a, 10) || 0, parseInt(b, 10) || 0];
  } catch { return [0, 0]; }
}

async function dbPutPairInt(key: string, a: number, b: number): Promise<void> {
  await dbNet.put(key, `${Math.round(a)},${Math.round(b)}`);
}

// ── Accessors ────────────────────────────────────────────────────────────────
export async function readMonthTotals(d: Date): Promise<[number, number]> {
  return dbGetPairInt(monthKey(d));
}
export async function writeMonthTotals(d: Date, u: number, dn: number) {
  return dbPutPairInt(monthKey(d), u, dn);
}
export async function readBase(d: Date, ifn: string): Promise<[number, number]> {
  return dbGetPairInt(baseKey(d, ifn));
}
export async function writeBase(d: Date, ifn: string, tx: number, rx: number) {
  return dbPutPairInt(baseKey(d, ifn), tx, rx);
}
export async function readLastAbs(ifn: string): Promise<[number, number]> {
  return dbGetPairInt(lastAbsKey(ifn));
}
export async function writeLastAbs(ifn: string, tx: number, rx: number) {
  return dbPutPairInt(lastAbsKey(ifn), tx, rx);
}

// ── Peak accessors ────────────────────────────────────────────────────────────
/** Save the final totals for a completed month (called before reset). */
async function writeMonthPeak(ym: string, upB: number, dnB: number): Promise<void> {
  await dbPutPairInt(peakKey(ym), upB, dnB);
}

/** Read peak for a specific "YYYY-MM" string. Returns [0,0] if not found. */
export async function readMonthPeak(ym: string): Promise<[number, number]> {
  return dbGetPairInt(peakKey(ym));
}

/** Read all stored monthly peaks, sorted chronologically. */
export async function readAllMonthPeaks(): Promise<
  Array<{ ym: string; upB: number; dnB: number }>
> {
  const result: Array<{ ym: string; upB: number; dnB: number }> = [];
  // Keys are "mtp:YYYY-MM", iterate the full range
  for await (const [k, v] of dbNet.iterator({ gte: "mtp:", lt: "mtq:" })) {
    try {
      const ym = k.slice(4); // strip "mtp:"
      if (!/^\d{4}-\d{2}$/.test(ym)) continue;
      const [a, b] = v.split(",");
      result.push({ ym, upB: parseInt(a, 10) || 0, dnB: parseInt(b, 10) || 0 });
    } catch {}
  }
  // Already lexicographically sorted by key, but be explicit
  result.sort((a, b) => a.ym.localeCompare(b.ym));
  return result;
}

/** Convenience: return the peak for the month immediately before `now`. */
export async function lastMonthPeak(
  now = new Date()
): Promise<{ ym: string; upB: number; dnB: number } | null> {
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const ym   = monthStr(prev);
  const [upB, dnB] = await readMonthPeak(ym);
  if (upB === 0 && dnB === 0) return null;
  return { ym, upB, dnB };
}

// ── Interface counters from /proc/net/dev ────────────────────────────────────
export async function getIfaceCounters(ifn: string): Promise<[number, number] | null> {
  try {
    const text = await Bun.file("/proc/net/dev").text();
    for (const line of text.split("\n")) {
      const idx = line.indexOf(":");
      if (idx < 0 || line.slice(0, idx).trim() !== ifn) continue;
      const parts = line.trim().split(/\s+/);
      // parts[0]="iface:", rx_bytes=parts[1], tx_bytes=parts[9]
      return [parseInt(parts[9], 10), parseInt(parts[1], 10)]; // [tx, rx]
    }
  } catch {}
  return null;
}

// ── Default iface from /proc/net/route ────────────────────────────────────────
export async function pickDefaultIface(): Promise<string> {
  try {
    const text = await Bun.file("/proc/net/route").text();
    for (const line of text.split("\n").slice(1)) {
      const p = line.trim().split(/\s+/);
      if (p.length >= 11) {
        const [iface, dst] = p;
        const flags = parseInt(p[3], 16);
        if (dst === "00000000" && (flags & 0x1)) return iface;
      }
    }
  } catch {}
  return "";
}

let _cachedIface: string | null = null;
export async function getIface(): Promise<string> {
  const { cfg } = await import("./config");
  const c = cfg();
  if (c.NET_IFACE) return c.NET_IFACE;
  if (_cachedIface !== null) return _cachedIface;
  _cachedIface = await pickDefaultIface();
  return _cachedIface;
}

// ── MT tick (called every INTERVAL_SEC) ─────────────────────────────────────
const _mtLock = { locked: false };

export async function ensureBaseIfMissing(now: Date, ifn: string) {
  const [bTx, bRx] = await readBase(now, ifn);
  if (bTx === 0 && bRx === 0) {
    const abs = await getIfaceCounters(ifn);
    if (abs) {
      await writeBase(now, ifn, abs[0], abs[1]);
      await writeLastAbs(ifn, abs[0], abs[1]);
    }
  }
}

async function rollMonthIfNeeded(now: Date): Promise<boolean> {
  const cur = monthStr(now);
  let last = "";
  try { last = await dbNet.get(activeKey()); } catch {}
  if (last === cur) return false;

  // ── Save peak for the month that just ended ──────────────────────────────
  // `last` is the previous "YYYY-MM" string (empty on very first run).
  if (last) {
    const prevDate     = new Date(Date.UTC(+last.slice(0, 4), +last.slice(5, 7) - 1, 1));
    const [upB, dnB]   = await readMonthTotals(prevDate);
    // Only write if we actually have data (avoid overwriting a real peak with zeros)
    if (upB > 0 || dnB > 0) {
      await writeMonthPeak(last, upB, dnB);
      console.log(`[quota] saved peak for ${last}: up=${upB} down=${dnB}`);
    }
  }

  await dbNet.put(activeKey(), cur);
  return last !== "";
}

export async function mtTick(ifn: string): Promise<void> {
  if (!ifn || _mtLock.locked) return;
  _mtLock.locked = true;
  try {
    const now = new Date();
    const changed = await rollMonthIfNeeded(now);
    if (changed) {
      const abs = await getIfaceCounters(ifn);
      if (abs) {
        await writeBase(now, ifn, abs[0], abs[1]);
        await writeLastAbs(ifn, abs[0], abs[1]);
        await writeMonthTotals(now, 0, 0);
      }
    }

    await ensureBaseIfMissing(now, ifn);

    const abs = await getIfaceCounters(ifn);
    if (!abs) return;
    const [curTx, curRx] = abs;
    let [lastTx, lastRx] = await readLastAbs(ifn);

    // counter wrap / reset
    if (curTx < lastTx || curRx < lastRx) {
      const [upAcc, dnAcc] = await readMonthTotals(now);
      await writeBase(now, ifn, curTx - upAcc, curRx - dnAcc);
      await writeLastAbs(ifn, curTx, curRx);
    }

    let [baseTx, baseRx] = await readBase(now, ifn);

    if (curTx < baseTx || curRx < baseRx) {
      const [upAcc, dnAcc] = await readMonthTotals(now);
      baseTx = curTx - upAcc;
      baseRx = curRx - dnAcc;
      await writeBase(now, ifn, baseTx, baseRx);
    }

    let deltaUp   = Math.max(0, curTx - baseTx);
    let deltaDown = Math.max(0, curRx - baseRx);

    if (deltaDown === 0 && baseRx > curRx) {
      const [, dnAcc] = await readMonthTotals(now);
      baseRx = curRx - dnAcc;
      await writeBase(now, ifn, baseTx, baseRx);
      deltaDown = Math.max(0, curRx - baseRx);
    }
    if (deltaUp === 0 && baseTx > curTx) {
      const [upAcc] = await readMonthTotals(now);
      baseTx = curTx - upAcc;
      await writeBase(now, ifn, baseTx, baseRx);
      deltaUp = Math.max(0, curTx - baseTx);
    }

    await writeMonthTotals(now, deltaUp, deltaDown);
    await writeMonthCheckpoint(now, deltaUp, deltaDown);
    await writeLastAbs(ifn, curTx, curRx);
  } finally {
    _mtLock.locked = false;
  }
}

// ── Checkpoint series ─────────────────────────────────────────────────────────
export async function writeMonthCheckpoint(now: Date, upB: number, dnB: number) {
  const stamp = formatStamp(now);
  await dbNet.put(`mtc:${stamp}`, `${Math.round(upB)},${Math.round(dnB)}`);
}

// Drop per-minute checkpoints older than `days`. Monthly peaks are stored
// separately under `mtp:`, so pruning the raw series is lossless for /peaks.
// Note: the "mtc:active" marker has no timestamp and is left untouched.
export async function cleanupOldCheckpoints(days = 35): Promise<void> {
  const cutoff = Date.now() - days * 86_400_000;
  const toDelete: string[] = [];
  for await (const [k] of dbNet.iterator({ gt: "mtc:", lt: "mtd:" })) {
    const dt = parseStamp(k.slice(4)); // "active" → null → skipped
    if (dt && dt.getTime() < cutoff) toDelete.push(k);
  }
  for (const k of toDelete) { try { await dbNet.del(k); } catch {} }
  if (toDelete.length) console.log(`[quota] cleanup ${toDelete.length} old checkpoints`);
}

export async function readMonthCheckpointSeries(): Promise<Array<{ dt: Date; upB: number; dnB: number }>> {
  const result: Array<{ dt: Date; upB: number; dnB: number }> = [];
  for await (const [k, v] of dbNet.iterator({ gt: "mtc:", lt: "mtd:" })) {
    try {
      const ts = k.slice(4); // strip "mtc:"
      const dt = parseStamp(ts);
      if (!dt) continue;
      const [a, b] = v.split(",");
      result.push({ dt, upB: parseInt(a, 10) || 0, dnB: parseInt(b, 10) || 0 });
    } catch {}
  }
  return result;
}

// ── Public queries ────────────────────────────────────────────────────────────
export async function monthlyTrafficGB(): Promise<{ up: number; down: number; total: number }> {
  const now = new Date();
  const [upB, dnB] = await readMonthTotals(now);
  return {
    up:    upB    / 1e9,
    down:  dnB    / 1e9,
    total: (upB + dnB) / 1e9,
  };
}

export async function monthCumulativeSeries() {
  const now        = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const series     = await readMonthCheckpointSeries();
  const filtered   = series.filter(r => r.dt >= monthStart);

  if (filtered.length === 0) {
    const [upB, dnB] = await readMonthTotals(now);
    return {
      times:   [now],
      upGB:    [upB / 1e9],
      downGB:  [dnB / 1e9],
      totalGB: [(upB + dnB) / 1e9],
    };
  }

  return {
    times:   filtered.map(r => r.dt),
    upGB:    filtered.map(r => r.upB / 1e9),
    downGB:  filtered.map(r => r.dnB / 1e9),
    totalGB: filtered.map(r => (r.upB + r.dnB) / 1e9),
  };
}

// ── Quota operations ──────────────────────────────────────────────────────────
async function rebaseMonthTo(now: Date, upB: number, dnB: number) {
  const ifn = await getIface();
  if (!ifn) return;
  await ensureBaseIfMissing(now, ifn);
  const cur = await getIfaceCounters(ifn);
  if (!cur) return;
  const [curTx, curRx] = cur;

  upB = Math.min(Math.round(upB), curTx);
  dnB = Math.min(Math.round(dnB), curRx);

  await writeBase(now, ifn, curTx - upB, curRx - dnB);
  await writeLastAbs(ifn, curTx, curRx);
  await writeMonthTotals(now, upB, dnB);
  await writeMonthCheckpoint(now, upB, dnB);
}

export async function quotaReset(): Promise<{ up: number; down: number; total: number }> {
  const now = new Date();
  await rebaseMonthTo(now, 0, 0);
  return monthlyTrafficGB();
}

export async function quotaSet(upGB: number, downGB: number) {
  const now  = new Date();
  const upB  = Math.max(0, upGB)   * 1e9;
  const dnB  = Math.max(0, downGB) * 1e9;
  await rebaseMonthTo(now, upB, dnB);
  const t = await monthlyTrafficGB();
  return { ...t, warn: "" };
}

export async function quotaShowMonth(monthStr: string) {
  try {
    const [y, m] = monthStr.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, 1));
    const [upB, dnB] = await readMonthTotals(dt);
    if (upB === 0 && dnB === 0) {
      try { await dbNet.get(monthKey(dt)); } catch { return null; }
    }
    return { up: upB / 1e9, down: dnB / 1e9, total: (upB + dnB) / 1e9 };
  } catch { return null; }
}

export async function quotaDeleteMonth(monthStr: string): Promise<boolean> {
  try {
    const [y, m] = monthStr.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, 1));
    const k = monthKey(dt);
    try { await dbNet.get(k); } catch { return false; }
    await dbNet.del(k);
    return true;
  } catch { return false; }
}