#!/usr/bin/env python3
"""Multi-view route: write a COLMAP text model from *assumed* turntable camera poses.

Generated multi-view images (4-8 views) usually have too few overlapping features for
SfM, so instead of running COLMAP we place the cameras analytically on a circle and let
the 3DGS trainer fit the subject.

Usage:
  python3 scripts/known_orbit.py <image_dir> <out_dataset_dir> [--fov-y 30] [--radius R]
         [--cam-height 1.0] [--subject-height 1.75]

<image_dir> must contain images whose filename includes `az<degrees>`, e.g. view_02_az090.png.
If <image_dir>/views.json exists (Blender ground truth), its fov/radius/height are used.
Otherwise, if <image_dir>/framing.json exists (written by prep_multiview.py) and --radius is not
given, the radius is chosen so the subject fills the measured fraction of the image height.

World convention (same as blender_testsubject.py):
  Z up, subject on z=0 facing -Y. azimuth 0 = front (camera on -Y), 90 = subject's left (+X).

Output layout (what Brush / other 3DGS trainers read):
  <out>/images/*.png
  <out>/sparse/0/{cameras,images,points3D}.txt
"""
import argparse
import json
import math
import os
import random
import re
import shutil
import struct
import zlib

ap = argparse.ArgumentParser()
ap.add_argument("image_dir")
ap.add_argument("out_dir")
ap.add_argument("--fov-y", type=float, default=30.0)
ap.add_argument("--radius", type=float, default=None)
ap.add_argument("--cam-height", type=float, default=1.0)
ap.add_argument("--subject-height", type=float, default=1.75)
ap.add_argument("--init-points", type=int, default=20000)
args = ap.parse_args()

gt_path = os.path.join(args.image_dir, "views.json")
if os.path.exists(gt_path):
    gt = json.load(open(gt_path))
    args.fov_y, args.radius, args.cam_height = gt["fov_y_deg"], gt["radius"], gt["cam_height"]
    print(f"using ground truth from views.json: fov_y={args.fov_y} radius={args.radius:.3f}")
target = (0.0, 0.0, args.subject_height / 2)
framing_path = os.path.join(args.image_dir, "framing.json")
if args.radius is None and os.path.exists(framing_path):
    # Written by prep_multiview.py: the subject spans this fraction of the image height, so
    # put the camera where a subject_height-tall person fills exactly that fraction.
    frac = json.load(open(framing_path))["subject_fraction"]
    args.radius = args.subject_height / (frac * 2 * math.tan(math.radians(args.fov_y) / 2))
    print(f"radius {args.radius:.3f} from framing.json (subject fills {frac * 100:.1f}% of the height)")
if args.radius is None:
    args.radius = (args.subject_height / 2 * 1.15) / math.tan(math.radians(args.fov_y) / 2)


def png_size(path):
    with open(path, "rb") as f:
        head = f.read(24)
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">II", head[16:24])
    raise SystemExit(f"{path}: only PNG supported (convert with ffmpeg or sips first)")


def sub(a, b): return (a[0] - b[0], a[1] - b[1], a[2] - b[2])
def cross(a, b): return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
def norm(a):
    n = math.sqrt(sum(x * x for x in a))
    return (a[0] / n, a[1] / n, a[2] / n)


def rot_to_quat(R):
    """Rotation matrix (row-major 3x3) -> (qw, qx, qy, qz)."""
    tr = R[0][0] + R[1][1] + R[2][2]
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        return (0.25 * s, (R[2][1] - R[1][2]) / s, (R[0][2] - R[2][0]) / s, (R[1][0] - R[0][1]) / s)
    if R[0][0] > R[1][1] and R[0][0] > R[2][2]:
        s = math.sqrt(1.0 + R[0][0] - R[1][1] - R[2][2]) * 2
        return ((R[2][1] - R[1][2]) / s, 0.25 * s, (R[0][1] + R[1][0]) / s, (R[0][2] + R[2][0]) / s)
    if R[1][1] > R[2][2]:
        s = math.sqrt(1.0 + R[1][1] - R[0][0] - R[2][2]) * 2
        return ((R[0][2] - R[2][0]) / s, (R[0][1] + R[1][0]) / s, 0.25 * s, (R[1][2] + R[2][1]) / s)
    s = math.sqrt(1.0 + R[2][2] - R[0][0] - R[1][1]) * 2
    return ((R[1][0] - R[0][1]) / s, (R[0][2] + R[2][0]) / s, (R[1][2] + R[2][1]) / s, 0.25 * s)


files = sorted(f for f in os.listdir(args.image_dir) if f.lower().endswith(".png") and re.search(r"az(\d+)", f))
if not files:
    raise SystemExit("no images named like *az<deg>*.png found")

img_out = os.path.join(args.out_dir, "images")
sp_out = os.path.join(args.out_dir, "sparse", "0")
os.makedirs(img_out, exist_ok=True)
os.makedirs(sp_out, exist_ok=True)

cams, imgs = [], []
for i, f in enumerate(files, start=1):
    az = float(re.search(r"az(\d+)", f).group(1))
    w, h = png_size(os.path.join(args.image_dir, f))
    shutil.copy(os.path.join(args.image_dir, f), os.path.join(img_out, f))
    fy = (h / 2) / math.tan(math.radians(args.fov_y) / 2)
    cams.append(f"{i} PINHOLE {w} {h} {fy:.4f} {fy:.4f} {w / 2:.2f} {h / 2:.2f}")

    a = math.radians(az)
    C = (args.radius * math.sin(a), -args.radius * math.cos(a), args.cam_height)
    fwd = norm(sub(target, C))
    right = norm(cross(fwd, (0, 0, 1)))
    down = cross(fwd, right)
    R = [right, down, fwd]  # world->camera rows (COLMAP: x right, y down, z forward)
    t = tuple(-sum(R[r][k] * C[k] for k in range(3)) for r in range(3))
    q = rot_to_quat(R)
    imgs.append(f"{i} {q[0]:.8f} {q[1]:.8f} {q[2]:.8f} {q[3]:.8f} {t[0]:.6f} {t[1]:.6f} {t[2]:.6f} {i} {f}\n")

with open(os.path.join(sp_out, "cameras.txt"), "w") as fo:
    fo.write("# CAMERA_ID MODEL WIDTH HEIGHT PARAMS[]\n" + "\n".join(cams) + "\n")
with open(os.path.join(sp_out, "images.txt"), "w") as fo:
    fo.write("# IMAGE_ID QW QX QY QZ TX TY TZ CAMERA_ID NAME\n# (empty 2D-point line follows each image)\n")
    for line in imgs:
        fo.write(line + "\n")

# Initial point cloud: random grey points filling a body-sized cylinder.
rng = random.Random(0)
with open(os.path.join(sp_out, "points3D.txt"), "w") as fo:
    fo.write("# POINT3D_ID X Y Z R G B ERROR TRACK[]\n")
    for i in range(1, args.init_points + 1):
        r = 0.35 * math.sqrt(rng.random())
        th = rng.random() * 2 * math.pi
        z = rng.random() * args.subject_height * 1.05
        fo.write(f"{i} {r * math.cos(th):.4f} {r * math.sin(th):.4f} {z:.4f} 128 128 128 0\n")

print(f"wrote {len(files)} cameras to {sp_out}")
