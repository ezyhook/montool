#!/usr/bin/env bash
# montool installer — builds from this checkout and installs a systemd service.
#
# First run (no config yet) needs at minimum a Telegram bot token and chat id.
# Provide them via environment or you will be prompted interactively:
#
#   BOT_TOKEN=123:abc CHAT_ID=-100123 ./install.sh
#
# Useful overrides (all optional):
#   CONFIG_FILE   target config path            (default: /etc/telegram-auth.conf)
#   INSTALL_DIR   where the app is installed/run (default: this script's directory)
#   RUN_USER      systemd service user           (default: root)
#   SERVICE_NAME  systemd unit name              (default: montool.service)
#   RUNTIME       node | bun                     (default: auto-detect, prefers node)
#   BUN_BIN       path to the bun binary         (default: $HOME/.bun/bin/bun)
#   ROLE          master | slave                 (master = leader/polling; prompted)
#   THREAD_ID     use this forum topic instead of creating one
#   CREATE_TOPIC  1 = auto-create "<label>-<ip>" topic (default), 0 = skip
#
# Uninstall with:  ./install.sh --remove
set -euo pipefail

CONFIG_FILE="${CONFIG_FILE:-/etc/telegram-auth.conf}"
SERVICE_NAME="${SERVICE_NAME:-montool.service}"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$SCRIPT_DIR}"
RUN_USER="${RUN_USER:-root}"
BUN_BIN="${BUN_BIN:-$HOME/.bun/bin/bun}"

# Runtime: default to Node, fall back to Bun only if Node is absent.
RUNTIME="${RUNTIME:-}"
if [[ -z "$RUNTIME" ]]; then
  if command -v node >/dev/null 2>&1; then RUNTIME=node
  elif command -v bun >/dev/null 2>&1 || [[ -x "$BUN_BIN" ]]; then RUNTIME=bun
  else RUNTIME=node; fi
fi

log() { echo "[+] $*"; }
err() { echo "[!] $*" >&2; }

remove() {
  log "Removing service ${SERVICE_NAME}..."
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "$SERVICE_PATH"
  systemctl daemon-reload
  systemctl reset-failed 2>/dev/null || true
  log "Removed. Config at ${CONFIG_FILE} was left in place."
}

[[ "${1:-}" == "--remove" ]] && { remove; exit 0; }

# ── Dependencies (best effort; needs apt-based distro for auto-install) ────────
ensure_pkg() {
  local pkg="$1" check="$2"
  eval "$check" >/dev/null 2>&1 && return 0
  err "${pkg} not found, trying to install..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get install -y "$pkg" >/dev/null 2>&1 && log "${pkg} installed." || err "could not install ${pkg} (install it manually)"
  else
    err "no apt-get; please install ${pkg} manually"
  fi
}

if [[ "$RUNTIME" == "bun" ]]; then
  [[ -x "$BUN_BIN" ]] || { log "Installing Bun..."; curl -fsSL https://bun.sh/install | bash; }
else
  command -v node >/dev/null 2>&1 || { err "Node.js not found — install Node >= 20 first"; exit 1; }
  command -v npm  >/dev/null 2>&1 || { err "npm not found — install npm first"; exit 1; }
fi
log "Runtime: ${RUNTIME}"

ensure_pkg conntrack        "command -v conntrack"
ensure_pkg fontconfig       "dpkg -l fontconfig        2>/dev/null | grep -q '^ii'"
ensure_pkg fonts-dejavu-core "dpkg -l fonts-dejavu-core 2>/dev/null | grep -q '^ii'"

# ── First-run configuration ───────────────────────────────────────────────────
if [[ ! -f "$CONFIG_FILE" ]]; then
  log "No config at ${CONFIG_FILE} — creating one."

  BOT_TOKEN="${BOT_TOKEN:-}"
  CHAT_ID="${CHAT_ID:-}"

  if [[ -z "$BOT_TOKEN" ]]; then
    if [[ -t 0 ]]; then read -rp "Telegram BOT_TOKEN: " BOT_TOKEN
    else err "BOT_TOKEN is required (set it via env or run interactively)"; exit 1; fi
  fi
  if [[ -z "$CHAT_ID" ]]; then
    if [[ -t 0 ]]; then read -rp "Telegram CHAT_ID: " CHAT_ID
    else err "CHAT_ID is required (set it via env or run interactively)"; exit 1; fi
  fi
  [[ -z "$BOT_TOKEN" || -z "$CHAT_ID" ]] && { err "BOT_TOKEN and CHAT_ID must not be empty"; exit 1; }

  # Role: master = leader (polls Telegram, routes to agents); slave = agent (HTTP).
  ROLE="${ROLE:-}"
  if [[ -z "$ROLE" && -n "${ENABLE_POLLING:-}" ]]; then
    [[ "$ENABLE_POLLING" == "1" ]] && ROLE=master || ROLE=slave
  fi
  if [[ -z "$ROLE" ]]; then
    if [[ -t 0 ]]; then read -rp "Host role [master/slave] (master = leader/polling) [master]: " ROLE
    else ROLE=master; fi
  fi
  case "${ROLE,,}" in
    master|leader|m|"") ROLE=master; ENABLE_POLLING=1 ;;
    slave|agent|s)      ROLE=slave;  ENABLE_POLLING=0 ;;
    *) err "unknown role '${ROLE}' (use master or slave)"; exit 1 ;;
  esac
  log "Role: ${ROLE} (ENABLE_POLLING=${ENABLE_POLLING})"

  HOST_LABEL="${LABEL:-$(hostname)}"
  DETECTED_IP="$(ip route get 8.8.8.8 2>/dev/null | sed -n '/src/{s/.*src *\([^ ]*\).*/\1/p;q}')"
  GEN_SECRET="$(openssl rand -hex 16 2>/dev/null || head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  AGENT_BIND="${AGENT_BIND:-0.0.0.0:9797}"

  # Forum topic — one per host, named "<label>-<ip>", so each host posts to its
  # own thread. Needs a forum supergroup where the bot is an admin that can
  # manage topics. Skip with CREATE_TOPIC=0 or by passing THREAD_ID.
  THREAD_ID="${THREAD_ID:-}"
  if [[ -z "$THREAD_ID" && "${CREATE_TOPIC:-1}" == "1" ]]; then
    TOPIC_NAME="${HOST_LABEL}-${DETECTED_IP}"
    log "Creating forum topic '${TOPIC_NAME}'..."
    topic_resp="$(curl -fsS -X POST "https://api.telegram.org/bot${BOT_TOKEN}/createForumTopic" \
        --data-urlencode "chat_id=${CHAT_ID}" \
        --data-urlencode "name=${TOPIC_NAME}" 2>/dev/null || true)"
    THREAD_ID="$(printf '%s' "$topic_resp" | grep -oE '"message_thread_id":[0-9]+' | head -1 | grep -oE '[0-9]+' || true)"
    if [[ -n "$THREAD_ID" ]]; then
      log "Topic created, THREAD_ID=${THREAD_ID}"
    else
      err "Could not create topic (is the chat a forum supergroup and the bot an admin with 'Manage topics'?)."
      err "Response: ${topic_resp:-<empty>}"
      err "Continuing without a topic; messages go to the group's General thread. Set THREAD_ID later if needed."
      THREAD_ID=""
    fi
  fi

  # The master handles commands typed in its own topic locally.
  LEADER_THREAD_ID=""
  [[ "$ROLE" == "master" ]] && LEADER_THREAD_ID="$THREAD_ID"

  umask 077
  cat > "$CONFIG_FILE" <<EOF
# Generated by install.sh on $(date -u '+%Y-%m-%d %H:%M:%S UTC')  (role: ${ROLE})
BOT_TOKEN=${BOT_TOKEN}
CHAT_ID=${CHAT_ID}
THREAD_ID=${THREAD_ID}

lable=${HOST_LABEL}
ip4=${DETECTED_IP}

ENABLE_POLLING=${ENABLE_POLLING}
SEND_WELCOME=0
LEADER_THREAD_ID=${LEADER_THREAD_ID}
DISPATCH_MAP={}
AGENT_SECRET=${AGENT_SECRET:-$GEN_SECRET}
AGENT_BIND=${AGENT_BIND:-0.0.0.0:9797}

NET_IFACE=

DDOS_ENABLED=1
DDOS_IFACE=
DDOS_INTERVAL=5
DDOS_PPS=100000
DDOS_BPS=104857600
DDOS_CT=0.80
DDOS_TOPN=1000
DDOS_SYN=500
DDOS_COOLDOWN=60

ALERT_CPU=1
ALERT_DISK=1
ALERT_SWAP=1
ALERT_RAM=1

CPU_LIMIT=
DISK_LIMIT=
RAM_LIMIT=
SWAP_LIMIT=

HEALTH_INTERVAL_SEC=30
DOWN_ALERT_REPEAT_MIN=0
HEALTH_TIMEOUT=5
EOF
  chmod 600 "$CONFIG_FILE"
  log "Config written to ${CONFIG_FILE}"
  if [[ "$ROLE" == "slave" ]]; then
    log "This host is a SLAVE. Register it on the master with:"
    log "    ./add-agent.sh ${THREAD_ID:-<thread_id>} http://${DETECTED_IP:-<this-host-ip>}:${AGENT_BIND##*:}"
  fi
else
  log "Using existing config at ${CONFIG_FILE}"
fi

# ── Install dependencies & resolve the start command ──────────────────────────
cd "$INSTALL_DIR"
if [[ "$RUNTIME" == "bun" ]]; then
  log "Installing dependencies (bun)..."
  "$BUN_BIN" install
  EXEC_START="${BUN_BIN} ${INSTALL_DIR}/index.ts"
else
  log "Installing dependencies (npm)..."
  if [[ -f package-lock.json ]]; then npm ci; else npm install; fi
  log "Building bundle (esbuild)..."
  npm run build
  [[ -f dist/index.js ]] || { err "build failed: dist/index.js not created"; exit 1; }
  log "Pruning dev dependencies..."
  npm prune --omit=dev
  NODE_BIN="$(command -v node)"
  # Run the precompiled bundle: fastest startup, lowest memory (no tsx/esbuild).
  EXEC_START="${NODE_BIN} ${INSTALL_DIR}/dist/index.js"
fi
log "Start command: ${EXEC_START}"

# ── systemd service ──────────────────────────────────────────────────────────
log "Installing ${SERVICE_NAME}..."
cat > "$SERVICE_PATH" <<EOF
[Unit]
Description=montool — Telegram server monitor
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${EXEC_START}
User=${RUN_USER}
WorkingDirectory=${INSTALL_DIR}
Environment=CONFIG_FILE=${CONFIG_FILE}
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF
chmod 644 "$SERVICE_PATH"

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
systemctl restart "$SERVICE_NAME"
log "Done. Status:"
systemctl --no-pager --lines=5 status "$SERVICE_NAME" || true
