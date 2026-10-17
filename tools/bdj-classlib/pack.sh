#!/usr/bin/env bash
# Runs inside the image with the repo mounted at /work (cwd). Called by build.sh.
set -euo pipefail

OUT=src/bdj-classlib
MK="python3 -I tools/bdj-classlib/make-jar.py"
LB=/usr/local/share/java
JRE="$JAVA_HOME/jre"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

$MK $OUT/libbluray-j2se.jar $LB/libbluray-j2se-1.5.1.jar -
$MK $OUT/libbluray-awt-j2se.jar $LB/libbluray-awt-j2se-1.5.1.jar -

# the synthetic disc's xlets: class version 47 (-source/-target 1.3), compiled against libbluray's own jars
mkdir "$T/xlets"
javac -nowarn -source 1.3 -target 1.3 \
  -bootclasspath "$LB/libbluray-j2se-1.5.1.jar:$LB/libbluray-awt-j2se-1.5.1.jar:$JRE/lib/rt.jar" \
  -d "$T/xlets" tests/bdj/xlets/src/bdjweb/test/*.java
$MK tests/bdj/xlets/00000.jar "$T/xlets" -
# the HDMV and BD-J disc's xlets (disc-bdj-mixed), in a jar of their own so disc-bdj's jar stays as it is
mkdir "$T/xlets-mixed"
javac -nowarn -source 1.3 -target 1.3 \
  -bootclasspath "$LB/libbluray-j2se-1.5.1.jar:$LB/libbluray-awt-j2se-1.5.1.jar:$JRE/lib/rt.jar" \
  -d "$T/xlets-mixed" tests/bdj/xlets/src/bdjweb/mixed/*.java
$MK tests/bdj/xlets/mixed.jar "$T/xlets-mixed" -

# the JVM conformance programs (package conformance) and HotSpot's stdout for each class with a main; every program runs
# twice and the outputs must match
mkdir "$T/conf"
javac -nowarn -source 1.8 -target 1.8 -d "$T/conf" tests/bdj/conformance/*.java
$MK tests/bdj/conformance.jar "$T/conf" -
# locale and encoding pinned so no output depends on the machine
JOPTS="-Xint -Duser.language=en -Duser.country=US -Dfile.encoding=UTF-8"
run_twice() { # <class> <classpath> <out>
  java $JOPTS -cp "$2" "$1" > "$3"
  java $JOPTS -cp "$2" "$1" > "$T/again"
  cmp "$3" "$T/again" || { echo "$1 output differs between runs" >&2; exit 1; }
  if LC_ALL=C grep -q -P '[^\x00-\x7F?]' "$3" || grep -q '?' "$3"; then echo "$3 has non-ASCII bytes or '?'" >&2; exit 1; fi
}
for src in tests/bdj/conformance/*.java; do
  name="$(basename "$src" .java)"
  grep -q 'static void main' "$src" || continue
  run_twice "conformance.$name" tests/bdj/conformance.jar "tests/bdj/conformance/$name.out"
done
# Bare has no main: a harness (not packed into the jar) prints each method's result
mkdir "$T/harness"
javac -nowarn -source 1.8 -target 1.8 -cp tests/bdj/conformance.jar -d "$T/harness" tests/bdj/conformance/harness/*.java
run_twice harness.BareMain "tests/bdj/conformance.jar:$T/harness" tests/bdj/conformance/Bare.out

# classes.txt plus every nested class of each listed class (X$*.class), from rt.jar and the other JRE jars whose
# classes HotSpot loads on the local discs (jsse.jar: the Sun and SunRsaSign providers; jce.jar: javax.crypto); the
# classes, then the resources (symlinks followed), are staged into one tree
JARS="rt jsse jce"
: > "$T/all-entries"
mkdir "$T/stage"
for j in $JARS; do
  unzip -Z1 "$JRE/lib/$j.jar" | grep '\.class$' | LC_ALL=C sort > "$T/$j-entries"
  cat "$T/$j-entries" >> "$T/all-entries"
  LC_ALL=C awk -v listfile=$OUT/classes.txt '
    BEGIN { while ((getline l < listfile) > 0) if (l != "") want[l] = 1 }
    { n = $0; sub(/\.class$/, "", n)
      keep = (n in want)
      p = n
      while (!keep && (i = match(p, /\$[^$]*$/)) > 0) { p = substr(p, 1, i - 1); if (p in want) keep = 1 }
      if (keep) print $0 }' "$T/$j-entries" > "$T/$j-names"
  echo "$(wc -l < "$T/$j-names") class entries from $j.jar" >&2
  python3 -I - "$JRE/lib/$j.jar" "$T/stage" "$T/$j-names" <<'PY'
import sys, zipfile
jar, dest, names = sys.argv[1:4]
z = zipfile.ZipFile(jar)
for n in open(names).read().split('\n'):
    if n:
        z.extract(n, dest)
PY
done
# every listed class must exist in one of the jars
LC_ALL=C sort -u "$T/all-entries" > "$T/entries"
sed 's/$/.class/' $OUT/classes.txt | LC_ALL=C sort | comm -23 - "$T/entries" > "$T/absent"
if [ -s "$T/absent" ]; then echo "classes.txt names not in $JARS:" >&2; head "$T/absent" >&2; exit 1; fi

while read -r r; do
  [ -n "$r" ] || continue
  mkdir -p "$T/stage/$(dirname "$r")"
  cp -L "$JRE/$r" "$T/stage/$r"
done < tools/bdj-classlib/resources.txt
$MK $OUT/rt-bdj.jar "$T/stage" -

# licenses
cp /usr/share/common-licenses/GPL-2 $OUT/LICENSE
sed -n '/^"CLASSPATH" EXCEPTION TO THE GPL$/,/^OpenJDK Trademark Notice/p' \
  /usr/share/doc/openjdk-8-jre-headless/copyright | sed '$d' | sed '$d' > $OUT/ASSEMBLY_EXCEPTION
SRC_PKG="$(dpkg-query -W -f='${source:Package}' openjdk-8-jre-headless)"
SRC_VER="$(dpkg-query -W -f='${source:Version}' openjdk-8-jre-headless)"
SNAPSHOT=20261015T000000Z
{
  echo "rt-bdj.jar holds classes and files of the OpenJDK 8 runtime (GPLv2 with the Classpath Exception; see LICENSE and"
  echo "ASSEMBLY_EXCEPTION), unmodified, selected by src/bdj-classlib/classes.txt and tools/bdj-classlib/resources.txt."
  echo
  echo "OpenJDK binary package: $(dpkg-query -W openjdk-8-jre-headless)"
  echo "Corresponding source:   Ubuntu source package $SRC_PKG $SRC_VER,"
  echo "  https://snapshot.ubuntu.com/ubuntu/$SNAPSHOT/pool/universe/${SRC_PKG:0:1}/$SRC_PKG/${SRC_PKG}_${SRC_VER#*:}.dsc"
  echo "Apt snapshot:           $SNAPSHOT (ubuntu 24.04)"
  echo
  echo "libbluray-j2se.jar and libbluray-awt-j2se.jar are libbluray's BD-J Java stack, LGPL-2.1-or-later (the license"
  echo "text is in src/engine/LICENSE), built from libbluray commit 448f896,"
  echo "https://code.videolan.org/videolan/libbluray (source: https://code.videolan.org/videolan/libbluray/-/tree/448f896)."
} > $OUT/NOTICE
