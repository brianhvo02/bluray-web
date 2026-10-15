#!/usr/bin/env bash
# Prints libbluray's trace of <disc> driven by <script>.
#   <disc>:   a folder name under fixtures/synthetic, or a path to a disc folder (the one holding BDMV/)
#   <script>: a name under tests/vm-trace/scripts without the disc prefix and .keys suffix, or a path to a .keys file
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DISC="$1"
SCRIPT="$2"
# the image the binary was built on, so it runs against the same libc
IMAGE=ubuntu@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55

if [ -d "$DISC" ]; then
  DISC_DIR="$(cd "$DISC" && pwd)"
else
  DISC_DIR="$ROOT/fixtures/synthetic/$DISC"
fi
if [ -f "$SCRIPT" ]; then
  SCRIPT_FILE="$(cd "$(dirname "$SCRIPT")" && pwd)/$(basename "$SCRIPT")"
else
  SCRIPT_FILE="$ROOT/tests/vm-trace/scripts/$(basename "$DISC_DIR").$SCRIPT.keys"
fi

exec docker run --rm --platform linux/amd64 -e BD_DEBUG_MASK -e BD_DEBUG_FILE \
  -v "$ROOT/tools/vm-trace/out:/vm-trace:ro" \
  -v "$DISC_DIR:/disc:ro" \
  -v "$SCRIPT_FILE:/script.keys:ro" \
  "$IMAGE" /vm-trace/vm_trace /disc /script.keys
