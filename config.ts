import { readFileSync, existsSync } from "fs";
import { hostname } from "os";

export interface Config {
  BOT_TOKEN: string;
  CHAT_ID: number;
  THREAD_ID: number | null;
  HOST_NAME: string;
  IP: string;
  LEADER_THREAD_ID: number;
  HANDLE_UNKNOWN_ON_LEADER: boolean;
  ENABLE_POLLING: boolean;
  SEND_WELCOME: boolean;
  HEALTH_INTERVAL_SEC: number;
  DOWN_ALERT_REPEAT_MIN: number;
  HEALTH_TIMEOUT: number;
  DISPATCH_MAP: Record<string, string>;
  AGENT_SECRET: string;
  AGENT_BIND: string;
  NET_IFACE: string;
  // DDoS
  DDOS_IFACE: string;
  DDOS_INTERVAL: number;
  DDOS_THRESHOLD_PPS: number;
  DDOS_THRESHOLD_BPS: number;
  DDOS_THRESHOLD_CT: number;
  DDOS_THRESHOLD_TOPN: number;
  DDOS_ALERT_COOLDOWN: number;
  DDOS_ENABLED: boolean;
  DDOS_THRESHOLD_SYN: number;
  //Alerts
  ALERT_CPU: boolean;
  ALERT_DISK: boolean;
  ALERT_SWAP: boolean;
  ALERT_RAM: boolean;
  // Limits
  DISK_LIMIT: number;
  CPU_LIMIT: number;
  SWAP_LIMIT: number;
  RAM_LIMIT: number;
}

function parseBool(v: string | undefined, def: boolean): boolean {
  if (v === undefined) return def;
  return ["1", "true", "yes"].includes(v.toLowerCase());
}

function parseInt2(v: string | undefined, def: number): number {
  if (v === undefined) return def;
  const n = parseInt(v, 10);
  return isNaN(n) ? def : n;
}

function parseFloat2(v: string | undefined, def: number): number {
  if (v === undefined) return def;
  const n = parseFloat(v);
  return isNaN(n) ? def : n;
}

export function loadConfig(path = process.env.CONFIG_FILE || "/etc/telegram-auth.conf"): Config {
  const raw: Record<string, string> = {};

  if (existsSync(path)) {
    const lines = readFileSync(path, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const eqIdx = trimmed.indexOf("=");
      const key   = trimmed.slice(0, eqIdx).trim();
      let val     = trimmed.slice(eqIdx + 1).trim();
      val = val.split("#")[0].trim().replace(/^["']|["']$/g, "");
      raw[key] = val;
    }
  }

  const g = (k: string) => raw[k] ?? process.env[k] ?? "";

  const BOT_TOKEN = g("BOT_TOKEN");
  const CHAT_ID   = parseInt2(g("CHAT_ID"), 0);
  const tid       = parseInt2(g("THREAD_ID"), 0);
  const THREAD_ID = tid || null;

  if (!BOT_TOKEN || !CHAT_ID) {
    throw new Error("BOT_TOKEN/CHAT_ID are empty — check /etc/telegram-auth.conf");
  }

  const ENABLE_POLLING = parseBool(g("ENABLE_POLLING") || "1", true);

  let DISPATCH_MAP: Record<string, string> = {};
  try { DISPATCH_MAP = JSON.parse(g("DISPATCH_MAP") || "{}"); } catch {}

  const leaderRaw = parseInt2(g("LEADER_THREAD_ID") || g("THREAD_ID") || "0", 0);

  return {
    BOT_TOKEN,
    CHAT_ID,
    THREAD_ID,
    HOST_NAME: g("lable") || hostname(),
    IP:        g("ip4") || "",
    LEADER_THREAD_ID: leaderRaw,
    HANDLE_UNKNOWN_ON_LEADER: ENABLE_POLLING ? false : parseBool(g("HANDLE_UNKNOWN_ON_LEADER"), false),
    ENABLE_POLLING,
    SEND_WELCOME: parseBool(g("SEND_WELCOME"), false),
    HEALTH_INTERVAL_SEC:   parseInt2(g("HEALTH_INTERVAL_SEC"),   30),
    DOWN_ALERT_REPEAT_MIN: parseInt2(g("DOWN_ALERT_REPEAT_MIN"),  0),
    HEALTH_TIMEOUT:        parseInt2(g("HEALTH_TIMEOUT"),          5),
    DISPATCH_MAP,
    AGENT_SECRET: g("AGENT_SECRET") || "changeme",
    AGENT_BIND:   g("AGENT_BIND")   || "0.0.0.0:9797",
    NET_IFACE:    g("NET_IFACE")    || "",
    // DDoS
    DDOS_IFACE:           g("DDOS_IFACE") || "",
    DDOS_INTERVAL:        parseInt2(g("DDOS_INTERVAL"),          5),
    DDOS_THRESHOLD_PPS:   parseInt2(g("DDOS_PPS")    || g("THRESHOLD_PPS"), 100_000),
    DDOS_THRESHOLD_BPS:   parseInt2(g("DDOS_BPS")    || g("THRESHOLD_BPS"), 104_857_600),
    DDOS_THRESHOLD_CT:    parseFloat2(g("DDOS_CT")   || g("THRESHOLD_CT"),  0.80),
    DDOS_THRESHOLD_TOPN:  parseInt2(g("DDOS_TOPN")   || g("THRESHOLD_TOPN"), 1000),
    DDOS_ALERT_COOLDOWN:  parseInt2(g("DDOS_COOLDOWN")|| g("ALERT_COOLDOWN"), 60),
    DDOS_ENABLED:         parseBool(g("DDOS_ENABLED") || "1", true),
    DDOS_THRESHOLD_SYN:   parseInt2(g("DDOS_SYN"), 500),
    // Alerts
    ALERT_CPU:            parseBool(g("ALERT_CPU") || "1", true),
    ALERT_DISK:           parseBool(g("ALERT_DISK") || "1", true),
    ALERT_RAM:            parseBool(g("ALERT_RAM") || "1", true),
    ALERT_SWAP:           parseBool(g("ALERT_SWAP") || "1", true),
    // Limits
    DISK_LIMIT: parseFloat2(g("DISK_LIMIT"), 99),
    CPU_LIMIT:  parseFloat2(g("CPU_LIMIT"),  99),
    SWAP_LIMIT: parseFloat2(g("SWAP_LIMIT"), 98),
    RAM_LIMIT:  parseFloat2(g("RAM_LIMIT"),  98),
  };
}

// singleton
let _cfg: Config | null = null;
export function cfg(): Config {
  if (!_cfg) _cfg = loadConfig();
  return _cfg;
}
