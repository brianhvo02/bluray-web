#!/usr/bin/env bash
# Prints libbluray's BD-J native-call trace (JSONL) for <disc> on stdout; libbluray's log goes to stderr.
#   run.sh <disc> [--until <call>[#<n>]] [--seconds N] [--jvm-option OPT]... [--planes] [--keys FILE] [--tail S] [--wait-timeout S]
#          [--dump-planes DIR] [--name NAME] [--online] [--storage VOLUME]
#   <disc>:        a folder name under fixtures/synthetic, or a path to a disc folder (the one holding BDMV/)
#   --until CALL:  stop right after the first trace line for CALL (a JNI name without the Java_org_videolan_Libbluray_
#                  prefix, e.g. selectPlaylistN); CALL#N stops after the N-th (selectPlaylistN#2)
#   --seconds N:   stop after N seconds of wall time (default 60)
#   --jvm-option:  passed to the JVM through JAVA_TOOL_OPTIONS (e.g. -verbose:class, -verbose:jni; their output
#                  goes to stderr)
#   --planes:      add a {"plane":"flush",...} line at every ARGB overlay flush
#   --keys FILE:   replay a .keys script (implies --planes); the run ends --tail seconds (default 5) after its last step;
#                  exit status 3 when a step waits longer than --wait-timeout S (default 30) or --seconds ends the run
#                  with steps left (raise --seconds for key runs: the default 60 is often too short)
#   --dump-planes DIR: also write DIR/<k>.png (the whole 1920x1080 plane) at flush k
#   --name NAME:   the container's name (so a caller can `docker kill` it)
#   --storage VOLUME: keep the BD-J storage (dvb.persistent.root, bluray.bindingunit.root) in the Docker volume VOLUME,
#                  mounted at /storage (LIBBLURAY_PERSISTENT_ROOT=/storage/persistent/, LIBBLURAY_CACHE_ROOT=/storage/buda/),
#                  so a later run with the same volume finds what this one saved, as a player keeps it between viewings.
#                  Without it every run starts with empty storage (inside the container, removed with it)
#   --online:      give the container a network. Runs are offline by default (`--network none`), as libbluray is on a
#                  machine with no network: a disc's BD-Live attempts fail at once and never reach a real server. Nothing
#                  in the repo passes --online; it is for a one-off comparison by hand
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE=bluray-web-bdj-trace
PLATFORM="${BDJ_TRACE_PLATFORM:-linux/amd64}"

DISC="${1:?usage: run.sh <disc> [--until <call>[#<n>]] [--seconds N] [--jvm-option OPT]... [--planes] [--keys FILE] [--tail S] [--wait-timeout S] [--dump-planes DIR]}"
shift
ENV_ARGS=()
NAME_ARGS=()
MOUNTS=()
HARNESS_ARGS=()
SECONDS_ARG=60
NETWORK_ARGS=(--network none)
JVM_OPTIONS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --until) ENV_ARGS+=(-e "BDJ_TRACE_UNTIL=$2"); shift 2 ;;
    --seconds) SECONDS_ARG="$2"; shift 2 ;;
    --jvm-option) JVM_OPTIONS="${JVM_OPTIONS:+$JVM_OPTIONS }$2"; shift 2 ;;
    --planes) HARNESS_ARGS+=(--planes); shift ;;
    --tail) HARNESS_ARGS+=(--tail "$2"); shift 2 ;;
    --name) NAME_ARGS=(--name "$2"); shift 2 ;;
    --online) NETWORK_ARGS=(); shift ;;
    --storage)
      MOUNTS+=(-v "$2:/storage")
      ENV_ARGS+=(-e LIBBLURAY_PERSISTENT_ROOT=/storage/persistent/ -e LIBBLURAY_CACHE_ROOT=/storage/buda/); shift 2 ;;
    --wait-timeout) HARNESS_ARGS+=(--wait-timeout "$2"); shift 2 ;;
    --keys)
      [ -f "$2" ] || { echo "no such script: $2" >&2; exit 2; }
      MOUNTS+=(-v "$(cd "$(dirname "$2")" && pwd)/$(basename "$2"):/script.keys:ro")
      HARNESS_ARGS+=(--keys /script.keys); shift 2 ;;
    --dump-planes)
      mkdir -p "$2"
      MOUNTS+=(-v "$(cd "$2" && pwd):/planes")
      HARNESS_ARGS+=(--dump-planes /planes); shift 2 ;;
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

exec docker run --rm ${NAME_ARGS[@]+"${NAME_ARGS[@]}"} ${NETWORK_ARGS[@]+"${NETWORK_ARGS[@]}"} --platform "$PLATFORM" -e BD_DEBUG_MASK -e BD_DEBUG_FILE \
  ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} \
  -v "$DISC_DIR:/disc:ro" \
  ${MOUNTS[@]+"${MOUNTS[@]}"} \
  "$IMAGE" bdj_trace /disc --seconds "$SECONDS_ARG" ${HARNESS_ARGS[@]+"${HARNESS_ARGS[@]}"}
