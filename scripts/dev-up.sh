#!/usr/bin/env bash
set -euo pipefail

# --- Location ---
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "→ Project: $ROOT"

# --- Python venv ---
if [[ ! -d ".venv" ]]; then
  echo "→ Creating venv (.venv)"
  python3 -m venv .venv
fi
source .venv/bin/activate

# --- Requirements (idempotent) ---
if [[ -f "requirements.txt" ]]; then
  echo "→ Installing/upgrading requirements"
  pip install -q -U -r requirements.txt
fi

# --- Secrets ---
# Prefer .env if present; otherwise rely on your shell environment
if [[ -f ".env" ]]; then
  echo "→ Loading .env"
  # shellcheck disable=SC2046
  export $(grep -v '^\s*#' .env | grep -v '^\s*$' | sed 's/[[:space:]]*$//' | xargs -I{} echo {})
fi

# Sanity check
if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "✗ OPENAI_API_KEY not set. Export it or put it in .env"
  exit 1
fi

# --- Static vendor checks (Three.js modules you already set up) ---
VENDOR="static/vendor/three-r152.2"
THREE="$VENDOR/build/three.module.js"
GLTF="$VENDOR/examples/jsm/loaders/GLTFLoader.js"
CTRL="$VENDOR/examples/jsm/controls/OrbitControls.js"

if [[ -f "$THREE" && -f "$GLTF" && -f "$CTRL" ]]; then
  echo "→ Three.js vendor files present."
else
  echo "⚠ Three.js vendor files missing:
   - $THREE
   - $GLTF
   - $CTRL
  The app may still run, but the avatar won’t load. Re-add these if needed."
fi

# --- Model check (optional) ---
if [[ -f "static/models/coach.glb" ]]; then
  echo "→ Found model: static/models/coach.glb"
else
  echo "⚠ Missing static/models/coach.glb (avatar won’t show)."
fi

# --- Run server ---
echo "→ Starting server on http://127.0.0.1:8000"
exec uvicorn server.main:app --reload --host 127.0.0.1 --port 8000
