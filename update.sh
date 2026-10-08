#!/usr/bin/env bash
# montool update — rebuild from this checkout and restart the service.
# Run `git pull` first, then this script.
#
# Overrides: INSTALL_DIR, SERVICE_NAME, BUN_BIN (see install.sh).
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-montool.service}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$SCRIPT_DIR}"
BUN_BIN="${BUN_BIN:-$HOME/.bun/bin/bun}"

log() { echo "[+] $*"; }

cd "$INSTALL_DIR"
log "Installing dependencies..."
"$BUN_BIN" install
log "Rebuilding index.js..."
"$BUN_BIN" build ./index.ts --production --target=bun --outfile=index.js
[[ -f index.js ]] || { echo "[!] build failed: index.js not created" >&2; exit 1; }
log "Build OK: $(du -sh index.js | cut -f1)"

log "Restarting ${SERVICE_NAME}..."
systemctl restart "$SERVICE_NAME"
systemctl --no-pager --lines=5 status "$SERVICE_NAME" || true
