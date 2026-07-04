#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0
RESULTS=""

run_bench() {
  local label="$1" placement="$2" script="$3"
  local placement_display
  placement_display="${placement:-(default)}"

  echo "── $label [$placement_display] ──"
  local output
  output=$(
    cd "$ROOT"
    TOOL_RESPONSE_PLACEMENT="$placement" pnpm "$script" 2>&1
  ) || true

  # Extract the final verdict line like "29/29 PASS" or "23/23 PASS"
  local verdict
  verdict=$(echo "$output" | grep -E '^[0-9]+/[0-9]+ (PASS|FAIL)$' | head -1)
  if [ -n "$verdict" ]; then
    echo "  $verdict"
    local total="${verdict%%/*}"
    local result="${verdict##* }"
    if [ "$result" = "PASS" ]; then
      PASS=$((PASS + 1))
    else
      FAIL=$((FAIL + 1))
    fi
    RESULTS+="  [$placement_display] $script: $verdict\n"
  else
    echo "  (no verdict — likely crashed)"
    echo "$output" | tail -5
    FAIL=$((FAIL + 1))
    RESULTS+="  [$placement_display] $script: NO VERDICT\n"
  fi
  echo ""
}

# ── Header ──
echo "=================================================="
echo "  TOOL_RESPONSE_PLACEMENT bake-off"
echo "=================================================="
echo ""

# ── block ──
run_bench "Oracle eval"   "block"  "eval"
run_bench "Trace tests"   "block"  "test:trace"

# ── inline ──
run_bench "Oracle eval"   "inline" "eval"
run_bench "Trace tests"   "inline" "test:trace"

# ── default (no env) ──
run_bench "Oracle eval"   ""       "eval"
run_bench "Trace tests"   ""       "test:trace"

# ── Summary ──
echo "=================================================="
echo "  Summary"
echo "=================================================="
echo -e "$RESULTS"
echo "Pass: $PASS  Fail: $FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
