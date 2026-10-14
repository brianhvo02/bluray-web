#!/usr/bin/env bash
# Regenerates tests/vm-trace/golden/*.jsonl from libbluray for every script in tests/vm-trace/scripts.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$ROOT/tests/vm-trace/golden"
for keys in "$ROOT"/tests/vm-trace/scripts/*.keys; do
  name="$(basename "$keys" .keys)"
  "$ROOT/tools/vm-trace/run.sh" "${name%%.*}" "${name#*.}" > "$ROOT/tests/vm-trace/golden/$name.jsonl"
  echo "wrote tests/vm-trace/golden/$name.jsonl"
done
