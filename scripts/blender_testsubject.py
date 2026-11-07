"""Render a synthetic test subject for validating the pipeline without any AI generation.

Usage:
  Blender -b -P scripts/blender_testsubject.py -- --out input/synthetic [--frames 96] [--views 8]

Outputs:
  <out>/orbit.mp4          360-degree orbit video     (-> video route)
  <out>/multiview/*.png    N evenly spaced views      (-> multi-view route)
  <out>/multiview/views.json  ground-truth camera params, same convention as known_orbit.py

World convention (shared with known_orbit.py):
  Z up, subject stands on z=0 and faces -Y.
  azimuth 0 = front view, camera on -Y.  azimuth 90 = camera on +X (the subject's left side).
"""
import argparse
import json
import math
import os
import subprocess
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("--out", required=True)
ap.add_argument("--frames", type=int, default=96)
ap.add_argument("--views", type=int, default=8)
ap.add_argument("--width", type=int, default=576)
ap.add_argument("--height", type=int, default=864)
ap.add_argument("--fov-y", type=float, default=30.0)
ap.add_argument("--cam-height", type=float, default=1.0)
args = ap.parse_args(argv)

OUT = os.path.abspath(args.out)
os.makedirs(os.path.join(OUT, "multiview"), exist_ok=True)
frames_dir = os.path.join(OUT, "_orbit_frames")
os.makedirs(frames_dir, exist_ok=True)

# ---------- scene ----------
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE_NEXT"
scene.render.resolution_x = args.width
scene.render.resolution_y = args.height
scene.render.film_transparent = False
scene.view_settings.view_transform = "Standard"

world = bpy.data.worlds.new("w")
scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.45, 0.45, 0.45, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 1.0


def textured_material(name, base, scale, seed):
    """Noise/voronoi texture so SfM has features to match (plain colours would fail)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = 0.8
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = scale
    noise.inputs["Detail"].default_value = 8.0
    vor = nt.nodes.new("ShaderNodeTexVoronoi")
    vor.inputs["Scale"].default_value = scale * 2.5
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.inputs["Factor"].default_value = 0.5
    nt.links.new(noise.outputs["Fac"], mix.inputs[6])
    nt.links.new(vor.outputs["Distance"], mix.inputs[7])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = tuple(c * 0.35 for c in base) + (1,)
    ramp.color_ramp.elements[1].color = tuple(min(1, c * 1.4) for c in base) + (1,)
    nt.links.new(mix.outputs[2], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    return m


skin = textured_material("skin", (0.85, 0.65, 0.52), 18, 1.0)
shirt = textured_material("shirt", (0.9, 0.3, 0.25), 12, 2.0)
pants = textured_material("pants", (0.2, 0.3, 0.7), 14, 3.0)
shoes = textured_material("shoes", (0.9, 0.9, 0.85), 20, 4.0)
hair = textured_material("hair", (0.25, 0.15, 0.08), 30, 5.0)


def add(kind, loc, scale, mat, rot=(0, 0, 0)):
    if kind == "sphere":
        bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, location=loc, rotation=rot)
    elif kind == "cyl":
        bpy.ops.mesh.primitive_cylinder_add(vertices=48, location=loc, rotation=rot)
    elif kind == "cube":
        bpy.ops.mesh.primitive_cube_add(location=loc, rotation=rot)
    o = bpy.context.object
    o.scale = scale
    o.data.materials.append(mat)
    bpy.ops.object.shade_smooth()
    return o


# A crude ~1.7 m humanoid facing -Y, in an A-pose.
add("sphere", (0, 0, 1.56), (0.10, 0.11, 0.13), skin)            # head
add("sphere", (0, 0.025, 1.62), (0.108, 0.11, 0.10), hair)       # hair cap (back/top)
add("sphere", (0, -0.095, 1.57), (0.018, 0.02, 0.02), skin)      # nose (front marker)
add("cyl", (0, 0, 1.42), (0.05, 0.05, 0.05), skin)               # neck
add("sphere", (0, 0, 1.17), (0.19, 0.12, 0.27), shirt)           # torso
add("cube", (0, -0.05, 1.22), (0.06, 0.03, 0.06), shoes)         # chest badge (front marker)
add("sphere", (0, 0, 0.90), (0.17, 0.11, 0.10), pants)           # hips
for s in (-1, 1):
    add("cyl", (s * 0.27, 0, 1.12), (0.045, 0.045, 0.27), skin, rot=(0, -s * 0.35, 0))   # arms
    add("sphere", (s * 0.365, 0, 0.84), (0.04, 0.025, 0.07), skin)                     # hands
    add("cyl", (s * 0.09, 0, 0.47), (0.065, 0.065, 0.42), pants)                       # legs
    add("cube", (s * 0.09, -0.04, 0.04), (0.05, 0.11, 0.04), shoes)                    # shoes

# lights
bpy.ops.object.light_add(type="AREA", location=(0, -3, 3))
key = bpy.context.object
key.data.energy = 150
key.data.size = 4
key.rotation_euler = (math.radians(45), 0, 0)
bpy.ops.object.light_add(type="AREA", location=(0, 3, 3))
back = bpy.context.object
back.data.energy = 80
back.data.size = 4
back.rotation_euler = (math.radians(-45), 0, 0)

# camera
bpy.ops.object.camera_add()
cam = bpy.context.object
scene.camera = cam
cam.data.sensor_fit = "VERTICAL"
cam.data.angle_y = math.radians(args.fov_y)
SUBJECT_H = 1.75
target = (0.0, 0.0, SUBJECT_H / 2)
radius = (SUBJECT_H / 2 * 1.15) / math.tan(math.radians(args.fov_y) / 2)


def place_camera(az_deg):
    a = math.radians(az_deg)
    cx, cy, cz = radius * math.sin(a), -radius * math.cos(a), args.cam_height
    cam.location = (cx, cy, cz)
    d = (target[0] - cx, target[1] - cy, target[2] - cz)
    # point -Z of the Blender camera at the target, +Y up
    import mathutils
    cam.rotation_euler = mathutils.Vector(d).to_track_quat("-Z", "Y").to_euler()
    return (cx, cy, cz)


# ---------- multi-view stills ----------
views = []
for i in range(args.views):
    az = 360.0 * i / args.views
    pos = place_camera(az)
    name = f"view_{i:02d}_az{int(round(az)):03d}.png"
    scene.render.filepath = os.path.join(OUT, "multiview", name)
    bpy.ops.render.render(write_still=True)
    views.append({"file": name, "azimuth_deg": az, "position": pos})

with open(os.path.join(OUT, "multiview", "views.json"), "w") as f:
    json.dump({"fov_y_deg": args.fov_y, "radius": radius, "cam_height": args.cam_height,
               "target": target, "width": args.width, "height": args.height, "views": views}, f, indent=2)

# ---------- orbit video frames ----------
for i in range(args.frames):
    az = 360.0 * i / args.frames
    place_camera(az)
    scene.render.filepath = os.path.join(frames_dir, f"f_{i:04d}.png")
    bpy.ops.render.render(write_still=True)

subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "24",
                "-i", os.path.join(frames_dir, "f_%04d.png"),
                "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p",
                os.path.join(OUT, "orbit.mp4")], check=True)
print("DONE", OUT)
