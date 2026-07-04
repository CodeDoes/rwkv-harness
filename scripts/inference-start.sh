#!/usr/bin/env bash
# inference-start.sh — start the inference engine as a fully detached
# daemon. Survives `gateway:stop` because:
#   1. we use a separate PID file (.inference.pid, not .gateway.pid)
#   2. `setsid` places the process in its own session group, so it
#      can't be killed when the pnpm/shell session closes
#   3. we listen on port 3130, not 3030, so the gateway can run
#      side-by-side without port collision
#
# Usage: pnpm inference:start
#   (or: bash scripts/inference-start.sh)

set -euo pipefail

PID_FILE=".inference.pid"
LOG_FILE=".inference.log"
PORT=3130
MODEL="${MODEL_PATH:-}"

# Idempotent guard: if the recorded PID is still alive, do nothing.
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  PID="$(cat "$PID_FILE")"
  echo "Inference already running (PID $PID, port $PORT) — log: $LOG_FILE"
  exit 0
fi
rm -f "$PID_FILE"

MODEL_ARG=""
if [ -n "$MODEL" ]; then
  MODEL_ARG="--model=$MODEL"
fi

# setsid → new session group, immune to HUP cascading from this shell
# nohup → ignore SIGHUP for good measure
# `&` → background
# we deliberately do NOT use `disown` because setsid handles it.
setsid nohup tsx src/cli.ts gateway --port=$PORT $MODEL_ARG > "$LOG_FILE" 2>&1 &
PID=$!
echo "$PID" > "$PID_FILE"
echo "Inference started — PID $PID, port $PORT, log: $LOG_FILE"
