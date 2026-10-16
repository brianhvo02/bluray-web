#!/usr/bin/env bash
# Runs libass on a script: prints its trace (JSON lines) and writes <out dir>/<ms>.rgba per time.
#   run.sh <file.ass> <fonts dir> <times file> <out dir> [<w>x<h> storage size]
set -euo pipefail

abs() { echo "$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; }
SCRIPT="$(abs "$1")"
FONTS="$(cd "$2" && pwd)"
TIMES="$(abs "$3")"
mkdir -p "$4"
OUT="$(cd "$4" && pwd)"

exec docker run --rm --platform linux/amd64 \
  -v "$SCRIPT:/in/script.ass:ro" -v "$FONTS:/fonts:ro" -v "$TIMES:/in/times.txt:ro" -v "$OUT:/out" \
  bluray-web-ass-trace ass_trace /in/script.ass /fonts /in/times.txt /out ${5:+"$5"}
