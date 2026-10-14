#!/usr/bin/env bash
# Builds patched libbluray and the trace harness in Docker (ubuntu 24.04 pinned by digest, linux/amd64
# everywhere so CI and Apple-silicon hosts agree) and copies the static binary to tools/vm-trace/out/vm_trace.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
IMAGE=bluray-web-vm-trace

docker build --platform linux/amd64 -t "$IMAGE" "$HERE"
mkdir -p "$HERE/out"
docker run --rm --platform linux/amd64 -v "$HERE/out:/out" "$IMAGE" cp /usr/local/bin/vm_trace /out/vm_trace
echo "built $HERE/out/vm_trace"
