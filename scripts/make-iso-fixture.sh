#!/usr/bin/env bash
# Builds fixtures/synthetic/disc1.iso, a UDF image with disc1's BDMV tree at its root, in Docker.
#
# The image is made by genisoimage 1.1.11 (Debian bookworm, package 9:1.1.11-3.4) with `-udf`, which writes an
# ISO 9660 + UDF 1.02 bridge image (one type-1 partition) without root. xorriso 1.5.4 was tried first and refuses
# `-as mkisofs -udf` ("Unsupported option"): it writes no UDF at all. A UDF 2.50 image with a metadata partition
# would need `mkudffs --media-type=bdr` and then a mount to copy files in, which an unprivileged container cannot
# do (udfclient 0.8.11 does not recognise the formatted image either). The metadata partition is covered by the
# UDF 2.50 images that tests/helpers/udf-image.ts builds in memory for the engine and server tests.
#
# genisoimage writes time() and clock() into the UDF volume set id, so it runs under faketime with clock() pinned
# to 0 by a preloaded shim, and with the file times pinned: rebuilding gives the same bytes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG='bluray-web-iso-fixture:2'
docker build --quiet --tag "$TAG" - >/dev/null <<'EOF'
FROM debian@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends genisoimage=9:1.1.11-3.4 faketime gcc libc6-dev && rm -rf /var/lib/apt/lists/*
RUN printf '#include <time.h>\nclock_t clock(void) { return 0; }\n' > /tmp/clock.c && gcc -shared -fPIC -o /usr/local/lib/clock0.so /tmp/clock.c
EOF
docker run --rm \
  -v "$ROOT/fixtures/synthetic/disc1:/src:ro" \
  -v "$ROOT/fixtures/synthetic:/out" \
  "$TAG" sh -euc '
    cp -r /src /tmp/disc1
    find /tmp/disc1 -exec touch -h -d "2026-01-01 00:00:00 UTC" {} +
    TZ=UTC LD_PRELOAD=/usr/local/lib/clock0.so faketime -f "2026-01-01 00:00:00" genisoimage -quiet -udf -iso-level 3 -V DISC1 -o /out/disc1.iso /tmp/disc1
    chown "$(stat -c %u:%g /out)" /out/disc1.iso
  '
