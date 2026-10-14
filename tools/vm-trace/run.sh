#!/usr/bin/env bash
# Prints libbluray's trace of <disc> (a folder name under fixtures/synthetic) driven by <script> (a name under
# tests/vm-trace/scripts, without the disc prefix and .keys suffix).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DISC="$1"
SCRIPT="$2"
# the image the binary was built on, so it runs against the same libc
IMAGE=ubuntu@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55

exec docker run --rm --platform linux/amd64 -e BD_DEBUG_MASK -e BD_DEBUG_FILE \
  -v "$ROOT/tools/vm-trace/out:/vm-trace:ro" \
  -v "$ROOT/fixtures/synthetic:/discs:ro" \
  -v "$ROOT/tests/vm-trace/scripts:/scripts:ro" \
  "$IMAGE" /vm-trace/vm_trace "/discs/$DISC" "/scripts/$DISC.$SCRIPT.keys"
