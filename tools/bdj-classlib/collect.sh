#!/usr/bin/env bash
# Grows src/bdj-classlib/classes.txt and tests/bdj/natives.txt from real runs: each BD-J disc runs through libbluray up
# to its first playlist selection with -verbose:class and -verbose:jni, and a synthetic disc with key scripts
# (tests/bdj/scripts/<disc>.<name>.keys, <disc> in lower case) runs each script to its end as well. A disc of the
# library check (a folder under $BDJ_LIBRARY_DIR/discs, default ~/.cache/bluray-web/bdj-library/discs) runs the
# check's generic script instead (tools/bdj-library/generic.keys: menu, two arrows, ok), with the check's limits.
# Names are only ever added.
#   collect.sh [disc...]: only these discs (folder names under fixtures/synthetic or paths); default: disc-bdj,
#                         disc-bdj-menu and every BD-J disc under fixtures/local
#   BDJ_COLLECT_JOBS=N:   discs run N at a time (default 1)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
PLATFORM="${BDJ_TRACE_PLATFORM:-linux/amd64}"
LIBRARY="${BDJ_LIBRARY_DIR:-$HOME/.cache/bluray-web/bdj-library}"

# one disc: collect.sh --one <disc> <out> <err>
if [ "${1:-}" = "--one" ]; then
  d="$2"; out="$3"; err="$4"
  : > "$out"; : > "$err"
  case "$(cd "$d" 2> /dev/null && pwd)/" in
    "$(cd "$LIBRARY" 2> /dev/null && pwd)"/discs/*)
      echo "collecting from $d with the generic script" >&2
      # HotSpot under amd64 emulation now and then dies at once (SIGSEGV in libzip): run once more without a script end
      for attempt in 1 2; do
        tools/bdj-trace/run.sh "$d" --keys tools/bdj-library/generic.keys --seconds 140 --wait-timeout 60 --tail 5 \
          --jvm-option -verbose:class --jvm-option -verbose:jni > "$out.run" 2>> "$err" || true
        cat "$out.run" >> "$out"
        if grep -q '"script":"end"' "$out.run"; then break; fi
      done
      rm -f "$out.run"
      ;;
    *)
      echo "collecting from $d" >&2
      # HotSpot prints -verbose output on stdout, between the trace lines
      tools/bdj-trace/run.sh "$d" --until selectPlaylistN --jvm-option -verbose:class --jvm-option -verbose:jni \
        > "$out" 2> "$err" || true
      # scripts for a local disc are named in lower case (a_new_era.play.keys for fixtures/local/A_NEW_ERA)
      for k in tests/bdj/scripts/"$(basename "$d" | tr '[:upper:]' '[:lower:]')".*.keys; do
        [ -f "$k" ] || continue
        echo "collecting from $d with $k" >&2
        tools/bdj-trace/run.sh "$d" --keys "$k" --seconds 180 --wait-timeout 60 --jvm-option -verbose:class \
          --jvm-option -verbose:jni >> "$out" 2>> "$err" || true
      done
      ;;
  esac
  exit 0
fi

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

DISCS=()
if [ $# -gt 0 ]; then
  for d in "$@"; do
    case "$(basename "$d")" in .tmp-*) continue ;; esac
    if [ -d "$d" ]; then DISCS+=("$d"); else DISCS+=("fixtures/synthetic/$d"); fi
  done
else
  for d in fixtures/synthetic/disc-bdj fixtures/synthetic/disc-bdj-menu fixtures/local/*; do
    [ -d "$d/BDMV/BDJO" ] && DISCS+=("$d")
  done
fi

mkdir "$T/runs"
i=0
for d in "${DISCS[@]}"; do
  i=$((i + 1))
  printf '%s\0%s\0%s\0' "$d" "$T/runs/$i.out" "$T/runs/$i.err"
done | xargs -0 -n 3 -P "${BDJ_COLLECT_JOBS:-1}" bash "$0" --one

: > "$T/loaded"
: > "$T/natives"
for out in "$T"/runs/*.out; do
  [ -f "$out" ] || continue
  # classes of rt.jar ("shared objects file" is the CDS archive, also built from rt.jar), jsse.jar and jce.jar (the
  # JAR signature check's providers and javax.crypto); pack.sh takes them from the same three jars
  { grep -E '^\[Loaded [^ ]+ from (/usr/lib/jvm/[^]]*/(rt|jsse|jce)\.jar|shared objects file)\]' "$out" || true; } \
    | sed -E 's/^\[Loaded ([^ ]+) from .*/\1/' | tr . / >> "$T/loaded"
  { grep -E '^\[(Dynamic-linking native method [^ ]+ \.\.\. JNI|Registering JNI native method [^ ]+)\]' "$out" || true; } \
    | sed -E 's/^\[(Dynamic-linking native method|Registering JNI native method) ([^] ]+).*/\2/' >> "$T/natives"
done

mkdir -p src/bdj-classlib tests/bdj
touch src/bdj-classlib/classes.txt tests/bdj/natives.txt
# HotSpot's own java.awt.Font loads its platform font stack (sun/font, the X11 and fontconfig font managers); libbluray's
# java/awt/Font takes its place in our JVM, so neither those classes nor their natives are collected
PLATFORM_FONTS='sun/font/|sun/awt/(X11FontManager|FcFontManager|FontConfiguration|FontDescriptor|motif/)|sun/java2d/FontSupport'
{ cat src/bdj-classlib/classes.txt; grep -vE '\$\$Lambda\$|LambdaForm\$|\$Proxy' "$T/loaded" | grep -vE "^($PLATFORM_FONTS)" || true; } \
  | grep -v '^$' | LC_ALL=C sort -u > "$T/classes.new"
cp "$T/classes.new" src/bdj-classlib/classes.txt

# "class.method" -> "class method", minus the natives that are the Java side's own table (Task 13)
sed -E 's/^(.*)\.([^.]+)$/\1 \2/' "$T/natives" | sort -u \
  | { grep -vE '^org\.videolan\.|^java\.awt\.BDFontMetrics |^java\.awt\.BDGraphicsBase |^java\.io\.FileInputStream ' || true; } \
  | { grep -vE "^($(echo "$PLATFORM_FONTS" | tr / .))" || true; } \
  > "$T/native-names"

# descriptors via javap inside the image
docker run --rm --platform "$PLATFORM" -v "$T:/in:ro" -v "$ROOT/tools/bdj-classlib:/tools:ro" \
  bluray-web-bdj-trace bash /tools/resolve-natives.sh > "$T/natives.resolved"
{ cat tests/bdj/natives.txt; cat "$T/natives.resolved"; } | grep -v '^$' | LC_ALL=C sort -u > "$T/natives.new"
cp "$T/natives.new" tests/bdj/natives.txt
wc -l src/bdj-classlib/classes.txt tests/bdj/natives.txt >&2
