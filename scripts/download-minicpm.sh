#!/usr/bin/env bash
#
# Download a MiniCPM‑V 2.6 int‑4 quantised GGUF into the project's
# `models/` directory.  This is the version known to support tool
# calling via the open-source `llama.cpp` / `ollama` servers.
#
# The script is intentionally *minimal*: it hits the public HF
# mirror, stores the GGUF in `models/minicpm-v26-int4.gguf` (skipping
# the download if the file already exists).
#
# Usage:
#   bash scripts/download-minicpm.sh

set -euo pipefail

MODEL_DIR="$(dirname "$0")/../models"
mkdir -p "$MODEL_DIR"

OUT="$MODEL_DIR/minicpm-v26-int4.gguf"
if [ -s "$OUT" ]; then
    echo "mini-cpm GGUF already at $OUT ($(du -h "$OUT" | awk '{print $1}')) – skipping"
    exit 0
fi

# Public HF mirror for MiniCPM‑V‑2.6 int‑4
URL="https://huggingface.co/ggml-org/MiniCPM-V-2_6-GGUF/resolve/main/MiniCPM-V-2_6-Instruct-Q4_K_M.gguf"

echo "downloading $URL"
curl -L --retry 5 --output "$OUT" "$URL" \
  || { echo "download failed – check URL or network"; exit 1; }

echo "saved to $OUT ($(du -h "$OUT" | awk '{print $1}'))"
