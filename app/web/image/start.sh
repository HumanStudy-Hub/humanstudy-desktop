#!/usr/bin/env bash
# Starts the web edition in the sandbox. HS_WEB_TOKEN must be set (the launcher passes it).
#   start.sh             detached, logs in $HS/server.log
#   start.sh foreground
set -euo pipefail
HS=${HS:-/vercel/sandbox/hs}
export HOME=$HS/home HS_USER_DATA=$HS/userData HS_APP_ROOT=$HS/app HUMANSTUDY_KERNEL_BIN=$HS/kernel/opencode
PORT=${PORT:-3000}
export PORT NODE_ENV=production
: "${HS_WEB_TOKEN:?HS_WEB_TOKEN is required}"
export HS_WEB_TOKEN
# A newer app than the image (HS_APP_URL + HS_APP_SHA256, a release's humanstudy-web-<version>.tgz): install
# it before starting. Users' sandboxes are persistent, so this is how they get updates. Projects, account and
# conversations live outside $HS/app and are kept.
if [ "${HS_UPDATED:-}" != 1 ] && [ -n "${HS_APP_URL:-}" ] && [ -n "${HS_APP_SHA256:-}" ] && [ "$(cat "$HS/app/.sha256" 2>/dev/null)" != "$HS_APP_SHA256" ]; then
  tmp=$(mktemp -d "$HS/.app-XXXXXX")
  if curl -fsSL --max-time 120 -o "$tmp/app.tgz" "$HS_APP_URL" && echo "$HS_APP_SHA256  $tmp/app.tgz" | sha256sum -c - >/dev/null \
     && mkdir "$tmp/app" && tar -xzf "$tmp/app.tgz" -C "$tmp/app" && [ -f "$tmp/app/server.cjs" ]; then
    echo "$HS_APP_SHA256" >"$tmp/app/.sha256"
    pkill -f "$HS/app/server.cjs" 2>/dev/null || true
    mv "$HS/app" "$tmp/old" && mv "$tmp/app" "$HS/app"
    echo "updated the app to $(cat "$HS/app/VERSION")"
  else
    echo "app update failed; starting the installed version" >&2
  fi
  rm -rf "$tmp"
  # The new start.sh may differ: run it.
  HS_UPDATED=1 exec "$HS/app/start.sh" "$@"
fi
export HS_APP_VERSION=$(cat "$HS/app/VERSION")
if [ "${1:-}" = foreground ]; then exec node "$HS/app/server.cjs"; fi
# Replace a running server: it saves conversations on SIGTERM; give it up to 10 s before forcing.
if pkill -f "$HS/app/server.cjs" 2>/dev/null; then
  for i in $(seq 1 100); do pgrep -f "$HS/app/server.cjs" >/dev/null || break; sleep 0.1; done
  pkill -9 -f "$HS/app/server.cjs" 2>/dev/null || true
fi
setsid nohup node "$HS/app/server.cjs" >"$HS/server.log" 2>&1 </dev/null &
for i in $(seq 1 100); do curl -sf "localhost:$PORT/healthz" >/dev/null && exit 0; sleep 0.1; done
echo "server did not start"; tail -20 "$HS/server.log"; exit 1
