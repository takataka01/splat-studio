#!/usr/bin/env bash
# Video route: orbit video -> frames -> COLMAP (SfM) -> dataset folder for 3DGS training.
#
# Usage: scripts/video_to_dataset.sh <orbit.mp4> <out_dataset_dir> [fps=4] [max_side=1080]
#
# Output layout (same as known_orbit.py):
#   <out>/images/*.png
#   <out>/sparse/0/{cameras,images,points3D}.bin
set -euo pipefail

VIDEO=$1
OUT=$2
FPS=${3:-4}
MAX_SIDE=${4:-1080}

ROOT=$(cd "$(dirname "$0")/.." && pwd)
COLMAP=${COLMAP:-$ROOT/.env/colmap/bin/colmap}
[ -x "$COLMAP" ] || COLMAP=$(command -v colmap) || { echo "colmap not found"; exit 1; }

mkdir -p "$OUT/images" "$OUT/sparse"
rm -f "$OUT/images/"*.png "$OUT/database.db"

echo "== extracting frames at ${FPS} fps"
ffmpeg -loglevel error -y -i "$VIDEO" \
  -vf "fps=${FPS},scale='if(gt(iw,ih),min(${MAX_SIDE},iw),-2)':'if(gt(iw,ih),-2,min(${MAX_SIDE},ih))'" \
  "$OUT/images/frame_%04d.png"
echo "   $(ls "$OUT/images" | wc -l | tr -d ' ') frames"

echo "== COLMAP feature extraction (single shared camera; video frames come from one lens)"
"$COLMAP" feature_extractor \
  --database_path "$OUT/database.db" \
  --image_path "$OUT/images" \
  --ImageReader.single_camera 1 \
  --ImageReader.camera_model SIMPLE_PINHOLE \
  --FeatureExtraction.use_gpu 0

NIMG=$(ls "$OUT/images" | wc -l | tr -d ' ')
if [ "$NIMG" -le 150 ]; then
  # A full orbit returns to the start, so the last frames must match the first ones.
  # With <=150 frames exhaustive matching is cheap and closes that loop for free.
  echo "== COLMAP exhaustive matching ($NIMG images)"
  "$COLMAP" exhaustive_matcher --database_path "$OUT/database.db" --FeatureMatching.use_gpu 0
else
  echo "== COLMAP sequential matching ($NIMG images)"
  "$COLMAP" sequential_matcher --database_path "$OUT/database.db" \
    --SequentialMatching.overlap 15 --SequentialMatching.quadratic_overlap 1 \
    --FeatureMatching.use_gpu 0
fi

echo "== COLMAP mapping"
"$COLMAP" mapper \
  --database_path "$OUT/database.db" \
  --image_path "$OUT/images" \
  --output_path "$OUT/sparse"

N=$(ls -d "$OUT/sparse/"*/ | wc -l | tr -d ' ')
echo "== done: $N reconstruction(s) in $OUT/sparse (0 is usually the largest)"
"$COLMAP" model_analyzer --path "$OUT/sparse/0" 2>&1 | grep -E 'Registered images|Points|Mean reprojection' || true
