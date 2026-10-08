import {
  sendText, sendImage, sendTextWithKeyboard, sendTextWithInlineKeyboard,
  removeKeyboard, setBotCommands, BOT_COMMANDS,
} from "./telegram";
import { buildGraph, buildMonthTrafficGraph, buildMonthPeaksGraph, LAST_PNG } from "./graphs";
import { monthlyTrafficGB, quotaReset, quotaSet, quotaShowMonth, quotaDeleteMonth, readAllMonthPeaks } from "./quota";
import { dbSys, dbNet } from "./db";
import { ddosStatusText } from "./ddos";
import { cfg } from "./config";

function buildHelpText(): string {
  return (
    "📖 <b>Help / commands</b>\n\n" +
    "• <b>/start</b> — welcome and menu\n" +
    "• <b>/rm_menu</b> — remove the menu\n" +
    "• <b>/net</b> — in/out traffic graph, 24h (Mbit/s)\n" +
    "• <b>/net 30d</b> — graph for the last 30 days\n" +
    "• <b>/net YYYY-MM-DD</b> — graph for a day, e.g. <code>/net 2025-09-09</code>\n" +
    "• <b>/graph month</b> — cumulative traffic for the month (GB)\n" +
    "• <b>/graph peaks</b> — monthly traffic peaks histogram\n" +
    "• <b>/graph cpu|ram|swap|disk|ioutil|load</b> — system graphs, 24h\n" +
    "• <b>/peaks</b> — monthly traffic peaks table (text)\n" +
    "• <b>/quota</b> or <b>/q</b> — current quota (Up/Down/Total) since month start\n" +
    "• <b>/quota reset</b> — reset the current month's counters\n" +
    "• <b>/quota set &lt;upGB&gt; &lt;downGB&gt;</b> — set the quota manually\n" +
    "• <b>/quota show YYYY-MM</b> — show the quota for a month\n" +
    "• <b>/quota del YYYY-MM</b> — delete a month's record\n" +
    "• <b>/m_(cpu|ram|swap|disk|ioutil|load)</b> — graphs for 30 days\n" +
    "• <b>/ddos</b> — DDoS detector status and current metrics\n" +
    "• <b>/help</b> — help\n"
  );
}

async function sendOrFallback(key: string, buildFn: () => Promise<Buffer | null>, caption: string) {
  const cached = LAST_PNG[key];
  const buf    = cached ?? await buildFn();
  if (buf) await sendImage(buf, caption);
  else     await sendText("No data.");
}

export async function handleCommand(raw: string): Promise<void> {
  if (!raw) return;
  const parts = raw.trim().split(/\s+/);
  if (!parts.length) return;

  // strip @BotName suffix
  const head = parts[0].split("@")[0].toLowerCase();
  const args = parts.slice(1);

  switch (head) {

    // ── NET ─────────────────────────────────────────────────────────────────
    case "/net24":
    case "/net": {
      const arg = args[0]?.toLowerCase();

      if (!arg || arg === "24h" || arg === "24") {
        const buf = await buildGraph("total", dbNet, "24h");
        buf ? await sendImage(buf, "📈 Traffic, 24h")
            : await sendText("No data for 24h.");
        break;
      }

      if (arg === "30d" || arg === "month") {
        const buf = await buildGraph("total", dbNet, "month");
        buf ? await sendImage(buf, "📈 Traffic, 30 days")
            : await sendText("No data for 30 days.");
        break;
      }

      if (!/^\d{4}-\d{2}-\d{2}$/.test(arg))
        return sendText("Format: /net | /net 24h | /net 30d | /net YYYY-MM-DD");

      const buf = await buildGraph("total", dbNet, "day", arg);
      buf ? await sendImage(buf, `📈 Traffic for ${arg}`)
          : await sendText("No data.");
      break;
    }

    // ── GRAPH ────────────────────────────────────────────────────────────────
    case "/graph":
    case "/g": {
      const m = (args[0] ?? "").toLowerCase();

      if (m === "month" || m === "mtraffic") {
        const buf = LAST_PNG["mtraffic"] ?? await buildMonthTrafficGraph();
        return buf
          ? sendImage(buf, "📈 Cumulative traffic for the month (UTC)")
          : sendText("No data for the current month.");
      }

      // ── Peaks histogram ──────────────────────────────────────────────────
      if (m === "peaks") {
        const buf = LAST_PNG["mpeaks"] ?? await buildMonthPeaksGraph();
        return buf
          ? sendImage(buf, "📊 Monthly traffic peaks (GB)")
          : sendText("No saved monthly peaks.");
      }

      const allowed = new Set(["cpu","load","ram","disk","swap","ioutil",
                                "m_cpu","m_load","m_ram","m_disk","m_swap","m_ioutil"]);
      if (!allowed.has(m))
        return sendText("Usage: /graph cpu|load|ram|disk|swap|ioutil|month|peaks");

      const mode    = m.startsWith("m_") ? "month" : "24h";
      const metric  = m.startsWith("m_") ? m.slice(2) : m;
      const caption = `📈 ${m.toUpperCase()} ${mode === "month" ? "30 days" : "24H"}`;
      await sendOrFallback(m, () => buildGraph(metric, dbSys, mode), caption);
      break;
    }

    // ── PEAKS (text table) ────────────────────────────────────────────────────
    case "/peaks": {
      const peaks = await readAllMonthPeaks();

      if (peaks.length === 0)
        return sendText("No saved monthly peaks.\n\nPeaks are recorded automatically at month rollover.");

      // Also append current month live value
      const cur = await monthlyTrafficGB();
      const now = new Date();
      const curYm = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

      const allEntries = [
        ...peaks.filter(p => p.ym !== curYm),
        { ym: curYm, upB: cur.up * 1e9, dnB: cur.down * 1e9 },
      ].sort((a, b) => a.ym.localeCompare(b.ym));

      const rows = allEntries.map(e => {
        const upGB    = (e.upB / 1e9).toFixed(2);
        const downGB  = (e.dnB / 1e9).toFixed(2);
        const totalGB = ((e.upB + e.dnB) / 1e9).toFixed(2);
        const mark = e.ym === curYm ? " ←" : "";
        return `${e.ym}  ↑${upGB}  ↓${downGB}  Σ${totalGB} GB${mark}`;
      });

      await sendText(
        `📊 <b>Monthly traffic peaks</b>\n\n` +
        `<code>${rows.join("\n")}</code>\n\n` +
        `<i>← current month (in progress)</i>`
      );
      break;
    }

    // ── QUOTA ────────────────────────────────────────────────────────────────
    case "/quota":
    case "/q": {
      if (!args.length) {
        const t = await monthlyTrafficGB();
        return sendText(
          `📦 Traffic since month start (UTC)\n` +
          `Up:   <b>${t.up.toFixed(2)} GB</b>\n` +
          `Down: <b>${t.down.toFixed(2)} GB</b>\n` +
          `Total: <b>${t.total.toFixed(2)} GB</b>`
        );
      }

      const sub = args[0].toLowerCase();

      if (sub === "reset") {
        const t = await quotaReset();
        return sendText(
          "♻️ Current month's quota reset.\n" +
          `Up: <b>${t.up.toFixed(2)} GB</b>, Down: <b>${t.down.toFixed(2)} GB</b>, Total: <b>${t.total.toFixed(2)} GB</b>`
        );
      }

      if (sub === "set" && args.length >= 3) {
        const up = parseFloat(args[1]), dn = parseFloat(args[2]);
        if (isNaN(up) || isNaN(dn))
          return sendText("Format: <code>/quota set &lt;upGB&gt; &lt;downGB&gt;</code>");
        const t = await quotaSet(up, dn);
        return sendText(
          "✅ Quota set manually.\n" +
          `Up: <b>${t.up.toFixed(2)} GB</b>, Down: <b>${t.down.toFixed(2)} GB</b>, Total: <b>${t.total.toFixed(2)} GB</b>${t.warn}`
        );
      }

      if (sub === "show" && args.length >= 2) {
        const res = await quotaShowMonth(args[1]);
        return res
          ? sendText(`📦 Quota for <b>${args[1]}</b>\nUp: <b>${res.up.toFixed(2)} GB</b>\nDown: <b>${res.down.toFixed(2)} GB</b>\nTotal: <b>${res.total.toFixed(2)} GB</b>`)
          : sendText(`No saved record for <b>${args[1]}</b>.`);
      }

      if (sub === "del" && args.length >= 2) {
        const ok = await quotaDeleteMonth(args[1]);
        return sendText(ok ? "🗑 Deleted." : "Nothing to delete or invalid format. Expected YYYY-MM.");
      }

      return sendText(
        "Usage:\n" +
        "• <code>/quota</code> — show the current month\n" +
        "• <code>/quota reset</code> — reset\n" +
        "• <code>/quota set &lt;upGB&gt; &lt;downGB&gt;</code> — set manually\n" +
        "• <code>/quota show YYYY-MM</code> — show a record\n" +
        "• <code>/quota del YYYY-MM</code> — delete a record"
      );
    }

    // ── DDOS ─────────────────────────────────────────────────────────────────
    case "/ddos":
      await sendText(await ddosStatusText());
      break;

    // ── START / MENU / HELP ───────────────────────────────────────────────────
    case "/start":
      await sendTextWithInlineKeyboard("👋 Choose a metric:");
      await setBotCommands(BOT_COMMANDS);
      break;

    case "/menu":
      await sendTextWithKeyboard("Hello! Menu added.");
      break;

    case "/allmenu": {
      const c = cfg();
      let ok  = true;
      for (const [, url] of Object.entries(c.DISPATCH_MAP)) {
        try {
          const r = await fetch(`${url.replace(/\/$/, "")}/handle`, {
            method:  "POST",
            headers: { "x-auth": c.AGENT_SECRET, "Content-Type": "application/json" },
            body:    JSON.stringify({ cmd: "/menu" }),
            signal:  AbortSignal.timeout(10_000),
          });
          const j = await r.json() as any;
          ok = ok && j.ok === true;
        } catch { ok = false; }
      }
      await sendText(ok
        ? "✅ Menu shown on all agents."
        : "⚠️ Failed to show the menu on some agents."
      );
      break;
    }

    case "/help":
      await sendText(buildHelpText());
      break;

    case "/rm_menu":
      await removeKeyboard();
      break;

    // ── shorthand graph commands ─────────────────────────────────────────────
    case "/g_month":
      await sendOrFallback("mtraffic", buildMonthTrafficGraph, "📈 Cumulative traffic for the month (UTC)");
      break;

    case "/g_peaks":
      await sendOrFallback("mpeaks", buildMonthPeaksGraph, "📊 Monthly traffic peaks (GB)");
      break;

    case "/g_cpu":
      await sendOrFallback("cpu", () => buildGraph("cpu", dbSys, "24h"), "📈 CPU 24H");
      break;
    case "/g_load":
      await sendOrFallback("load", () => buildGraph("load", dbSys, "24h"), "📈 Load 24H");
      break;
    case "/g_ram":
      await sendOrFallback("ram", () => buildGraph("ram", dbSys, "24h"), "📈 RAM 24H");
      break;
    case "/g_disk":
      await sendOrFallback("disk", () => buildGraph("disk", dbSys, "24h"), "📈 Disk 24H");
      break;
    case "/g_swap":
      await sendOrFallback("swap", () => buildGraph("swap", dbSys, "24h"), "📈 Swap 24H");
      break;
    case "/g_ioutil":
      await sendOrFallback("ioutil", () => buildGraph("ioutil", dbSys, "24h"), "📈 IOutil 24H");
      break;

    case "/m_cpu":
      await sendOrFallback("m_cpu", () => buildGraph("cpu", dbSys, "month"), "📈 CPU 30 days");
      break;
    case "/m_load":
      await sendOrFallback("m_load", () => buildGraph("load", dbSys, "month"), "📈 Load 30 days");
      break;
    case "/m_ram":
      await sendOrFallback("m_ram", () => buildGraph("ram", dbSys, "month"), "📈 RAM 30 days");
      break;
    case "/m_disk":
      await sendOrFallback("m_disk", () => buildGraph("disk", dbSys, "month"), "📈 Disk 30 days");
      break;
    case "/m_swap":
      await sendOrFallback("m_swap", () => buildGraph("swap", dbSys, "month"), "📈 Swap 30 days");
      break;
    case "/m_ioutil":
      await sendOrFallback("m_ioutil", () => buildGraph("ioutil", dbSys, "month"), "📈 IOutil 30 days");
      break;

    default:
      await sendText("Unknown command.");
  }
}