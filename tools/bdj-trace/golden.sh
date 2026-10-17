#!/usr/bin/env bash
# Regenerates the golden traces in tests/bdj/golden/ from libbluray, each reduced to the control calls. Diagnostic calls
# are dropped because their text or count varies between runs (logN carries timing, cacheBdRomFileN a random cache
# directory).
#   disc-bdj.jsonl:       up to the disc's second playlist selection (the one TitleXlet makes when the first playlist
#                         ends)
#   disc-bdj-mixed.jsonl: up to its first playlist selection from Java (PlaylistXlet in BD-J title 2, after First Play's
#                         selectTitleN of HDMV title 1 and that title's playlist and JumpTitle 2)
#   disc-bdj-menu.<script>.jsonl: the run of tests/bdj/scripts/disc-bdj-menu.<script>.keys, reduced by settled.py to the
#                         control calls and the plane hash at each `wait still` step and at the end (flush counts vary
#                         between runs)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONTROL='selectTitleN|selectPlaylistN|seekN|selectAngleN|selectRateN|writeRegN|setUOMaskN|setKeyInterestN|soundEffectN|setVirtualPackageN'
mkdir -p "$ROOT/tests/bdj/golden"

golden() { # <disc> <selectPlaylistN count>
  local out="$ROOT/tests/bdj/golden/$1.jsonl"
  "$ROOT/tools/bdj-trace/run.sh" "$1" --until "selectPlaylistN#$2" \
    | { grep -E "^\{\"call\":\"($CONTROL)\"" || true; } > "$out"
  if [ "$(grep -c '"call":"selectPlaylistN"' "$out")" != "$2" ]; then
    echo "golden.sh: the $1 run ended before selectPlaylistN #$2" >&2
    exit 1
  fi
  echo "wrote tests/bdj/golden/$1.jsonl"
}

golden_keys() { # <disc> <script name>
  local out="$ROOT/tests/bdj/golden/$1.$2.jsonl"
  "$ROOT/tools/bdj-trace/run.sh" "$1" --keys "$ROOT/tests/bdj/scripts/$1.$2.keys" --seconds 120 --wait-timeout 60 \
    | python3 -I "$ROOT/tools/bdj-trace/settled.py" > "$out"
  echo "wrote tests/bdj/golden/$1.$2.jsonl"
}

golden disc-bdj 2
golden disc-bdj-mixed 1
golden_keys disc-bdj-menu arrows
golden_keys disc-bdj-menu mouse
