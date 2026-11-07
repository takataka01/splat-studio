// Pure animation evaluation and keyframe helpers. No DOM, no three.js —
// importable from node for unit tests.
//
// A property is { value, keys: [{ t, v, interp }] } where value/v is a number
// or an array of numbers, t is an integer frame and interp is
// 'linear' | 'ease' | 'hold' (describes the segment leaving that key).

export const INTERPS = ["linear", "ease", "hold"];

// Cubic bezier timing function (like CSS cubic-bezier) solved for x -> y.
export function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (s) => ((ax * s + bx) * s + cx) * s;
  const sy = (s) => ((ay * s + by) * s + cy) * s;
  const dsx = (s) => (3 * ax * s + 2 * bx) * s + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // Newton iterations, then bisection fallback.
    let s = x;
    for (let i = 0; i < 8; i++) {
      const err = sx(s) - x;
      if (Math.abs(err) < 1e-7) return sy(s);
      const d = dsx(s);
      if (Math.abs(d) < 1e-6) break;
      s -= err / d;
    }
    let lo = 0, hi = 1;
    s = x;
    for (let i = 0; i < 40; i++) {
      const v = sx(s);
      if (Math.abs(v - x) < 1e-7) break;
      if (v < x) lo = s; else hi = s;
      s = (lo + hi) / 2;
    }
    return sy(s);
  };
}

export const easeInOut = cubicBezier(0.42, 0, 0.58, 1);

export function lerpValue(a, b, u) {
  if (Array.isArray(a)) return a.map((x, i) => x + ((b?.[i] ?? x) - x) * u);
  return a + (b - a) * u;
}

export function cloneValue(v) {
  return Array.isArray(v) ? v.slice() : v;
}

export function sortKeys(prop) {
  prop.keys.sort((a, b) => a.t - b.t);
  return prop;
}

/** Evaluate a property at (possibly fractional) frame t. */
export function evaluate(prop, t) {
  const keys = prop?.keys;
  if (!keys || keys.length === 0) return cloneValue(prop.value);
  if (t <= keys[0].t) return cloneValue(keys[0].v);
  const last = keys[keys.length - 1];
  if (t >= last.t) return cloneValue(last.v);
  // Binary search for segment [k0, k1] containing t.
  let lo = 0, hi = keys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].t <= t) lo = mid; else hi = mid;
  }
  const k0 = keys[lo], k1 = keys[hi];
  const interp = k0.interp || "linear";
  if (interp === "hold") return cloneValue(k0.v);
  let u = (t - k0.t) / (k1.t - k0.t);
  if (interp === "ease") u = easeInOut(u);
  return lerpValue(k0.v, k1.v, u);
}

export function keyIndexAt(prop, t) {
  return prop.keys ? prop.keys.findIndex((k) => k.t === t) : -1;
}

export function hasKeyAt(prop, t) {
  return keyIndexAt(prop, t) >= 0;
}

/** Insert or replace a key at frame t. Returns the key. */
export function setKey(prop, t, v, interp) {
  prop.keys ??= [];
  t = Math.round(t);
  const i = keyIndexAt(prop, t);
  if (i >= 0) {
    prop.keys[i].v = cloneValue(v);
    if (interp) prop.keys[i].interp = interp;
    return prop.keys[i];
  }
  const k = { t, v: cloneValue(v), interp: interp || "linear" };
  prop.keys.push(k);
  sortKeys(prop);
  return k;
}

export function removeKeyAt(prop, t) {
  const i = keyIndexAt(prop, t);
  if (i >= 0) prop.keys.splice(i, 1);
  return i >= 0;
}

/**
 * Set a property's value "at time t" like a DCC does:
 * - no keys: change the static value
 * - keys + autoKey (or a key already on t): set/replace a key at t
 * - keys, no autoKey, no key at t: set the static value so the edit is
 *   visible (returns { dirty: true }) — the caller shows the prop as
 *   un-keyed/dirty until the user presses I or the time changes.
 */
export function setValueAtTime(prop, t, v, { autoKey = false } = {}) {
  if (!prop.keys || prop.keys.length === 0) {
    if (autoKey) { setKey(prop, t, v); return { keyed: true }; }
    prop.value = cloneValue(v);
    return { keyed: false };
  }
  if (autoKey || hasKeyAt(prop, t)) { setKey(prop, t, v); return { keyed: true }; }
  return { keyed: false, dirty: true };
}

/**
 * Move keys by dt frames. `sel` is an array of key objects belonging to prop.
 * Keys landing on an existing unselected key replace it.
 */
export function moveKeys(prop, sel, dt) {
  if (!dt) return;
  const set = new Set(sel);
  const targets = new Set(sel.map((k) => Math.round(k.t + dt)));
  prop.keys = prop.keys.filter((k) => set.has(k) || !targets.has(k.t));
  for (const k of sel) k.t = Math.round(k.t + dt);
  sortKeys(prop);
}

export function prevKeyTime(times, t) {
  let best = null;
  for (const x of times) if (x < t && (best === null || x > best)) best = x;
  return best;
}

export function nextKeyTime(times, t) {
  let best = null;
  for (const x of times) if (x > t && (best === null || x < best)) best = x;
  return best;
}

/** Evaluate all props of a layer at t → { name: value }. */
export function evaluateLayer(layer, t) {
  const out = {};
  for (const [name, prop] of Object.entries(layer.props)) out[name] = evaluate(prop, t);
  return out;
}

/** Generate orbit keyframes for a camera: position circles `target` once over [t0, t0+frames]. */
export function orbitKeys({ target = [0, 1, 0], radius = 4, height = 1.2, frames = 120, t0 = 0, startDeg = 0, step = 1, turns = 1 }) {
  const keys = [];
  for (let f = 0; f <= frames; f += step) {
    const a = ((startDeg + (360 * turns * f) / frames) * Math.PI) / 180;
    keys.push({
      t: t0 + f,
      v: [target[0] + radius * Math.sin(a), height, target[2] + radius * Math.cos(a)],
      interp: "linear",
    });
  }
  if (keys[keys.length - 1].t !== t0 + frames) {
    const a = ((startDeg + 360 * turns) * Math.PI) / 180;
    keys.push({ t: t0 + frames, v: [target[0] + radius * Math.sin(a), height, target[2] + radius * Math.cos(a)], interp: "linear" });
  }
  return keys;
}

// ---- scene model ---------------------------------------------------------

let idCounter = 0;
export function newId(prefix = "L") {
  idCounter++;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export const PROP_DEFS = {
  camera: [
    { name: "position", label: "位置", dims: 3, step: 0.01 },
    { name: "target", label: "注視点", dims: 3, step: 0.01 },
    { name: "fov", label: "FOV (°)", dims: 1, step: 0.1, min: 1, max: 170 },
  ],
  splat: [
    { name: "position", label: "位置", dims: 3, step: 0.01 },
    { name: "rotation", label: "回転 (°)", dims: 3, step: 0.5 },
    { name: "scale", label: "スケール", dims: 1, step: 0.01, min: 0.001 },
    { name: "opacity", label: "不透明度", dims: 1, step: 0.01, min: 0, max: 1 },
  ],
};

export function makeCameraLayer() {
  return {
    id: newId("C"), type: "camera", name: "カメラ", visible: true,
    props: {
      position: { value: [0, 1.2, 4.5], keys: [] },
      target: { value: [0, 0.9, 0], keys: [] },
      fov: { value: 35, keys: [] },
    },
  };
}

export function makeSplatLayer(model) {
  return {
    id: newId("S"), type: "splat", name: model.name, visible: true,
    model: { name: model.name, url: model.url, up: model.up ?? [0, 1, 0] },
    props: {
      position: { value: [0, 0, 0], keys: [] },
      rotation: { value: [0, 0, 0], keys: [] },
      scale: { value: 1, keys: [] },
      opacity: { value: 1, keys: [] },
    },
  };
}

export function makeScene() {
  return {
    version: 1,
    comp: { width: 1920, height: 1080, fps: 30, duration: 150, background: "#1b1b1f", workIn: 0, workOut: 149 },
    layers: [makeCameraLayer()],
  };
}

/** Fill in missing fields of a loaded scene (forward/backward compat). */
export function normalizeScene(s) {
  const base = makeScene();
  s.version ??= 1;
  s.comp = { ...base.comp, ...(s.comp || {}) };
  s.layers ??= [];
  if (!s.layers.some((l) => l.type === "camera")) s.layers.unshift(makeCameraLayer());
  for (const l of s.layers) {
    const proto = l.type === "camera" ? makeCameraLayer() : makeSplatLayer(l.model || { name: l.name });
    l.id ??= newId();
    l.visible ??= true;
    l.props ??= {};
    for (const [k, p] of Object.entries(proto.props)) {
      l.props[k] ??= p;
      l.props[k].keys ??= [];
      sortKeys(l.props[k]);
    }
  }
  return s;
}
