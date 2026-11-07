// Left panel: model library, subjects, pipeline steps, jobs + live log.
import { h, activateTab } from "./ui.js";
import { api } from "./api.js";
import { status } from "./state.js";

const JOB_LABEL = {
  gen_source: "元画像生成", gen_multiview: "多視点生成", prep_multiview: "多視点の前処理", dataset_multiview: "データセット (多視点)",
  dataset_video: "データセット (動画)", train: "3DGS 学習", pipeline_multiview: "一括パイプライン",
};
const STATUS_LABEL = { queued: "待機", running: "実行中", done: "完了", error: "エラー", cancelled: "中止" };
export const MODEL_MIME = "application/x-splat-model";

export class PipelinePanel {
  constructor(leftEl, { onAddModel, onModels }) {
    this.left = leftEl;
    this.onAddModel = onAddModel;
    this.onModels = onModels;
    this.models = [];
    this.subjects = [];
    this.jobs = [];
    this.selSubject = null;
    this.selJob = null;
    this.es = null;
    this.liveProgress = new Map();
    this.modelList = document.getElementById("model-list");
    this.subjectList = document.getElementById("subject-list");
    this.pipelineEl = document.getElementById("pipeline");
    this.jobList = document.getElementById("job-list");
    this.logEl = document.getElementById("log");
    this.logTitle = document.getElementById("log-title");
    this.badge = document.getElementById("jobs-badge");
    document.getElementById("btn-models-refresh").onclick = () => this.loadModels();
    document.getElementById("btn-subjects-refresh").onclick = () => this.loadSubjects();
    document.getElementById("btn-jobs-refresh").onclick = () => this.loadJobs();
    this.fileInput = h("input", { type: "file", style: { display: "none" } });
    document.body.append(this.fileInput);
    this.renderPipeline();
    this.loadModels();
    this.loadSubjects();
    this.loadJobs();
    this.pollTimer = setInterval(() => this.loadJobs(true), 2500);
  }

  // ---- models ----
  async loadModels() {
    try {
      this.models = await api.models();
    } catch (e) {
      this.models = [];
      this.modelList.replaceChildren(h("div", { class: "hint" }, `モデル一覧を取得できません (${e.message})`));
      return;
    }
    this.onModels?.(this.models);
    if (!this.models.length) { this.modelList.replaceChildren(h("div", { class: "hint" }, "学習済みモデルがありません")); return; }
    this.modelList.replaceChildren(...this.models.map((m) => {
      const el = h("div", { class: "model-item", draggable: true, title: m.url, ondblclick: () => this.onAddModel(m) },
        h("span", { class: "ico" }),
        h("span", { class: "name" }, m.name),
        h("span", { class: "meta" }, m.file?.replace(/\.ply$/, "") === m.name ? "ply" : m.file ?? ""),
        h("button", { class: "mini", title: "シーンに追加", onclick: (e) => { e.stopPropagation(); this.onAddModel(m); } }, "＋"));
      el.addEventListener("dragstart", (e) => { e.dataTransfer.setData(MODEL_MIME, JSON.stringify(m)); e.dataTransfer.effectAllowed = "copy"; });
      return el;
    }));
  }

  // ---- subjects ----
  async loadSubjects() {
    try {
      this.subjects = await api.subjects();
    } catch (e) {
      this.subjects = [];
      this.subjectList.replaceChildren(this.newSubjectRow(), h("div", { class: "hint" }, `被写体一覧を取得できません (${e.message})`));
      return;
    }
    this.subjectList.replaceChildren(this.newSubjectRow(), ...this.subjects.map((s) => this.subjectItem(s)));
    if (this.selSubject) this.renderPipeline();
  }

  newSubjectRow() {
    const inp = h("input", { class: "text", placeholder: "新規被写体 ID (例: subject02)", spellcheck: false, onkeydown: (e) => { e.stopPropagation(); if (e.key === "Enter") create(); } });
    const create = async () => {
      const id = inp.value.trim();
      if (!/^[a-z0-9_]+$/.test(id)) { status("ID は英小文字・数字・_ のみ", true); return; }
      try { await api.createSubject(id); status(`被写体 ${id} を作成`); this.selSubject = id; await this.loadSubjects(); activateTab(this.left, "pipeline"); }
      catch (e) { status(e.message, true); }
    };
    return h("div", { class: "new-subject" }, inp, h("button", { onclick: create }, "作成"));
  }

  subjectItem(s) {
    const tags = [];
    tags.push(h("span", { class: `tag${s.source ? " ok" : ""}` }, "元画像"));
    tags.push(h("span", { class: `tag${s.multiview?.length ? " ok" : ""}` }, `多視点 ${s.multiview?.length ?? 0}`));
    if (s.multiviewPrepared?.length) tags.push(h("span", { class: "tag ok" }, `前処理 ${s.multiviewPrepared.length}`));
    if (s.video) tags.push(h("span", { class: "tag ok" }, "動画"));
    for (const d of s.datasets ?? []) tags.push(h("span", { class: "tag" }, `DS:${d.route}`));
    for (const m of s.models ?? []) tags.push(h("span", { class: "tag ok" }, `◆ ${m.name}`));
    const thumb = h("div", { class: "thumb", style: s.source ? { backgroundImage: `url("${s.source}")` } : {} }, s.source ? "" : "なし");
    const strip = (s.multiviewPrepared?.length ? s.multiviewPrepared : s.multiview ?? []).slice(0, 8).map((u) => h("img", { src: u, loading: "lazy" }));
    return h("div", { class: `subject${this.selSubject === s.id ? " active" : ""}`, onclick: () => { this.selSubject = s.id; this.loadSubjects(); activateTab(this.left, "pipeline"); } },
      h("div", { class: "row" }, thumb, h("div", { style: { minWidth: 0 } }, h("div", { class: "title" }, s.id), h("div", { class: "tags" }, tags))),
      strip.length ? h("div", { class: "strip" }, strip) : null);
  }

  // ---- pipeline steps for the selected subject ----
  renderPipeline() {
    const s = this.subjects.find((x) => x.id === this.selSubject);
    if (!s) {
      this.pipelineEl.replaceChildren(h("div", { class: "p-empty" }, "プロジェクトタブで被写体を選択するか作成してください"));
      return;
    }
    const num = (v, w = 64) => h("input", { class: "num", value: v, style: { width: `${w}px` }, onkeydown: (e) => e.stopPropagation() });
    const run = async (type, params, btn) => {
      if (btn) btn.disabled = true;
      try {
        const { id } = await api.startJob(type, s.id, params);
        status(`ジョブ開始: ${JOB_LABEL[type]} (${id})`);
        this.selJob = id;
        await this.loadJobs();
        this.attachLog(id);
        activateTab(this.left, "jobs");
      } catch (e) { status(e.message, true); }
      finally { if (btn) btn.disabled = false; }
    };
    const step = (n, title, desc, done, ...rows) => h("div", { class: "pp-step" },
      h("div", { class: "st-head" }, h("span", { class: `st-num${done ? " done" : ""}` }, done ? "✓" : n), h("span", { class: "st-title" }, title)),
      desc ? h("div", { class: "st-desc" }, desc) : null, ...rows);
    const upload = (kind, accept) => () => {
      this.fileInput.accept = accept;
      this.fileInput.onchange = async () => {
        const f = this.fileInput.files[0]; this.fileInput.value = "";
        if (!f) return;
        status(`アップロード中: ${f.name}`);
        try { await api.upload(s.id, kind, f); status(`アップロード完了: ${f.name}`); this.loadSubjects(); }
        catch (e) { status(e.message, true); }
      };
      this.fileInput.click();
    };

    const prompt1 = h("textarea", { placeholder: "人物の説明（例: 20代の日本人女性、白T・ジーンズ、全身、正面、無地背景）", onkeydown: (e) => e.stopPropagation() });
    const promptAll = h("textarea", { placeholder: "（任意）元画像が無い場合のプロンプト", onkeydown: (e) => e.stopPropagation() });
    const viewsAll = num(8, 46), stepsAll = num(7000), views = num(8, 46), fovY = num(30, 46), vfps = num(6, 46), steps = num(7000);
    const route = h("select", {}, h("option", { value: "multiview" }, "マルチビュー"), s.video ? h("option", { value: "video" }, "動画") : null);
    const dsNames = (s.datasets ?? []).map((d) => d.route);
    const strip = (urls) => urls?.length ? h("div", { class: "strip" }, urls.slice(0, 8).map((u) => h("img", { src: u, loading: "lazy" }))) : null;
    const b = (label, fn, cls = "") => { const el = h("button", { class: cls }); el.textContent = label; el.onclick = () => fn(el); return el; };

    this.pipelineEl.replaceChildren(
      h("div", { class: "pp-head" },
        h("div", { class: "thumb", style: s.source ? { backgroundImage: `url("${s.source}")` } : {} }),
        h("div", { style: { display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 } },
          h("div", { class: "title", style: { fontWeight: 600, color: "var(--fg-hi)" } }, s.id),
          h("button", { onclick: upload("source", "image/png,image/jpeg,image/webp") }, "元画像をアップロード"),
          h("button", { onclick: upload("video", "video/mp4,video/*") }, "周回動画をアップロード"),
          s.video ? h("a", { href: s.video, target: "_blank", class: "dim" }, "orbit.mp4") : null)),
      h("div", { class: "pp-step big" },
        h("div", { class: "st-head" }, h("span", { class: "st-num" }, "⚡"), h("span", { class: "st-title" }, "ワンクリック: 画像 → 3DGS")),
        h("div", { class: "st-desc" }, "元画像 →（生成）多視点 → 前処理 → データセット → 学習 を順に実行"),
        promptAll,
        h("div", { class: "st-row" }, h("span", { class: "dim" }, "視点"), viewsAll, h("span", { class: "dim" }, "ステップ"), stepsAll, h("span", { class: "spacer" }),
          b("一括実行", (el) => run("pipeline_multiview", { ...(promptAll.value.trim() ? { prompt: promptAll.value.trim() } : {}), views: +viewsAll.value || 8, steps: +stepsAll.value || 7000 }, el), "primary"))),
      step(1, "元画像の生成", "プロンプトから人物画像を1枚生成（source.png）", !!s.source, prompt1,
        h("div", { class: "st-row" }, h("span", { class: "spacer" }), b("生成", (el) => { if (!prompt1.value.trim()) return status("プロンプトを入力してください", true); run("gen_source", { prompt: prompt1.value.trim() }, el); }))),
      step(2, "多視点画像の生成", "元画像から周囲の視点を生成", !!s.multiview?.length, strip(s.multiview),
        h("div", { class: "st-row" }, h("span", { class: "dim" }, "視点数"), views, h("span", { class: "spacer" }), b("生成", (el) => run("gen_multiview", { views: +views.value || 8 }, el)))),
      step(3, "多視点の前処理", "構図合わせ＋背景除去", !!s.multiviewPrepared?.length, strip(s.multiviewPrepared),
        h("div", { class: "st-row" }, h("span", { class: "spacer" }), b("実行", (el) => run("prep_multiview", {}, el)))),
      step(4, "データセット作成（多視点）", "カメラを円周上に仮定して配置", dsNames.includes("multiview"),
        h("div", { class: "st-row" }, h("span", { class: "dim" }, "FOV-Y"), fovY, h("span", { class: "spacer" }), b("実行", (el) => run("dataset_multiview", { fovY: +fovY.value || 30 }, el)))),
      s.video ? step("4'", "データセット作成（動画）", "フレーム抽出 + SfM でカメラ推定", dsNames.includes("video"),
        h("div", { class: "st-row" }, h("span", { class: "dim" }, "抽出 fps"), vfps, h("span", { class: "spacer" }), b("実行", (el) => run("dataset_video", { fps: +vfps.value || 6 }, el)))) : null,
      step(5, "3DGS 学習", "学習してモデルライブラリへ公開", !!s.models?.length,
        h("div", { class: "st-row" }, route, h("span", { class: "dim" }, "ステップ"), steps, h("span", { class: "spacer" }), b("学習", (el) => run("train", { route: route.value, steps: +steps.value || 7000 }, el)))),
      s.models?.length ? h("div", { class: "pp-step" },
        h("div", { class: "st-head" }, h("span", { class: "st-num done" }, "◆"), h("span", { class: "st-title" }, "学習済みモデル")),
        ...s.models.map((m) => h("div", { class: "st-row" }, h("span", { class: "mono", style: { flex: 1 } }, m.name), h("button", { onclick: () => this.onAddModel(m) }, "シーンに追加")))) : null,
    );
  }

  // ---- jobs ----
  async loadJobs(quiet = false) {
    let jobs;
    try { jobs = await api.jobs(); } catch (e) {
      if (!quiet) this.jobList.replaceChildren(h("div", { class: "hint" }, `ジョブ一覧を取得できません (${e.message})`));
      return;
    }
    const prev = new Map(this.jobs.map((j) => [j.id, j.status]));
    this.jobs = jobs;
    // A job finished since last poll: refresh outputs.
    if (jobs.some((j) => prev.has(j.id) && prev.get(j.id) !== j.status && j.status === "done")) { this.loadSubjects(); this.loadModels(); }
    const active = jobs.filter((j) => j.status === "running" || j.status === "queued").length;
    this.badge.textContent = active; this.badge.classList.toggle("hidden", !active);
    if (!this.selJob) { const run = jobs.find((j) => j.status === "running"); if (run) { this.selJob = run.id; this.attachLog(run.id); } }
    this.renderJobs();
  }

  renderJobs() {
    if (!this.jobs.length) { this.jobList.replaceChildren(h("div", { class: "hint" }, "ジョブはまだありません")); return; }
    this.jobList.replaceChildren(...[...this.jobs].reverse().map((j) => {
      const p = this.liveProgress.get(j.id) ?? j.progress;
      const running = j.status === "running";
      const bar = h("div", { class: `progress${running && p == null ? " indet" : ""}` }, h("div", { style: { width: `${Math.round((j.status === "done" ? 1 : p ?? 0) * 100)}%` } }));
      const dur = j.startedAt ? Math.round(((j.endedAt ? new Date(j.endedAt) : new Date()) - new Date(j.startedAt)) / 1000) : null;
      return h("div", { class: `job${this.selJob === j.id ? " active" : ""}`, onclick: () => { this.selJob = j.id; this.attachLog(j.id); this.renderJobs(); } },
        h("div", { class: "jrow" },
          h("span", { class: "jtype" }, JOB_LABEL[j.type] ?? j.type),
          h("span", { class: "dim mono" }, j.subject ?? ""),
          h("span", { class: `jstatus ${j.status}` }, STATUS_LABEL[j.status] ?? j.status),
          (running || j.status === "queued") ? h("button", { class: "mini danger", title: "中止", onclick: async (e) => { e.stopPropagation(); try { await api.cancelJob(j.id); this.loadJobs(); } catch (err) { status(err.message, true); } } }, "✕") : null),
        h("div", { class: "jrow dim mono", style: { fontSize: "10px" } }, `${j.id}${dur != null ? ` · ${dur}s` : ""}${p != null && running ? ` · ${Math.round(p * 100)}%` : ""}`),
        (running || j.status === "queued" || p != null) ? bar : null);
    }));
  }

  attachLog(id) {
    if (this.es) { this.es.close(); this.es = null; }
    this.logEl.textContent = "";
    const j = this.jobs.find((x) => x.id === id);
    this.logTitle.textContent = j ? `${JOB_LABEL[j.type] ?? j.type} · ${id}` : id;
    let es;
    try { es = api.jobEvents(id); } catch (e) { this.logEl.textContent = e.message; return; }
    this.es = es;
    let pending = "";
    let flushQueued = false;
    const flush = () => {
      flushQueued = false;
      const atBottom = this.logEl.scrollTop + this.logEl.clientHeight >= this.logEl.scrollHeight - 20;
      this.logEl.append(pending); pending = "";
      // Keep the log bounded.
      if (this.logEl.textContent.length > 400000) this.logEl.textContent = this.logEl.textContent.slice(-300000);
      if (atBottom) this.logEl.scrollTop = this.logEl.scrollHeight;
    };
    es.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { m = { kind: "log", line: ev.data }; }
      if (m.kind === "log") { pending += m.line + "\n"; if (!flushQueued) { flushQueued = true; requestAnimationFrame(flush); setTimeout(() => flushQueued && flush(), 100); } }
      else if (m.kind === "progress") { this.liveProgress.set(id, m.value); this.renderJobs(); }
      else if (m.kind === "status") {
        const jj = this.jobs.find((x) => x.id === id);
        if (jj) jj.status = m.status;
        if (["done", "error", "cancelled"].includes(m.status)) {
          es.close(); if (this.es === es) this.es = null;
          pending += `\n── ${STATUS_LABEL[m.status] ?? m.status} ──\n`; flush();
          this.renderJobs();
          if (m.status === "done") { this.loadSubjects(); this.loadModels(); status(`ジョブ完了: ${id}`); }
          else status(`ジョブ ${STATUS_LABEL[m.status]}: ${id}`, m.status === "error");
        }
      }
    };
    // EventSource reconnects automatically and the server replays the whole
    // log on connect, so start from a clean pane on every (re)open.
    es.onopen = () => { pending = ""; this.logEl.textContent = ""; };
    es.onerror = () => {
      const jj = this.jobs.find((x) => x.id === id);
      if (jj && ["done", "error", "cancelled"].includes(jj.status)) { es.close(); if (this.es === es) this.es = null; }
    };
  }
}
