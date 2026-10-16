#!/usr/bin/env bash
# Fetches the DejaVu fonts used by the ASS fixtures (and as the default ASS font) into fixtures/ass/fonts.
# The output is committed; rerun only to change the font set.
set -euo pipefail
URL=https://github.com/dejavu-fonts/dejavu-fonts/releases/download/version_2_37/dejavu-fonts-ttf-2.37.tar.bz2
SHA256=fa9ca4d13871dd122f61258a80d01751d603b4d3ee14095d65453b4e846e17d7
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/fixtures/ass/fonts"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -sSL -o "$TMP/dejavu.tar.bz2" "$URL"
echo "$SHA256  $TMP/dejavu.tar.bz2" | shasum -a 256 -c - >/dev/null
tar -xjf "$TMP/dejavu.tar.bz2" -C "$TMP"
SRC="$TMP/dejavu-fonts-ttf-2.37"
mkdir -p "$OUT"
FONTS=(DejaVuSans.ttf DejaVuSans-Bold.ttf DejaVuSans-Oblique.ttf DejaVuSerif.ttf DejaVuSansMono.ttf)
for f in "${FONTS[@]}"; do cp "$SRC/ttf/$f" "$OUT/$f"; done
cp "$SRC/LICENSE" "$OUT/LICENSE-DejaVu.txt"
printf '%s\n' "${FONTS[@]}" > "$OUT/index.txt"
