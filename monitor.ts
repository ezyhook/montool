import { execSync } from "child_process";
import { readFileSync, existsSync, readdirSync, readlinkSync, unlinkSync, statSync } from "fs";
import { dbSys, saveMetric, cleanupOld, formatStamp } from "./db";
import { monthlyTrafficGB } from "./quota";
import { sendText } from "./telegram";
import { cfg } from "./config";

const MINER_PROCS = [
  "xmrig","kdevtmpfsi","kinsing","watchbog","sysupdate",
  "sustse","kworkerds","ziggy","ziggystar","xmrig-cpu",
  "libprocesshider","dbused","updata","unicorn",
];

// ── CPU percent via /proc/stat ────────────────────────────────────────────────
let _prevStat: { idle: number; total: number } | null = null;

function readCpuStat(): { idle: number; total: number } {
  const lines = readFileSync("/proc/stat", "utf-8").split("\n");
  for (const line of lines) {
    if (!line.startsWith("cpu ")) continue;
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle  = parts[3] + (parts[4] ?? 0); // idle + iowait
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  }
  return { idle: 0, total: 1 };
}

function getCpuPercent(): number {
  const cur = readCpuStat();
  if (!_prevStat) { _prevStat = cur; return 0; }
  const dTotal = cur.total - _prevStat.total;
  const dIdle  = cur.idle  - _prevStat.idle;
  _prevStat = cur;
  return dTotal > 0 ? 100 * (1 - dIdle / dTotal) : 0;
}

// ── /proc/meminfo ─────────────────────────────────────────────────────────────
interface MemInfo { total: number; used: number; pct: number; swapTotal: number; swapUsed: number; swapPct: number; }
function getMemInfo(): MemInfo {
  const raw: Record<string, number> = {};
  for (const line of readFileSync("/proc/meminfo", "utf-8").split("\n")) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) raw[m[1]] = parseInt(m[2], 10) * 1024; // kB → bytes
  }
  const total     = raw["MemTotal"]     ?? 0;
  const available = raw["MemAvailable"] ?? 0;
  const used      = total - available;
  const swapTotal = raw["SwapTotal"]    ?? 0;
  const swapFree  = raw["SwapFree"]     ?? 0;
  const swapUsed  = swapTotal - swapFree;
  return {
    total, used, pct: total ? (used / total) * 100 : 0,
    swapTotal, swapUsed, swapPct: swapTotal ? (swapUsed / swapTotal) * 100 : 0,
  };
}

// ── /proc/loadavg ─────────────────────────────────────────────────────────────
function getLoadAvg(): number[] {
  const raw = readFileSync("/proc/loadavg", "utf-8").trim().split(/\s+/);
  return raw.slice(0, 3).map(parseFloat);
}

// ── statvfs (disk) via df ─────────────────────────────────────────────────────
interface DiskInfo { total: number; used: number; pct: number; }
// function getDiskInfo(path = "/"): DiskInfo {
//   try {
//     const out  = execSync(`df -B1 ${path} 2>/dev/null | tail -1`, { encoding: "utf-8" });
//     const p    = out.trim().split(/\s+/);
//     const total = parseInt(p[1], 10);
//     const used  = parseInt(p[2], 10);
//     return { total, used, pct: total ? (used / total) * 100 : 0 };
//   } catch { return { total: 0, used: 0, pct: 0 }; }
// }
function getDiskInfo(path = "/"): DiskInfo {
  try {
    // -B1 → bytes; columns: Filesystem  Size  Used  Avail  Use%  MountedOn
    const out = execSync(`df -B1 ${path} 2>/dev/null | tail -1`, { encoding: "utf-8" });
    const p   = out.trim().split(/\s+/);
    // p[4] = "88%" — take Use% straight from df, matches `df -h`
    const total = parseInt(p[1], 10);
    const used  = parseInt(p[2], 10);
    const pct   = parseFloat(p[4]);   // "88%" → 88 (parseFloat drops the %)
    return {
      total,
      used,
      pct: isNaN(pct) ? (total ? (used / total) * 100 : 0) : pct,
    };
  } catch { return { total: 0, used: 0, pct: 0 }; }
}
// ── I/O util via /proc/diskstats ──────────────────────────────────────────────
let _prevIo: Record<string, number> = {};
let _prevIoT = 0;
const IGNORE_PREFIX = ["loop", "ram", "zram"];

function readDiskStats(): Record<string, number> {
  const result: Record<string, number> = {};
  for (const line of readFileSync("/proc/diskstats", "utf-8").split("\n")) {
    const p = line.trim().split(/\s+/);
    if (p.length < 14) continue;
    const dev = p[2];
    if (IGNORE_PREFIX.some(pfx => dev.startsWith(pfx))) continue;
    result[dev] = parseInt(p[12], 10); // field 10 = io_ms (busy_time)
  }
  return result;
}

export function sampleDiskUtilPercent(): number {
  const now = Date.now();
  const cur = readDiskStats();
  if (_prevIoT === 0) { _prevIo = cur; _prevIoT = now; return 0; }
  const dt = Math.max(1, now - _prevIoT);
  let maxUtil = 0;
  for (const [dev, ms] of Object.entries(cur)) {
    const prev = _prevIo[dev] ?? ms;
    const util = Math.min(100, Math.max(0, (ms - prev) / dt * 100));
    if (util > maxUtil) maxUtil = util;
  }
  _prevIo  = cur;
  _prevIoT = now;
  return maxUtil;
}

// ── CPU count ─────────────────────────────────────────────────────────────────
function cpuCount(): number {
  return parseInt(execSync("nproc", { encoding: "utf-8" }).trim(), 10) || 1;
}

// ── Process listing ───────────────────────────────────────────────────────────
interface ProcEntry { pid: number; comm: string; value: number; }

function topProcesses(by: "cpu" | "ram" | "swap", n = 5): string {
  try {
    if (by === "swap") {
      // /proc/[pid]/status has VmSwap field — ps cannot sort by swap
      const procs: ProcEntry[] = [];
      const pids = readdirSync("/proc").filter(d => /^\d+$/.test(d));

      for (const pid of pids) {
        try {
          const status = readFileSync(`/proc/${pid}/status`, "utf-8");
          const swapLine = status.match(/^VmSwap:\s+(\d+)\s+kB/m);
          if (!swapLine) continue;
          const swapKb = parseInt(swapLine[1], 10);
          if (swapKb === 0) continue;
          const commLine = status.match(/^Name:\s+(\S+)/m);
          procs.push({ pid: parseInt(pid, 10), comm: commLine?.[1] ?? "?", value: swapKb });
        } catch {}
      }

      procs.sort((a, b) => b.value - a.value);
      const header = `${"PID".padStart(7)}  ${"SWAP(MB)".padStart(8)}  COMM`;
      const lines  = procs.slice(0, n).map(p =>
        `${String(p.pid).padStart(7)}  ${(p.value / 1024).toFixed(1).padStart(8)}  ${p.comm}`
      );
      return [header, ...lines].join("\n");
    }

    // CPU or RAM — read directly from /proc/[pid]/stat + /proc/[pid]/status
    const cpuCount_ = cpuCount();
    const uptimeSec = parseFloat(readFileSync("/proc/uptime", "utf-8").split(" ")[0]);
    const HZ        = 100; // CLK_TCK, always 100 on Linux

    const memTotal = (() => {
      const m = readFileSync("/proc/meminfo", "utf-8").match(/^MemTotal:\s+(\d+)/m);
      return m ? parseInt(m[1], 10) : 1;
    })();

    const procs: ProcEntry[] = [];
    const pids = readdirSync("/proc").filter(d => /^\d+$/.test(d));

    for (const pid of pids) {
      try {
        const stat   = readFileSync(`/proc/${pid}/stat`, "utf-8");
        // fields: (1)pid (2)comm (3)state ... (14)utime (15)stime
        const m = stat.match(/^(\d+)\s+\((.+)\)\s+\S+(?:\s+\S+){10}\s+(\d+)\s+(\d+)/);
        if (!m) continue;
        const comm  = m[2];
        const utime = parseInt(m[3], 10);
        const stime = parseInt(m[4], 10);

        if (by === "cpu") {
          // starttime is field 22 (0-indexed from the stat fields after state)
          const fields = stat.split(" ");
          const starttime = parseInt(fields[21], 10);
          const elapsedSec = Math.max(0.001, uptimeSec - starttime / HZ);
          const cpuPct = ((utime + stime) / HZ / elapsedSec) * 100 / cpuCount_;
          procs.push({ pid: parseInt(pid, 10), comm, value: cpuPct });
        } else {
          // RAM: read RSS from /proc/[pid]/statm (field 2, in pages)
          const statm   = readFileSync(`/proc/${pid}/statm`, "utf-8").trim().split(" ");
          const rssKb   = parseInt(statm[1], 10) * 4; // page = 4 kB on x86
          const memPct  = (rssKb / memTotal) * 100;
          procs.push({ pid: parseInt(pid, 10), comm, value: memPct });
        }
      } catch {}
    }

    procs.sort((a, b) => b.value - a.value);

    if (by === "cpu") {
      const header = `${"PID".padStart(7)}  ${"CPU%".padStart(6)}  COMM`;
      const lines  = procs.slice(0, n).map(p =>
        `${String(p.pid).padStart(7)}  ${p.value.toFixed(1).padStart(6)}  ${p.comm}`
      );
      return [header, ...lines].join("\n");
    } else {
      const header = `${"PID".padStart(7)}  ${"MEM%".padStart(6)}  COMM`;
      const lines  = procs.slice(0, n).map(p =>
        `${String(p.pid).padStart(7)}  ${p.value.toFixed(1).padStart(6)}  ${p.comm}`
      );
      return [header, ...lines].join("\n");
    }

  } catch (e) {
    return `(error collecting processes: ${e})`;
  }
}

// ── Miner detection & neutralization ──────────────────────────────────────────
interface MinerHit { pid: number; comm: string; exe: string | null; }

// Locations where mining malware typically drops its binary. A matched binary
// is deleted only if it lives here — never a system path like /usr/bin — so a
// false-positive name match can kill a process but can't wipe legit files.
const DROP_DIRS = ["/tmp/", "/dev/shm/", "/var/tmp/", "/run/"];

function findMinerProcesses(): MinerHit[] {
  const hits: MinerHit[] = [];
  let pids: string[];
  try { pids = readdirSync("/proc").filter(d => /^\d+$/.test(d)); }
  catch { return hits; }

  for (const pid of pids) {
    try {
      // /proc/<pid>/comm — kernel task name, reliable, no shell needed
      const comm = readFileSync(`/proc/${pid}/comm`, "utf-8").trim();
      if (!MINER_PROCS.includes(comm)) continue;
      let exe: string | null = null;
      try { exe = readlinkSync(`/proc/${pid}/exe`); } catch {}
      // readlink yields "/path/bin (deleted)" once the file is unlinked
      if (exe) exe = exe.replace(/ \(deleted\)$/, "");
      hits.push({ pid: parseInt(pid, 10), comm, exe });
    } catch {}
  }
  return hits;
}

// Kill each matched process (SIGKILL) and remove ONLY the exact binary it ran
// from, and only when that binary sits in a known malware-drop directory.
function neutralizeMiners(hits: MinerHit[]): string[] {
  const report: string[] = [];
  for (const h of hits) {
    try {
      process.kill(h.pid, "SIGKILL");
      report.push(`killed pid=${h.pid} (${h.comm})`);
    } catch (e: any) {
      report.push(`kill failed pid=${h.pid} (${h.comm}): ${e?.message ?? e}`);
    }

    if (h.exe && DROP_DIRS.some(d => h.exe!.startsWith(d))) {
      try {
        if (statSync(h.exe).isFile()) { unlinkSync(h.exe); report.push(`removed ${h.exe}`); }
      } catch (e: any) {
        report.push(`rm failed ${h.exe}: ${e?.message ?? e}`);
      }
    } else if (h.exe) {
      report.push(`left in place (not a drop dir): ${h.exe}`);
    }
  }
  return report;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Status message ─────────────────────────────────────────────────────────────
function fmt(n: number) { return `${(n / 1_073_741_824).toFixed(0)}G`; }
function fmtTraffic(gb: number): string {
  if (gb >= 1024) {
    return `${(gb / 1024).toFixed(1)}T`;
  }
  return `${gb.toFixed(0)}G`;
}
export async function infoStatus(alarm: boolean, ioUtil: number): Promise<string> {
  const c     = cfg();
  const mem   = getMemInfo();
  const disk  = getDiskInfo();
  const load  = getLoadAvg();
  const cpu   = getCpuPercent();
  const cores = cpuCount();
  const t     = await monthlyTrafficGB();

  const marker  = alarm ? "🔴" : "🟢";
  const ramStr  = `${fmt(mem.total - mem.used)}/${fmt(mem.total)} ${mem.pct.toFixed(0)}%`;
  const swapStr = `${fmt(mem.swapTotal - mem.swapUsed)}/${fmt(mem.swapTotal)} ${mem.swapPct.toFixed(0)}%`;
  const diskStr = `${fmt(disk.used)}/${fmt(disk.total)} ${disk.pct.toFixed(0)}%`;

  return (
    `<b> ${marker} ${c.HOST_NAME} -- [ ${c.IP} ]</b><code>\n` +
    `CPU_ > [ ${cpu.toFixed(1)}% ]\n` +
    `Load > [ ${load[1].toFixed(2)} ] Cors:${cores}\n` +
    `Ram_ > [ ${ramStr} ]\n` +
    `Swap > [ ${swapStr} ]\n` +
    `I/O_ > [ ${ioUtil.toFixed(1)}% util ]\n` +
    `Disk > [ ${diskStr} ]\n` +
    `Traf > [⬆️${fmtTraffic(t.up)} ⬇️${fmtTraffic(t.down)} ${fmtTraffic(t.total)}]</code>`
  );
}

// ── Alarm state ───────────────────────────────────────────────────────────────
let _lastAlarmSent = 0;
const ALARM_MIN_MS = 10 * 60 * 1000;
let _hourlyLastKey = "";
let _lastCleanupDay = "";

export function startMonitorLoop() {
  // prime CPU sample
  getCpuPercent();
  sampleDiskUtilPercent();

  setInterval(async () => {
    try {
      await tick();
    } catch (e) {
      console.error("[monitor] error:", e);
    }
  }, 60_000);
}

async function tick() {
  const c     = cfg();
  const cpu   = getCpuPercent();
  const mem   = getMemInfo();
  const disk  = getDiskInfo();
  const load  = getLoadAvg();
  const cores = cpuCount();
  const io    = sampleDiskUtilPercent();
  const now   = new Date();

  await saveMetric("cpu",    cpu);
  await saveMetric("load",   (load[1] / cores) * 100);
  await saveMetric("ram",    mem.pct);
  await saveMetric("disk",   disk.pct);
  await saveMetric("swap",   mem.swapPct);
  await saveMetric("ioutil", io);

  // metric DB cleanup — once per day, not on every tick (full-DB scan)
  const dayKey = formatStamp(now).slice(0, 10); // "YYYY-MM-DD"
  if (_lastCleanupDay !== dayKey) {
    _lastCleanupDay = dayKey;
    await cleanupOld(dbSys, 32);
  }

  await checkOomEvents();

  // hourly status
  const hourKey = formatStamp(now).slice(0, 13); // "YYYY-MM-DD_HH"
  if (_hourlyLastKey !== hourKey) {
    _hourlyLastKey = hourKey;
    const msg = await infoStatus(false, io);
    await sendText(msg).catch(console.error);
  }

  // alarm thresholds
  const alarmCpu  = cpu       >= c.CPU_LIMIT;
  const alarmRam  = mem.pct   >= c.RAM_LIMIT;
  const alarmSwap = mem.swapPct >= c.SWAP_LIMIT;
  const alarmDisk = disk.pct  >= c.DISK_LIMIT;
  const alarm     = ( alarmCpu && c.ALERT_CPU ) || ( alarmRam && c.ALERT_RAM ) || ( alarmSwap && c.ALERT_SWAP ) || ( alarmDisk && c.ALERT_DISK );

  if (alarm && (Date.now() - _lastAlarmSent >= ALARM_MIN_MS)) {
    _lastAlarmSent = Date.now();
    await sendText(await infoStatus(true, io));

    if (alarmCpu && c.ALERT_CPU)  await sendText(`🔴 <b>TOP-5 CPU</b>\n<code>${topProcesses("cpu")}</code>`);
    if (alarmRam  && c.ALERT_RAM)  await sendText(`🔴 <b>TOP-5 RAM</b>\n<code>${topProcesses("ram")}</code>`);
    if (alarmSwap && c.ALERT_SWAP) await sendText(`🔴 <b>TOP-5 SWAP</b>\n<code>${topProcesses("swap")}</code>`);
  }

  // miner scan → targeted neutralization (kill PID + remove its dropped binary)
  const found = findMinerProcesses();
  if (found.length > 0) {
    const names  = [...new Set(found.map(f => f.comm))].join(" ");
    const report = neutralizeMiners(found);
    await sendText(
      `<b>🔴 Suspicious processes detected:</b> ${escHtml(names)}\n` +
      `<code>${escHtml(report.join("\n"))}</code>`
    );
  }
}

// ── OOM killer events ────────────────────────────────────────────────────────
const OOM_PATTERNS = [
  "oom-kill:",
  "invoked oom-killer",
  "Out of memory:",
  "Memory cgroup out of memory",
];

let _lastOomSeen = 0;
let _bootTime    = 0;

function getBootTime(): number {
  if (_bootTime) return _bootTime;
  try {
    const raw = readFileSync("/proc/stat", "utf-8");
    for (const line of raw.split("\n")) {
      if (line.startsWith("btime ")) {
        _bootTime = parseInt(line.split(" ")[1], 10);
        return _bootTime;
      }
    }
  } catch {}
  return Math.floor(Date.now() / 1000) - process.uptime();
}

export async function initOomMarker() {
  try {
    const out = execSync("dmesg 2>/dev/null", { encoding: "utf-8" });
    for (const line of out.split("\n").reverse()) {
      const m = line.match(/^\[\s*([0-9]+(?:\.[0-9]+)?)\]/);
      if (m) { _lastOomSeen = parseFloat(m[1]); break; }
    }
    console.log(`[oom] init_oom_marker: last_oom_seen=${_lastOomSeen}`);
  } catch (e) {
    console.error("[oom] initOomMarker error:", e);
  }
}

async function checkOomEvents() {
  try {
    const out  = execSync("dmesg 2>/dev/null", { encoding: "utf-8" });
    const boot = getBootTime();
    const newEvents: Array<[number, string]> = [];

    for (const line of out.split("\n")) {
      const low = line.toLowerCase();
      if (!OOM_PATTERNS.some(p => low.includes(p.toLowerCase()))) continue;
      const m = line.match(/^\[\s*([0-9]+(?:\.[0-9]+)?)\]/);
      if (!m) continue;
      const ts = parseFloat(m[1]);
      if (ts <= _lastOomSeen) continue;
      newEvents.push([ts, line.trim()]);
    }

    if (newEvents.length === 0) return;
    _lastOomSeen = Math.max(...newEvents.map(([ts]) => ts));

    for (const [ts, line] of newEvents.slice(-3)) {
      const eventDate = new Date((boot + ts) * 1000);
      const human     = eventDate.toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
      await sendText(
        `🔴 <b>OOM killer event</b>\n` +
        `<code>[${ts.toFixed(3)} s uptime] ${human}</code>\n` +
        `<code>${line.slice(-300)}</code>`
      );
    }
  } catch (e) {
    console.error("[oom] checkOomEvents error:", e);
  }
}