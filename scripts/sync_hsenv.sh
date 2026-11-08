#!/usr/bin/env bash
# Refresh the vendored protocol engine (pack/runtime/hsenv/) from an hsenv checkout.
#   scripts/sync_hsenv.sh /path/to/hsenv/hsenv [label]   (the package folder holding engine.py)
# Copies the files byte for byte and rewrites pack/runtime/hsenv/VERSION with a source label and their SHA-256
# (no local paths: this repository is public). Never edit the vendored files by hand: change the engine upstream,
# then run this. Refuses an engine that carries study-specific data (protocols are private): non-empty LEGACY_*
# tables or study ids such as author2024topic.
set -euo pipefail
src="${1:?usage: scripts/sync_hsenv.sh /path/to/hsenv/hsenv [label]}"
here="$(cd "$(dirname "$0")/.." && pwd)"
dest="$here/pack/runtime/hsenv"
FILES=(__init__.py engine.py expr.py checks.py effects_core.py)
for f in "${FILES[@]}"; do
  [ -f "$src/$f" ] || { echo "missing $src/$f" >&2; exit 1; }
done
python3 - "$src" "${FILES[@]}" <<'PY'
import re, sys
src, files = sys.argv[1], sys.argv[2:]
bad = []
for f in files:
    text = open(f"{src}/{f}", encoding="utf-8").read()
    for m in re.finditer(r"^(LEGACY_\w+)\s*=\s*([\[{(])\s*(\S)", text, re.M):
        if m.group(3) not in "]})":
            bad.append(f"{f}: {m.group(1)} is not empty")
    for m in re.finditer(r"\b[a-z]+20\d\d[a-z]+\b", text):
        bad.append(f"{f}:{text.count(chr(10), 0, m.start()) + 1}: study id {m.group(0)}")
if bad:
    sys.exit("refusing to vendor study-specific data:\n  " + "\n  ".join(bad[:20]))
PY
mkdir -p "$dest/hsenv"
for f in "${FILES[@]}"; do cp "$src/$f" "$dest/hsenv/$f"; done
commit="$(git -C "$src" rev-parse --short HEAD 2>/dev/null || true)"
label="${2:-hsenv${commit:+@$commit}}"
{
  echo "# Vendored hsenv engine. Refresh with scripts/sync_hsenv.sh; never edit by hand."
  echo "source: $label"
  echo "synced: $(date -u +%Y-%m-%d)"
  for f in "${FILES[@]}"; do
    printf '%s  hsenv/%s\n' "$(shasum -a 256 "$dest/hsenv/$f" | cut -d' ' -f1)" "$f"
  done
} > "$dest/VERSION"
echo "synced ${#FILES[@]} files into $dest"
