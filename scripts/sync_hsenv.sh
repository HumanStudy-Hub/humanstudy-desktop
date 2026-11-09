#!/usr/bin/env bash
# Refresh vendored sandbox code from its upstream checkout. Copies files byte for byte and writes a manifest with a
# source label and their SHA-256 (no local paths: this repository is public). Never edit vendored files by hand:
# change them upstream, then run this.
#
#   scripts/sync_hsenv.sh /path/to/hsenv/hsenv [label]            the engine   -> pack/runtime/hsenv/ (VERSION)
#   scripts/sync_hsenv.sh skills /path/to/sandbox/skills [label]  run + preview -> pack/skills/{run,preview}/ (VENDORED)
#   scripts/sync_hsenv.sh run|preview /path/to/sandbox/skills [label]   one of the two skills
#
# Refuses code that carries study-specific data (protocols are private): non-empty LEGACY_* tables, study ids
# such as author2024topic, or absolute home-folder paths. The skills' SKILL.md files are app-owned (they describe
# the app's paths and approval), not vendored.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
ENGINE=(__init__.py engine.py expr.py checks.py effects_core.py)
RUN=(run_study.py fspec.py render.py)
PREVIEW=(build_preview.py preview.css preview.js)

guard() {  # guard <src dir> <files...>
  python3 - "$@" <<'PY'
import re, sys
src, files = sys.argv[1], sys.argv[2:]
bad = []
for f in files:
    text = open(f"{src}/{f}", encoding="utf-8").read()
    line = lambda m: text.count(chr(10), 0, m.start()) + 1
    for m in re.finditer(r"^(LEGACY_\w+)\s*=\s*([\[{(])\s*(\S)", text, re.M):
        if m.group(3) not in "]})":
            bad.append(f"{f}: {m.group(1)} is not empty")
    for m in re.finditer(r"\b[a-z]+20\d\d[a-z]+\b", text):
        bad.append(f"{f}:{line(m)}: study id {m.group(0)}")
    for m in re.finditer(r"(?:/Users/|/home/|[A-Za-z]:\\Users\\)[^\s\"']+", text):
        bad.append(f"{f}:{line(m)}: local path {m.group(0)[:60]}")
if bad:
    sys.exit("refusing to vendor study-specific data or local paths:\n  " + "\n  ".join(bad[:20]))
PY
}

vendor() {  # vendor <src dir> <dest dir> <manifest name> <label> <files...>
  local src="$1" dest="$2" manifest="$3" label="$4"; shift 4
  for f in "$@"; do [ -f "$src/$f" ] || { echo "missing $src/$f" >&2; exit 1; }; done
  guard "$src" "$@"
  mkdir -p "$dest"
  for f in "$@"; do cp "$src/$f" "$dest/$f"; done
  {
    echo "# Vendored sandbox code. Refresh with scripts/sync_hsenv.sh; never edit by hand."
    echo "source: $label"
    echo "synced: $(date -u +%Y-%m-%d)"
    for f in "$@"; do printf '%s  %s\n' "$(shasum -a 256 "$dest/$f" | cut -d' ' -f1)" "$f"; done
  } > "$dest/$manifest"
  echo "synced $# files into $dest"
}

label_for() {  # label_for <src> <default name> [label]
  local commit; commit="$(git -C "$1" rev-parse --short HEAD 2>/dev/null || true)"
  echo "${3:-$2${commit:+@$commit}}"
}

case "${1:?usage: scripts/sync_hsenv.sh /path/to/hsenv/hsenv [label] | skills|run|preview /path/to/sandbox/skills [label]}" in
  skills|run|preview)
    skills="${2:?the sandbox skills folder}"
    [ "$1" = preview ] || vendor "$skills/run" "$here/pack/skills/run" VENDORED "$(label_for "$skills" "sandbox skills/run" "${3:-}")" "${RUN[@]}"
    [ "$1" = run ] || vendor "$skills/preview" "$here/pack/skills/preview" VENDORED "$(label_for "$skills" "sandbox skills/preview" "${3:-}")" "${PREVIEW[@]}"
    ;;
  *)
    src="$1"
    dest="$here/pack/runtime/hsenv"
    for f in "${ENGINE[@]}"; do [ -f "$src/$f" ] || { echo "missing $src/$f" >&2; exit 1; }; done
    guard "$src" "${ENGINE[@]}"
    mkdir -p "$dest/hsenv"
    for f in "${ENGINE[@]}"; do cp "$src/$f" "$dest/hsenv/$f"; done
    {
      echo "# Vendored hsenv engine. Refresh with scripts/sync_hsenv.sh; never edit by hand."
      echo "source: $(label_for "$src" hsenv "${2:-}")"
      echo "synced: $(date -u +%Y-%m-%d)"
      for f in "${ENGINE[@]}"; do printf '%s  hsenv/%s\n' "$(shasum -a 256 "$dest/hsenv/$f" | cut -d' ' -f1)" "$f"; done
    } > "$dest/VERSION"
    echo "synced ${#ENGINE[@]} files into $dest"
    ;;
esac
