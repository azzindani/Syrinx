#!/usr/bin/env bash
# Live-box setup: CPM2 GGUF pair (ungated) for tts-cpm2.
# BaseLM-Q8_0 (~1.6GB) + Acoustic-F16 (~1.7GB) => ~3.3GB.
set -euo pipefail
DIR="${CHECKPOINT_DIR:-./checkpoints/cpm2-gguf}"
mkdir -p "$DIR"
hf download DennisHuang648/VoxCPM2-GGUF \
  --include "VoxCPM2-BaseLM-Q8_0.gguf" \
  --include "VoxCPM2-Acoustic-F16.gguf" \
  --local-dir "$DIR"
ls -la "$DIR"
echo "weights: $DIR (set CPM_CKPT=$DIR)"
