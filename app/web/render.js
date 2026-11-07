// Render queue: deterministic frame-by-frame export through the backend.
import { h } from "./ui.js";
import { api } from "./api.js";
import { S, bus, status } from "./state.js";

const PRESETS = [
  { v: "comp", label: "コンポジションと同じ" },
  { v: "1920x1080", label: "1920×1080 (16:9 横)" },
  { v: "1080x1920", label: "1080×1920 (9:16 縦)" },
  { v: "1080x1080", label: "1080×1080 (1:1)" },
  { v: "custom", label: "カスタム" },
];

export class RenderQueue {
  constructor(el, viewport, { beforeRender } = {}) {
    this.el = el;
    this.vp = viewport;
    this.beforeRender = beforeRender;
    this.items = [];
    this.running = null;
    this.build();
    bus.on("change", (what) => { if (what === "comp" || what === "load") this.syncFromComp(); });
  }

  build() {
    const onKey = (e) => e.stopPropagation();
    this.name = h("input", { class: "text", value: "shot01", spellcheck: false, onkeydown: onKey });
    this.preset = h("select", {}, PRESETS.map((p) => h("option", { value: p.v }, p.label)));
    this.w = h("input", { class: "num", value: 1920, onkeydown: onKey });
    this.h = h("input", { class: "num", value: 1080, onkeydown: onKey });
    this.fps = h("input", { class: "num", value: 30, onkeydown: onKey });
    this.range = h("select", {}, h("option", { value: "work" }, "ワークエリア"), h("option", { value: "full" }, "コンポジション全体"));
    this.format = h("select", {}, h("option", { value: "mp4" }, "MP4 (H.264)"), h("option", { value: "webm" }, "WebM"), h("option", { value: "png" }, "PNG 連番"));
    this.summary = h("div", { class: "full dim mono" });
    this.preset.addEventListener("change", () => this.syncFromComp());
    this.fps.addEventListener("input", () => { this.fpsTouched = true; });
    [this.w, this.h, this.fps, this.range].forEach((x) => x.addEventListener("change", () => this.updateSummary()));
    const addBtn = h("button", { class: "primary", onclick: () => this.enqueue() }, "キューに追加してレンダリング");
    const form = h("div", { class: "rq-form" },
      h("label", {}, "出力名"), h("div", { class: "full", style: { gridColumn: "2 / 5" } }, this.name),
      h("label", {}, "解像度"), this.preset,
      h("label", {}, "サイズ"), h("div", { class: "wh" }, this.w, h("span", { class: "dim" }, "×"), this.h),
      h("label", {}, "フレームレート"), this.fps,
      h("label", {}, "範囲"), this.range,
      h("label", {}, "形式"), this.format,
      h("span"), h("span"),
      this.summary,
      h("div", { class: "full", style: { display: "flex", gap: "6px", justifyContent: "flex-end" } }, addBtn),
    );
    this.list = h("div", { class: "rq-list" });
    this.el.replaceChildren(form, this.list);
    this.syncFromComp();
    this.renderList();
  }

  syncFromComp() {
    const c = S.scene.comp;
    const p = this.preset.value;
    const custom = p === "custom";
    if (p === "comp") { this.w.value = c.width; this.h.value = c.height; }
    else if (!custom) { const [w, hh] = p.split("x").map(Number); this.w.value = w; this.h.value = hh; }
    this.w.disabled = this.h.disabled = !custom;
    if (!this.fpsTouched) this.fps.value = c.fps;
    this.updateSummary();
  }

  settings() {
    const c = S.scene.comp;
    const width = Math.max(16, Math.round(+this.w.value / 2) * 2);
    const height = Math.max(16, Math.round(+this.h.value / 2) * 2);
    const fps = Math.max(1, +this.fps.value || c.fps);
    const [from, to] = this.range.value === "work" ? [c.workIn, c.workOut] : [0, c.duration - 1];
    const frames = Math.max(1, Math.floor(((to - from + 1) * fps) / c.fps));
    const name = (this.name.value.trim() || "shot").replace(/[^\w.-]+/g, "_");
    return { name, width, height, fps, from, to, frames, format: this.format.value, compFps: c.fps };
  }

  updateSummary() {
    const s = this.settings();
    this.summary.textContent = `${s.width}×${s.height} · ${s.fps}fps · f${s.from}–f${s.to} · ${s.frames} フレーム · ${(s.frames / s.fps).toFixed(2)} 秒`;
  }

  enqueue(overrides = {}) {
    const item = { ...this.settings(), ...overrides, state: "queued", progress: 0, id: null, file: null, error: null, cancel: false };
    this.items.unshift(item);
    this.renderList();
    this.pump();
    return item;
  }

  async pump() {
    if (this.running) return;
    const next = [...this.items].reverse().find((i) => i.state === "queued");
    if (!next) return;
    this.running = next;
    try { await this.run(next); } finally { this.running = null; this.renderList(); this.pump(); }
  }

  /** Wait until an item settles. */
  wait(item) {
    return new Promise((r) => { const iv = setInterval(() => { if (["done", "error", "cancelled"].includes(item.state)) { clearInterval(iv); r(item); } }, 100); });
  }

  async run(item) {
    this.beforeRender?.();
    const cover = document.getElementById("render-cover");
    const savedTime = S.time;
    item.state = "rendering"; this.renderList();
    let started = false;
    const t0 = performance.now();
    try {
      const { id } = await api.renderStart({ name: item.name, fps: item.fps, width: item.width, height: item.height, format: item.format });
      item.id = id;
      S.overrides.clear();
      this.vp.beginExport(item.width, item.height);
      started = true;
      const img = h("img", { style: { maxWidth: "70%", maxHeight: "70%", border: "1px solid #333" } });
      const txt = h("div", { class: "mono" }, "準備中…");
      cover.replaceChildren(h("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: "8px", width: "100%", height: "100%", justifyContent: "center" } }, img, txt));
      cover.classList.remove("hidden");
      await this.vp.whenReady();
      let lastUrl = null;
      for (let n = 0; n < item.frames; n++) {
        if (item.cancel) throw new Error("cancelled");
        const t = item.from + (n * item.compFps) / item.fps;
        const blob = await this.vp.renderFrame(t);
        await api.renderFrame(id, n, blob);
        item.progress = (n + 1) / item.frames;
        if (lastUrl) URL.revokeObjectURL(lastUrl);
        lastUrl = URL.createObjectURL(blob); img.src = lastUrl;
        const el = (performance.now() - t0) / 1000;
        txt.textContent = `レンダリング中 ${n + 1} / ${item.frames}  (${(el / (n + 1)).toFixed(2)} s/frame)`;
        this.updateItem(item);
      }
      txt.textContent = "エンコード中…";
      const res = await api.renderFinish(id);
      item.file = res?.file ?? null;
      item.state = "done";
      item.elapsed = (performance.now() - t0) / 1000;
      status(`レンダリング完了: ${item.file ?? item.name}`);
      if (lastUrl) URL.revokeObjectURL(lastUrl);
    } catch (e) {
      if (item.cancel || e.message === "cancelled") {
        item.state = "cancelled";
        if (item.id) api.renderAbort(item.id).catch(() => {});
        status("レンダリングを中止しました");
      } else {
        item.state = "error"; item.error = e.message;
        if (item.id) api.renderAbort(item.id).catch(() => {});
        status(`レンダリング失敗: ${e.message}`, true);
        console.error(e);
      }
    } finally {
      if (started) this.vp.endExport();
      cover.classList.add("hidden");
      cover.replaceChildren();
      S.time = savedTime;
      bus.emit("change", "time");
      this.renderList();
    }
  }

  updateItem(item) {
    const el = this.list.querySelector(`[data-key="${this.items.indexOf(item)}"]`);
    if (!el) return this.renderList();
    el.querySelector(".progress > div").style.width = `${Math.round(item.progress * 100)}%`;
    el.querySelector(".rstate").textContent = this.stateText(item);
  }

  stateText(i) {
    return { queued: "待機中", rendering: `レンダリング中 ${Math.round(i.progress * 100)}%`, done: `完了${i.elapsed ? ` (${i.elapsed.toFixed(1)}s)` : ""}`, error: `エラー: ${i.error}`, cancelled: "中止" }[i.state];
  }

  renderList() {
    if (!this.items.length) { this.list.replaceChildren(h("div", { class: "hint", style: { padding: "10px" } }, "レンダーキューは空です。左のフォームから追加してください。")); return; }
    this.list.replaceChildren(...this.items.map((i, k) => h("div", { class: `rq-item ${i.state}`, dataset: { key: k } },
      h("div", { class: "rrow" },
        h("span", { class: "rname" }, `${i.name}.${i.format === "png" ? "png/" : i.format}`),
        h("span", { class: "dim mono" }, `${i.width}×${i.height} · ${i.fps}fps · ${i.frames}f`),
        h("span", { class: "rstate dim" }, this.stateText(i)),
        i.file ? h("a", { href: i.file, target: "_blank" }, "結果を開く") : null,
        (i.state === "queued" || i.state === "rendering") ? h("button", { class: "mini danger", onclick: () => { i.cancel = true; if (i.state === "queued") { i.state = "cancelled"; this.renderList(); } } }, "中止") : null),
      h("div", { class: "progress" }, h("div", { style: { width: `${Math.round((i.state === "done" ? 1 : i.progress) * 100)}%` } })))));
  }
}
