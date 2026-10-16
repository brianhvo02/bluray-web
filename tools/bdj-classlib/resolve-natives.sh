#!/usr/bin/env bash
# Runs inside the trace image with a directory mounted at /in holding native-names (lines "dotted.Class method").
# Prints "slash/Class.method(descriptor)" for every method of that name the class declares native. Called by collect.sh.
set -euo pipefail

CP="$JAVA_HOME/jre/lib/rt.jar:/usr/local/share/java/libbluray-j2se-1.5.1.jar:/usr/local/share/java/libbluray-awt-j2se-1.5.1.jar"
cut -d' ' -f1 /in/native-names | sort -u | while read -r cls; do
  names="$(awk -v c="$cls" '$1 == c { printf "%s ", $2 }' /in/native-names)"
  javap -s -p -cp "$CP" "$cls" | awk -v c="${cls//.//}" -v names="$names" '
    BEGIN { n = split(names, a, " "); for (i = 1; i <= n; i++) want[a[i]] = 1 }
    / native / && /\(/ { m = $0; sub(/\(.*/, "", m); k = split(m, w, " "); m = w[k]; hit = (m in want); next }
    /descriptor:/ { if (hit) print c "." m $2; hit = 0 }'
done
