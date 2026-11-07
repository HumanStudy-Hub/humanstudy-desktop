#!/usr/bin/env bash
# Prepares a Vercel Sandbox as the base image of the web edition (run once, then snapshot):
#   the web build (out/web, copied to $HS/app), the HumanStudy agent kernel for Linux, and the
#   research runtime, which the app installs itself on its first start.
#   usage: setup.sh <kernel-tag>          e.g. setup.sh hs-v1.19.0-2
set -euo pipefail
HS=${HS:-/vercel/sandbox/hs}
TAG=${1:?kernel tag}
ARCH=$(uname -m); case "$ARCH" in x86_64) A=x64;; aarch64) A=arm64;; *) echo "unsupported $ARCH"; exit 1;; esac
ASSET=opencode-humanstudy-linux-$A.zip
if [ "$A" = x64 ] && ! grep -q avx2 /proc/cpuinfo; then ASSET=opencode-humanstudy-linux-x64-baseline.zip; fi
mkdir -p "$HS/kernel" "$HS/userData" "$HS/home"
cd "$HS/kernel"
BASE=https://github.com/HumanStudy-Hub/opencode/releases/download/$TAG
curl -fsSL -o "$ASSET" "$BASE/$ASSET"
curl -fsSL -o SHA256SUMS.txt "$BASE/SHA256SUMS.txt"
grep " $ASSET\$" SHA256SUMS.txt | sha256sum -c -
python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall('.')" "$ASSET"
chmod 755 opencode && rm -f "$ASSET"
./opencode --version
# First start installs the research runtime into userData; wait for it, then stop.
HS_WEB_TOKEN=setup PORT=3999 "$HS/app/start.sh" foreground &
PID=$!
for i in $(seq 1 360); do
  S=$(curl -s -XPOST -H 'Authorization: Bearer setup' localhost:3999/ipc/kernel:installStatus -d '{"args":[]}' || true)
  case "$S" in *'"state":"ready"'*) echo "runtime ready"; break;; *'"state":"error"'*) echo "install failed: $S"; kill $PID; exit 1;; esac
  sleep 5
  [ "$i" = 360 ] && { echo "runtime install did not finish in 30 minutes"; kill $PID; exit 1; }
done
kill $PID; wait $PID 2>/dev/null || true
# Nothing user- or install-specific in the image: each user gets their own ids on first start.
rm -rf "$HS/userData/account.json" "$HS/userData/telemetry.json" "$HS/userData/uploads" "$HS/home/HumanStudy Hub" "$HS/home/.humanstudy-web"
echo "image ready"
