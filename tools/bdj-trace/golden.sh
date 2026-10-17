#!/usr/bin/env bash
# Regenerates tests/bdj/golden/disc-bdj.jsonl from libbluray: the disc's trace up to its second playlist selection (the
# one TitleXlet makes when the first playlist ends), reduced to the control calls. Diagnostic calls are dropped because their text or count varies between runs (logN carries
# timing, cacheBdRomFileN a random cache directory).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONTROL='selectTitleN|selectPlaylistN|seekN|selectAngleN|selectRateN|writeRegN|setUOMaskN|setKeyInterestN|soundEffectN|setVirtualPackageN'
mkdir -p "$ROOT/tests/bdj/golden"
"$ROOT/tools/bdj-trace/run.sh" disc-bdj --until 'selectPlaylistN#2' \
  | { grep -E "^\{\"call\":\"($CONTROL)\"" || true; } > "$ROOT/tests/bdj/golden/disc-bdj.jsonl"
if [ "$(grep -c '"call":"selectPlaylistN"' "$ROOT/tests/bdj/golden/disc-bdj.jsonl")" != 2 ]; then
  echo "golden.sh: the run ended before the second selectPlaylistN" >&2
  exit 1
fi
echo "wrote tests/bdj/golden/disc-bdj.jsonl"
