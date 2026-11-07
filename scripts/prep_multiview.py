#!/usr/bin/env python3
"""Multi-view route: remove the plain studio background and align the framing of every view.

Usage:
  python3 scripts/prep_multiview.py <multiview_dir> <out_dir>
         [--method auto|model|threshold] [--ref-az 0] [--no-align]

Needs numpy, Pillow, scipy and (for --method model) onnxruntime. If they are not importable
the script re-runs itself with the project venv .env/py/bin/python (see README).

For each *az<deg>*.png in <multiview_dir>:
  1. Background removal.
     - model (default): ISNet salient-object segmentation (isnet-general-use.onnx, the model
       rembg ships) run with onnxruntime on the CPU. The model file is downloaded once to
       .tools/models/. Needed because a white shirt in soft shade has nearly the same colour
       as the light-grey studio background, which defeats any colour threshold.
     - threshold: no model. The background is a quadratic colour field fitted to the border
       and then to all background pixels; alpha is a soft ramp of the colour distance to it.
     Both are followed by the same cleanup: morphological open/close, keep the largest
     connected component (plus any other large one), fill enclosed holes, and un-mix edge
     colours from the fitted background colour so no grey halo is left.
  2. Framing (skipped when views.json exists, or with --no-align). Image generators do not
     keep the scale/position of the subject constant between views, but known_orbit.py
     assumes they do. Each view is scaled and shifted so the top of the head and the bottom
     of the feet land on the same rows as in the reference view (az000 = the source image),
     and the subject's bbox is centred horizontally. Canvas size is unchanged.

Output: <out_dir>/<same filename>.png as RGBA (straight alpha), plus framing.json (head/feet rows
of the reference view, read by known_orbit.py). views.json is copied if present.
"""
import argparse
import json
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENV_PY = os.path.join(ROOT, ".env", "py", "bin", "python")

try:
    import numpy as np
    from PIL import Image
    from scipy import ndimage as ndi
except ImportError:
    if os.path.exists(VENV_PY) and os.path.realpath(sys.executable) != os.path.realpath(VENV_PY):
        os.execv(VENV_PY, [VENV_PY] + sys.argv)
    raise SystemExit("numpy/Pillow/scipy missing: uv venv .env/py --python 3.12 && "
                     "uv pip install --python .env/py/bin/python numpy pillow scipy onnxruntime")

MODEL_URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx"
MODEL_PATH = os.path.join(ROOT, ".tools", "models", "isnet-general-use.onnx")

ap = argparse.ArgumentParser()
ap.add_argument("in_dir")
ap.add_argument("out_dir")
ap.add_argument("--method", choices=["auto", "model", "threshold"], default="auto",
                help="auto = model if onnxruntime is available, else threshold")
ap.add_argument("--ref-az", type=int, default=0, help="azimuth of the reference view (default 0)")
ap.add_argument("--threshold", type=float, default=18.0,
                help="threshold method: colour distance (0-255) at which alpha reaches 0.5")
ap.add_argument("--softness", type=float, default=10.0,
                help="threshold method: width of the soft alpha ramp")
ap.add_argument("--border", type=int, default=12, help="border band (px) used as initial background")
ap.add_argument("--no-align", action="store_true",
                help="only remove the background; keep the framing (default when views.json exists,"
                     " because ground-truth renders are already framed exactly)")
args = ap.parse_args()
gt_path = os.path.join(args.in_dir, "views.json")
align = not args.no_align and not os.path.exists(gt_path)

method = args.method
if method in ("auto", "model"):
    try:
        import onnxruntime as ort
        method = "model"
    except ImportError:
        if method == "model":
            raise SystemExit("onnxruntime missing: uv pip install --python .env/py/bin/python onnxruntime")
        method = "threshold"
print(f"background removal: {method}")


def poly_basis(h, w, ys, xs):
    y = ys / h * 2 - 1
    x = xs / w * 2 - 1
    return np.stack([np.ones_like(x), x, y, x * x, x * y, y * y], axis=-1)


def fit_background(rgb, bg_mask):
    """Least-squares quadratic colour field fitted to the pixels in bg_mask."""
    h, w, _ = rgb.shape
    ys, xs = np.nonzero(bg_mask)
    if len(ys) > 200000:  # subsample for speed
        sel = np.random.default_rng(0).choice(len(ys), 200000, replace=False)
        ys, xs = ys[sel], xs[sel]
    A = poly_basis(h, w, ys.astype(np.float64), xs.astype(np.float64))
    coef, *_ = np.linalg.lstsq(A, rgb[ys, xs], rcond=None)
    gy, gx = np.mgrid[0:h, 0:w].astype(np.float64)
    return poly_basis(h, w, gy, gx) @ coef  # (h, w, 3)


def threshold_alpha(rgb):
    h, w, _ = rgb.shape
    b = args.border
    bg = np.zeros((h, w), bool)
    bg[:b], bg[-b:], bg[:, :b], bg[:, -b:] = True, True, True, True
    for _ in range(3):
        field = fit_background(rgb, bg)
        dist = np.linalg.norm(rgb - field, axis=-1)
        bg = dist < args.threshold * 0.6
    return np.clip((dist - (args.threshold - args.softness / 2)) / args.softness, 0, 1)


_session = None


def model_alpha(rgb):
    """ISNet (rembg's isnet-general-use): 1024x1024 input, mean 0.5, std 1."""
    global _session
    if _session is None:
        if not os.path.exists(MODEL_PATH):
            import urllib.request
            os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
            print(f"downloading {MODEL_URL}")
            urllib.request.urlretrieve(MODEL_URL, MODEL_PATH + ".part")
            os.replace(MODEL_PATH + ".part", MODEL_PATH)
        _session = ort.InferenceSession(MODEL_PATH, providers=["CPUExecutionProvider"])
    h, w, _ = rgb.shape
    img = Image.fromarray(rgb.astype(np.uint8))
    x = np.asarray(img.resize((1024, 1024), Image.LANCZOS)).astype(np.float32)
    x = x / max(float(x.max()), 1e-6) - 0.5
    x = x.transpose(2, 0, 1)[None]
    y = _session.run(None, {_session.get_inputs()[0].name: x})[0][0, 0]
    y = (y - y.min()) / max(float(y.max() - y.min()), 1e-6)
    a = Image.fromarray((y * 255).astype(np.uint8)).resize((w, h), Image.LANCZOS)
    return np.asarray(a).astype(np.float64) / 255.0


def remove_background(rgb):
    h, w, _ = rgb.shape
    alpha = model_alpha(rgb) if method == "model" else threshold_alpha(rgb)

    hard = alpha > 0.5
    if method == "model":
        # The model sometimes misses white parts (shoes) against the light background. Add
        # back pixels clearly BRIGHTER than the background field (shadows are darker, so
        # they stay out) when they touch the model's mask.
        field = fit_background(rgb, alpha < 0.02)
        dist = np.linalg.norm(rgb - field, axis=-1)
        bright = (dist > args.threshold) & (rgb.mean(-1) > field.mean(-1) + 8)
        bright = ndi.binary_opening(bright, iterations=1)
        bl, bn = ndi.label(bright)
        if bn:
            touch = np.unique(bl[ndi.binary_dilation(hard, iterations=3) & (bl > 0)])
            extra = np.isin(bl, touch[touch > 0])
            hard |= extra
            alpha = np.where(extra, 1.0, alpha)

    # Morphological cleanup on the hard mask, then use it to gate the soft alpha.
    hard = ndi.binary_opening(hard, iterations=2)
    hard = ndi.binary_closing(hard, iterations=3)
    labels, n = ndi.label(hard)
    if n == 0:
        raise SystemExit("no foreground found")
    sizes = ndi.sum(hard, labels, index=np.arange(1, n + 1))
    # Keep the largest component, other large ones, and smaller pieces lying close to the
    # largest one (e.g. a shoe separated from the trouser leg by a thin gap).
    main = labels == (1 + int(np.argmax(sizes)))
    near_main = ndi.binary_dilation(main, iterations=max(4, h // 40))
    touching = np.unique(labels[near_main & (labels > 0)])
    keep = (sizes >= 0.05 * sizes.max()) | (
        np.isin(np.arange(1, n + 1), touching) & (sizes >= 0.0003 * h * w))
    hard = np.isin(labels, 1 + np.nonzero(keep)[0])
    # Fill small enclosed holes only: real gaps (neck/ponytail, between the legs) can be
    # enclosed too and must stay transparent.
    holes = ndi.binary_fill_holes(hard) & ~hard
    hl, hn = ndi.label(holes)
    if hn:
        hsizes = ndi.sum(holes, hl, index=np.arange(1, hn + 1))
        hard |= np.isin(hl, 1 + np.nonzero(hsizes < 0.0005 * h * w)[0])

    # Soft alpha only within a thin band around the kept mask; fully opaque inside.
    near = ndi.binary_dilation(hard, iterations=2)
    alpha = np.where(hard, np.maximum(alpha, ndi.binary_erosion(hard, iterations=2)), alpha * near)
    alpha = np.clip(ndi.gaussian_filter(alpha, 0.6) * near, 0, 1)

    # Un-mix edge colours: I = a*C + (1-a)*B  =>  C = (I - (1-a)*B) / a
    field = fit_background(rgb, alpha < 0.02)
    a3 = alpha[..., None]
    fg = np.where(a3 > 0.05, (rgb - (1 - a3) * field) / np.maximum(a3, 0.05), rgb)
    fg = np.clip(fg, 0, 255)
    return fg, alpha


def bbox(alpha):
    ys, xs = np.nonzero(alpha > 0.5)
    return ys.min(), ys.max(), xs.min(), xs.max()


def transform(rgba, scale, dy, dx):
    """Resample so that out(y, x) = in((y - dy) / scale, (x - dx) / scale)."""
    h, w, _ = rgba.shape
    # Premultiply so that resampling does not bleed transparent colours into edges.
    pm = rgba.copy()
    pm[..., :3] *= pm[..., 3:4]
    out = np.empty_like(pm)
    matrix = [1 / scale, 1 / scale]
    offset = [-dy / scale, -dx / scale]
    for c in range(4):
        out[..., c] = ndi.affine_transform(pm[..., c], matrix, offset=offset, order=1,
                                           mode="constant", cval=0.0)
    a = out[..., 3:4]
    out[..., :3] = np.where(a > 1e-4, out[..., :3] / np.maximum(a, 1e-4), 0)
    return out


files = sorted(f for f in os.listdir(args.in_dir)
               if f.lower().endswith(".png") and re.search(r"az(\d+)", f))
if not files:
    raise SystemExit(f"no *az<deg>*.png files in {args.in_dir}")
ref = [f for f in files if int(re.search(r"az(\d+)", f).group(1)) == args.ref_az]
if not ref:
    raise SystemExit(f"reference view az{args.ref_az:03d} not found")
os.makedirs(args.out_dir, exist_ok=True)

views = {}
for f in files:
    img = Image.open(os.path.join(args.in_dir, f))
    if img.mode == "RGBA" and np.asarray(img)[..., 3].min() < 250:
        # Already has a real alpha channel (e.g. Blender renders): keep it.
        arr = np.asarray(img).astype(np.float64)
        fg, alpha = arr[..., :3], arr[..., 3] / 255.0
    else:
        fg, alpha = remove_background(np.asarray(img.convert("RGB")).astype(np.float64))
    views[f] = np.concatenate([fg / 255.0, alpha[..., None]], axis=-1)

ref_rgba = views[ref[0]]
H, W, _ = ref_rgba.shape
rt, rb, _, _ = bbox(ref_rgba[..., 3])
print(f"reference {ref[0]}: head row {rt}, feet row {rb} ({W}x{H})")

for f in files:
    rgba = views[f]
    if rgba.shape[:2] != (H, W):
        # Different canvas: resize to the reference canvas first (aspect may change slightly).
        im = Image.fromarray((rgba * 255).round().astype(np.uint8), "RGBA").resize((W, H), Image.LANCZOS)
        rgba = np.asarray(im).astype(np.float64) / 255.0
    t, b, l, r = bbox(rgba[..., 3])
    if align:
        scale = (rb - rt) / max(b - t, 1)
        dy = rt - t * scale
        dx = W / 2 - (l + r) / 2 * scale
        out = transform(rgba, scale, dy, dx)
    else:
        scale, dy, dx, out = 1.0, 0.0, 0.0, rgba
    nt, nb, nl, nr = bbox(out[..., 3])
    dest = os.path.join(args.out_dir, f)
    Image.fromarray((np.clip(out, 0, 1) * 255).round().astype(np.uint8), "RGBA").save(
        dest + ".part", format="PNG")
    os.replace(dest + ".part", dest)  # atomic: a cancelled run never leaves a truncated PNG
    cover = (out[..., 3] > 0.5).mean()
    print(f"  {f}: scale {scale:.3f} shift ({dx:+.0f},{dy:+.0f})px -> rows {nt}-{nb}, "
          f"cols {nl}-{nr}, foreground {cover * 100:.1f}%")

# Framing of the reference view, so known_orbit.py can pick a matching camera distance.
with open(os.path.join(args.out_dir, "framing.json"), "w") as fo:
    json.dump({"width": W, "height": H, "head_row": int(rt), "feet_row": int(rb),
               "subject_fraction": round((rb - rt) / H, 4)}, fo, indent=2)

if os.path.exists(gt_path):
    shutil.copy(gt_path, os.path.join(args.out_dir, "views.json"))
    print("copied views.json (framing kept as rendered)")
print(f"wrote {len(files)} views to {args.out_dir}")
