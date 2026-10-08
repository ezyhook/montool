import { sendTextToThread } from "./telegram";
import { cfg } from "./config";

interface AgentState {
  up: boolean;
  lastChange: number;
  lastAlert: number;
}

const _healthState: Record<string, AgentState> = {};

function mkState(): AgentState {
  return { up: true, lastChange: Date.now(), lastAlert: 0 };
}

function hcMark(tid: string, up: boolean) {
  const st = (_healthState[tid] ??= mkState());
  if (st.up !== up) {
    st.up         = up;
    st.lastChange = Date.now();
    st.lastAlert  = 0;
  }
}

function shouldRemind(tid: string): boolean {
  const c  = cfg();
  if (c.DOWN_ALERT_REPEAT_MIN <= 0) return false;
  const st = _healthState[tid];
  if (!st || st.up) return false;
  return (Date.now() - st.lastAlert) >= c.DOWN_ALERT_REPEAT_MIN * 60_000;
}

async function hcAlert(tid: string, msg: string) {
  await sendTextToThread(parseInt(tid, 10), msg);
  const st = (_healthState[tid] ??= mkState());
  st.lastAlert = Date.now();
}

async function checkOne(tid: string, baseUrl: string) {
  const c    = cfg();
  let ok     = false;
  try {
    const r = await fetch(`${baseUrl.replace(/\/$/, "")}/health`, {
      headers: { "x-auth": c.AGENT_SECRET },
      signal:  AbortSignal.timeout(c.HEALTH_TIMEOUT * 1000),
    });
    const j = await r.json() as any;
    ok = r.ok && j.ok === true;
  } catch {}

  const prev = (_healthState[tid] ??= mkState()).up;
  hcMark(tid, ok);

  if (prev && !ok)  await hcAlert(tid, `🔴 <b>AGENT DOWN</b> — no response from <code>${baseUrl}</code>`);
  if (!prev && ok)  await hcAlert(tid, `🟢 <b>AGENT UP</b> — recovered <code>${baseUrl}</code>`);
}

export function startHealthcheckLoop() {
  const c = cfg();
  for (const tid of Object.keys(c.DISPATCH_MAP)) {
    _healthState[tid] = mkState();
  }

  setInterval(async () => {
    try {
      for (const [tid, url] of Object.entries(c.DISPATCH_MAP)) {
        await checkOne(tid, url);
        if (shouldRemind(tid))
          await hcAlert(tid, `🔴 <b>AGENT STILL DOWN</b> — <code>${url}</code>`);
      }
    } catch (e) {
      console.error("[healthcheck] error:", e);
    }
  }, c.HEALTH_INTERVAL_SEC * 1000);
}
