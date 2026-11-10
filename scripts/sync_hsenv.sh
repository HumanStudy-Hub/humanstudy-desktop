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
# such as author2024topic, the name of any folder in the upstream studies/ folder (read at sync time,
# case-insensitive: hsenv/studies next to the engine; STUDIES_DIR overrides), or absolute home-folder paths.
# Without a readable studies/ folder the sync refuses. The skills' SKILL.md files are app-owned (they describe the
# app's paths and approval), not vendored.
#   scripts/sync_hsenv.sh --check <any of the above>             run the guard only; copy and write nothing
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
CHECK_ONLY=0
if [ "${1:-}" = "--check" ]; then CHECK_ONLY=1; shift; fi
# serve.py: evaldata.code_hash() hashes it. distribution.py: hsenv.rehydrate (v0.8.1) imports it; stdlib only.
# Upstream tests/ name real studies and are never vendored.
ENGINE=(__init__.py engine.py expr.py checks.py effects_core.py evaldata.py rewards.py score.py serve.py schema_check.py distribution.py)
# The frozen v1 schemas schema_check.py validates against (it looks for them in ../schema next to the package).
SCHEMAS=(protocol.v1.json study.v1.json run.v1.json)
RUN=(run_study.py fspec.py render.py)
PREVIEW=(build_preview.py preview.css preview.js)

guard() {  # guard <studies dir> <src dir> <files...>
  python3 - "$@" <<'PY'
import os, re, sys
studies, src, files = sys.argv[1], sys.argv[2], sys.argv[3:]
if not os.path.isdir(studies):
    sys.exit(f"refusing to vendor: no upstream studies folder at {studies} to check names against (set STUDIES_DIR)")
names = sorted({n for n in os.listdir(studies) if os.path.isdir(os.path.join(studies, n)) and not n.startswith(".")}, key=len, reverse=True)
if not names:
    sys.exit(f"refusing to vendor: {studies} lists no study folders")
names_rx = re.compile(r"(?<![A-Za-z0-9])(" + "|".join(map(re.escape, names)) + r")(?![A-Za-z0-9])", re.I)
# Study surnames (review 4, S3): the author part of every folder named like author2024topic, refused anywhere in a
# vendored file (code, strings, comments, JSON). A surname of 4 letters or more is refused on its own, also inside
# an identifier (followed by _ or a digit); a shorter one (li, wu) only next to a year or "et al", so it does not
# trip on ordinary words and tags. Review every hit by hand; the folder-name rule above stays the hard gate.
surnames = sorted({m.group(1) for n in names for m in [re.match(r"([a-z]+)(?:19|20)\d\d", n)] if m}, key=len, reverse=True)
long_rx = re.compile(r"(?<![A-Za-z])(" + "|".join(map(re.escape, [x for x in surnames if len(x) >= 4])) + r")(?![A-Za-z])", re.I) \
    if any(len(x) >= 4 for x in surnames) else None
short_rx = re.compile(r"(?<![A-Za-z])(" + "|".join(map(re.escape, [x for x in surnames if len(x) < 4])) +
                      r")(?:[\s_,(]*(?:19|20)\d\d|\s+et\s+al)", re.I) if any(len(x) < 4 for x in surnames) else None
# CamelCase compounds (review 5, review 6 S1), case-sensitive, 4+ letter surnames:
#   getZorbel, ZorbelItems, IDZorbel   the capitalised surname not followed by a lowercase letter
#   zorbelScore                        the lowercase surname followed by an uppercase letter
#   ZORBELItems, ID_ZORBEL             the uppercase surname on a word start, not followed by a lowercase letter
#                                      (so a surname inside a longer upper-case word is not one)
_long = [x for x in surnames if len(x) >= 4]
camel_rx = re.compile("|".join([r"(" + "|".join(map(re.escape, [x.capitalize() for x in _long])) + r")(?![a-z])",
                                 r"(?<![A-Za-z])(" + "|".join(map(re.escape, _long)) + r")(?=[A-Z])",
                                 r"(?<![A-Za-z])(" + "|".join(map(re.escape, [x.upper() for x in _long])) + r")(?![a-z])"])) \
    if _long else None
# an id shaped like a study folder: letters + a year, with or without a topic, any case
id_rx = re.compile(r"(?<![A-Za-z0-9])[A-Za-z]{2,}(?:19|20)\d\d[A-Za-z]*(?![A-Za-z0-9])")


bad = []
for f in files:
    text = open(f"{src}/{f}", encoding="utf-8").read()
    line = lambda m: text.count(chr(10), 0, m.start()) + 1
    for m in names_rx.finditer(text):
        bad.append(f"{f}:{line(m)}: study folder name {m.group(0)}")
    for rx in (long_rx, short_rx, camel_rx):
        for m in (rx.finditer(text) if rx else ()):
            bad.append(f"{f}:{line(m)}: study surname {m.group(0)}")
    # a LEGACY_* table written out as data (a literal opening with a string or number); a table built from the
    # private sidecar (a comprehension or dict(...) over PRIVATE) holds nothing in the code
    for m in re.finditer(r"^(LEGACY_\w+)\s*=\s*[\[{(]\s*(\S)", text, re.M):
        if m.group(2) in "\"'0123456789-":
            bad.append(f"{f}: {m.group(1)} is not empty")
    for m in id_rx.finditer(text):
        bad.append(f"{f}:{line(m)}: study id shape {m.group(0)}")
    for m in re.finditer(r"(?:/Users/|/home/|[A-Za-z]:\\Users\\)[^\s\"']+", text):
        bad.append(f"{f}:{line(m)}: local path {m.group(0)[:60]}")
if bad:
    sys.exit("refusing to vendor study-specific data or local paths:\n  " + "\n  ".join(bad[:20]))
PY
}

vendor() {  # vendor <studies dir> <src dir> <dest dir> <manifest name> <label> <files...>
  local studies="$1" src="$2" dest="$3" manifest="$4" label="$5"; shift 5
  for f in "$@"; do [ -f "$src/$f" ] || { echo "missing $src/$f" >&2; exit 1; }; done
  guard "$studies" "$src" "$@"
  if [ "$CHECK_ONLY" = 1 ]; then echo "guard passed: $src"; return 0; fi
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
    studies="${STUDIES_DIR:-$skills/../hsenv/studies}"
    [ "$1" = preview ] || vendor "$studies" "$skills/run" "$here/pack/skills/run" VENDORED "$(label_for "$skills" "sandbox skills/run" "${3:-}")" "${RUN[@]}"
    [ "$1" = run ] || vendor "$studies" "$skills/preview" "$here/pack/skills/preview" VENDORED "$(label_for "$skills" "sandbox skills/preview" "${3:-}")" "${PREVIEW[@]}"
    ;;
  *)
    src="$1"
    dest="$here/pack/runtime/hsenv"
    for f in "${ENGINE[@]}"; do [ -f "$src/$f" ] || { echo "missing $src/$f" >&2; exit 1; }; done
    guard "${STUDIES_DIR:-$src/../studies}" "$src" "${ENGINE[@]}"
    if [ "$CHECK_ONLY" = 1 ]; then
      guard "${STUDIES_DIR:-$src/../studies}" "$src/../schema" "${SCHEMAS[@]}"
      echo "guard passed: $src"; exit 0
    fi
    mkdir -p "$dest/hsenv"
    for f in "${ENGINE[@]}"; do cp "$src/$f" "$dest/hsenv/$f"; done
    for f in "${SCHEMAS[@]}"; do [ -f "$src/../schema/$f" ] || { echo "missing $src/../schema/$f" >&2; exit 1; }; done
    guard "${STUDIES_DIR:-$src/../studies}" "$src/../schema" "${SCHEMAS[@]}"
    mkdir -p "$dest/schema"
    for f in "${SCHEMAS[@]}"; do cp "$src/../schema/$f" "$dest/schema/$f"; done
    if [ -f "$src/../LICENSE" ]; then guard "${STUDIES_DIR:-$src/../studies}" "$src/.." LICENSE; cp "$src/../LICENSE" "$dest/LICENSE"; fi
    {
      echo "# Vendored hsenv engine. Refresh with scripts/sync_hsenv.sh; never edit by hand."
      echo "source: $(label_for "$src" hsenv "${2:-}")"
      echo "synced: $(date -u +%Y-%m-%d)"
      for f in "${ENGINE[@]}"; do printf '%s  hsenv/%s\n' "$(shasum -a 256 "$dest/hsenv/$f" | cut -d' ' -f1)" "$f"; done
      for f in "${SCHEMAS[@]}"; do printf '%s  schema/%s\n' "$(shasum -a 256 "$dest/schema/$f" | cut -d' ' -f1)" "$f"; done
    } > "$dest/VERSION"
    echo "synced ${#ENGINE[@]} files into $dest"
    ;;
esac
