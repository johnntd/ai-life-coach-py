#!/usr/bin/env bash
set -euo pipefail

# -------------------------------
# Quick iOS Launcher for Miss Sunny
# - Runs FastAPI on 0.0.0.0:8000
# - Exposes it via Cloudflare Tunnel (HTTPS)
# - Prints the HTTPS URL for your iPhone/iPad
# -------------------------------

APP_MODULE="server.main:app"
HOST="0.0.0.0"
PORT="8000"

# Where to log cloudflared so we can parse the URL
CLOUDFLARE_LOG="$(mktemp -t cloudflared.XXXXXXXX).log"

# Ensure we're in the project root (this script should live there too)
cd "$(dirname "$0")"

# --- Checks ---------------------------------------------------------------

if ! command -v python >/dev/null 2>&1; then
  echo "❌ Python not found. Activate your venv first (e.g., 'source .venv/bin/activate')."
  exit 1
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "❌ 'cloudflared' is not installed."
  echo "   macOS: brew install cloudflared"
  echo "   or download: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/"
  exit 1
fi

# --- Start FastAPI (reload is nice during dev) ----------------------------
echo "▶ Starting FastAPI on http://${HOST}:${PORT} ..."
# Use uvicorn from your venv if present
if command -v uvicorn >/dev/null 2>&1; then
  uvicorn "$APP_MODULE" --host "$HOST" --port "$PORT" --reload &
else
  python -m uvicorn "$APP_MODULE" --host "$HOST" --port "$PORT" --reload &
fi
UVICORN_PID=$!

# Give uvicorn a moment to come up
sleep 1

# --- Start Cloudflare Tunnel ---------------------------------------------
echo "▶ Opening Cloudflare Tunnel to http://localhost:${PORT} ..."
# We tee logs to a file so we can grab the https URL once it appears
cloudflared tunnel --url "http://localhost:${PORT}" 2>&1 | tee "$CLOUDFLARE_LOG" &
CLOUDFLARE_PID=$!

# Trap to clean up background processes on exit
cleanup() {
  echo ""
  echo "⏹ Stopping..."
  kill -TERM "${CLOUDFLARE_PID}" >/dev/null 2>&1 || true
  kill -TERM "${UVICORN_PID}"    >/dev/null 2>&1 || true
  wait "${CLOUDFLARE_PID}" 2>/dev/null || true
  wait "${UVICORN_PID}"    2>/dev/null || true
  rm -f "$CLOUDFLARE_LOG"
  echo "✅ Done."
}
trap cleanup EXIT INT TERM

# --- Wait for the HTTPS URL ----------------------------------------------
echo "⏳ Waiting for the public HTTPS URL..."
TUNNEL_URL=""
# Cloudflared prints the URL like: https://xyz.trycloudflare.com
for _ in $(seq 1 60); do
  if [[ -f "$CLOUDFLARE_LOG" ]]; then
    TUNNEL_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$CLOUDFLARE_LOG" | tail -n1 || true)"
    if [[ -n "$TUNNEL_URL" ]]; then
      break
    fi
  fi
  sleep 0.5
done

if [[ -z "$TUNNEL_URL" ]]; then
  echo "⚠️  Couldn't detect the tunnel URL yet. Cloudflared may still be warming up."
  echo "   Keep this window open and watch for a line with https://…trycloudflare.com"
else
  echo ""
  echo "🔗 Open this on your iPhone/iPad (HTTPS required for mic/audio):"
  echo "   ${TUNNEL_URL}"
  echo ""
  echo "💡 Tip: if audio is still muted on iPhone, make sure:"
  echo "   - You tapped ▶ Start once (unlocks audio on iOS)"
  echo "   - Ring/silent switch is OFF (ring mode) and volume up"
  echo "   - Safari settings allow microphone for this site"
  echo ""
fi

# --- Keep foreground running so logs are visible --------------------------
echo "Press Ctrl-C to stop."
wait
