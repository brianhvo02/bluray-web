#!/usr/bin/env bash
# Builds src/bdj-classlib/ in Docker: libbluray's two Java jars re-packed reproducibly, and rt-bdj.jar, the classes of
# the OpenJDK 8 rt.jar listed in classes.txt (plus their nested classes) and the resource files of resources.txt.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
IMAGE=bluray-web-bdj-classlib
PLATFORM="${BDJ_TRACE_PLATFORM:-linux/amd64}"

docker build --platform "$PLATFORM" -t "$IMAGE" "$HERE"
mkdir -p "$ROOT/src/bdj-classlib"
docker run --rm --platform "$PLATFORM" --user "$(id -u):$(id -g)" -v "$ROOT:/work" -w /work "$IMAGE" \
  bash tools/bdj-classlib/pack.sh
ls -l "$ROOT/src/bdj-classlib"
