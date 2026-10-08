import { readFileSync } from "fs";
import { execSync } from "child_process";
import { sendText } from "./telegram";
import { cfg } from "./config";

// ── Net stats from /proc/net/dev ─────────────────────────────────────────────
interface NetStats { rxBytes: number; rxPackets: number; txBytes: number; txPackets: number; }

function readNetDev(iface: string): NetStats | null {
  try {
    const text = readFileSync("/proc/net/dev", "utf-8");
    for (const line of text.split("\n")) {
      const idx = line.indexOf(":");
      if (idx < 0 || line.slice(0, idx).trim() !== iface) continue;
      const parts = line.slice(idx + 1).trim().split(/\s+/);
      return {
        rxBytes:   parseInt(parts[0],  10),
        rxPackets: parseInt(parts[1],  10),
        txBytes:   parseInt(parts[8],  10),
        txPackets: parseInt(parts[9],  10),
      };
    }
  } catch (e) { console.error("[ddos] /proc/net/dev error:", e); }
  return null;
}

function calcRates(prev: NetStats, curr: NetStats, dt: number) {
  return {
    rxBps: (curr.rxBytes   - prev.rxBytes)   / dt,
    rxPps: (curr.rxPackets - prev.rxPackets) / dt,
    txBps: (curr.txBytes   - prev.txBytes)   / dt,
    txPps: (curr.txPackets - prev.txPackets) / dt,
  };
}

// ── Self-IP detection ─────────────────────────────────────────────────────────
// Collects all local IP addresses to exclude them from "top attackers" lists.
// Sources (in priority order):
//   1. cfg().IP — explicitly configured IP
//   2. /proc/net/fib_trie — all IPv4 addresses on all interfaces (LOCAL host entries)
//   3. /proc/net/if_inet6 — all IPv6 addresses
function getSelfIps(): Set<string> {
  const self = new Set<string>();

  // 1. Explicitly configured IP
  const cfgIp = cfg().IP;
  if (cfgIp) self.add(cfgIp);

  // 2. All IPv4 addresses from fib_trie
  // Format: under each "32 host" entry the next line is "LOCAL  <ip>"
  try {
    const text  = readFileSync("/proc/net/fib_trie", "utf-8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i].includes("32 host")) {
        // next non-empty line looks like "      LOCAL     1.2.3.4"
        const next = lines[i + 1] ?? "";
        const m    = next.match(/LOCAL\s+(\S+)/);
        if (m) self.add(m[1]);
      }
    }
  } catch {}

  // 3. All IPv6 addresses from /proc/net/if_inet6
  // Format: <hex-addr> <iface-idx> <prefix-len> <scope> <flags> <iface>
  try {
    const text = readFileSync("/proc/net/if_inet6", "utf-8");
    for (const line of text.split("\n")) {
      const hex = line.trim().split(/\s+/)[0];
      if (!hex || hex.length !== 32) continue;
      // Convert 32-char hex to colon-separated IPv6
      const groups: string[] = [];
      for (let i = 0; i < 32; i += 4) groups.push(hex.slice(i, i + 4));
      self.add(groups.join(":"));
    }
  } catch {}

  return self;
}

// ── Conntrack ─────────────────────────────────────────────────────────────────
function readConntrack(): [number, number] {
  try {
    const count = parseInt(readFileSync("/proc/sys/net/netfilter/nf_conntrack_count", "utf-8").trim(), 10);
    const max   = parseInt(readFileSync("/proc/sys/net/netfilter/nf_conntrack_max",   "utf-8").trim(), 10);
    return [count, max];
  } catch { return [0, 1]; }
}

function topIps(n = 10): Array<[string, number]> {
  const self = getSelfIps();

  // Try conntrack utility first
  try {
    const out = execSync("conntrack -L 2>/dev/null", { encoding: "utf-8", timeout: 5000 });
    const counts: Record<string, number> = {};
    for (const line of out.split("\n")) {
      const m = line.match(/\bsrc=(\S+)/);
      if (m && !self.has(m[1])) counts[m[1]] = (counts[m[1]] ?? 0) + 1;
    }
    if (Object.keys(counts).length) {
      return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n) as [string, number][];
    }
  } catch {}

  // Fallback: /proc/net/nf_conntrack or /proc/net/ip_conntrack
  for (const path of ["/proc/net/nf_conntrack", "/proc/net/ip_conntrack"]) {
    try {
      const counts: Record<string, number> = {};
      for (const line of readFileSync(path, "utf-8").split("\n")) {
        const m = line.match(/\bsrc=(\S+)/);
        if (m && !self.has(m[1])) counts[m[1]] = (counts[m[1]] ?? 0) + 1;
      }
      if (Object.keys(counts).length) {
        return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n) as [string, number][];
      }
    } catch {}
  }
  return [];
}

function countSynRecv(): number {
  let count = 0;
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      const lines = readFileSync(path, "utf-8").split("\n").slice(1);
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length > 3 && parts[3] === "03") count++;
      }
    } catch {}
  }
  return count;
}

function synTopIps(n = 10): Array<[string, number]> {
  const self = getSelfIps();

  try {
    const out = execSync("ss -ntH state syn-recv 2>/dev/null", {
      encoding: "utf-8",
      timeout: 5000,
    });

    const counts: Record<string, number> = {};
    for (const line of out.trim().split("\n")) {
      if (!line.trim()) continue;
      // Columns: Recv-Q Send-Q Local-Address:Port Peer-Address:Port
      const parts           = line.trim().split(/\s+/);
      const remoteAddrPort  = parts[4];
      if (!remoteAddrPort) continue;

      const lastColon = remoteAddrPort.lastIndexOf(":");
      const ip        = lastColon !== -1 ? remoteAddrPort.substring(0, lastColon) : remoteAddrPort;
      const cleanIp   = ip.replace(/[\[\]]/g, "");

      if (!self.has(cleanIp)) {
        counts[cleanIp] = (counts[cleanIp] ?? 0) + 1;
      }
    }

    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);
  } catch {
    return [];
  }
}

function fmtBytes(b: number): string {
  for (const unit of ["B", "KB", "MB", "GB"]) {
    if (b < 1024) return `${b.toFixed(1)} ${unit}/s`;
    b /= 1024;
  }
  return `${b.toFixed(1)} TB/s`;
}

async function pickDdosIface(): Promise<string> {
  const c = cfg();
  if (c.DDOS_IFACE) return c.DDOS_IFACE;
  if (c.NET_IFACE)  return c.NET_IFACE;
  // fallback: default route iface
  try {
    const text = readFileSync("/proc/net/route", "utf-8");
    for (const line of text.split("\n").slice(1)) {
      const p = line.trim().split(/\s+/);
      if (p.length >= 4 && p[1] === "00000000" && (parseInt(p[3], 16) & 0x1)) return p[0];
    }
  } catch {}
  return "";
}

// ── Alert cooldown ────────────────────────────────────────────────────────────
const _alertTimes: Record<string, number> = {};
function canAlert(key: string): boolean {
  const now  = Date.now();
  const last = _alertTimes[key] ?? 0;
  if (now - last >= cfg().DDOS_ALERT_COOLDOWN * 1000) {
    _alertTimes[key] = now;
    return true;
  }
  return false;
}

async function checkAndAlert(
  rates: ReturnType<typeof calcRates>,
  ctCount: number, ctMax: number,
  topIpsList: Array<[string, number]>,
  iface: string,
  synCount: number,
  synTop: Array<[string, number]>
) {
  const c = cfg();
  const alerts: string[] = [];

  if (rates.rxPps > c.DDOS_THRESHOLD_PPS && canAlert("pps")) {
    alerts.push(`⚠️ <b>High PPS</b>\nRX: <code>${rates.rxPps.toFixed(0)} pps</code> (threshold: ${c.DDOS_THRESHOLD_PPS})`);
  }
  if (rates.rxBps > c.DDOS_THRESHOLD_BPS && canAlert("bps")) {
    alerts.push(`⚠️ <b>High inbound traffic</b>\nRX: <code>${fmtBytes(rates.rxBps)}</code> (threshold: ${fmtBytes(c.DDOS_THRESHOLD_BPS)})`);
  }
  if (ctMax > 0 && ctCount / ctMax >= c.DDOS_THRESHOLD_CT && canAlert("conntrack")) {
    alerts.push(`⚠️ <b>Conntrack table full</b>\n<code>${ctCount}/${ctMax} (${((ctCount/ctMax)*100).toFixed(1)}%)</code>`);
  }
  for (const [ip, count] of topIpsList) {
    if (count >= c.DDOS_THRESHOLD_TOPN && canAlert(`topip_${ip}`)) {
      alerts.push(`⚠️ <b>Suspicious IP</b>\n<code>${ip}</code> — ${count} connections (threshold: ${c.DDOS_THRESHOLD_TOPN})`);
    }
  }
  if (synCount >= c.DDOS_THRESHOLD_SYN && canAlert("syn_flood")) {
    let synStr = "";
    if (synTop.length) {
      synStr = "\n<b>Top SYN sources:</b>\n<code>" + synTop.slice(0, 5).map(([ip, c]) => `  ${c.toString().padStart(6)}  ${ip}`).join("\n") + "</code>";
    }
    alerts.push(`🌊 <b>SYN Flood — ${synCount} SYN_RECV connections</b>\n(threshold: ${c.DDOS_THRESHOLD_SYN})${synStr}`);
  }

  if (!alerts.length) return;

  const topStr = topIpsList.slice(0, 5).map(([ip, c]) => `  ${c.toString().padStart(6)}  ${ip}`).join("\n") || "  no data";
  await sendText(
    `🚨 <b>DDoS Alert — ${c.HOST_NAME}</b>\n` +
    `Interface: <code>${iface}</code>\n\n` +
    alerts.join("\n\n") +
    `\n\n<b>Top sources (all):</b>\n<code>${topStr}</code>`
  );
}

// ── Status text (for /ddos command) ──────────────────────────────────────────
export async function ddosStatusText(): Promise<string> {
  const c = cfg();
  if (!c.DDOS_ENABLED) return "🛡 DDoS detector <b>disabled</b> (DDOS_ENABLED=0)";

  const iface = await pickDdosIface();
  const [ctCount, ctMax] = readConntrack();
  const ctPct = ctMax ? (ctCount / ctMax * 100) : 0;
  const top   = topIps(5);
  const syn   = countSynRecv();
  const topStr = top.map(([ip, c]) => `  ${c.toString().padStart(6)}  ${ip}`).join("\n") || "  no data";

  let ratesStr = "  n/a";
  if (iface) {
    try {
      const s1 = readNetDev(iface);
      await Bun.sleep(1000);
      const s2 = readNetDev(iface);
      if (s1 && s2) {
        const r    = calcRates(s1, s2, 1.0);
        const rxOk = r.rxPps > c.DDOS_THRESHOLD_PPS ? "🔴" : "🟢";
        const bpOk = r.rxBps > c.DDOS_THRESHOLD_BPS ? "🔴" : "🟢";
        ratesStr =
          `${rxOk} RX: <code>${fmtBytes(r.rxBps)}</code>  <code>${r.rxPps.toFixed(0)} pps</code>\n` +
          `   TX: <code>${fmtBytes(r.txBps)}</code>  <code>${r.txPps.toFixed(0)} pps</code>`;
      }
    } catch (e: any) { ratesStr = `  error: ${e.message}`; }
  }

  const ctOk  = ctMax > 0 ? (ctCount / ctMax >= c.DDOS_THRESHOLD_CT ? "🔴" : "🟢") : "⚪";
  const synSt = syn >= c.DDOS_THRESHOLD_SYN
    ? `🔴 <code>${syn}</code> 🌊 <b>FLOOD DETECTED</b>`
    : `🟢 <code>${syn}</code>`;

  return (
    `🛡 <b>DDoS detector active</b>\n` +
    `Interface: <code>${iface || "—"}</code>  Interval: <code>${c.DDOS_INTERVAL}s</code>\n\n` +
    `<b>Current traffic:</b>\n  ${ratesStr}\n\n` +
    `<b>Conntrack:</b> ${ctOk} <code>${ctCount}/${ctMax} (${ctPct.toFixed(1)}%)</code>  threshold: <code>${(c.DDOS_THRESHOLD_CT*100).toFixed(0)}%</code>\n` +
    `<b>SYN_RECV:</b>  ${synSt}  threshold: <code>${c.DDOS_THRESHOLD_SYN}</code>\n\n` +
    `<b>Alert thresholds:</b>\n` +
    `  PPS:    <code>${c.DDOS_THRESHOLD_PPS}</code>\n` +
    `  BPS:    <code>${fmtBytes(c.DDOS_THRESHOLD_BPS)}</code>\n` +
    `  Top-IP: <code>${c.DDOS_THRESHOLD_TOPN} conn</code>\n\n` +
    `<b>Top sources:</b>\n<code>${topStr}</code>`
  );
}

// ── Loop ─────────────────────────────────────────────────────────────────────
export async function startDdosLoop() {
  const c = cfg();
  if (!c.DDOS_ENABLED) { console.log("[ddos] disabled"); return; }

  const iface = await pickDdosIface();
  if (!iface) { console.log("[ddos] no interface found"); return; }

  console.log(`[ddos] started | iface=${iface} interval=${c.DDOS_INTERVAL}s`);

  let prev = readNetDev(iface);
  if (!prev) { console.log(`[ddos] interface ${iface} not found`); return; }

  setInterval(async () => {
    try {
      const curr = readNetDev(iface);
      if (!curr || !prev) { prev = curr; return; }

      const rates            = calcRates(prev, curr, c.DDOS_INTERVAL);
      const [ctCount, ctMax] = readConntrack();
      const top              = topIps(10);
      const synCount         = countSynRecv();
      const synTop           = synCount >= c.DDOS_THRESHOLD_SYN ? synTopIps(5) : [];

      console.log(
        `[ddos] RX: ${fmtBytes(rates.rxBps)} | ${rates.rxPps.toFixed(0)} pps | ` +
        `conntrack: ${ctCount}/${ctMax} | SYN_RECV: ${synCount}`
      );

      await checkAndAlert(rates, ctCount, ctMax, top, iface, synCount, synTop);
      prev = curr;
    } catch (e) {
      console.error("[ddos] loop error:", e);
    }
  }, c.DDOS_INTERVAL * 1000);
}