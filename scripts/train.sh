#!/usr/bin/env bash
# Train 3D Gaussian Splatting with Brush (wgpu -> Metal, works without CUDA).
#
# Usage: scripts/train.sh <dataset_dir> <out_dir> [steps=7000] [extra brush args...]
#
# <dataset_dir> is the output of video_to_dataset.sh or known_orbit.py (images/ + sparse/0/).
# SH degree 0: generated footage has inconsistent lighting between views, so view-dependent
# colour mostly learns noise.
#
# Transparent backgrounds: if the images are RGBA (prep_multiview.py output), Brush premultiplies
# them, renders on black and adds an L1 loss between rendered and target alpha weighted by
# --match-alpha-weight (Brush default 0.1). With 0.1, dark splats in the background are almost
# free (black on black), so we raise it to 1.0: on the synthetic multi-view set (1500 steps)
# opacity mass outside the visual hull dropped from 108 to 35. Override with ALPHA_WEIGHT=...
# Images without alpha (video route) are unaffected.
set -euo pipefail

DATA=$1
OUT=$2
STEPS=${3:-7000}
shift $(( $# >= 3 ? 3 : $# ))

ROOT=$(cd "$(dirname "$0")/.." && pwd)
BRUSH=${BRUSH:-$ROOT/.tools/brush/target/release/brush_app}
[ -x "$BRUSH" ] || { echo "brush not found at $BRUSH (build it: cd .tools/brush && cargo build --release)"; exit 1; }

mkdir -p "$OUT"
# Brush logs "Refine iter N, M splats." / "Eval iter ..." through env_logger (used for progress).
export RUST_LOG=${RUST_LOG:-brush_cli=info}
"$BRUSH" "$DATA" \
  --total-steps "$STEPS" \
  --sh-degree 0 \
  --max-resolution 1080 \
  --export-every "$STEPS" \
  --export-path "$OUT" \
  --export-name "splat_{iter}.ply" \
  --match-alpha-weight "${ALPHA_WEIGHT:-1.0}" \
  "$@"

ls -la "$OUT"
