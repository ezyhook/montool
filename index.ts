import { Bot } from "grammy";
import { cfg as loadCfg } from "./config";
import { startMonitorLoop } from "./monitor";
import { startNetCollector } from "./net";
import { startGraphRefresher } from "./graphs";
import { startDdosLoop } from "./ddos";
import { startHealthcheckLoop } from "./healthcheck";
import { handleCommand } from "./handler";
import { initOomMarker } from "./monitor";
import { sendText, sendTextWithInlineKeyboard, setBotCommands, BOT_COMMANDS } from "./telegram";

const cfg = loadCfg();

// ── grammy bot (only used in LEADER / polling mode) ──────────────────────────
let bot: Bot | null = null;

if (cfg.ENABLE_POLLING) {
  bot = new Bot(cfg.BOT_TOKEN);

  bot.on("message:text", (ctx) => {
    const text     = ctx.message.text?.trim() ?? "";
    const threadId = (ctx.message as any).message_thread_id as number | undefined;
    if (text) routeOrHandle(threadId, text);
  });

  bot.on("callback_query:data", async (ctx) => {
    const data     = ctx.callbackQuery.data ?? "";
    const msg      = ctx.callbackQuery.message;
    const threadId = (msg as any)?.message_thread_id as number | undefined;
    const handled  = routeOrHandle(threadId, data);
    if (handled) {
      try { await ctx.answerCallbackQuery(); } catch {}
      try { await ctx.editMessageReplyMarkup({ reply_markup: undefined as any }); } catch {}
    }
  });
}

// ── Routing ───────────────────────────────────────────────────────────────────
function routeOrHandle(threadId: number | undefined, text: string): boolean {
  const key      = String(threadId ?? "");
  const agentUrl = cfg.DISPATCH_MAP[key];

  if (agentUrl) {
    forwardToAgent(agentUrl, text).catch(console.error);
    return true;
  }
  if (cfg.LEADER_THREAD_ID && key === String(cfg.LEADER_THREAD_ID)) {
    handleCommand(text).catch(console.error);
    return true;
  }
  if (cfg.HANDLE_UNKNOWN_ON_LEADER) {
    handleCommand(text).catch(console.error);
    return true;
  }
  return false;
}

async function forwardToAgent(url: string, cmd: string): Promise<void> {
  try {
    const r = await fetch(`${url.replace(/\/$/, "")}/handle`, {
      method:  "POST",
      headers: { "x-auth": cfg.AGENT_SECRET, "Content-Type": "application/json" },
      body:    JSON.stringify({ cmd }),
      signal:  AbortSignal.timeout(10_000),
    });
    const j = await r.json() as any;
    if (!j.ok) console.warn("[forward] agent replied not-ok:", j);
  } catch (e) {
    console.error("[forward] error:", e);
  }
}

// ── HTTP agent server (Bun.serve) ─────────────────────────────────────────────
function startAgentServer(): void {
  const [host, portStr] = cfg.AGENT_BIND.split(":");
  const port = parseInt(portStr, 10);

  Bun.serve({
    hostname: host,
    port,
    async fetch(req) {
      const auth = req.headers.get("x-auth");
      if (auth !== cfg.AGENT_SECRET)
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });

      const url = new URL(req.url);

      if (url.pathname === "/health" && req.method === "GET") {
        return Response.json({
          ok:   true,
          host: cfg.HOST_NAME,
          ip:   cfg.IP,
          time: new Date().toISOString(),
        });
      }

      if (url.pathname === "/handle" && req.method === "POST") {
        let cmd = "";
        try { cmd = ((await req.json()) as any).cmd?.trim() ?? ""; } catch {}
        if (!cmd) return Response.json({ ok: false, error: "empty cmd" });
        handleCommand(cmd).catch(console.error);
        return Response.json({ ok: true });
      }

      return Response.json({ ok: false, error: "not found" }, { status: 404 });
    },
  });

  console.log(`[agent] HTTP server listening on ${host}:${port}`);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  const role = cfg.ENABLE_POLLING ? "LEADER" : "AGENT";
  console.log(`[startup] host=${cfg.HOST_NAME} role=${role} thread=${cfg.THREAD_ID} chat=${cfg.CHAT_ID}`);

  await initOomMarker();

  startMonitorLoop();
  startNetCollector();
  startGraphRefresher();
  startDdosLoop();

  if (cfg.ENABLE_POLLING) {
    startHealthcheckLoop();

    if (cfg.SEND_WELCOME) {
      await sendText("🚀 Monitoring bot started.");
      await sendTextWithInlineKeyboard("👋 Choose a metric:");
    }

    await setBotCommands(BOT_COMMANDS);

    console.log("[bot] starting grammy polling...");
    bot!.start({ onStart: () => console.log("[bot] polling started") });
  } else {
    startAgentServer();
    await new Promise(() => {}); // keep alive
  }
}

main().catch((e) => { console.error(e); process.exit(1); });