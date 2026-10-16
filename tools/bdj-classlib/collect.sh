#!/usr/bin/env bash
# Grows src/bdj-classlib/classes.txt and tests/bdj/natives.txt from real runs: each BD-J disc runs through libbluray up
# to its first playlist selection with -verbose:class and -verbose:jni. Names are only ever added.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
PLATFORM="${BDJ_TRACE_PLATFORM:-linux/amd64}"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

DISCS=()
[ -d fixtures/synthetic/disc-bdj/BDMV ] && DISCS+=(fixtures/synthetic/disc-bdj)
for d in fixtures/local/*; do
  [ -d "$d/BDMV/BDJO" ] && DISCS+=("$d")
done

: > "$T/loaded"
: > "$T/natives"
for d in "${DISCS[@]}"; do
  echo "collecting from $d" >&2
  # HotSpot prints -verbose output on stdout, between the trace lines
  tools/bdj-trace/run.sh "$d" --until selectPlaylistN --jvm-option -verbose:class --jvm-option -verbose:jni \
    > "$T/out" 2> "$T/err" || true
  # classes of rt.jar ("shared objects file" is the CDS archive, also built from rt.jar)
  { grep -E '^\[Loaded [^ ]+ from (/usr/lib/jvm/[^]]*/rt\.jar|shared objects file)\]' "$T/out" || true; } \
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
