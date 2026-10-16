#!/usr/bin/env bash
# Builds patched libass and the trace harness in Docker (ubuntu 24.04 pinned by digest, linux/amd64 everywhere
# so CI and Apple-silicon hosts agree). The harness runs inside this image (run.sh).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
docker build --platform linux/amd64 -t bluray-web-ass-trace "$HERE"
