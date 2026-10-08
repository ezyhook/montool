#!/usr/bin/env bash
# setup-login-alerts.sh — optional SSH login / failed-login Telegram alerts.
#
# Reuses BOT_TOKEN / CHAT_ID / THREAD_ID from the montool config. This is an
# add-on and is independent of the monitoring service itself.
#
# Install:   ./setup-login-alerts.sh
# Remove:    ./setup-login-alerts.sh --remove
set -euo pipefail

CONFIG_FILE="${CONFIG_FILE:-/etc/telegram-auth.conf}"
NOTIFY_SCRIPT="/usr/local/bin/telegram_login_notify.sh"
FAILED_SCRIPT="/usr/local/bin/telegram_failed_notify.sh"
FAILED_SERVICE="/etc/systemd/system/telegram-auth-fail.service"
PAM_FILES=("/etc/pam.d/sshd" "/etc/pam.d/login")

log() { echo "[+] $*"; }

remove() {
  log "Removing login alerts..."
  systemctl stop telegram-auth-fail.service 2>/dev/null || true
  systemctl disable telegram-auth-fail.service 2>/dev/null || true
  rm -f "$NOTIFY_SCRIPT" "$FAILED_SCRIPT" "$FAILED_SERVICE"
  for f in "${PAM_FILES[@]}"; do
    [[ -f "$f" ]] && sed -i "\#session optional pam_exec.so ${NOTIFY_SCRIPT}#d" "$f"
  done
  systemctl daemon-reload
  systemctl reset-failed 2>/dev/null || true
  log "Login alerts removed."
}

[[ "${1:-}" == "--remove" ]] && { remove; exit 0; }
[[ -f "$CONFIG_FILE" ]] || { echo "[!] ${CONFIG_FILE} not found — run install.sh first" >&2; exit 1; }

# ── Successful login notification ─────────────────────────────────────────────
cat > "$NOTIFY_SCRIPT" <<EOF
#!/bin/bash
source ${CONFIG_FILE}

HOSTNAME=\$(hostname)
USER=\$PAM_USER
REMOTE_IP=\${PAM_RHOST:-}
case "\${PAM_TYPE}" in
  open_session) status='LOGIN';;
  close_session) status='LOGOUT';;
  *) status="\$PAM_TYPE";;
esac

[[ "\${SKIP_LIST[@]:-}" =~ "\$REMOTE_IP" ]] && exit 0

if [ -z "\$REMOTE_IP" ]; then
    REMOTE_IP=\$(who | grep "\$USER" | awk '{print \$5}' | tr -d '()')
fi
[ -z "\$REMOTE_IP" ] && REMOTE_IP="local"

if [[ "\$REMOTE_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\$ && "\$REMOTE_IP" != "127.0.0.1" ]]; then
    GEO_JSON=\$(curl -s "http://ip-api.com/json/\$REMOTE_IP?fields=country,regionName,city,org,as")
    COUNTRY=\$(echo "\$GEO_JSON" | grep -oP '"country":"\K[^"]+')
    REGION=\$(echo "\$GEO_JSON" | grep -oP '"regionName":"\K[^"]+')
    CITY=\$(echo "\$GEO_JSON" | grep -oP '"city":"\K[^"]+')
    ORG=\$(echo "\$GEO_JSON" | grep -oP '"org":"\K[^"]+')
    AS=\$(echo "\$GEO_JSON" | grep -oP '"as":"\K[^"]+')
    GEO="🌐 \$COUNTRY, \$REGION, \$CITY, \$ORG, \$AS"
else
    GEO="🌐 local / private network"
fi

DATE=\$(date '+%Y-%m-%d %H:%M:%S')
MESSAGE="🔐 *\$status ON \$HOSTNAME*%0AUser: *\$USER*%0AIP: \\\`\$REMOTE_IP\\\`%0A\$GEO%0ADate: \$DATE"

curl -s -X POST https://api.telegram.org/bot\$BOT_TOKEN/sendMessage \\
    -d message_thread_id="\$THREAD_ID" \\
    -d chat_id="\$CHAT_ID" \\
    -d text="\$MESSAGE" \\
    -d parse_mode="Markdown"
EOF
chmod +x "$NOTIFY_SCRIPT"
log "Login notification script created."

for PAM_FILE in "${PAM_FILES[@]}"; do
  [[ -f "$PAM_FILE" ]] || continue
  if ! grep -q "$NOTIFY_SCRIPT" "$PAM_FILE"; then
    echo "session optional pam_exec.so $NOTIFY_SCRIPT" >> "$PAM_FILE"
    log "Added to $PAM_FILE"
  fi
done

# ── Failed login notification ─────────────────────────────────────────────────
cat > "$FAILED_SCRIPT" <<EOF
#!/bin/bash
source ${CONFIG_FILE}

LINE=\$1
DATE=\$(date '+%Y-%m-%d %H:%M:%S')
REMOTE_IP=\$(echo "\$LINE" | grep -oP 'from \K[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+')

if [[ "\$REMOTE_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\$ ]]; then
    GEO_JSON=\$(curl -s "http://ip-api.com/json/\$REMOTE_IP?fields=country,regionName,city,org,as")
    COUNTRY=\$(echo "\$GEO_JSON" | grep -oP '"country":"\K[^"]+')
    REGION=\$(echo "\$GEO_JSON" | grep -oP '"regionName":"\K[^"]+')
    CITY=\$(echo "\$GEO_JSON" | grep -oP '"city":"\K[^"]+')
    ORG=\$(echo "\$GEO_JSON" | grep -oP '"org":"\K[^"]+')
    AS=\$(echo "\$GEO_JSON" | grep -oP '"as":"\K[^"]+')
    GEO="🌐 \$COUNTRY, \$REGION, \$CITY, \$ORG, \$AS"
else
    GEO="🌐 unknown"
fi

MESSAGE="🚫 *FAILED LOGIN ATTEMPT*%0A\$LINE%0A\$GEO%0ADate: \$DATE"

curl -s -X POST https://api.telegram.org/bot\$BOT_TOKEN/sendMessage \\
    -d message_thread_id="\$THREAD_ID" \\
    -d chat_id="\$CHAT_ID" \\
    -d text="\$MESSAGE" \\
    -d parse_mode="Markdown"
EOF
chmod +x "$FAILED_SCRIPT"
log "Failed-login notification script created."

cat > "$FAILED_SERVICE" <<EOF
[Unit]
Description=Telegram notifications on failed SSH login attempts
After=network.target

[Service]
ExecStart=/bin/bash -c 'journalctl -f -u ssh -n0 | grep --line-buffered "Failed password" | while read line; do ${FAILED_SCRIPT} "\$line"; done'
Restart=always

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable telegram-auth-fail.service >/dev/null 2>&1 || true
systemctl restart telegram-auth-fail.service
log "Login alerts installed."
