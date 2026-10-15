#!/usr/bin/env bash
# Regenerates tests/vm-trace/golden/*.jsonl from libbluray for every script of a disc in fixtures/synthetic.
# Scripts for local discs (fixtures/local, not committed) have no golden file: run them with npm run vm-trace.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$ROOT/tests/vm-trace/golden"
for keys in "$ROOT"/tests/vm-trace/scripts/*.keys; do
  name="$(basename "$keys" .keys)"
  disc="${name%%.*}"
  [ -d "$ROOT/fixtures/synthetic/$disc" ] || continue
  "$ROOT/tools/vm-trace/run.sh" "$disc" "${name#*.}" > "$ROOT/tests/vm-trace/golden/$name.jsonl"
  echo "wrote tests/vm-trace/golden/$name.jsonl"
done
