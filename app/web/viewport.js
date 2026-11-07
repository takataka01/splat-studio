// three.js + Spark viewport: scene camera view, free edit view, gizmo, export rendering.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import {
  S, bus, propValue, cameraLayer, selectedLayer, checkpoint, setPropValue, changed, status, selectLayer, layerById,
} from "./state.js";

const DEG = Math.PI / 180;
const SUBJECT_HEIGHT = 1.75;
const tick = () => new Promise((r) => {
  let done = false;
  const fin = () => { if (!done) { done = true; r(); } };
  requestAnimationFrame(fin);
  setTimeout(fin, 40);
});

export class Viewport {
  constructor(el) {
    this.el = el;
    this.exporting = false;
    this.renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    this.pixelRatio = Math.min(devicePixelRatio, 2);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.canvas = this.renderer.domElement;
    this.canvas.tabIndex = 0;
    el.prepend(this.canvas);

    this.scene = new THREE.Scene();
    this.spark = new SparkRenderer({ renderer: this.renderer });
    this.scene.add(this.spark);

    this.sceneCam = new THREE.PerspectiveCamera(35, 16 / 9, 0.01, 500);
    this.editCam = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
    this.editCam.position.set(4.5, 3.0, 6.5);
    this.orbit = new OrbitControls(this.editCam, this.canvas);
    this.orbit.target.set(0, 0.9, 0);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.15;

    // Edit-view-only helpers.
    this.helpers = new THREE.Group();
    this.scene.add(this.helpers);
    const grid = new THREE.GridHelper(20, 40, 0x5a5a66, 0x2e2e36);
    grid.material.transparent = true; grid.material.opacity = 0.8;
    this.helpers.add(grid);
    const axes = new THREE.AxesHelper(0.6);
    axes.material.depthTest = false;
    this.helpers.add(axes);
    this.camHelper = new THREE.CameraHelper(this.sceneCam);
    this.helpers.add(this.camHelper);
    this.camProxy = new THREE.Object3D();
    this.scene.add(this.camProxy);
    this.targetProxy = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 8), new THREE.MeshBasicMaterial({ color: 0xc47de8, depthTest: false }));
    this.helpers.add(this.targetProxy);
    this.camLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineDashedMaterial({ color: 0xc47de8, dashSize: 0.05, gapSize: 0.04 }));
    this.helpers.add(this.camLine);
    this.pathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x8a5ab0 }));
    this.helpers.add(this.pathLine);
    this.pathSig = "";

    this.tc = new TransformControls(this.editCam, this.canvas);
    this.tc.setSize(0.8);
    this.tcHelper = this.tc.getHelper();
    this.scene.add(this.tcHelper);
    this.tc.addEventListener("dragging-changed", (e) => {
      this.orbit.enabled = !e.value;
      if (e.value) checkpoint("ギズモ操作");
    });
    this.tc.addEventListener("objectChange", () => this.onGizmo());

    this.objs = new Map(); // layer id -> { group, holder, pivot, mesh, box, url, ready }

    this.frameRect = { x: 0, y: 0, w: 1, h: 1 };
    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
    this.setupPicking();

    bus.on("change", () => this.sync());
    this.renderer.setAnimationLoop(() => this.loop());
  }

  resize() {
    if (this.exporting) return;
    const w = Math.max(1, this.el.clientWidth), h = Math.max(1, this.el.clientHeight);
    this.size = { w, h };
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    this.updateFrameRect();
  }

  updateFrameRect() {
    const { w, h } = this.size;
    const c = S.scene.comp;
    const ca = c.width / c.height;
    const m = 28;
    let fw = w - 2 * m, fh = fw / ca;
    if (fh > h - 2 * m) { fh = h - 2 * m; fw = fh * ca; }
    fw = Math.max(10, fw); fh = Math.max(10, fh);
    this.frameRect = { x: (w - fw) / 2, y: (h - fh) / 2, w: fw, h: fh };
    const sf = document.getElementById("safe-frame");
    if (sf) Object.assign(sf.style, { left: `${this.frameRect.x}px`, top: `${this.frameRect.y}px`, width: `${fw}px`, height: `${fh}px` });
  }

  // ---- layers ----
  sync() {
    const ids = new Set();
    for (const l of S.scene.layers) {
      if (l.type !== "splat") continue;
      ids.add(l.id);
      const o = this.objs.get(l.id);
      const url = l.model?.url;
      if (!o || o.url !== url) { if (o) this.disposeObj(l.id); this.createObj(l); }
    }
    for (const id of [...this.objs.keys()]) if (!ids.has(id)) this.disposeObj(id);
    this.updateFrameRect();
    this.updateGizmo();
    document.getElementById("overlay")?.classList.toggle("edit", S.view === "edit");
  }

  createObj(layer) {
    const group = new THREE.Group();
    const holder = new THREE.Group();
    const pivot = new THREE.Group();
    group.add(holder); holder.add(pivot);
    group.visible = false;
    this.scene.add(group);
    const o = { group, holder, pivot, mesh: null, box: null, url: layer.model?.url, ready: false, failed: false };
    this.objs.set(layer.id, o);
    if (!o.url) { o.failed = true; return o; }
    const mesh = new SplatMesh({ url: o.url });
    o.mesh = mesh;
    pivot.add(mesh);
    o.promise = mesh.initialized.then(() => {
      if (this.objs.get(layer.id) !== o) return;
      this.normalize(o, layer.model.up);
      o.ready = true;
      bus.emit("splat-loaded", layer.id, mesh.numSplats);
      status(`${layer.name}: ${mesh.numSplats.toLocaleString()} splats 読込完了`);
    }).catch((e) => {
      o.failed = true;
      console.error(e);
      status(`モデル読込失敗: ${o.url}`, true);
    });
    return o;
  }

  // Stand the subject upright (model `up` -> +Y), put feet at y=0, centre on XZ,
  // scale to SUBJECT_HEIGHT using percentile bounds (robust to floaters).
  normalize(o, upArr) {
    const up = new THREE.Vector3(...(upArr ?? [0, 1, 0])).normalize();
    o.pivot.quaternion.setFromUnitVectors(up, new THREE.Vector3(0, 1, 0));
    const xs = [], ys = [], zs = [];
    const v = new THREE.Vector3();
    const q = o.pivot.quaternion;
    const stride = Math.max(1, Math.floor(o.mesh.numSplats / 40000));
    o.mesh.forEachSplat((i, center) => {
      if (i % stride) return;
      v.copy(center).applyQuaternion(q);
      xs.push(v.x); ys.push(v.y); zs.push(v.z);
    });
    const pct = (a, p) => a[Math.floor(p * (a.length - 1))];
    [xs, ys, zs].forEach((a) => a.sort((x, y) => x - y));
    const minY = pct(ys, 0.01), maxY = pct(ys, 0.99);
    const cx = pct(xs, 0.5), cz = pct(zs, 0.5);
    const s = SUBJECT_HEIGHT / Math.max(1e-6, maxY - minY);
    o.holder.scale.setScalar(s);
    o.holder.position.set(-cx * s, -minY * s, -cz * s);
    const box = new THREE.Box3(
      new THREE.Vector3((pct(xs, 0.02) - cx) * s, 0, (pct(zs, 0.02) - cz) * s),
      new THREE.Vector3((pct(xs, 0.98) - cx) * s, (maxY - minY) * s, (pct(zs, 0.98) - cz) * s),
    );
    o.localBox = box;
    o.box = new THREE.Box3Helper(box, 0x4a90e2);
    o.box.visible = false;
    o.group.add(o.box);
  }

  disposeObj(id) {
    const o = this.objs.get(id);
    if (!o) return;
    if (this.tc.object === o.group) this.tc.detach();
    this.scene.remove(o.group);
    o.mesh?.dispose?.();
    this.objs.delete(id);
  }

  allReady() {
    return [...this.objs.values()].every((o) => o.ready || o.failed);
  }
  async whenReady() {
    await Promise.all([...this.objs.values()].map((o) => o.promise).filter(Boolean));
  }

  // ---- evaluate the scene at the current time into three objects ----
  apply(t = S.time) {
    for (const l of S.scene.layers) {
      if (l.type === "camera") {
        const p = propValue(l, "position", t), tg = propValue(l, "target", t);
        this.sceneCam.position.set(...p);
        this.sceneCam.up.set(0, 1, 0);
        this.sceneCam.lookAt(new THREE.Vector3(...tg));
        this.sceneCam.fov = propValue(l, "fov", t);
        if (!this.tc.dragging || this.tc.object !== this.camProxy) this.camProxy.position.set(...p);
        if (!this.tc.dragging || this.tc.object !== this.targetProxy) this.targetProxy.position.set(...tg);
        this.camLine.geometry.setFromPoints([new THREE.Vector3(...p), new THREE.Vector3(...tg)]);
        this.camLine.computeLineDistances();
        this.updatePath(l);
        continue;
      }
      const o = this.objs.get(l.id);
      if (!o) continue;
      const p = propValue(l, "position", t), r = propValue(l, "rotation", t), s = propValue(l, "scale", t), a = propValue(l, "opacity", t);
      o.group.position.set(...p);
      o.group.rotation.set(r[0] * DEG, r[1] * DEG, r[2] * DEG, "XYZ");
      o.group.scale.setScalar(Math.max(1e-4, s));
      if (o.mesh) o.mesh.opacity = Math.max(0, Math.min(1, a));
      o.group.visible = o.ready && l.visible && a > 0.001;
      if (o.box) o.box.visible = S.view === "edit" && S.selLayer === l.id && !this.exporting;
    }
    const bg = S.scene.comp.background || "#000000";
    if (!this.scene.background || this._bg !== bg) { this.scene.background = new THREE.Color(bg); this._bg = bg; }
  }

  updatePath(camLayer) {
    const keys = camLayer.props.position.keys;
    const sig = JSON.stringify(keys);
    if (sig === this.pathSig) return;
    this.pathSig = sig;
    if (keys.length < 2) { this.pathLine.visible = false; return; }
    const pts = [];
    const t0 = keys[0].t, t1 = keys[keys.length - 1].t;
    const n = Math.min(400, Math.max(2, (t1 - t0) * 2));
    for (let i = 0; i <= n; i++) pts.push(new THREE.Vector3(...propValue(camLayer, "position", t0 + ((t1 - t0) * i) / n)));
    this.pathLine.geometry.dispose();
    this.pathLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    this.pathLine.visible = true;
  }

  // ---- gizmo ----
  updateGizmo() {
    const l = selectedLayer();
    let target = null;
    if (S.view === "edit" && l && l.visible !== false) {
      if (l.type === "splat") target = this.objs.get(l.id)?.group ?? null;
      else target = S.selProp === "target" ? this.targetProxy : this.camProxy;
    }
    if (target !== this.tc.object) { if (target) this.tc.attach(target); else this.tc.detach(); }
    const mode = l?.type === "camera" ? "translate" : S.gizmoMode;
    if (this.tc.mode !== mode) this.tc.setMode(mode);
  }

  onGizmo() {
    const l = selectedLayer();
    if (!l) return;
    const near = (a, b) => (Array.isArray(a) ? a.every((x, i) => Math.abs(x - b[i]) < 1e-6) : Math.abs(a - b) < 1e-6);
    const set = (name, v) => { if (!near(v, propValue(l, name))) setPropValue(l, name, v, { notify: false }); };
    if (l.type === "splat") {
      const g = this.objs.get(l.id).group;
      set("position", g.position.toArray());
      set("rotation", [g.rotation.x / DEG, g.rotation.y / DEG, g.rotation.z / DEG]);
      const prev = propValue(l, "scale");
      const c = [g.scale.x, g.scale.y, g.scale.z];
      const s = c.reduce((best, x) => (Math.abs(x - prev) > Math.abs(best - prev) ? x : best), prev);
      set("scale", s);
      g.scale.setScalar(s);
    } else {
      if (this.tc.object === this.targetProxy) set("target", this.targetProxy.position.toArray());
      else set("position", this.camProxy.position.toArray());
    }
    changed("scene");
  }

  setupPicking() {
    let down = null;
    this.canvas.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, axis: this.tc.axis }; });
    this.canvas.addEventListener("pointerup", (e) => {
      if (!down || S.view !== "edit" || e.button !== 0) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4;
      const axis = down.axis;
      down = null;
      if (moved || axis) return;
      const rect = this.canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.editCam);
      let best = null;
      for (const l of S.scene.layers) {
        if (l.type !== "splat" || !l.visible) continue;
        const o = this.objs.get(l.id);
        if (!o?.localBox) continue;
        o.group.updateMatrixWorld(true);
        const inv = o.group.matrixWorld.clone().invert();
        const r = ray.ray.clone().applyMatrix4(inv);
        const hit = r.intersectBox(o.localBox, new THREE.Vector3());
        if (hit) {
          const d = hit.applyMatrix4(o.group.matrixWorld).distanceTo(this.editCam.position);
          if (!best || d < best.d) best = { d, id: l.id };
        }
      }
      if (best) selectLayer(best.id);
      else if (S.selLayer && layerById(S.selLayer)?.type === "splat") selectLayer(null);
    });
  }

  frameSelected() {
    const l = selectedLayer();
    const o = l && this.objs.get(l.id);
    let center = new THREE.Vector3(0, 0.9, 0), radius = 1.5;
    if (o?.localBox) {
      const b = o.localBox.clone().applyMatrix4(o.group.matrixWorld);
      b.getCenter(center); radius = b.getSize(new THREE.Vector3()).length() / 2;
    } else if (l?.type === "camera") center = this.camProxy.position.clone();
    const dir = this.editCam.position.clone().sub(this.orbit.target).normalize();
    this.orbit.target.copy(center);
    this.editCam.position.copy(center).addScaledVector(dir, radius * 2.6 + 0.5);
  }

  /** Put the edit camera where the scene camera is. */
  editFromScene() {
    this.editCam.position.copy(this.sceneCam.position);
    const l = cameraLayer();
    this.orbit.target.set(...propValue(l, "target"));
  }

  // ---- per-frame ----
  loop() {
    if (this.exporting) return;
    bus.emit("frame");
    this.apply();
    const { w, h } = this.size;
    const edit = S.view === "edit";
    this.helpers.visible = edit;
    this.tcHelper.visible = edit && !!this.tc.object;
    // Camera helper should show the comp's frustum, not the viewport's.
    const c = S.scene.comp;
    this.sceneCam.aspect = c.width / c.height;
    this.sceneCam.clearViewOffset();
    this.sceneCam.updateProjectionMatrix();
    this.sceneCam.updateMatrixWorld(true);
    this.camHelper.update();
    if (edit) {
      this.orbit.update();
      this.editCam.aspect = w / h;
      this.editCam.updateProjectionMatrix();
      this.renderer.render(this.scene, this.editCam);
    } else {
      // Show the whole canvas with the comp frame centred inside it. Spark
      // ignores setViewOffset, so widen the vertical FOV instead: the comp's
      // vertical extent maps onto the frame rect's height.
      const f = this.frameRect;
      const half = Math.tan((this.sceneCam.fov * DEG) / 2) * (h / f.h);
      this.sceneCam.fov = (2 * Math.atan(half)) / DEG;
      this.sceneCam.aspect = w / h;
      this.sceneCam.updateProjectionMatrix();
      this.renderer.render(this.scene, this.sceneCam);
    }
    const info = document.getElementById("vp-label");
    if (info) info.textContent = edit ? "編集ビュー" : `カメラ · ${c.width}×${c.height} · f${S.time}`;
  }

  // ---- export ----
  beginExport(width, height) {
    this.exporting = true;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.exportSize = { width, height };
    this.helpers.visible = false;
    this.tcHelper.visible = false;
    for (const o of this.objs.values()) if (o.box) o.box.visible = false;
  }

  /** Render frame t at export resolution, waiting for Spark's sort to settle. Returns a PNG Blob. */
  async renderFrame(t) {
    const { width, height } = this.exportSize;
    this.apply(t);
    for (const o of this.objs.values()) if (o.box) o.box.visible = false;
    const cam = this.sceneCam;
    cam.clearViewOffset();
    cam.aspect = width / height;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    const spark = this.spark;
    for (let i = 0; i < 60; i++) {
      this.renderer.render(this.scene, cam);
      await tick();
      const settled = !spark.sorting && !spark.sortDirty && spark.updateTimeoutId === undefined;
      if (i >= 3 && settled) break;
    }
    this.renderer.render(this.scene, cam);
    return await new Promise((res, rej) => this.canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"));
  }

  endExport() {
    this.exporting = false;
    this.resize();
  }
}
