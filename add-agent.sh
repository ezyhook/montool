#!/usr/bin/env bash
# add-agent.sh THREAD_ID URL [CONFIG_FILE]
# Registers an agent in the leader's DISPATCH_MAP and restarts the service.
#
# Override the unit name with SERVICE_NAME (default: montool.service).
set -euo pipefail

THREAD_ID="${1:-}"
URL="${2:-}"
CONF="${3:-${CONFIG_FILE:-/etc/telegram-auth.conf}}"
SERVICE_NAME="${SERVICE_NAME:-montool.service}"

if [[ -z "$THREAD_ID" || -z "$URL" ]]; then
  echo "Usage: $0 THREAD_ID URL [CONFIG_FILE]" >&2
  exit 1
fi

# make sure python3 is available
command -v python3 >/dev/null 2>&1 || { echo "python3 not found"; exit 1; }

touch "$CONF"
chmod 600 "$CONF"

# 1) pull the current JSON value without the outer single quotes
current_line="$(grep -m1 '^DISPATCH_MAP=' "$CONF" || true)"
current_json="${current_line#DISPATCH_MAP=}"
# strip any leading/trailing single quotes (including triple ones)
current_json="$(printf %s "$current_json" | sed -E "s/^'+|'+$//g")"
[[ -z "$current_json" ]] && current_json="{}"

# 2) update the JSON via python (robust with quotes/slashes)
read -r new_json <<EOF
$(CUR="$current_json" THREAD_ID="$THREAD_ID" URL="$URL" python3 - <<'PY'
import os, json
cur = os.environ.get("CUR","{}")
try:
    obj = json.loads(cur)
except Exception:
    obj = {}
obj[os.environ["THREAD_ID"]] = os.environ["URL"]
print(json.dumps(obj, separators=(",",":")))
PY
)
EOF

# 3) replace/append the line in the config
tmp="$(mktemp)"
awk -v repl="DISPATCH_MAP='${new_json}'" '
  BEGIN{done=0}
  /^DISPATCH_MAP=/ { print repl; done=1; next }
  { print }
  END{ if (!done) print repl }
' "$CONF" >"$tmp"

install -m 600 "$tmp" "$CONF"
rm -f "$tmp"

echo "Updated DISPATCH_MAP:"
grep -n '^DISPATCH_MAP=' "$CONF" || true
systemctl restart "$SERVICE_NAME"
