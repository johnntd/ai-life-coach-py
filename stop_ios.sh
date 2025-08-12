# stop_ios.sh
#!/usr/bin/env bash
pkill -f "cloudflared tunnel --url" || true
pkill -f "uvicorn server.main:app" || true
echo "Stopped cloudflared and uvicorn."
