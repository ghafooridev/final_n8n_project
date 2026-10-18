#!/usr/bin/env bash
# Starts sandbox + tunnel, reads the public tunnel URL, then (re)starts n8n with WEBHOOK_URL set.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "Missing .env. Run: cp .env.example .env  and fill it in." >&2
  exit 1
fi

docker compose up -d --build sandbox tunnel

echo "Waiting for the cloudflared tunnel URL..."
url=""
for _ in $(seq 1 30); do
  url=$(docker compose logs tunnel 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)
  [ -n "$url" ] && break
  sleep 2
done
if [ -z "$url" ]; then
  echo "Could not read the tunnel URL. Check: docker compose logs tunnel" >&2
  exit 1
fi

if grep -q '^WEBHOOK_URL=' .env; then
  sed -i "s#^WEBHOOK_URL=.*#WEBHOOK_URL=${url}/#" .env
else
  echo "WEBHOOK_URL=${url}/" >> .env
fi

docker compose up -d --force-recreate n8n

echo
echo "n8n editor:      http://localhost:5678"
echo "Public URL:      ${url}/"
echo "Sandbox health:  curl http://127.0.0.1:8080/health"
echo
echo "The tunnel URL changes on every restart; n8n re-registers the Telegram webhook on startup."
