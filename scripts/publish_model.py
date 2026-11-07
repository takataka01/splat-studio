#!/usr/bin/env python3
"""Copy a trained .ply into viewer/models/ and register it in viewer/models/index.json.

Usage: python3 scripts/publish_model.py <name> <splat.ply> <dataset_dir>

The subject's "up" direction is estimated from the dataset cameras (average of each
camera's up axis), so COLMAP reconstructions with arbitrary orientation stand upright
in the viewer. Known-orbit datasets come out as +Z.
"""
import json
import math
import os
import shutil
import struct
import sys

name, ply, data = sys.argv[1:4]
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sparse = os.path.join(data, "sparse", "0")


def quats_txt(path):
    out = []
    for line in open(path):
        if line.startswith("#") or not line.strip():
            continue
        p = line.split()
        if len(p) >= 10 and p[0].isdigit():
            out.append(tuple(map(float, p[1:5])))
    return out[::1]


def quats_bin(path):
    out = []
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        for _ in range(n):
            _id, qw, qx, qy, qz, tx, ty, tz, _cam = struct.unpack("<idddddddi", f.read(64))
            while f.read(1) != b"\x00":  # image name
                pass
            npts = struct.unpack("<Q", f.read(8))[0]
            f.read(24 * npts)
            out.append((qw, qx, qy, qz))
    return out


if os.path.exists(os.path.join(sparse, "images.bin")):
    qs = quats_bin(os.path.join(sparse, "images.bin"))
else:
    # images.txt alternates image lines and 2D-point lines; image lines have 10 fields
    qs = [q for q in quats_txt(os.path.join(sparse, "images.txt"))]

# Camera "up" in world = -(second row of R_world->cam) = -(camera y axis).
up = [0.0, 0.0, 0.0]
for qw, qx, qy, qz in qs:
    row1 = (2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw))
    for k in range(3):
        up[k] -= row1[k]
n = math.sqrt(sum(u * u for u in up))
up = [round(u / n, 5) for u in up]

models_dir = os.path.join(root, "viewer", "models")
os.makedirs(models_dir, exist_ok=True)
fname = f"{name}.ply"
shutil.copy(ply, os.path.join(models_dir, fname))

index_path = os.path.join(models_dir, "index.json")
index = json.load(open(index_path)) if os.path.exists(index_path) else []
index = [m for m in index if m["name"] != name] + [{"name": name, "file": fname, "up": up}]
json.dump(index, open(index_path, "w"), indent=2, ensure_ascii=False)
print(f"published {name}: up={up}  ({len(qs)} cameras)")
