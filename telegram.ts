import { InlineKeyboard, Keyboard } from "grammy";
import { cfg } from "./config";

// ── Rate limiter (1.2 s between sends) ───────────────────────────────────────
let _lastSend = 0;
async function throttle() {
  const wait = 1200 - (Date.now() - _lastSend);
  if (wait > 0) await Bun.sleep(wait);
  _lastSend = Date.now();
}

// ── Core Telegram API call via fetch ─────────────────────────────────────────
async function tgCall(method: string, body: Record<string, unknown>): Promise<any> {
  const c   = cfg();
  const url = `https://api.telegram.org/bot${c.BOT_TOKEN}/${method}`;

  let attempt = 0;
  while (true) {
    await throttle();
    try {
      const resp = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
        signal:  AbortSignal.timeout(20_000),
      });

      if (resp.ok) return resp.json();

      const status = resp.status;
      if ([429, 500, 502, 503, 504].includes(status)) {
        let retryAfter = 1;
        try { retryAfter = ((await resp.json()) as any)?.parameters?.retry_after ?? 1; } catch {}
        const wait = retryAfter * 1000 + Math.random() * 500;
        console.warn(`[tg] ${status} on ${method}, retry in ${(wait / 1000).toFixed(1)}s`);
        await Bun.sleep(wait);
        if (++attempt > 5) { console.error(`[tg] too many retries on ${method}`); return null; }
        continue;
      }

      console.error(`[tg] ${method} → ${status}:`, await resp.text().catch(() => ""));
      return null;
    } catch (e: any) {
      if (++attempt > 5) { console.error(`[tg] network error on ${method}:`, e?.message); return null; }
      await Bun.sleep(Math.min(2 ** attempt * 1000, 30_000) + Math.random() * 500);
    }
  }
}

// ── Thread id helper ─────────────────────────────────────────────────────────
function threadOpts(): Record<string, unknown> {
  const tid = cfg().THREAD_ID;
  return tid ? { message_thread_id: tid } : {};
}

// ── Public send helpers ───────────────────────────────────────────────────────
export async function sendText(msg: string): Promise<void> {
  await tgCall("sendMessage", {
    chat_id:    cfg().CHAT_ID,
    text:       msg,
    parse_mode: "HTML",
    ...threadOpts(),
  });
}

export async function sendImage(buf: Buffer, caption: string): Promise<void> {
  const c    = cfg();
  const form = new FormData();
  form.append("chat_id", String(c.CHAT_ID));
  form.append("caption", caption);
  if (c.THREAD_ID) form.append("message_thread_id", String(c.THREAD_ID));
  form.append("photo", new Blob([new Uint8Array(buf)], { type: "image/png" }), "graph.png");

  await throttle();
  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${c.BOT_TOKEN}/sendPhoto`,
      { method: "POST", body: form, signal: AbortSignal.timeout(30_000) }
    );
    if (!resp.ok) console.error("[sendImage]", resp.status, await resp.text().catch(() => ""));
  } catch (e: any) {
    console.error("[sendImage]", e?.message);
  }
}

export async function sendTextToThread(threadId: number, msg: string): Promise<void> {
  await tgCall("sendMessage", {
    chat_id:    cfg().CHAT_ID,
    text:       msg,
    parse_mode: "HTML",
    ...(threadId ? { message_thread_id: threadId } : {}),
  });
}

export async function sendTextWithKeyboard(msg: string): Promise<void> {
  const keyboard = new Keyboard()
    .text("/net").text("/quota").text("/g month").row()
    .text("/g cpu").text("/g load").text("/g ram").text("/g swap").row()
    .text("/g disk").text("/g ioutil").row()
    .text("/g peaks").text("/ddos").text("/rm_menu").text("/help")
    .resized();

  await tgCall("sendMessage", {
    chat_id:      cfg().CHAT_ID,
    text:         msg,
    parse_mode:   "HTML",
    reply_markup: keyboard,
    ...threadOpts(),
  });
}

export async function sendTextWithInlineKeyboard(msg: string): Promise<void> {
  const kb = new InlineKeyboard()
    .text("NET 24h","/net").text("QUOTA", "/quota").text("MONTH Σ", "/graph month").row()
    .text("CPU",    "/graph cpu").text("RAM",  "/graph ram")
    .text("SWAP",   "/graph swap").text("LOAD", "/graph load").row()
    .text("DISK",   "/graph disk").text("IOUTIL", "/graph ioutil").row()
    .text("📊 Peaks", "/graph peaks").text("🛡 DDoS", "/ddos").text("HELP", "/help");

  await tgCall("sendMessage", {
    chat_id:      cfg().CHAT_ID,
    text:         msg,
    parse_mode:   "HTML",
    reply_markup: kb,
    ...threadOpts(),
  });
}

export async function removeKeyboard(): Promise<void> {
  await tgCall("sendMessage", {
    chat_id:      cfg().CHAT_ID,
    text:         "🗑 Keyboard hidden",
    reply_markup: { remove_keyboard: true },
    ...threadOpts(),
  });
}

export const BOT_COMMANDS = [
  { command: "start",    description: "Start the bot and menu" },
  { command: "help",     description: "Help and commands" },
  { command: "rm_menu",  description: "Hide the menu" },
  { command: "net",      description: "In/out traffic graph, 24h" },
  { command: "quota",    description: "Quota (month)" },
  { command: "peaks",    description: "Monthly traffic peaks table" },
  { command: "g_month",  description: "Monthly traffic graph" },
  { command: "g_peaks",  description: "Monthly peaks histogram" },
  { command: "g_cpu",    description: "CPU graph, 24h" },
  { command: "g_load",   description: "LOAD graph, 24h" },
  { command: "g_ram",    description: "RAM graph, 24h" },
  { command: "g_swap",   description: "SWAP graph, 24h" },
  { command: "g_disk",   description: "DISK graph, 24h" },
  { command: "g_ioutil", description: "IO Utilization graph, 24h" },
  { command: "m_cpu",    description: "CPU graph, month" },
  { command: "m_load",   description: "LOAD graph, month" },
  { command: "m_ram",    description: "RAM graph, month" },
  { command: "m_swap",   description: "SWAP graph, month" },
  { command: "m_disk",   description: "DISK graph, month" },
  { command: "m_ioutil", description: "IO Utilization graph, month" },
  { command: "ddos",     description: "DDoS detector status" },
];

export async function setBotCommands(commands: typeof BOT_COMMANDS): Promise<void> {
  const scopes = [
    { type: "chat", chat_id: cfg().CHAT_ID },
    { command: "all_group_chats"   },
    { command: "all_private_chats" },
  ];
  for (const scope of scopes) {
    await tgCall("setMyCommands", { commands, scope });
  }
}