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

# the JVM conformance programs (package conformance) and HotSpot's stdout for each class with a main; every program runs
# twice and the outputs must match
mkdir "$T/conf"
javac -nowarn -source 1.8 -target 1.8 -d "$T/conf" tests/bdj/conformance/*.java
$MK tests/bdj/conformance.jar "$T/conf" -
for src in tests/bdj/conformance/*.java; do
  name="$(basename "$src" .java)"
  grep -q 'static void main' "$src" || continue
  java -Xint -cp tests/bdj/conformance.jar "conformance.$name" > "tests/bdj/conformance/$name.out"
  java -Xint -cp tests/bdj/conformance.jar "conformance.$name" > "$T/$name.again"
  cmp "tests/bdj/conformance/$name.out" "$T/$name.again" || { echo "conformance.$name output differs between runs" >&2; exit 1; }
done

# classes.txt plus every nested class of each listed class (X$*.class)
unzip -Z1 "$JRE/lib/rt.jar" | grep '\.class$' | LC_ALL=C sort > "$T/rt-entries"
LC_ALL=C awk -v listfile=$OUT/classes.txt '
  BEGIN { while ((getline l < listfile) > 0) if (l != "") want[l] = 1 }
  { n = $0; sub(/\.class$/, "", n)
    keep = (n in want)
    p = n
    while (!keep && (i = match(p, /\$[^$]*$/)) > 0) { p = substr(p, 1, i - 1); if (p in want) keep = 1 }
    if (keep) print $0 }' "$T/rt-entries" > "$T/names"
echo "$(wc -l < "$T/names") class entries" >&2
# every listed class must exist in rt.jar
sed 's/$/.class/' $OUT/classes.txt | LC_ALL=C sort | comm -23 - "$T/rt-entries" > "$T/absent"
if [ -s "$T/absent" ]; then echo "classes.txt names not in rt.jar:" >&2; head "$T/absent" >&2; exit 1; fi

# the classes, then the resources (symlinks followed), staged into one tree
mkdir "$T/stage"
python3 -I - "$JRE/lib/rt.jar" "$T/stage" "$T/names" <<'PY'
import sys, zipfile
jar, dest, names = sys.argv[1:4]
z = zipfile.ZipFile(jar)
for n in open(names).read().split('\n'):
    if n:
        z.extract(n, dest)
PY
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
{
  echo "rt-bdj.jar holds classes and files of the OpenJDK 8 runtime (GPLv2 with the Classpath Exception; see LICENSE and"
  echo "ASSEMBLY_EXCEPTION), unmodified, selected by tools/bdj-classlib/classes.txt and resources.txt."
  echo
  echo "OpenJDK package: $(dpkg-query -W openjdk-8-jre-headless)"
  echo "Apt snapshot:    20261015T000000Z (ubuntu 24.04)"
  echo "libbluray:       448f896 (libbluray-j2se.jar and libbluray-awt-j2se.jar are its BD-J Java stack, LGPL-2.1)"
} > $OUT/NOTICE
