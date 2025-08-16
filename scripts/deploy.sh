#!/usr/bin/env bash
set -euo pipefail
PROJECT="ai-life-coach-694f9"
REGION="us-central1"
SERVICE="ai-life-coach-py"

gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --project "$PROJECT" \
  --allow-unauthenticated \
  --set-env-vars GOOGLE_ENTRYPOINT='uvicorn server.main:app --host 0.0.0.0 --port $PORT' \
  --set-env-vars TTS_MODEL=gpt-4o-mini-tts,TTS_VOICE=alloy,PRIMARY_MODEL=gpt-5-2025-08-07,FALLBACK_MODEL=gpt-4o

SVC_URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
echo "Service URL: $SVC_URL"
