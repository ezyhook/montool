#!/usr/bin/env bash
# montool update — refresh dependencies from this checkout and restart the service.
# Run `git pull` first, then this script.
#
# Overrides: INSTALL_DIR, SERVICE_NAME, RUNTIME (node|bun), BUN_BIN (see install.sh).
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-montool.service}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$SCRIPT_DIR}"
BUN_BIN="${BUN_BIN:-$HOME/.bun/bin/bun}"

RUNTIME="${RUNTIME:-}"
if [[ -z "$RUNTIME" ]]; then
  if command -v node >/dev/null 2>&1; then RUNTIME=node
  elif command -v bun >/dev/null 2>&1 || [[ -x "$BUN_BIN" ]]; then RUNTIME=bun
  else RUNTIME=node; fi
fi

log() { echo "[+] $*"; }

cd "$INSTALL_DIR"
if [[ "$RUNTIME" == "bun" ]]; then
  log "Installing dependencies (bun)..."
  "$BUN_BIN" install
else
  log "Installing dependencies (npm)..."
  # npm install (not ci): re-resolves platform-specific optional deps (sharp).
  npm install
  log "Rebuilding bundle (esbuild)..."
  npm run build
  [[ -f dist/index.js ]] || { echo "[!] build failed: dist/index.js not created" >&2; exit 1; }
  npm prune --omit=dev
fi

log "Restarting ${SERVICE_NAME}..."
systemctl restart "$SERVICE_NAME"
systemctl --no-pager --lines=5 status "$SERVICE_NAME" || true
