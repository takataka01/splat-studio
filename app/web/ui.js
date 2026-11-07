// Small DOM helpers shared by panels.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

// ---- context menu ----
const menuEl = () => document.getElementById("menu");
let menuClose = null;
/** items: [{ label, key?, checked?, action }] or "-" for separator. */
export function showMenu(x, y, items) {
  const m = menuEl();
  m.replaceChildren(...items.map((it) => it === "-" ? h("div", { class: "sep" }) :
    h("div", { class: `mi${it.checked ? " checked" : ""}`, onclick: () => { hideMenu(); it.action(); } },
      h("span", {}, it.label), it.key ? h("span", { class: "k" }, it.key) : null)));
  m.classList.remove("hidden");
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(x, innerWidth - r.width - 4)}px`;
  m.style.top = `${Math.min(y, innerHeight - r.height - 4)}px`;
  setTimeout(() => {
    menuClose = (e) => { if (!m.contains(e.target)) hideMenu(); };
    addEventListener("pointerdown", menuClose, true);
  });
}
export function hideMenu() {
  menuEl().classList.add("hidden");
  if (menuClose) removeEventListener("pointerdown", menuClose, true);
  menuClose = null;
}

// ---- tabs ----
export function setupTabs(root) {
  const tabs = root.querySelectorAll(":scope > .tabs > .tab");
  tabs.forEach((t) => t.addEventListener("click", () => activateTab(root, t.dataset.tab)));
}
export function activateTab(root, name) {
  root.querySelectorAll(":scope > .tabs > .tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === name));
  root.querySelectorAll(":scope > .tab-body").forEach((b) => b.classList.toggle("active", b.dataset.body === name));
}

// ---- scrubbable numeric field ----
/**
 * A number input whose `handle` element can be dragged horizontally to scrub.
 * opts: { value, step, min, max, digits, onStart(), onInput(v), onCommit(v), label, axisClass }
 */
export function numField(opts) {
  const { step = 0.01, min = -Infinity, max = Infinity, digits = 3 } = opts;
  const input = h("input", { type: "text", spellcheck: false });
  const wrap = h("div", { class: `nf${opts.label ? "" : " nolabel"}` });
  let handle = null;
  if (opts.label) { handle = h("span", { class: `axis ${opts.axisClass || ""}` }, opts.label); wrap.append(handle); }
  wrap.append(input);
  const clamp = (v) => Math.max(min, Math.min(max, v));
  const fmt = (v) => { const s = (+v).toFixed(digits); return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s; };
  let current = opts.value ?? 0;
  const api = {
    el: wrap, input,
    set(v) { current = v; if (document.activeElement !== input) input.value = fmt(v); },
    get: () => current,
    attachScrub(el) { scrub(el); },
  };
  api.set(current);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { input.blur(); }
    if (e.key === "Escape") { input.value = fmt(current); input.blur(); }
    e.stopPropagation();
  });
  input.addEventListener("change", () => {
    let v;
    try { v = Function(`"use strict";return (${input.value})`)(); } catch { v = NaN; }
    if (!Number.isFinite(+v)) { input.value = fmt(current); return; }
    v = clamp(+v);
    opts.onStart?.();
    current = v; opts.onCommit?.(v);
    input.value = fmt(v);
  });
  input.addEventListener("focus", () => input.select());
  function scrub(el) {
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const x0 = e.clientX, v0 = current;
      let started = false;
      el.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const dx = ev.clientX - x0;
        if (!started && Math.abs(dx) < 2) return;
        if (!started) { started = true; opts.onStart?.(); }
        const mul = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
        const v = clamp(v0 + dx * step * mul);
        current = v; input.value = fmt(v);
        opts.onInput?.(v);
      };
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        if (started) opts.onCommit?.(current, true);
        else input.focus();
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    });
  }
  if (handle) scrub(handle);
  return api;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
