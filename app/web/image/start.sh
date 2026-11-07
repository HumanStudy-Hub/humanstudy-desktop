#!/usr/bin/env bash
# Starts the web edition in the sandbox. HS_WEB_TOKEN must be set (the launcher passes it).
#   start.sh             detached, logs in $HS/server.log
#   start.sh foreground
set -euo pipefail
HS=${HS:-/vercel/sandbox/hs}
export HOME=$HS/home HS_USER_DATA=$HS/userData HS_APP_ROOT=$HS/app HUMANSTUDY_KERNEL_BIN=$HS/kernel/opencode
export HS_APP_VERSION=$(cat "$HS/app/VERSION") PORT=${PORT:-3000} NODE_ENV=production
: "${HS_WEB_TOKEN:?HS_WEB_TOKEN is required}"
export HS_WEB_TOKEN
if [ "${1:-}" = foreground ]; then exec node "$HS/app/server.cjs"; fi
pkill -f "$HS/app/server.cjs" 2>/dev/null || true
setsid nohup node "$HS/app/server.cjs" >"$HS/server.log" 2>&1 </dev/null &
for i in $(seq 1 100); do curl -sf "localhost:$PORT/healthz" >/dev/null && exit 0; sleep 0.1; done
echo "server did not start"; tail -20 "$HS/server.log"; exit 1
