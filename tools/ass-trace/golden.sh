#!/usr/bin/env bash
# Regenerates tests/ass-trace/golden/<name>.jsonl and golden/<name>/<ms>.png from libass for every
# fixtures/ass/<name>/<name>.ass that has a times.txt (and an optional storage.txt, "<w>x<h>").
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
mkdir -p tests/ass-trace/golden
for dir in fixtures/ass/*/; do
  name="$(basename "$dir")"
  [ -f "$dir/$name.ass" ] && [ -f "$dir/times.txt" ] || continue
  storage=""
  [ -f "$dir/storage.txt" ] && storage="$(tr -d '[:space:]' < "$dir/storage.txt")"
  out="tools/ass-trace/out/$name"
  rm -rf "$out" "tests/ass-trace/golden/$name"
  npx tsx -e "
    import { traceScript } from './tests/ass-trace/run.ts';
    traceScript('$dir$name.ass', 'fixtures/ass/fonts', '${dir}times.txt', '$out', '$storage' || undefined);
  "
  cp "$out/trace.jsonl" "tests/ass-trace/golden/$name.jsonl"
  mkdir -p "tests/ass-trace/golden/$name"
  cp "$out"/*.png "tests/ass-trace/golden/$name/"
  echo "wrote tests/ass-trace/golden/$name.jsonl and $(ls "$out"/*.png | wc -l | tr -d ' ') frames"
done
