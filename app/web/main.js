// Splat Studio entry point: wires panels together, hotkeys, playback, persistence.
import { Viewport } from "./viewport.js";
import { Timeline } from "./timeline.js";
import { PropertiesPanel } from "./properties.js";
import { PipelinePanel, MODEL_MIME } from "./pipeline.js";
import { RenderQueue } from "./render.js";
import { setupTabs, activateTab, hideMenu } from "./ui.js";
import { api } from "./api.js";
import {
  S, bus, changed, checkpoint, undo, redo, canUndo, canRedo, setTime, selectLayer, selectedLayer, layerById,
  insertKey, keyId, parseKeyId, status, loadScene, setAutosaveHandler, pruneSelection, propValue, setPropValue,
} from "./state.js";
import {
  makeScene, makeSplatLayer, PROP_DEFS, removeKeyAt, setKey, hasKeyAt, prevKeyTime, nextKeyTime,
} from "./keyframes.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const SELFTEST = params.has("selftest");

// ---------------------------------------------------------------- actions
const actions = {
  addModel(m, { undoable = true } = {}) {
    if (undoable) checkpoint("レイヤー追加");
    const l = makeSplatLayer(m);
    const n = S.scene.layers.filter((x) => x.type === "splat").length;
    if (n) l.props.position.value = [n * 0.8, 0, 0];
    S.scene.layers.push(l);
    S.expanded.add(l.id);
    S.selLayer = l.id; S.selProp = null;
    changed("scene");
    status(`レイヤー追加: ${m.name}`);
    return l;
  },
  deleteLayer(id) {
    const l = layerById(id);
    if (!l || l.type === "camera") return;
    checkpoint("レイヤー削除");
    S.scene.layers = S.scene.layers.filter((x) => x.id !== id);
    if (S.selLayer === id) { S.selLayer = null; S.selProp = null; }
    pruneSelection();
    changed("scene");
  },
  targetProps() {
    const l = selectedLayer();
    if (!l) return [null, []];
    if (S.selProp) return [l, [S.selProp]];
    const transform = l.type === "camera" ? ["position", "target", "fov"] : ["position", "rotation", "scale"];
    return [l, transform];
  },
  insertKeys() {
    const [l, names] = actions.targetProps();
    if (!l) return status("レイヤーを選択してください", true);
    checkpoint("キー挿入");
    for (const n of names) insertKey(l, n);
    changed("scene");
    status(`キー挿入: ${l.name} / ${names.join(", ")} @ f${S.time}`);
  },
  deleteKeysHere() {
    const [l, names] = actions.targetProps();
    if (!l) return;
    if (!names.some((n) => hasKeyAt(l.props[n], S.time))) return;
    checkpoint("キー削除");
    for (const n of names) {
      const p = l.props[n];
      // Removing the last key bakes the value so the property doesn't jump.
      if (p.keys.length === 1 && p.keys[0].t === S.time) p.value = Array.isArray(p.keys[0].v) ? p.keys[0].v.slice() : p.keys[0].v;
      removeKeyAt(p, S.time);
      S.overrides.delete(`${l.id}|${n}`);
    }
    pruneSelection();
    changed("scene");
  },
  deleteSelectedKeys() {
    if (!S.selKeys.size) return false;
    checkpoint("キー削除");
    for (const id of S.selKeys) {
      const { layerId, prop, t } = parseKeyId(id);
      const l = layerById(layerId);
      if (!l) continue;
      const p = l.props[prop];
      // Removing the last key bakes the value so the property doesn't jump.
      if (p.keys.length === 1 && p.keys[0].t === t) p.value = Array.isArray(p.keys[0].v) ? p.keys[0].v.slice() : p.keys[0].v;
      removeKeyAt(p, t);
    }
    S.selKeys.clear();
    changed("scene");
    return true;
  },
  setInterp(ip) {
    if (!S.selKeys.size) return;
    checkpoint("補間変更");
    for (const id of S.selKeys) {
      const { layerId, prop, t } = parseKeyId(id);
      const k = layerById(layerId)?.props[prop]?.keys.find((x) => x.t === t);
      if (k) k.interp = ip;
    }
    changed("scene");
  },
  copyKeys() {
    if (!S.selKeys.size) return;
    const items = [];
    for (const id of S.selKeys) {
      const { layerId, prop, t } = parseKeyId(id);
      const k = layerById(layerId)?.props[prop]?.keys.find((x) => x.t === t);
      if (k) items.push({ layerId, prop, t, v: structuredClone(k.v), interp: k.interp });
    }
    const minT = Math.min(...items.map((i) => i.t));
    S.clipboard = items.map((i) => ({ ...i, dt: i.t - minT }));
    status(`${items.length} キーをコピー`);
  },
  pasteKeys() {
    const clip = S.clipboard;
    if (!clip?.length) return;
    const layersInClip = new Set(clip.map((c) => c.layerId));
    const sel = selectedLayer();
    checkpoint("キーペースト");
    const newSel = new Set();
    for (const c of clip) {
      let l = layerById(c.layerId);
      // Single-layer clipboard pastes onto the selected layer if compatible.
      if (layersInClip.size === 1 && sel && sel.props[c.prop]) l = sel;
      if (!l?.props[c.prop]) continue;
      const t = Math.min(S.scene.comp.duration - 1, S.time + c.dt);
      setKey(l.props[c.prop], t, c.v, c.interp);
      newSel.add(keyId(l.id, c.prop, t));
    }
    S.selKeys = newSel;
    S.overrides.clear();
    changed("scene");
    status(`${newSel.size} キーをペースト @ f${S.time}`);
  },
  jumpKey(dir) {
    const l = selectedLayer();
    const src = l ? [l] : S.scene.layers;
    const times = src.flatMap((x) => Object.entries(x.props).filter(([n]) => !l || !S.selProp || n === S.selProp).flatMap(([, p]) => p.keys.map((k) => k.t)));
    const t = dir < 0 ? prevKeyTime(times, S.time) : nextKeyTime(times, S.time);
    if (t !== null) setTime(t);
  },
  togglePlay() {
    S.playing = !S.playing;
    playClock = null;
    if (S.playing) {
      const c = S.scene.comp;
      if (S.loop && (S.time < c.workIn || S.time >= c.workOut)) setTime(c.workIn);
    }
    bus.emit("change", "time");
  },
  setView(v) {
    S.view = v;
    document.querySelectorAll("#view-mode button").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
    changed("ui");
  },
  setGizmo(mode) {
    S.gizmoMode = mode;
    document.querySelectorAll("#gizmo-mode button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    changed("ui");
  },
  cameraFromEdit() {
    const cam = S.scene.layers.find((l) => l.type === "camera");
    checkpoint("カメラを編集ビューに合わせる");
    S.overrides.clear();
    setPropValue(cam, "position", vp.editCam.position.toArray(), { notify: false });
    setPropValue(cam, "target", vp.orbit.target.toArray(), { notify: false });
    changed("scene");
    status("カメラを編集ビューの視点に設定しました");
  },
};

// ---------------------------------------------------------------- panels
const vp = new Viewport($("viewport"));
const timeline = new Timeline($("timeline"), actions);
const sceneOps = {
  load: (name) => openScene(name),
  refreshList: () => refreshSceneList(),
  newScene: () => {
    const name = prompt("新しいシーン名", `scene${Date.now().toString(36).slice(-4)}`);
    if (!name) return;
    S.sceneName = name.replace(/[^\w.-]+/g, "_");
    $("scene-name").value = S.sceneName;
    loadScene(makeScene(), S.sceneName);
    save();
  },
  cameraFromEdit: () => actions.cameraFromEdit(),
};
const props = new PropertiesPanel($("props"), $("comp"), { onDeleteLayer: (id) => actions.deleteLayer(id), sceneOps });
const pipeline = new PipelinePanel($("left"), {
  onAddModel: (m) => actions.addModel(m),
  onModels: (models) => { S.models = models; },
});
const renderQueue = new RenderQueue($("render"), vp, { beforeRender: () => { S.playing = false; } });

for (const id of ["left", "right", "bottom"]) setupTabs($(id));

// ---------------------------------------------------------------- menubar & viewport header
$("btn-undo").onclick = () => undo();
$("btn-redo").onclick = () => redo();
bus.on("history", () => { $("btn-undo").disabled = !canUndo(); $("btn-redo").disabled = !canRedo(); });
$("autokey").addEventListener("change", (e) => { S.autoKey = e.target.checked; status(S.autoKey ? "自動キー: ON" : "自動キー: OFF"); });
$("btn-help").onclick = () => $("help").classList.remove("hidden");
$("help-close").onclick = () => $("help").classList.add("hidden");
$("help").addEventListener("click", (e) => { if (e.target === $("help")) $("help").classList.add("hidden"); });
document.querySelectorAll("#view-mode button").forEach((b) => (b.onclick = () => actions.setView(b.dataset.view)));
document.querySelectorAll("#gizmo-mode button").forEach((b) => (b.onclick = () => actions.setGizmo(b.dataset.mode)));
$("show-guides").addEventListener("change", (e) => $("overlay").classList.toggle("noguides", !e.target.checked));
$("scene-name").addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") e.target.blur(); });
$("scene-name").addEventListener("change", (e) => {
  S.sceneName = e.target.value.trim().replace(/[^\w.-]+/g, "_") || "main";
  e.target.value = S.sceneName;
  save();
});
$("btn-save").onclick = () => save();

// Viewport info.
bus.on("change", () => {
  const c = S.scene.comp;
  $("viewport-info").textContent = `${c.width}×${c.height} · ${c.fps}fps · ${c.duration}f`;
  document.title = `${S.sceneName} — Splat Studio`;
});

// Drag & drop models onto viewport / timeline.
for (const target of [$("viewport"), $("timeline")]) {
  target.addEventListener("dragover", (e) => {
    if (![...e.dataTransfer.types].includes(MODEL_MIME)) return;
    e.preventDefault(); e.dataTransfer.dropEffect = "copy";
    $("viewport").classList.add("dragover");
  });
  target.addEventListener("dragleave", () => $("viewport").classList.remove("dragover"));
  target.addEventListener("drop", (e) => {
    $("viewport").classList.remove("dragover");
    const data = e.dataTransfer.getData(MODEL_MIME);
    if (!data) return;
    e.preventDefault();
    actions.addModel(JSON.parse(data));
  });
}

// ---------------------------------------------------------------- playback
let playClock = null;
bus.on("frame", () => {
  if (!S.playing) { playClock = null; return; }
  const now = performance.now();
  if (playClock === null) { playClock = { t0: now, f0: S.time }; return; }
  const c = S.scene.comp;
  let f = playClock.f0 + Math.floor(((now - playClock.t0) / 1000) * c.fps);
  const end = S.loop ? c.workOut : c.duration - 1;
  if (f > end) {
    if (S.loop) { f = c.workIn; playClock = { t0: now, f0: f }; }
    else { f = end; S.playing = false; }
  }
  if (f !== S.time) setTime(f); else if (!S.playing) bus.emit("change", "time");
});

// ---------------------------------------------------------------- hotkeys
function isTyping(e) {
  const t = e.target;
  return t instanceof HTMLInputElement && !["checkbox", "range", "button"].includes(t.type) || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t?.isContentEditable;
}
addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); save(); return; }
  if (isTyping(e)) return;
  if (!$("help").classList.contains("hidden")) { if (e.key === "Escape") $("help").classList.add("hidden"); return; }
  const k = e.key;
  const c = S.scene.comp;
  let handled = true;
  if (mod && k.toLowerCase() === "z") { if (e.shiftKey) redo(); else undo(); }
  else if (mod && k.toLowerCase() === "y") redo();
  else if (mod && k.toLowerCase() === "c") actions.copyKeys();
  else if (mod && k.toLowerCase() === "v") actions.pasteKeys();
  else if (mod) handled = false;
  else if (k === " ") actions.togglePlay();
  else if (k === "ArrowLeft") setTime(S.time - (e.shiftKey ? 10 : 1));
  else if (k === "ArrowRight") setTime(S.time + (e.shiftKey ? 10 : 1));
  else if (k === "ArrowUp") actions.jumpKey(-1);
  else if (k === "ArrowDown") actions.jumpKey(1);
  else if (k === "Home") setTime(e.shiftKey ? c.workIn : 0);
  else if (k === "End") setTime(e.shiftKey ? c.workOut : c.duration - 1);
  else if ((k === "i" || k === "I" || e.code === "KeyI") && e.altKey) actions.deleteKeysHere();
  else if (k === "i" || k === "I") actions.insertKeys();
  else if (k === "Delete" || k === "Backspace") { if (!actions.deleteSelectedKeys() && S.selLayer) actions.deleteLayer(S.selLayer); }
  else if (k === "F9") actions.setInterp("ease");
  else if (k === "Tab") actions.setView(S.view === "camera" ? "edit" : "camera");
  else if (e.code === "Numpad0") actions.setView("camera");
  else if (k === "g" || k === "G") actions.setGizmo("translate");
  else if (k === "r" || k === "R") actions.setGizmo("rotate");
  else if (k === "s" || k === "S") actions.setGizmo("scale");
  else if (k === "f" || k === "F") { if (S.view === "edit") vp.frameSelected(); }
  else if (k === "b" || k === "B") { checkpoint("ワークエリア"); c.workIn = Math.min(S.time, c.workOut); changed("comp"); }
  else if (k === "n" || k === "N") { checkpoint("ワークエリア"); c.workOut = Math.max(S.time, c.workIn); changed("comp"); }
  else if (k === "Escape") { hideMenu(); S.selKeys.clear(); bus.emit("change", "select-keys"); }
  else handled = false;
  if (handled) e.preventDefault();
});

// ---------------------------------------------------------------- persistence
let saving = false, lastSavedJson = null, backendScenes = true;
const saveStatus = (t, cls = "dim") => { const el = $("save-status"); el.textContent = t; el.className = cls; };
bus.on("dirty-doc", () => saveStatus("未保存", "dim"));
setAutosaveHandler(() => save(true));

async function save(auto = false) {
  if (SELFTEST && S.sceneName === "main") S.sceneName = "selftest";
  const json = JSON.stringify(S.scene);
  if (auto && json === lastSavedJson) return saveStatus("保存済み");
  if (saving) { setTimeout(() => save(auto), 400); return; }
  saving = true;
  try {
    if (backendScenes) await api.putScene(S.sceneName, S.scene);
    else localStorage.setItem(`splat-studio:${S.sceneName}`, json);
    lastSavedJson = json;
    saveStatus(`保存済み ${new Date().toLocaleTimeString()}`);
    if (!auto) status(`シーン「${S.sceneName}」を保存しました`);
  } catch (e) {
    try { localStorage.setItem(`splat-studio:${S.sceneName}`, json); } catch {}
    saveStatus("保存失敗（ローカルに退避）", "err");
    status(`保存失敗: ${e.message}`, true);
  } finally { saving = false; }
}

async function refreshSceneList() {
  let names = [];
  try { names = await api.scenes(); backendScenes = true; }
  catch { backendScenes = false; names = Object.keys(localStorage).filter((k) => k.startsWith("splat-studio:")).map((k) => k.slice(13)); }
  props.setSceneList(names.includes(S.sceneName) ? names : [S.sceneName, ...names]);
  return names;
}

async function openScene(name) {
  let data = null;
  try { data = backendScenes ? await api.getScene(name) : JSON.parse(localStorage.getItem(`splat-studio:${name}`)); }
  catch (e) { status(`シーンを開けません: ${e.message}`, true); return false; }
  // Files without a layer list aren't documents of ours (e.g. API test stubs).
  if (!data || !Array.isArray(data.layers)) return false;
  S.sceneName = name;
  $("scene-name").value = name;
  loadScene(data, name);
  S.expanded = new Set(S.scene.layers.map((l) => l.id));
  lastSavedJson = JSON.stringify(S.scene);
  saveStatus("読込済み");
  status(`シーン「${name}」を開きました`);
  bus.emit("change", "load");
  return true;
}

// ---------------------------------------------------------------- boot
async function boot() {
  const want = params.get("scene") || (SELFTEST ? "selftest" : "main");
  S.sceneName = want;
  $("scene-name").value = want;
  const names = await refreshSceneList();
  let opened = false;
  if (names.includes(want) && !SELFTEST) opened = await openScene(want);
  if (!opened) {
    loadScene(makeScene(), want);
    S.expanded = new Set(S.scene.layers.map((l) => l.id));
    // First run: drop the first available model into the scene.
    let models = [];
    try { models = await api.models(); } catch {}
    if (models.length) actions.addModel(models[0], { undoable: false });
    saveStatus("新規");
  }
  selectLayer(S.scene.layers.find((l) => l.type === "splat")?.id ?? S.scene.layers[0].id);
  bus.emit("history");
  changed("ui");
  status("準備完了");
  if (SELFTEST) selftest();
}

// Self-test: keyframe a splat, verify evaluation + undo, render 3 frames through the API.
async function selftest() {
  const result = { steps: [] };
  const log = (m) => { result.steps.push(m); console.log("[selftest]", m); };
  window.__selftest = result;
  try {
    const l = S.scene.layers.find((x) => x.type === "splat");
    if (!l) throw new Error("no splat layer (no models?)");
    await vp.whenReady();
    log(`splat ready: ${vp.objs.get(l.id)?.mesh?.numSplats} splats`);
    selectLayer(l.id, "position");
    setTime(0);
    const before = JSON.stringify(l.props.position);
    // Use the same paths as the UI: set value, press I.
    checkpoint("selftest");
    l.props.position.value = [-0.6, 0, 0];
    actions.insertKeys();
    setTime(2);
    S.autoKey = true;
    setPropValue(l, "position", [0.6, 0, 0]);
    S.autoKey = false;
    const mid = propValue(l, "position", 1);
    log(`keys: ${l.props.position.keys.map((k) => `f${k.t}=${k.v[0]}`).join(" ")}; f1.x=${mid[0].toFixed(3)}`);
    if (l.props.position.keys.length !== 2 || Math.abs(mid[0]) > 1e-6) throw new Error("keyframe evaluation mismatch");
    // Undo/redo round-trip.
    undo(); undo();
    const afterUndo = layerById(l.id).props.position.keys.length;
    redo(); redo();
    const l2 = layerById(l.id);
    log(`undo→${afterUndo} keys, redo→${l2.props.position.keys.length} keys (before: ${JSON.parse(before).keys.length})`);
    if (l2.props.position.keys.length !== 2) throw new Error("undo/redo mismatch");
    // Ease on the first key, small camera move for visible motion.
    // (undo/redo replaced the layer objects, so look the camera up now)
    const cam = S.scene.layers.find((x) => x.type === "camera");
    S.selKeys = new Set([keyId(l2.id, "position", 0)]);
    actions.setInterp("ease");
    setKey(cam.props.fov, 0, 30); setKey(cam.props.fov, 2, 40);
    S.scene.comp.workIn = 0; S.scene.comp.workOut = 2;
    changed("comp");
    timeline.draw();
    activateTab($("bottom"), "render");
    const item = renderQueue.enqueue({ name: "selftest", width: 320, height: 180, fps: S.scene.comp.fps, from: 0, to: 2, frames: 3, format: "mp4" });
    await renderQueue.wait(item);
    log(`render: ${item.state} file=${item.file} error=${item.error ?? ""}`);
    result.ok = item.state === "done";
  } catch (e) {
    result.ok = false; result.error = e.message;
    console.error("[selftest] FAILED", e);
  }
  document.body.dataset.selftest = result.ok ? "pass" : "fail";
  console.log("[selftest] result", JSON.stringify(result));
}

window.studio = { S, vp, timeline, props, pipeline, renderQueue, actions };
boot();
