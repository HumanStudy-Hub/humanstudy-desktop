#!/usr/bin/env bash
# Regenerate icon.png / icon.icns / icon.ico from icon.svg (macOS: rsvg-convert, iconutil, Pillow).
set -euo pipefail
cd "$(dirname "$0")"
rsvg-convert -w 1024 -h 1024 icon.svg -o icon.png
set_dir=$(mktemp -d)/icon.iconset
mkdir -p "$set_dir"
for s in 16 32 128 256 512; do
  rsvg-convert -w $s -h $s icon.svg -o "$set_dir/icon_${s}x${s}.png"
  rsvg-convert -w $((s * 2)) -h $((s * 2)) icon.svg -o "$set_dir/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$set_dir" -o icon.icns
# icon.ico: PNG-compressed entries (Vista+), written without extra tools.
ico_dir=$(mktemp -d)
for s in 16 24 32 48 64 128 256; do rsvg-convert -w $s -h $s icon.svg -o "$ico_dir/$s.png"; done
python3 - "$ico_dir" <<'PY'
import struct, sys
sizes = [16, 24, 32, 48, 64, 128, 256]
blobs = [open(f"{sys.argv[1]}/{s}.png", "rb").read() for s in sizes]
out = struct.pack("<HHH", 0, 1, len(sizes))
offset = 6 + 16 * len(sizes)
for s, b in zip(sizes, blobs):
    out += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(b), offset)
    offset += len(b)
open("icon.ico", "wb").write(out + b"".join(blobs))
PY
