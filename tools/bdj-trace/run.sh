#!/usr/bin/env bash
# Prints libbluray's BD-J native-call trace (JSONL) for <disc> on stdout; libbluray's log goes to stderr.
#   run.sh <disc> [--until <call>[#<n>]] [--seconds N] [--jvm-option OPT]...
#   <disc>:        a folder name under fixtures/synthetic, or a path to a disc folder (the one holding BDMV/)
#   --until CALL:  stop right after the first trace line for CALL (a JNI name without the Java_org_videolan_Libbluray_
#                  prefix, e.g. selectPlaylistN); CALL#N stops after the N-th (selectPlaylistN#2)
#   --seconds N:   stop after N seconds of wall time (default 60)
#   --jvm-option:  passed to the JVM through JAVA_TOOL_OPTIONS (e.g. -verbose:class, -verbose:jni; their output
#                  goes to stderr)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE=bluray-web-bdj-trace
PLATFORM="${BDJ_TRACE_PLATFORM:-linux/amd64}"

DISC="${1:?usage: run.sh <disc> [--until <call>[#<n>]] [--seconds N] [--jvm-option OPT]...}"
shift
ENV_ARGS=()
SECONDS_ARG=60
JVM_OPTIONS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --until) ENV_ARGS+=(-e "BDJ_TRACE_UNTIL=$2"); shift 2 ;;
    --seconds) SECONDS_ARG="$2"; shift 2 ;;
    --jvm-option) JVM_OPTIONS="${JVM_OPTIONS:+$JVM_OPTIONS }$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
if [ -n "$JVM_OPTIONS" ]; then
  ENV_ARGS+=(-e "JAVA_TOOL_OPTIONS=$JVM_OPTIONS")
fi

if [ -d "$DISC" ]; then
  DISC_DIR="$(cd "$DISC" && pwd)"
else
  DISC_DIR="$ROOT/fixtures/synthetic/$DISC"
fi

exec docker run --rm --platform "$PLATFORM" -e BD_DEBUG_MASK -e BD_DEBUG_FILE \
  ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} \
  -v "$DISC_DIR:/disc:ro" \
  "$IMAGE" bdj_trace /disc --seconds "$SECONDS_ARG"
