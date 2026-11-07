#!/usr/bin/env bash
# Image generation via Codex CLI's built-in image tool (uses your ChatGPT plan, no API key).
#
#   scripts/gen_images.sh source    <subject_dir> "<person description>"
#       -> <subject_dir>/source.png  (full body, A-pose, front, plain background)
#
#   scripts/gen_images.sh multiview <subject_dir> [n_views=8]
#       -> <subject_dir>/multiview/view_XX_azDDD.png, each generated from source.png
#
# Azimuth convention (must match known_orbit.py): 0 = front, 90 = camera at the subject's
# LEFT side (we see their left profile), 180 = back, 270 = their right side.
set -euo pipefail

MODE=$1
DIR=$2
mkdir -p "$DIR"
DIR=$(cd "$DIR" && pwd)
ROOT=$(cd "$(dirname "$0")/.." && pwd)

COMMON="Photorealistic studio photo. Full body visible head to toe with a small margin, \
subject centred, standing in a relaxed A-pose (arms slightly away from the body), \
seamless plain light-grey background, soft even lighting with no strong shadows, \
camera at chest height, 50mm lens look, portrait 2:3. No text, no watermark."

run_codex () {  # $1 prompt, $2 output path, rest: images to attach
  local prompt=$1 out=$2; shift 2
  local attach=()
  for img in "$@"; do attach+=(-i "$img"); done
  # The prompt goes before -i: `-i` takes multiple values and would swallow a trailing prompt.
  codex exec --skip-git-repo-check -s workspace-write -C "$ROOT" \
    "Use your image generation tool to create exactly ONE image. ${prompt}
Save the resulting image file to ${out} (overwrite if it exists). Print only the saved path. Do nothing else." \
    ${attach[@]+"${attach[@]}"} < /dev/null > "${out%.png}.codex.log" 2>&1 || { echo "codex failed, see ${out%.png}.codex.log"; return 1; }
  [ -f "$out" ] || { echo "no image written for $out"; return 1; }
  echo "  -> $out"
}

case "$MODE" in
  source)
    DESC=${3:?person description required}
    run_codex "A fictional person (not a real individual): ${DESC}. Facing the camera straight on. ${COMMON}" \
      "$DIR/source.png"
    ;;
  multiview)
    N=${3:-8}
    [ -f "$DIR/source.png" ] || { echo "$DIR/source.png missing"; exit 1; }
    mkdir -p "$DIR/multiview"
    for ((i = 0; i < N; i++)); do
      AZ=$(( 360 * i / N ))
      case $AZ in
        0)   VIEW="front view, the person faces the camera" ;;
        45)  VIEW="front three-quarter view: the person is turned so we see the front and their LEFT side (their left shoulder is nearer to the camera)" ;;
        90)  VIEW="exact left profile: the camera sees the person's LEFT side, their nose points to the LEFT edge of the image" ;;
        135) VIEW="back three-quarter view: we see their back and their LEFT side (left shoulder nearer to the camera), face mostly hidden" ;;
        180) VIEW="back view: the camera sees the person's back, face not visible" ;;
        225) VIEW="back three-quarter view: we see their back and their RIGHT side (right shoulder nearer to the camera), face mostly hidden" ;;
        270) VIEW="exact right profile: the camera sees the person's RIGHT side, their nose points to the RIGHT edge of the image" ;;
        315) VIEW="front three-quarter view: the person is turned so we see the front and their RIGHT side (their right shoulder is nearer to the camera)" ;;
        *)   VIEW="the camera has orbited ${AZ} degrees around the person (0 = front, 90 = their left side, 180 = back)" ;;
      esac
      OUTF=$(printf "%s/multiview/view_%02d_az%03d.png" "$DIR" "$i" "$AZ")
      if [ -f "$OUTF" ]; then echo "  skip existing $OUTF"; continue; fi
      if [ "$AZ" -eq 0 ]; then
        # The front view is the source itself (already the canonical framing).
        cp "$DIR/source.png" "$OUTF"; echo "  -> $OUTF (copied source)"; continue
      fi
      run_codex "The attached image shows a person. Generate the SAME person — identical face, hairstyle, \
body shape, clothing, shoes, colours and A-pose — photographed from a different angle: ${VIEW}. \
Only the camera moves around the person; the person stays in exactly the same pose. \
Keep the same distance, the same height of the camera, the same framing and the same scale \
(head and feet at the same positions in the frame as in the attached image). ${COMMON}" \
        "$OUTF" "$DIR/source.png"
    done
    ;;
  *) echo "unknown mode $MODE"; exit 1 ;;
esac
