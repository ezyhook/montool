import { readFileSync } from "fs";
import { dbNet, formatStamp, cleanupOld } from "./db";
import { getIface, mtTick, ensureBaseIfMissing, getIfaceCounters, writeMonthCheckpoint, cleanupOldCheckpoints } from "./quota";
import { cfg } from "./config";

const INTERVAL_SEC = 60;
const DAYS_TO_KEEP = 30;

interface NetStats { sent: number; recv: number; }

async function readIfaceStats(ifn: string): Promise<NetStats | null> {
  try {
    const text = readFileSync("/proc/net/dev", "utf-8");
    for (const line of text.split("\n")) {
      const idx = line.indexOf(":");
      if (idx < 0 || line.slice(0, idx).trim() !== ifn) continue;
      const parts = line.slice(idx + 1).trim().split(/\s+/);
      return {
        recv: parseInt(parts[0], 10),  // rx bytes
        sent: parseInt(parts[8], 10),  // tx bytes
      };
    }
  } catch {}
  return null;
}

export async function startNetCollector() {
  const ifn = await getIface();
  // if (!ifn) { console.error("[net] no iface found"); return; }
  if (!ifn) {
    console.error("[net] no iface found, retry in 30s");
    await Bun.sleep(30_000);
    return startNetCollector(); // recursive retry
    }
  console.log(`[net] using iface=${ifn}`);

  const now = new Date();
  await dbNet.put("mtc:active", `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,"0")}`);
  await ensureBaseIfMissing(now, ifn);

  let prev = await readIfaceStats(ifn);
  let prevT = Date.now();

  // wait one interval before first measurement
  await Bun.sleep(INTERVAL_SEC * 1000);

  setInterval(async () => {
    try {
      const curr  = await readIfaceStats(ifn);
      const nowT  = Date.now();
      const dt    = Math.max(0.001, (nowT - prevT) / 1000);
      const now2  = new Date();

      if (prev && curr) {
        const sent = Math.max(0, curr.sent - prev.sent);
        const recv = Math.max(0, curr.recv - prev.recv);
        const up   = sent * 8 / dt / 1_000_000; // Mbit/s
        const down = recv * 8 / dt / 1_000_000;

        const stamp = formatStamp(now2);
        await dbNet.put(`total:${stamp}`, `${up.toFixed(4)},${down.toFixed(4)}`);
      }

      await mtTick(ifn);

      // midnight cleanup
      if (now2.getUTCHours() === 0 && now2.getUTCMinutes() < Math.max(1, Math.floor(INTERVAL_SEC / 60))) {
        await cleanupOld(dbNet, DAYS_TO_KEEP);
        await cleanupOldCheckpoints(35);
      }

      prev  = curr;
      prevT = nowT;
    } catch (e) {
      console.error("[net] collect error:", e);
    }
  }, INTERVAL_SEC * 1000);
}
