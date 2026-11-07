// Bottom timeline: transport, ruler, work area, layer rows, property rows, keyframes.
import { h, showMenu } from "./ui.js";
import {
  S, bus, layerById, selectLayer, setTime, checkpoint, changed, keyId, parseKeyId, propValue, isDirty, insertKey, fmtNum, status, pruneSelection,
} from "./state.js";
import { PROP_DEFS, hasKeyAt, removeKeyAt, moveKeys, INTERPS, prevKeyTime, nextKeyTime } from "./keyframes.js";

const ROW = 20;
const PAD = 10; // px left padding inside track area
const INTERP_LABEL = { linear: "リニア", ease: "イーズ (イン/アウト)", hold: "停止 (ホールド)" };
const COLORS = { camera: "#c47de8", splat: "#4ab0c4" };

export class Timeline {
  constructor(el, actions) {
    this.el = el;
    this.actions = actions; // { togglePlay, deleteSelectedKeys, setInterp, copyKeys, pasteKeys }
    this.ppf = null; // pixels per frame (null = fit)
    this.start = 0;  // first visible frame (may be fractional)
    this.build();
    bus.on("change", (what) => this.onChange(what));
    new ResizeObserver(() => this.resize()).observe(this.right);
  }

  build() {
    const btn = (label, title, fn, cls = "") => h("button", { class: `mini ${cls}`, title, onclick: fn }, label);
    this.tc = h("input", { class: "tc", spellcheck: false, title: "現在のフレーム" });
    this.tc.addEventListener("keydown", (e) => { if (e.key === "Enter") this.tc.blur(); e.stopPropagation(); });
    this.tc.addEventListener("change", () => { const v = parseInt(this.tc.value, 10); if (Number.isFinite(v)) setTime(v); this.updateTc(); });
    this.durLabel = h("span", { class: "dim mono" });
    this.playBtn = btn("▶", "再生 / 停止 (Space)", () => this.actions.togglePlay());
    this.loopBox = h("input", { type: "checkbox", checked: S.loop });
    this.loopBox.addEventListener("change", () => { S.loop = this.loopBox.checked; });
    this.zoom = h("input", { type: "range", min: 0, max: 100, value: 0, title: "ズーム (Ctrl+ホイール)" });
    this.zoom.addEventListener("input", () => this.setZoomFromSlider());
    this.interpBtns = INTERPS.map((ip) => btn(INTERP_LABEL[ip].split(" ")[0], `選択キーを ${INTERP_LABEL[ip]} に`, () => this.actions.setInterp(ip)));
    this.selInfo = h("span", { class: "dim" });
    const toolbar = h("div", { class: "tl-toolbar" },
      btn("⏮", "先頭 (Home)", () => setTime(0)),
      btn("◀|", "前のキー (↑)", () => this.actions.jumpKey(-1)),
      btn("◀", "前のフレーム (←)", () => setTime(S.time - 1)),
      this.playBtn,
      btn("▶", "次のフレーム (→)", () => setTime(S.time + 1)),
      btn("|▶", "次のキー (↓)", () => this.actions.jumpKey(1)),
      btn("⏭", "末尾 (End)", () => setTime(S.scene.comp.duration - 1)),
      h("label", { class: "toggle", title: "ループ再生（ワークエリア）" }, this.loopBox, h("span", {}, "ループ")),
      h("span", { class: "sep" }),
      this.tc, this.durLabel,
      h("span", { class: "sep" }),
      h("span", { class: "dim" }, "補間"), ...this.interpBtns, this.selInfo,
      h("span", { class: "spacer" }),
      h("span", { class: "dim" }, "ズーム"), this.zoom,
      btn("全体", "全体を表示", () => { this.ppf = null; this.start = 0; this.zoom.value = 0; this.draw(); }),
    );

    this.rowsInner = h("div", { class: "tl-rows-inner" });
    this.rowsEl = h("div", { class: "tl-rows" }, this.rowsInner);
    this.rowsEl.addEventListener("wheel", (e) => { this.tracksWrap.scrollTop += e.deltaY; e.preventDefault(); }, { passive: false });
    const left = h("div", { class: "tl-left" },
      h("div", { class: "tl-left-head" }, h("span", { style: { width: "18px" } }, "👁"), h("span", { style: { width: "36px" } }, "#"), h("span", {}, "レイヤー名 / プロパティ")),
      this.rowsEl);

    this.ruler = h("canvas", { class: "tl-ruler" });
    this.tracks = h("canvas", { class: "tl-tracks" });
    this.tracksWrap = h("div", { class: "tl-tracks-wrap" }, this.tracks);
    this.tracksWrap.addEventListener("scroll", () => { this.rowsInner.style.transform = `translateY(${-this.tracksWrap.scrollTop}px)`; });
    this.right = h("div", { class: "tl-right" }, this.ruler, this.tracksWrap);
    this.el.replaceChildren(toolbar, h("div", { class: "tl-main" }, left, this.right));

    this.setupRuler();
    this.setupTracks();
    this.right.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
  }

  // ---- geometry ----
  get width() { return this.right.clientWidth; }
  fitPpf() { return Math.max(0.05, (this.width - 2 * PAD) / Math.max(1, S.scene.comp.duration)); }
  get scale() { return this.ppf ?? this.fitPpf(); }
  x(t) { return PAD + (t - this.start) * this.scale; }
  frameAt(x) { return (x - PAD) / this.scale + this.start; }
  clampStart() {
    const vis = (this.width - 2 * PAD) / this.scale;
    this.start = Math.max(0, Math.min(this.start, Math.max(0, S.scene.comp.duration - vis)));
  }
  setZoomFromSlider() {
    const z = +this.zoom.value / 100;
    const fit = this.fitPpf();
    const center = this.frameAt(this.x(S.time));
    this.ppf = z === 0 ? null : fit * Math.pow(Math.max(1.0001, 60 / fit), z);
    const vis = (this.width - 2 * PAD) / this.scale;
    this.start = center - vis / 2;
    this.clampStart();
    this.draw();
  }
  onWheel(e) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const rect = this.right.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const f = this.frameAt(mx);
      const fit = this.fitPpf();
      let s = this.scale * Math.exp(-e.deltaY * 0.002);
      s = Math.max(fit, Math.min(60, s));
      this.ppf = s <= fit * 1.0001 ? null : s;
      this.start = f - (mx - PAD) / this.scale;
      this.clampStart();
      this.zoom.value = this.ppf ? Math.round(100 * Math.log(this.ppf / fit) / Math.log(Math.max(1.0001, 60 / fit))) : 0;
      this.draw();
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      this.start += (e.deltaX || e.deltaY) / this.scale;
      this.clampStart();
      this.draw();
    }
  }

  resize() {
    const dpr = devicePixelRatio || 1;
    const w = this.width;
    this.ruler.width = w * dpr; this.ruler.height = 26 * dpr; this.ruler.style.width = `${w}px`; this.ruler.style.height = "26px";
    this.clampStart();
    this.layoutTracks();
    this.draw();
  }
  layoutTracks() {
    const dpr = devicePixelRatio || 1;
    const w = this.width;
    const hgt = Math.max(this.rows.length * ROW, this.tracksWrap.clientHeight);
    this.tracks.width = w * dpr; this.tracks.height = hgt * dpr;
    this.tracks.style.width = `${w}px`; this.tracks.style.height = `${hgt}px`;
  }

  // ---- rows ----
  get rows() {
    const out = [];
    S.scene.layers.forEach((l, i) => {
      out.push({ kind: "layer", layer: l, index: i + 1 });
      if (S.expanded.has(l.id)) for (const def of PROP_DEFS[l.type]) out.push({ kind: "prop", layer: l, def });
    });
    return out;
  }

  onChange(what) {
    if (what === "time" || what === "select-keys") { this.updateValues(); this.draw(); return; }
    this.buildRows();
    this.layoutTracks();
    this.draw();
  }

  buildRows() {
    const rows = this.rows;
    this.rowEls = [];
    const els = rows.map((r) => {
      const l = r.layer;
      if (r.kind === "layer") {
        const open = S.expanded.has(l.id);
        const name = h("span", { class: "lname" }, l.name);
        name.addEventListener("dblclick", (e) => {
          e.stopPropagation();
          const inp = h("input", { class: "text", value: l.name, style: { flex: 1, height: "16px" } });
          name.replaceWith(inp); inp.focus(); inp.select();
          const done = () => { if (inp.value && inp.value !== l.name) { checkpoint("名前変更"); l.name = inp.value; } changed("scene"); };
          inp.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Enter") inp.blur(); if (ev.key === "Escape") { inp.value = l.name; inp.blur(); } });
          inp.addEventListener("blur", done);
        });
        const el = h("div", { class: `tl-row layer${S.selLayer === l.id && !S.selProp ? " sel" : S.selLayer === l.id ? " sel" : ""}`, onclick: () => selectLayer(l.id) },
          h("button", { class: `eye${l.visible ? "" : " off"}`, title: "表示切替", onclick: (e) => { e.stopPropagation(); checkpoint("表示切替"); l.visible = !l.visible; changed("scene"); } }, "●"),
          h("button", { class: "twirl", title: "プロパティを展開", onclick: (e) => { e.stopPropagation(); S.expanded[open ? "delete" : "add"](l.id); changed("ui"); } }, open ? "▼" : "▶"),
          h("span", { class: "lcolor", style: { background: COLORS[l.type] } }),
          h("span", { class: "lidx" }, r.index),
          name,
          h("span", { class: "ltype" }, l.type === "camera" ? "カメラ" : "スプラット"),
        );
        el.addEventListener("contextmenu", (e) => { e.preventDefault(); this.layerMenu(e, l); });
        return el;
      }
      const def = r.def, prop = l.props[def.name];
      const watch = h("button", { class: `watch${prop.keys.length ? " on" : ""}`, title: "ストップウォッチ: アニメーションの有効 / 無効" }, "⏱");
      watch.addEventListener("click", (e) => {
        e.stopPropagation();
        if (prop.keys.length) {
          checkpoint("アニメーション解除");
          prop.value = propValue(l, def.name); prop.keys = []; S.overrides.delete(`${l.id}|${def.name}`);
        } else { checkpoint("アニメーション有効"); insertKey(l, def.name); }
        changed("scene");
      });
      const kd = h("button", { class: "kdia", title: "現在フレームのキーを追加 / 削除" });
      kd.addEventListener("click", (e) => {
        e.stopPropagation();
        if (hasKeyAt(prop, S.time) && !isDirty(l, def.name)) { checkpoint("キー削除"); removeKeyAt(prop, S.time); }
        else { checkpoint("キー追加"); insertKey(l, def.name); }
        changed("scene");
      });
      const nav = (dir) => h("button", { class: "knav", title: dir < 0 ? "前のキー" : "次のキー", onclick: (e) => {
        e.stopPropagation();
        const times = prop.keys.map((k) => k.t);
        const t = dir < 0 ? prevKeyTime(times, S.time) : nextKeyTime(times, S.time);
        if (t !== null) setTime(t);
      } }, dir < 0 ? "◀" : "▶");
      const val = h("span", { class: "pval" });
      const el = h("div", { class: `tl-row prop${S.selLayer === l.id && S.selProp === def.name ? " sel" : ""}`, onclick: () => selectLayer(l.id, def.name) },
        watch, h("span", { class: "pname" }, def.label), val, nav(-1), kd, nav(1));
      this.rowEls.push({ l, def, el, val, kd });
      return el;
    });
    if (!rows.length) els.push(h("div", { class: "tl-empty" }, "レイヤーがありません"));
    this.rowsInner.replaceChildren(...els);
    this.updateValues();
  }

  updateValues() {
    this.updateTc();
    for (const r of this.rowEls ?? []) {
      const v = propValue(r.l, r.def.name);
      r.val.textContent = fmtNum(v, r.def.name === "rotation" || r.def.name === "fov" ? 1 : 2);
      r.kd.classList.toggle("on", hasKeyAt(r.l.props[r.def.name], S.time));
      r.el.classList.toggle("dirty", isDirty(r.l, r.def.name));
    }
    const n = S.selKeys.size;
    this.selInfo.textContent = n ? `${n} キー選択中` : "";
    this.interpBtns.forEach((b) => (b.disabled = !n));
  }

  updateTc() {
    if (document.activeElement !== this.tc) this.tc.value = String(S.time);
    const c = S.scene.comp;
    const secs = S.time / c.fps;
    this.durLabel.textContent = `/ ${c.duration - 1}  ${Math.floor(secs / 60)}:${(secs % 60).toFixed(2).padStart(5, "0")}`;
    this.playBtn.textContent = S.playing ? "❚❚" : "▶";
  }

  layerMenu(e, l) {
    const items = [
      { label: "すべてのプロパティを表示", action: () => { S.expanded.add(l.id); changed("ui"); } },
      { label: "全プロパティにキー挿入", key: "I", action: () => { selectLayer(l.id); this.actions.insertKeys(); } },
    ];
    if (l.type === "splat") items.push("-", { label: "レイヤー削除", key: "Del", action: () => this.actions.deleteLayer(l.id) });
    showMenu(e.clientX, e.clientY, items);
  }

  // ---- drawing ----
  tickStep() {
    const fps = S.scene.comp.fps;
    const cands = [1, 2, 5, 10, Math.round(fps / 2), Math.round(fps), Math.round(fps * 2), Math.round(fps * 5), Math.round(fps * 10), Math.round(fps * 30), Math.round(fps * 60)];
    for (const s of cands) if (s * this.scale >= 52) return s;
    return cands[cands.length - 1];
  }

  draw() {
    if (!this.ruler.width) return;
    this.drawRuler();
    this.drawTracks();
  }

  drawRuler() {
    const ctx = this.ruler.getContext("2d");
    const dpr = devicePixelRatio || 1;
    const w = this.width, H = 26;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#232327"; ctx.fillRect(0, 0, w, H);
    const c = S.scene.comp;
    // Work area bar.
    const wx0 = this.x(c.workIn), wx1 = this.x(c.workOut + 1);
    ctx.fillStyle = "#3d4a5e"; ctx.fillRect(wx0, 1, wx1 - wx0, 7);
    ctx.fillStyle = "#8fa8c8"; ctx.fillRect(wx0, 1, 3, 7); ctx.fillRect(wx1 - 3, 1, 3, 7);
    // Comp end.
    ctx.fillStyle = "#00000060"; ctx.fillRect(this.x(c.duration), 0, w, H);
    // Ticks.
    const step = this.tickStep();
    const minor = this.scale >= 6 ? 1 : Math.max(1, Math.round(step / 5));
    const f0 = Math.max(0, Math.floor(this.start)), f1 = Math.min(c.duration, Math.ceil(this.frameAt(w)));
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.textBaseline = "top";
    for (let f = f0 - (f0 % minor); f <= f1; f += minor) {
      const x = Math.round(this.x(f)) + 0.5;
      const major = f % step === 0;
      ctx.strokeStyle = major ? "#8a8a94" : "#4a4a52";
      ctx.beginPath(); ctx.moveTo(x, major ? 12 : 19); ctx.lineTo(x, H); ctx.stroke();
      if (major) { ctx.fillStyle = "#9a9aa4"; ctx.fillText(String(f), x + 3, 11); }
    }
    // Playhead tag.
    const px = this.x(S.time);
    ctx.fillStyle = "#4a90e2";
    const label = String(S.time);
    const tw = ctx.measureText(label).width + 8;
    ctx.fillRect(px - tw / 2, 10, tw, 14);
    ctx.fillStyle = "#fff"; ctx.fillText(label, px - tw / 2 + 4, 12);
    ctx.strokeStyle = "#4a90e2"; ctx.beginPath(); ctx.moveTo(Math.round(px) + 0.5, 0); ctx.lineTo(Math.round(px) + 0.5, H); ctx.stroke();
    ctx.strokeStyle = "#0c0c0d"; ctx.beginPath(); ctx.moveTo(0, H - 0.5); ctx.lineTo(w, H - 0.5); ctx.stroke();
  }

  keyShape(ctx, x, y, interp, sel, r = 5) {
    ctx.beginPath();
    if (interp === "hold") { ctx.rect(x - r + 1, y - r + 1, 2 * r - 2, 2 * r - 2); }
    else if (interp === "ease") {
      // hourglass-ish
      ctx.moveTo(x - r, y - r + 1); ctx.quadraticCurveTo(x, y, x - r, y + r - 1);
      ctx.lineTo(x + r, y + r - 1); ctx.quadraticCurveTo(x, y, x + r, y - r + 1); ctx.closePath();
    } else { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); }
    ctx.fillStyle = sel ? "#ffd84a" : "#b8b8c0";
    ctx.fill();
    ctx.strokeStyle = sel ? "#fff" : "#1a1a1d";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  drawTracks() {
    const ctx = this.tracks.getContext("2d");
    const dpr = devicePixelRatio || 1;
    const w = this.width, H = this.tracks.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#1c1c1f"; ctx.fillRect(0, 0, w, H);
    const c = S.scene.comp;
    const rows = this.rows;
    const step = this.tickStep();
    rows.forEach((r, i) => {
      const y = i * ROW;
      const sel = S.selLayer === r.layer.id && (r.kind === "layer" || S.selProp === r.def.name);
      ctx.fillStyle = r.kind === "layer" ? (sel ? "#2b3d5a" : "#232327") : (sel ? "#202a3a" : "#1c1c1f");
      ctx.fillRect(0, y, w, ROW - 1);
      ctx.fillStyle = "#00000055"; ctx.fillRect(0, y + ROW - 1, w, 1);
    });
    // Grid lines.
    const f0 = Math.max(0, Math.floor(this.start)), f1 = Math.min(c.duration, Math.ceil(this.frameAt(w)));
    ctx.strokeStyle = "#ffffff0a";
    for (let f = f0 - (f0 % step); f <= f1; f += step) { const x = Math.round(this.x(f)) + 0.5; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    // Outside work area.
    ctx.fillStyle = "#00000050";
    ctx.fillRect(0, 0, Math.max(0, this.x(c.workIn)), H);
    ctx.fillRect(this.x(c.workOut + 1), 0, w, H);
    ctx.fillStyle = "#00000070"; ctx.fillRect(this.x(c.duration), 0, w, H);
    // Layer bars + keys.
    this.hits = [];
    rows.forEach((r, i) => {
      const y = i * ROW, cy = y + ROW / 2 - 0.5;
      const l = r.layer;
      if (r.kind === "layer") {
        ctx.fillStyle = COLORS[l.type] + (l.visible ? "55" : "22");
        ctx.fillRect(this.x(0), y + 3, this.x(c.duration) - this.x(0), ROW - 7);
        // Summary keys.
        const times = new Map();
        for (const [name, p] of Object.entries(l.props)) for (const k of p.keys) {
          const e = times.get(k.t) ?? { sel: false, ids: [] };
          const id = keyId(l.id, name, k.t);
          e.ids.push(id); e.sel ||= S.selKeys.has(id);
          times.set(k.t, e);
        }
        for (const [t, e] of times) {
          const x = this.x(t);
          if (x < -10 || x > w + 10) continue;
          ctx.beginPath(); ctx.moveTo(x, cy - 4); ctx.lineTo(x + 4, cy); ctx.lineTo(x, cy + 4); ctx.lineTo(x - 4, cy); ctx.closePath();
          ctx.fillStyle = e.sel ? "#ffd84a" : "#d0d0d8"; ctx.fill();
          this.hits.push({ x, y: cy, ids: e.ids, t, layer: l });
        }
      } else {
        const p = l.props[r.def.name];
        // Interpolation hint lines between keys.
        for (let k = 0; k < p.keys.length - 1; k++) {
          const a = p.keys[k], b = p.keys[k + 1];
          ctx.strokeStyle = a.interp === "hold" ? "#ffffff18" : a.interp === "ease" ? "#e8c54740" : "#ffffff30";
          ctx.setLineDash(a.interp === "hold" ? [2, 3] : []);
          ctx.beginPath(); ctx.moveTo(this.x(a.t), cy + 0.5); ctx.lineTo(this.x(b.t), cy + 0.5); ctx.stroke();
        }
        ctx.setLineDash([]);
        for (const k of p.keys) {
          const x = this.x(k.t);
          if (x < -10 || x > w + 10) continue;
          const id = keyId(l.id, r.def.name, k.t);
          this.keyShape(ctx, x, cy, k.interp, S.selKeys.has(id));
          this.hits.push({ x, y: cy, ids: [id], t: k.t, layer: l, prop: r.def.name });
        }
      }
    });
    // Marquee.
    if (this.marquee) {
      const m = this.marquee;
      ctx.fillStyle = "#4a90e220"; ctx.strokeStyle = "#4a90e2";
      ctx.fillRect(m.x0, m.y0, m.x1 - m.x0, m.y1 - m.y0);
      ctx.strokeRect(m.x0 + 0.5, m.y0 + 0.5, m.x1 - m.x0, m.y1 - m.y0);
    }
    // Playhead.
    const px = Math.round(this.x(S.time)) + 0.5;
    ctx.strokeStyle = "#4a90e2"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
  }

  // ---- interaction ----
  setupRuler() {
    this.ruler.addEventListener("pointerdown", (e) => {
      const rect = this.ruler.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      const c = S.scene.comp;
      let mode = "scrub";
      if (y < 9) {
        const wx0 = this.x(c.workIn), wx1 = this.x(c.workOut + 1);
        if (Math.abs(x - wx0) < 6) mode = "in";
        else if (Math.abs(x - wx1) < 6) mode = "out";
        else if (x > wx0 && x < wx1) mode = "move";
      }
      const f0 = this.frameAt(x);
      const in0 = c.workIn, out0 = c.workOut;
      let checked = false;
      const apply = (ev) => {
        const fx = this.frameAt(ev.clientX - rect.left);
        const f = Math.round(fx);
        if (mode === "scrub") { setTime(Math.floor(fx)); return; }
        if (!checked) { checkpoint("ワークエリア"); checked = true; }
        if (mode === "in") c.workIn = Math.max(0, Math.min(f, c.workOut));
        else if (mode === "out") c.workOut = Math.min(c.duration - 1, Math.max(f - 1, c.workIn));
        else {
          let d = Math.round(fx - f0);
          d = Math.max(-in0, Math.min(d, c.duration - 1 - out0));
          c.workIn = in0 + d; c.workOut = out0 + d;
        }
        changed("comp");
      };
      this.ruler.setPointerCapture(e.pointerId);
      if (mode === "scrub") apply(e);
      const up = () => { this.ruler.removeEventListener("pointermove", apply); this.ruler.removeEventListener("pointerup", up); };
      this.ruler.addEventListener("pointermove", apply);
      this.ruler.addEventListener("pointerup", up);
    });
  }

  hitTest(x, y) {
    let best = null;
    for (const hk of this.hits ?? []) {
      const d = Math.abs(hk.x - x);
      if (d <= 6 && Math.abs(hk.y - y) <= ROW / 2 && (!best || d < best.d)) best = { ...hk, d };
    }
    return best;
  }

  setupTracks() {
    this.tracks.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const rect = this.tracks.getBoundingClientRect();
      const hit = this.hitTest(e.clientX - rect.left, e.clientY - rect.top);
      if (hit && !hit.ids.some((id) => S.selKeys.has(id))) { S.selKeys = new Set(hit.ids); bus.emit("change", "select-keys"); }
      if (!S.selKeys.size) return;
      const cur = new Set([...S.selKeys].map((id) => { const k = this.keyObj(id); return k?.interp; }));
      showMenu(e.clientX, e.clientY, [
        ...INTERPS.map((ip) => ({ label: INTERP_LABEL[ip], checked: cur.size === 1 && cur.has(ip), key: ip === "ease" ? "F9" : "", action: () => this.actions.setInterp(ip) })),
        "-",
        { label: "コピー", key: "Ctrl+C", action: () => this.actions.copyKeys() },
        { label: "現在フレームにペースト", key: "Ctrl+V", action: () => this.actions.pasteKeys() },
        "-",
        { label: "キー削除", key: "Del", action: () => this.actions.deleteSelectedKeys() },
      ]);
    });

    this.tracks.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const rect = this.tracks.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      const hit = this.hitTest(x, y);
      const row = this.rows[Math.floor(y / ROW)];
      this.tracks.setPointerCapture(e.pointerId);
      if (hit) {
        const already = hit.ids.every((id) => S.selKeys.has(id));
        if (e.shiftKey) {
          if (already) hit.ids.forEach((id) => S.selKeys.delete(id)); else hit.ids.forEach((id) => S.selKeys.add(id));
        } else if (!already) S.selKeys = new Set(hit.ids);
        if (row) { S.selLayer = row.layer.id; S.selProp = row.kind === "prop" ? row.def.name : S.selProp && row.layer.id === S.selLayer ? S.selProp : null; }
        bus.emit("change", "select");
        this.beginKeyDrag(e, rect, hit, already && !e.shiftKey);
        return;
      }
      // Empty area: select row, start marquee.
      if (!e.shiftKey) S.selKeys.clear();
      if (row) selectLayer(row.layer.id, row.kind === "prop" ? row.def.name : null);
      else bus.emit("change", "select-keys");
      const base = new Set(S.selKeys);
      this.marquee = { x0: x, y0: y, x1: x, y1: y };
      const move = (ev) => {
        const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
        this.marquee = { x0: Math.min(x, mx), y0: Math.min(y, my), x1: Math.max(x, mx), y1: Math.max(y, my) };
        const sel = new Set(base);
        for (const hk of this.hits) if (hk.x >= this.marquee.x0 && hk.x <= this.marquee.x1 && hk.y >= this.marquee.y0 && hk.y <= this.marquee.y1) hk.ids.forEach((id) => sel.add(id));
        S.selKeys = sel;
        bus.emit("change", "select-keys");
      };
      const up = (ev) => {
        this.tracks.removeEventListener("pointermove", move);
        this.tracks.removeEventListener("pointerup", up);
        const m = this.marquee; this.marquee = null;
        // A plain click (no drag) on empty track area moves the playhead.
        if (m && m.x1 - m.x0 < 3 && m.y1 - m.y0 < 3) setTime(Math.floor(this.frameAt(ev.clientX - rect.left)));
        this.draw();
      };
      this.tracks.addEventListener("pointermove", move);
      this.tracks.addEventListener("pointerup", up);
    });
  }

  keyObj(id) {
    const { layerId, prop, t } = parseKeyId(id);
    return layerById(layerId)?.props[prop]?.keys.find((k) => k.t === t);
  }

  beginKeyDrag(e, rect, hit, wasSelected) {
    // Snapshot the affected properties' keys so the drag can be re-applied from scratch.
    const groups = new Map(); // "layer|prop" -> { layer, prop, orig, times }
    for (const id of S.selKeys) {
      const { layerId, prop, t } = parseKeyId(id);
      const g = `${layerId}|${prop}`;
      const l = layerById(layerId);
      if (!l) continue;
      if (!groups.has(g)) groups.set(g, { l, name: prop, orig: JSON.parse(JSON.stringify(l.props[prop].keys)), times: [] });
      groups.get(g).times.push(t);
    }
    const all = [...groups.values()].flatMap((g) => g.times);
    const minT = Math.min(...all), maxT = Math.max(...all);
    const dur = S.scene.comp.duration;
    const fStart = this.frameAt(e.clientX - rect.left);
    let lastDt = 0, checked = false;
    const move = (ev) => {
      let dt = Math.round(this.frameAt(ev.clientX - rect.left) - fStart);
      dt = Math.max(-minT, Math.min(dt, dur - 1 - maxT));
      if (dt === lastDt) return;
      if (!checked) {
        // Undo snapshot must hold the pre-drag keys.
        for (const g of groups.values()) g.l.props[g.name].keys = JSON.parse(JSON.stringify(g.orig));
        checkpoint("キー移動"); checked = true;
      }
      lastDt = dt;
      const sel = new Set();
      for (const g of groups.values()) {
        const prop = g.l.props[g.name];
        prop.keys = JSON.parse(JSON.stringify(g.orig));
        const keys = prop.keys.filter((k) => g.times.includes(k.t));
        moveKeys(prop, keys, dt);
        for (const k of keys) sel.add(keyId(g.l.id, g.name, k.t));
      }
      S.selKeys = sel;
      S.overrides.clear();
      changed("scene");
    };
    const up = (ev) => {
      this.tracks.removeEventListener("pointermove", move);
      this.tracks.removeEventListener("pointerup", up);
      if (!checked && wasSelected && !ev.shiftKey && S.selKeys.size > hit.ids.length) {
        // Click on an already-selected key without dragging: reduce selection to it.
        S.selKeys = new Set(hit.ids);
        bus.emit("change", "select-keys");
      }
      pruneSelection();
    };
    this.tracks.addEventListener("pointermove", move);
    this.tracks.addEventListener("pointerup", up);
  }
}
