#!/usr/bin/env bash
# Regenerates tests/bdj/golden/disc-bdj.jsonl from libbluray: the disc's trace up to its first playlist selection, reduced
# to the control calls. Diagnostic calls are dropped because their text or count varies between runs (logN carries
# timing, cacheBdRomFileN a random cache directory).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONTROL='selectTitleN|selectPlaylistN|seekN|selectAngleN|selectRateN|writeRegN|setUOMaskN|setKeyInterestN|soundEffectN|setVirtualPackageN'
mkdir -p "$ROOT/tests/bdj/golden"
"$ROOT/tools/bdj-trace/run.sh" disc-bdj --until selectPlaylistN \
  | { grep -E "^\{\"call\":\"($CONTROL)\"" || true; } > "$ROOT/tests/bdj/golden/disc-bdj.jsonl"
echo "wrote tests/bdj/golden/disc-bdj.jsonl"
