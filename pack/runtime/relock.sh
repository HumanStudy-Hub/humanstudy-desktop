#!/bin/sh
# Regenerates requirements.lock (all platforms, with hashes) from requirements.in. Needs `uv` on the dev machine.
set -e
cd "$(dirname "$0")"
uv pip compile requirements.in --universal --python-version 3.12 --only-binary :all: --generate-hashes \
  --exclude-newer "$(date -u +%Y-%m-%d)" -o requirements.lock
# Every target must have a binary wheel for every pinned package (hashes checked).
for plat in aarch64-apple-darwin x86_64-apple-darwin x86_64-pc-windows-msvc; do
  uv pip install --dry-run --no-deps --python-platform "$plat" --python-version 3.12 --only-binary :all: \
    --require-hashes -r requirements.lock --target "${TMPDIR:-/tmp}/hs-lock-check" >/dev/null
  echo "lock ok for $plat"
done
