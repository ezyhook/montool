// Thin wrappers around two LevelDB instances.
// We use the `classic-level` package (LevelDB binding for Node/Bun).

import { ClassicLevel } from "classic-level";

export const dbSys = new ClassicLevel<string, string>("sysmetrics.ldb", {
  keyEncoding: "utf8",
  valueEncoding: "utf8",
});

export const dbNet = new ClassicLevel<string, string>("net_total.ldb", {
  keyEncoding: "utf8",
  valueEncoding: "utf8",
});

// convenience
export const db = { sys: dbSys, net: dbNet };

// ── poll offset ──────────────────────────────────────────────────────────────
export async function loadPollOffset(): Promise<number> {
  try {
    const v = await dbSys.get("poll:offset");
    return parseInt(v, 10) || -1;
  } catch { return -1; }
}

export async function savePollOffset(off: number): Promise<void> {
  await dbSys.put("poll:offset", String(off));
}

// ── metric save ──────────────────────────────────────────────────────────────
export async function saveMetric(metric: string, value: number): Promise<void> {
  const now = new Date();
  const stamp = formatStamp(now);
  await dbSys.put(`${metric}:${stamp}`, value.toFixed(2));
}

// ── cleanup ──────────────────────────────────────────────────────────────────
export async function cleanupOld(
  db: ClassicLevel<string, string>,
  days: number
): Promise<void> {
  const cutoff = Date.now() - days * 86_400_000;
  const toDelete: string[] = [];

  for await (const [k] of db.iterator()) {
    if (k.startsWith("mt:") || k.startsWith("mtc:") || k.startsWith("poll:")) continue;
    const parts = k.split(":");
    if (parts.length < 2) continue;
    try {
      const dt = parseStamp(parts.slice(1).join(":"));
      if (dt && dt.getTime() < cutoff) toDelete.push(k);
    } catch {}
  }

  for (const k of toDelete) {
    try { await db.del(k); } catch {}
  }

  if (toDelete.length > 0)
    console.log(`[cleanup] removed ${toDelete.length} records older than ${days} days`);
}

// ── helpers ──────────────────────────────────────────────────────────────────
export function formatStamp(d: Date): string {
  // "YYYY-MM-DD_HH:MM"
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}_${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function parseStamp(s: string): Date | null {
  // "YYYY-MM-DD_HH:MM"
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2}):(\d{2})$/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5]));
}
