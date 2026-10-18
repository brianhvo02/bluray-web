#!/usr/bin/env bash
# Fetches the disc font of the synthetic BD-J menu disc (disc-bdj-menu) into fixtures/bdj-fonts: Source Sans 3 Regular
# (OpenType with CFF outlines, SIL Open Font License 1.1) from Adobe's source-sans repository at release 3.052R, with its
# licence. The output is committed; rerun only to change the font.
set -euo pipefail
COMMIT=87b37a2daaed80fcb8e8ccb0085c4d72ddade12e # adobe-fonts/source-sans, branch release, 3.052R
BASE="https://raw.githubusercontent.com/adobe-fonts/source-sans/$COMMIT"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/fixtures/bdj-fonts"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -sSL -o "$TMP/font.otf" "$BASE/OTF/SourceSans3-Regular.otf"
curl -sSL -o "$TMP/LICENSE.md" "$BASE/LICENSE.md"
echo "08df266400933d3178d081a45f94a08814c3e55b4b7dd2e0ff69cb1329f13ab6  $TMP/font.otf" | shasum -a 256 -c - >/dev/null
echo "56af9b9c6715597e458284a474dc118a50a4150e9d547c70f7b4a33c3e6a9328  $TMP/LICENSE.md" | shasum -a 256 -c - >/dev/null
mkdir -p "$OUT"
cp "$TMP/font.otf" "$OUT/SourceSans3-Regular.otf"
cp "$TMP/LICENSE.md" "$OUT/LICENSE-SourceSans3.md"
