import { createServer } from "http";
import { Bot } from "grammy";
import { sleep } from "./runtime";
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

  // Don't let an error thrown inside a handler crash the process.
  bot.catch((err) => console.error("[bot] handler error:", (err as any)?.error ?? err));

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

// ── HTTP agent server (node:http — runs on both Node and Bun) ─────────────────
function startAgentServer(): void {
  const [host, portStr] = cfg.AGENT_BIND.split(":");
  const port = parseInt(portStr, 10);

  const server = createServer((req, res) => {
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    if (req.headers["x-auth"] !== cfg.AGENT_SECRET)
      return send(401, { ok: false, error: "unauthorized" });

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/health" && req.method === "GET") {
      return send(200, { ok: true, host: cfg.HOST_NAME, ip: cfg.IP, time: new Date().toISOString() });
    }

    if (url.pathname === "/handle" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) req.destroy(); // cap request size
      });
      req.on("end", () => {
        let cmd = "";
        try { cmd = (JSON.parse(body) as any).cmd?.trim() ?? ""; } catch {}
        if (!cmd) return send(200, { ok: false, error: "empty cmd" });
        handleCommand(cmd).catch(console.error);
        send(200, { ok: true });
      });
      return;
    }

    return send(404, { ok: false, error: "not found" });
  });

  server.listen(port, host, () => console.log(`[agent] HTTP server listening on ${host}:${port}`));
}

// ── Resilient long-polling (LEADER) ──────────────────────────────────────────
// A polling error (notably 409 Conflict from a second poller) must not crash the
// process into a tight systemd restart loop — fast restarts re-trigger 409 while
// Telegram still holds the previous long-poll slot. Retry in-process with a pause
// so a transient conflict clears on its own.
async function runPolling(): Promise<void> {
  for (;;) {
    try {
      await bot!.start({
        drop_pending_updates: true,
        onStart: () => console.log("[bot] polling started"),
      });
      return; // start() resolves only on an intentional stop
    } catch (e: any) {
      const code = e?.error_code;
      if (code === 401) {
        console.error("[bot] 401 Unauthorized — check BOT_TOKEN. Exiting.");
        process.exit(1);
      }
      if (code === 409) {
        console.error(
          "[bot] 409 Conflict — another process is polling this bot token. " +
          "Run only ONE leader (ENABLE_POLLING=1) per token; other hosts must be agents " +
          "(ENABLE_POLLING=0). Retrying in 35s."
        );
      } else {
        console.error(`[bot] polling error (${code ?? "network"}): ${e?.description ?? e?.message ?? e}. Retrying in 35s.`);
      }
      try { await bot!.stop(); } catch {}
      await sleep(35_000);
    }
  }
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
    await runPolling();
  } else {
    startAgentServer();
    await new Promise(() => {}); // keep alive
  }
}

main().catch((e) => { console.error(e); process.exit(1); });