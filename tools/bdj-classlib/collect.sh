#!/usr/bin/env bash
# Grows src/bdj-classlib/classes.txt and tests/bdj/natives.txt from real runs: each BD-J disc runs through libbluray up
# to its first playlist selection with -verbose:class and -verbose:jni, and a synthetic disc with key scripts
# (tests/bdj/scripts/<disc>.<name>.keys, <disc> in lower case) runs each script to its end as well. Names are only ever added.
#   collect.sh [disc...]: only these discs (folder names under fixtures/synthetic or paths); default: disc-bdj,
#                         disc-bdj-menu and every BD-J disc under fixtures/local
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
PLATFORM="${BDJ_TRACE_PLATFORM:-linux/amd64}"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

DISCS=()
if [ $# -gt 0 ]; then
  for d in "$@"; do
    if [ -d "$d" ]; then DISCS+=("$d"); else DISCS+=("fixtures/synthetic/$d"); fi
  done
else
  for d in fixtures/synthetic/disc-bdj fixtures/synthetic/disc-bdj-menu fixtures/local/*; do
    [ -d "$d/BDMV/BDJO" ] && DISCS+=("$d")
  done
fi

: > "$T/loaded"
: > "$T/natives"
for d in "${DISCS[@]}"; do
  echo "collecting from $d" >&2
  # HotSpot prints -verbose output on stdout, between the trace lines
  tools/bdj-trace/run.sh "$d" --until selectPlaylistN --jvm-option -verbose:class --jvm-option -verbose:jni \
    > "$T/out" 2> "$T/err" || true
  # scripts for a local disc are named in lower case (a_new_era.play.keys for fixtures/local/A_NEW_ERA)
  for k in tests/bdj/scripts/"$(basename "$d" | tr '[:upper:]' '[:lower:]')".*.keys; do
    [ -f "$k" ] || continue
    echo "collecting from $d with $k" >&2
    tools/bdj-trace/run.sh "$d" --keys "$k" --seconds 180 --wait-timeout 60 --jvm-option -verbose:class \
      --jvm-option -verbose:jni >> "$T/out" 2>> "$T/err" || true
  done
  # classes of rt.jar ("shared objects file" is the CDS archive, also built from rt.jar), jsse.jar and jce.jar (the
  # JAR signature check's providers and javax.crypto); pack.sh takes them from the same three jars
  { grep -E '^\[Loaded [^ ]+ from (/usr/lib/jvm/[^]]*/(rt|jsse|jce)\.jar|shared objects file)\]' "$T/out" || true; } \
    | sed -E 's/^\[Loaded ([^ ]+) from .*/\1/' | tr . / >> "$T/loaded"
  { grep -E '^\[(Dynamic-linking native method [^ ]+ \.\.\. JNI|Registering JNI native method [^ ]+)\]' "$T/out" || true; } \
    | sed -E 's/^\[(Dynamic-linking native method|Registering JNI native method) ([^] ]+).*/\2/' >> "$T/natives"
done

mkdir -p src/bdj-classlib tests/bdj
touch src/bdj-classlib/classes.txt tests/bdj/natives.txt
{ cat src/bdj-classlib/classes.txt; grep -vE '\$\$Lambda\$|LambdaForm\$|\$Proxy' "$T/loaded" || true; } \
  | grep -v '^$' | LC_ALL=C sort -u > "$T/classes.new"
cp "$T/classes.new" src/bdj-classlib/classes.txt

# "class.method" -> "class method", minus the natives that are the Java side's own table (Task 13)
sed -E 's/^(.*)\.([^.]+)$/\1 \2/' "$T/natives" | sort -u \
  | { grep -vE '^org\.videolan\.|^java\.awt\.BDFontMetrics |^java\.awt\.BDGraphicsBase |^java\.io\.FileInputStream ' || true; } \
  > "$T/native-names"

# descriptors via javap inside the image
docker run --rm --platform "$PLATFORM" -v "$T:/in:ro" -v "$ROOT/tools/bdj-classlib:/tools:ro" \
  bluray-web-bdj-trace bash /tools/resolve-natives.sh > "$T/natives.resolved"
{ cat tests/bdj/natives.txt; cat "$T/natives.resolved"; } | grep -v '^$' | LC_ALL=C sort -u > "$T/natives.new"
cp "$T/natives.new" tests/bdj/natives.txt
wc -l src/bdj-classlib/classes.txt tests/bdj/natives.txt >&2
