#!/usr/bin/env bash
# Builds patched libbluray (with BD-J) and the trace harness in Docker. The image is linux/amd64 everywhere so CI
# and Apple-silicon hosts agree; BDJ_TRACE_PLATFORM overrides that for local runs only (see README.md).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
IMAGE=bluray-web-bdj-trace
PLATFORM="${BDJ_TRACE_PLATFORM:-linux/amd64}"

docker build --platform "$PLATFORM" -t "$IMAGE" "$HERE"
echo "built image $IMAGE ($PLATFORM)"
