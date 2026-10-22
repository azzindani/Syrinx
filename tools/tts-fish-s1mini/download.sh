#!/usr/bin/env bash
# Live-box setup: weights + fish-speech checkout (pinned rev).
# Requires: uv tool install 'huggingface_hub[cli]' ; huggingface-cli login (gated repo).
set -euo pipefail
DIR="${CHECKPOINT_DIR:-./checkpoints/s1-mini}"
REPO="${FISH_REPO:-./fish-speech}"
# Pinned rev verified 2026-09-12: text2semantic --prompt-audio/--output/--output-dir
# flags as used in server.py _try_real_infer(). Re-verify flags if you move rev.
REV="${FISH_REV:-befe400}"
mkdir -p "$DIR"
hf download fishaudio/s1-mini --local-dir "$DIR"
ls "$DIR"  # expect codec.pth + model weights (server.py needs <ckpt>/codec.pth)
if [ ! -d "$REPO" ]; then
  git clone https://github.com/fishaudio/fish-speech.git "$REPO"
fi
(cd "$REPO" && git fetch origin && git checkout "$REV" && git rev-parse --short HEAD)
echo "weights: $DIR | repo: $REPO@$REV"
