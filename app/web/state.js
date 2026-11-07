// Application state, change notification, undo/redo and value editing.
import {
  makeScene, normalizeScene, evaluate, setValueAtTime, setKey, cloneValue, hasKeyAt,
} from "./keyframes.js";

const listeners = new Map();
export const bus = {
  on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); return () => listeners.get(ev).delete(fn); },
  emit(ev, ...a) { for (const fn of listeners.get(ev) ?? []) { try { fn(...a); } catch (e) { console.error(e); } } },
};

export const S = {
  scene: makeScene(),
  sceneName: "main",
  time: 0,
  playing: false,
  loop: true,
  autoKey: false,
  view: "camera",          // 'camera' | 'edit'
  gizmoMode: "translate",
  selLayer: null,          // layer id
  selProp: null,           // property name on selLayer
  selKeys: new Set(),      // "layerId|prop|t"
  expanded: new Set(),     // layer ids twirled open in the timeline
  overrides: new Map(),    // "layerId|prop" -> un-keyed edited value (dirty)
  clipboard: null,
};

// ---- lookup helpers ----
export const comp = () => S.scene.comp;
export const layers = () => S.scene.layers;
export const layerById = (id) => S.scene.layers.find((l) => l.id === id) ?? null;
export const selectedLayer = () => layerById(S.selLayer);
export const cameraLayer = () => S.scene.layers.find((l) => l.type === "camera");
export const keyId = (layerId, prop, t) => `${layerId}|${prop}|${t}`;
export function parseKeyId(id) { const [l, p, t] = id.split("|"); return { layerId: l, prop: p, t: +t }; }

export function propValue(layer, name, t = S.time) {
  const o = S.overrides.get(`${layer.id}|${name}`);
  if (o !== undefined && t === S.time) return cloneValue(o);
  return evaluate(layer.props[name], t);
}
export const isDirty = (layer, name) => S.overrides.has(`${layer.id}|${name}`);

// ---- change notification ----
let saveTimer = null;
export let onAutosave = null;
export function setAutosaveHandler(fn) { onAutosave = fn; }

/** Notify that the document changed (re-render everything, schedule autosave). */
export function changed(what = "scene") {
  bus.emit("change", what);
  if (what === "scene" || what === "comp") {
    clearTimeout(saveTimer);
    bus.emit("dirty-doc");
    saveTimer = setTimeout(() => onAutosave?.(), 1200);
  }
}

// ---- undo / redo (whole-document snapshots) ----
const undoStack = [];
const redoStack = [];
const MAX_UNDO = 150;
let lastLabel = null, lastTime = 0;

function snapshot() { return JSON.stringify(S.scene); }

/**
 * Record the current document before a mutation. Calls with the same
 * `coalesce` tag within 600 ms collapse into one undo step (for scrubbing).
 */
export function checkpoint(label = "edit", coalesce = null) {
  const now = performance.now();
  if (coalesce && coalesce === lastLabel && now - lastTime < 600) { lastTime = now; return; }
  undoStack.push({ label, json: snapshot() });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
  lastLabel = coalesce; lastTime = now;
  bus.emit("history");
}
export function undo() {
  const e = undoStack.pop();
  if (!e) return false;
  redoStack.push({ label: e.label, json: snapshot() });
  restore(e.json);
  lastLabel = null;
  bus.emit("history");
  status(`元に戻す: ${e.label}`);
  return true;
}
export function redo() {
  const e = redoStack.pop();
  if (!e) return false;
  undoStack.push({ label: e.label, json: snapshot() });
  restore(e.json);
  lastLabel = null;
  bus.emit("history");
  status(`やり直し: ${e.label}`);
  return true;
}
export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;
function restore(json) {
  S.scene = normalizeScene(JSON.parse(json));
  S.overrides.clear();
  if (!layerById(S.selLayer)) { S.selLayer = null; S.selProp = null; }
  pruneSelection();
  changed("scene");
}

/** Replace the whole document (load / new). Clears history. */
export function loadScene(scene, name) {
  S.scene = normalizeScene(scene);
  if (name) S.sceneName = name;
  S.overrides.clear(); S.selKeys.clear();
  S.selLayer = null; S.selProp = null;
  undoStack.length = 0; redoStack.length = 0;
  S.time = Math.min(S.time, S.scene.comp.duration - 1);
  bus.emit("history");
  bus.emit("change", "load");
}

export function pruneSelection() {
  for (const id of [...S.selKeys]) {
    const { layerId, prop, t } = parseKeyId(id);
    const l = layerById(layerId);
    if (!l || !l.props[prop] || !hasKeyAt(l.props[prop], t)) S.selKeys.delete(id);
  }
}

// ---- time ----
export function setTime(t, { keepOverrides = false } = {}) {
  const c = S.scene.comp;
  t = Math.max(0, Math.min(c.duration - 1, Math.round(t)));
  if (t === S.time) return;
  S.time = t;
  if (!keepOverrides) S.overrides.clear();
  bus.emit("change", "time");
}

// ---- selection ----
export function selectLayer(id, prop = null) {
  S.selLayer = id; S.selProp = prop;
  bus.emit("change", "select");
}

// ---- editing ----
/**
 * Edit a property value "at the current time" honouring the auto-key toggle.
 * The caller is responsible for checkpoint() (so drags can coalesce).
 */
export function setPropValue(layer, name, v, { notify = true } = {}) {
  const prop = layer.props[name];
  const r = setValueAtTime(prop, S.time, v, { autoKey: S.autoKey });
  const k = `${layer.id}|${name}`;
  if (r.dirty) S.overrides.set(k, cloneValue(v)); else S.overrides.delete(k);
  if (notify) changed("scene");
  return r;
}

/** Insert a key at the current frame with the current (possibly dirty) value. */
export function insertKey(layer, name) {
  const v = propValue(layer, name);
  setKey(layer.props[name], S.time, v);
  S.overrides.delete(`${layer.id}|${name}`);
}

// ---- status line ----
export function status(msg, isError = false) {
  const el = document.getElementById("status-msg");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("err", !!isError);
}

export function fmtNum(v, digits = 3) {
  if (Array.isArray(v)) return v.map((x) => fmtNum(x, digits)).join(", ");
  const s = (+v).toFixed(digits);
  return s.replace(/\.?0+$/, "") || "0";
}
