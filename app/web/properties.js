// Right sidebar: selected layer's properties, camera orbit helper, composition settings.
import { h, numField } from "./ui.js";
import {
  S, bus, selectedLayer, propValue, isDirty, checkpoint, setPropValue, insertKey, changed, selectLayer, status, comp,
} from "./state.js";
import { PROP_DEFS, hasKeyAt, removeKeyAt, orbitKeys } from "./keyframes.js";

const AXES = ["X", "Y", "Z"];
const LAYER_COLORS = { camera: "var(--cam)", splat: "var(--splat)" };
const SENSOR_H = 24; // mm, full-frame vertical
const fovToMm = (fov) => SENSOR_H / 2 / Math.tan((fov * Math.PI) / 360);
const mmToFov = (mm) => (2 * Math.atan(SENSOR_H / 2 / mm) * 180) / Math.PI;

export const RES_PRESETS = [
  { label: "1920×1080 (16:9)", w: 1920, h: 1080 },
  { label: "1080×1920 (9:16)", w: 1080, h: 1920 },
  { label: "1080×1080 (1:1)", w: 1080, h: 1080 },
  { label: "3840×2160 (4K)", w: 3840, h: 2160 },
  { label: "1280×720", w: 1280, h: 720 },
];

export class PropertiesPanel {
  constructor(el, compEl, { onDeleteLayer, sceneOps }) {
    this.el = el;
    this.compEl = compEl;
    this.onDeleteLayer = onDeleteLayer;
    this.sceneOps = sceneOps;
    this.builtFor = null;
    this.rows = [];
    this.closed = new Set();
    bus.on("change", (what) => this.update(what));
    this.buildComp();
    this.update("load");
  }

  update(what) {
    const l = selectedLayer();
    const sig = l ? `${l.id}:${l.type}` : "none";
    // Undo/redo replaces layer objects, so compare identity as well as id.
    if (sig !== this.builtFor || l !== this.builtLayer || what === "load") { this.builtLayer = l; this.build(l, sig); }
    else this.refresh();
    if (what !== "time") this.refreshComp();
  }

  // ---- layer properties ----
  build(l, sig) {
    this.builtFor = sig;
    this.rows = [];
    this.extra = [];
    if (!l) {
      this.el.replaceChildren(h("div", { class: "p-empty" }, "レイヤーが選択されていません", h("br"), h("span", { class: "dim" }, "タイムラインかビューアでレイヤーを選択")));
      return;
    }
    const nameInput = h("input", { class: "text", value: l.name, spellcheck: false, onkeydown: (e) => e.stopPropagation() });
    nameInput.addEventListener("change", () => { checkpoint("名前変更"); l.name = nameInput.value || l.name; changed("scene"); });
    this.nameInput = nameInput;
    const visBox = h("input", { type: "checkbox", checked: l.visible, title: "表示" });
    visBox.addEventListener("change", () => { checkpoint("表示切替"); l.visible = visBox.checked; changed("scene"); });
    this.visBox = visBox;
    const head = h("div", { class: "p-layer-head" },
      h("span", { class: "swatch", style: { background: LAYER_COLORS[l.type] } }),
      nameInput,
      h("label", { class: "toggle", title: "表示" }, visBox),
      l.type === "splat" ? h("button", { class: "mini danger", title: "レイヤー削除", onclick: () => this.onDeleteLayer(l.id) }, "✕") : null,
    );

    const tf = this.group("transform", l.type === "camera" ? "カメラ" : "トランスフォーム",
      PROP_DEFS[l.type].map((def) => this.propRow(l, def)));
    const parts = [head, tf];

    if (l.type === "camera") {
      // Focal length mirror of FOV.
      const mm = numField({
        value: fovToMm(propValue(l, "fov")), step: 0.1, min: 5, max: 1000, digits: 1,
        onStart: () => checkpoint("焦点距離", `fov:${l.id}`),
        onInput: (v) => setPropValue(l, "fov", mmToFov(v)),
        onCommit: (v) => setPropValue(l, "fov", mmToFov(v)),
      });
      this.extra.push(() => mm.set(fovToMm(propValue(l, "fov"))));
      const mmRow = h("div", { class: "p-row" }, h("span"), h("span", { class: "p-label" }, "焦点距離 mm"), h("div", { class: "p-fields" }, mm.el));
      mm.attachScrub(mmRow.querySelector(".p-label"));
      tf.querySelector(".g-body").append(mmRow);
      parts.push(this.orbitGroup(l));
      parts.push(this.group("camtools", "ツール", [h("div", { class: "p-sub" },
        h("button", { class: "full", onclick: () => this.sceneOps.cameraFromEdit() }, "編集ビューの視点をカメラに設定"),
      )]));
    } else {
      parts.push(this.group("source", "ソース", [h("div", { class: "p-sub" },
        h("label", {}, "モデル"), h("span", { class: "mono" }, l.model?.name ?? "—"),
        h("label", {}, "URL"), h("span", { class: "mono dim", style: { overflow: "hidden", textOverflow: "ellipsis" } }, l.model?.url ?? "—"),
        h("label", {}, "up"), h("span", { class: "mono dim" }, (l.model?.up ?? []).map((x) => (+x).toFixed(3)).join(", ")),
      )]));
    }
    this.el.replaceChildren(...parts);
    this.refresh();
  }

  group(id, title, children) {
    const g = h("div", { class: `p-group${this.closed.has(id) ? " closed" : ""}` },
      h("div", { class: "g-head", onclick: () => { g.classList.toggle("closed"); this.closed[g.classList.contains("closed") ? "add" : "delete"](id); } }, title),
      h("div", { class: "g-body" }, children));
    return g;
  }

  propRow(l, def) {
    const kbtn = h("button", { class: "kbtn", title: "キーフレーム (I)" });
    const label = h("span", { class: "p-label", title: "ドラッグで値を変更 / クリックで選択" }, def.label);
    const fields = [];
    const edit = (i, v) => {
      let val = propValue(l, def.name);
      if (def.dims === 1) val = v; else { val = val.slice(); val[i] = v; }
      setPropValue(l, def.name, val);
    };
    const tag = `${l.id}:${def.name}`;
    for (let i = 0; i < def.dims; i++) {
      const f = numField({
        step: def.step, min: def.min, max: def.max, digits: def.name === "rotation" || def.name === "fov" ? 2 : 3,
        label: def.dims > 1 ? AXES[i] : null, axisClass: AXES[i].toLowerCase(),
        onStart: () => checkpoint(`${def.label} 変更`, tag),
        onInput: (v) => edit(i, v),
        onCommit: (v) => edit(i, v),
      });
      fields.push(f);
    }
    if (def.dims === 1) {
      // Scalar: the row label scrubs.
      fields[0].attachScrub(label);
    } else {
      // Vector: dragging the label scrubs all axes together.
      const all = numField({
        step: def.step, value: 0,
        onStart: () => { checkpoint(`${def.label} 変更`, tag); all.base = propValue(l, def.name); all.set(0); },
        onInput: (d) => setPropValue(l, def.name, all.base.map((x) => x + d)),
        onCommit: () => {},
      });
      all.attachScrub(label);
    }
    label.addEventListener("click", () => selectLayer(l.id, def.name));
    kbtn.addEventListener("click", () => {
      const prop = l.props[def.name];
      if (hasKeyAt(prop, S.time) && !isDirty(l, def.name)) { checkpoint("キー削除"); removeKeyAt(prop, S.time); }
      else { checkpoint("キー追加"); insertKey(l, def.name); }
      selectLayer(l.id, def.name);
      changed("scene");
    });
    const row = h("div", { class: "p-row" }, kbtn, label, h("div", { class: "p-fields" }, fields.map((f) => f.el)));
    this.rows.push({ l, def, row, kbtn, fields });
    return row;
  }

  refresh() {
    const l = selectedLayer();
    if (!l) return;
    if (this.nameInput && document.activeElement !== this.nameInput) this.nameInput.value = l.name;
    if (this.visBox) this.visBox.checked = l.visible;
    for (const r of this.rows) {
      const v = propValue(r.l, r.def.name);
      r.fields.forEach((f, i) => f.set(r.def.dims === 1 ? v : v[i]));
      const prop = r.l.props[r.def.name];
      const animated = prop.keys.length > 0;
      const onKey = hasKeyAt(prop, S.time);
      const dirty = isDirty(r.l, r.def.name);
      r.row.classList.toggle("animated", animated);
      r.row.classList.toggle("onkey", onKey && !dirty);
      r.row.classList.toggle("dirty", dirty);
      r.row.classList.toggle("sel", S.selProp === r.def.name);
      r.kbtn.classList.toggle("animated", animated);
      r.kbtn.classList.toggle("on", onKey);
    }
    for (const fn of this.extra) fn();
  }

  orbitGroup(l) {
    const fld = (value, step, digits = 2, min, max) => numField({ value, step, digits, min, max });
    const pos = propValue(l, "position"), tg = propValue(l, "target");
    const radius = fld(Math.hypot(pos[0] - tg[0], pos[2] - tg[2]) || 4, 0.01, 2, 0.01);
    const height = fld(pos[1], 0.01, 2);
    const frames = fld(comp().workOut - comp().workIn, 1, 0, 1);
    const start = fld(comp().workIn, 1, 0, 0);
    const startDeg = fld((Math.atan2(pos[0] - tg[0], pos[2] - tg[2]) * 180) / Math.PI, 1, 1);
    const step = fld(2, 1, 0, 1, 60);
    const dir = h("select", {}, h("option", { value: "1" }, "反時計回り"), h("option", { value: "-1" }, "時計回り"));
    const fromCurrent = () => {
      const p = propValue(l, "position"), t = propValue(l, "target");
      radius.set(Math.hypot(p[0] - t[0], p[2] - t[2]) || 4);
      height.set(p[1]);
      startDeg.set((Math.atan2(p[0] - t[0], p[2] - t[2]) * 180) / Math.PI);
      frames.set(comp().workOut - comp().workIn);
      start.set(comp().workIn);
    };
    const generate = () => {
      checkpoint("オービット生成");
      const t = propValue(l, "target");
      const keys = orbitKeys({ target: t, radius: radius.get(), height: height.get(), frames: Math.round(frames.get()), t0: Math.round(start.get()), startDeg: startDeg.get(), step: Math.round(step.get()), turns: +dir.value });
      const prop = l.props.position;
      const t0 = keys[0].t, t1 = keys[keys.length - 1].t;
      prop.keys = prop.keys.filter((k) => k.t < t0 || k.t > t1).concat(keys).sort((a, b) => a.t - b.t);
      S.overrides.clear();
      changed("scene");
      status(`360° オービット: ${keys.length} キー (f${t0}–f${t1})`);
    };
    const row = (label, f) => [h("label", {}, label), f.el ?? f];
    return this.group("orbit", "360° オービット生成", [h("div", { class: "p-sub" },
      ...row("半径 r", radius), ...row("高さ h", height), ...row("開始角 °", startDeg),
      ...row("開始 f", start), ...row("長さ N", frames), ...row("キー間隔", step), ...row("方向", dir),
      h("div", { class: "full", style: { display: "flex", gap: "4px" } },
        h("button", { onclick: fromCurrent, title: "現在のカメラ位置から値を取得" }, "現在値から"),
        h("button", { class: "primary", style: { flex: 1 }, onclick: generate }, "キーフレーム生成")),
      h("div", { class: "full dim", style: { fontSize: "10.5px" } }, "注視点を中心に半径 r・高さ h で N フレームかけて一周する位置キーを打ちます（既存の範囲内キーは置換）。"),
    )]);
  }

  // ---- composition ----
  buildComp() {
    const c = () => S.scene.comp;
    const setComp = (k, v, label) => { checkpoint(label, `comp:${k}`); c()[k] = v; changed("comp"); };
    const preset = h("select", { class: "full" }, h("option", { value: "" }, "プリセット…"), RES_PRESETS.map((p, i) => h("option", { value: i }, p.label)));
    preset.addEventListener("change", () => {
      const p = RES_PRESETS[+preset.value]; if (!p) return;
      checkpoint("解像度"); c().width = p.w; c().height = p.h; preset.value = ""; changed("comp");
    });
    const f = {
      width: numField({ step: 2, min: 16, max: 8192, digits: 0, onStart: () => checkpoint("幅", "comp:w"), onCommit: (v) => { c().width = Math.round(v); changed("comp"); }, onInput: (v) => { c().width = Math.round(v); changed("comp"); } }),
      height: numField({ step: 2, min: 16, max: 8192, digits: 0, onStart: () => checkpoint("高さ", "comp:h"), onCommit: (v) => { c().height = Math.round(v); changed("comp"); }, onInput: (v) => { c().height = Math.round(v); changed("comp"); } }),
      fps: numField({ step: 0.1, min: 1, max: 120, digits: 3, onCommit: (v) => setComp("fps", v, "fps") }),
      duration: numField({ step: 1, min: 1, max: 100000, digits: 0, onCommit: (v) => {
        checkpoint("デュレーション"); const d = Math.round(v); c().duration = d;
        c().workOut = Math.min(c().workOut, d - 1); c().workIn = Math.min(c().workIn, c().workOut);
        if (S.time > d - 1) S.time = d - 1; changed("comp");
      } }),
      workIn: numField({ step: 1, min: 0, digits: 0, onCommit: (v) => setComp("workIn", Math.min(Math.round(v), c().workOut), "ワークエリア") }),
      workOut: numField({ step: 1, min: 0, digits: 0, onCommit: (v) => setComp("workOut", Math.max(Math.min(Math.round(v), c().duration - 1), c().workIn), "ワークエリア") }),
    };
    const bg = h("input", { type: "color", class: "color" });
    bg.addEventListener("input", () => setComp("background", bg.value, "背景色"));
    const secs = h("span", { class: "dim mono" });
    this.compFields = { f, bg, secs };
    const lab = (t, el) => [h("label", {}, t), el.el ?? el];
    const sceneSel = h("select", { class: "full" });
    this.sceneSel = sceneSel;
    this.compEl.replaceChildren(
      this.group("comp", "コンポジション設定", [h("div", { class: "p-sub" },
        preset,
        ...lab("幅", f.width), ...lab("高さ", f.height),
        ...lab("フレームレート", f.fps), ...lab("長さ (f)", f.duration),
        h("span"), secs,
        ...lab("ワーク開始", f.workIn), ...lab("ワーク終了", f.workOut),
        ...lab("背景色", bg),
      )]),
      this.group("scenes", "シーンファイル", [h("div", { class: "p-sub" },
        sceneSel,
        h("button", { onclick: () => sceneSel.value && this.sceneOps.load(sceneSel.value) }, "開く"),
        h("button", { onclick: () => this.sceneOps.refreshList() }, "一覧更新"),
        h("button", { class: "full", onclick: () => this.sceneOps.newScene() }, "新規シーン"),
        h("div", { class: "full dim", style: { fontSize: "10.5px" } }, "変更は自動保存されます（scenes/<名前>.json）。名前はメニューバーで変更。"),
      )]),
    );
    for (const [k, fl] of Object.entries(f)) fl.attachScrub?.(fl.el.previousSibling ?? fl.el);
    this.refreshComp();
  }

  setSceneList(names) {
    this.sceneSel.replaceChildren(...names.map((n) => h("option", { value: n, selected: n === S.sceneName }, n)));
  }

  refreshComp() {
    const c = S.scene.comp, { f, bg, secs } = this.compFields;
    for (const k of Object.keys(f)) f[k].set(c[k]);
    if (document.activeElement !== bg) bg.value = c.background;
    secs.textContent = `= ${(c.duration / c.fps).toFixed(2)} 秒`;
  }
}
