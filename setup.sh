#!/usr/bin/env bash
# Imports credentials (from .env) and the 3 workflows into the running n8n container,
# publishes them and restarts n8n. Run once after you created the n8n owner account.
set -euo pipefail
cd "$(dirname "$0")"

set -a
. ./.env
set +a

for v in TELEGRAM_BOT_TOKEN GITHUB_MODELS_TOKEN GITHUB_PUSH_TOKEN; do
  if [ -z "${!v:-}" ]; then
    echo "$v is empty in .env" >&2
    exit 1
  fi
done

mkdir -p setup/generated
python3 setup/make_credentials.py > setup/generated/credentials.json
trap 'rm -f setup/generated/credentials.json' EXIT

docker compose exec -T n8n n8n import:credentials --input=/import/credentials/credentials.json
docker compose exec -T n8n n8n import:workflow --separate --input=/import/workflows

# Sub-workflows used as tools and error workflows must be published too in n8n 2.x.
for id in CodeAgentAskHum1 CodeAgentErrRep1 CodeAgentMain001; do
  docker compose exec -T n8n n8n publish:workflow --id="$id"
done
docker compose restart n8n

echo
echo "Imported and published. Last step in the n8n editor (http://localhost:5678):"
echo "  Overview > Data tables: create 'agent_memory' and 'runs' (columns in README)."
