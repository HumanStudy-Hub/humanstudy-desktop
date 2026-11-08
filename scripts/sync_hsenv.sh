#!/usr/bin/env bash
# Refresh the vendored protocol engine (pack/runtime/hsenv/) from an hsenv checkout.
#   scripts/sync_hsenv.sh /path/to/hsenv/hsenv      (the package folder holding engine.py)
# Copies the files byte for byte and rewrites pack/runtime/hsenv/VERSION with their SHA-256.
# Never edit the vendored files by hand: change the engine upstream, then run this.
set -euo pipefail
src="${1:?usage: scripts/sync_hsenv.sh /path/to/hsenv/hsenv}"
here="$(cd "$(dirname "$0")/.." && pwd)"
dest="$here/pack/runtime/hsenv"
FILES=(__init__.py engine.py expr.py checks.py effects_core.py)
for f in "${FILES[@]}"; do
  [ -f "$src/$f" ] || { echo "missing $src/$f" >&2; exit 1; }
done
mkdir -p "$dest/hsenv"
for f in "${FILES[@]}"; do cp "$src/$f" "$dest/hsenv/$f"; done
commit="$(git -C "$src" rev-parse --short HEAD 2>/dev/null || echo unknown)"
{
  echo "# Vendored hsenv engine. Refresh with scripts/sync_hsenv.sh; never edit by hand."
  echo "source: $(cd "$src" && pwd)"
  echo "commit: $commit"
  echo "synced: $(date -u +%Y-%m-%d)"
  for f in "${FILES[@]}"; do
    printf '%s  hsenv/%s\n' "$(shasum -a 256 "$dest/hsenv/$f" | cut -d' ' -f1)" "$f"
  done
} > "$dest/VERSION"
echo "synced ${#FILES[@]} files into $dest"
