// Thin wrappers around the local backend API (see app/API.md).

async function req(method, url, body, headers = {}) {
  const opts = { method, headers: { ...headers } };
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer || body instanceof Uint8Array) opts.body = body;
    else { opts.body = JSON.stringify(body); opts.headers["content-type"] = "application/json"; }
  }
  const r = await fetch(url, opts);
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const msg = (data && (data.error || data.message)) || `${r.status} ${r.statusText}`;
    const e = new Error(`${method} ${url}: ${msg}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

export const api = {
  models: () => req("GET", "/api/models"),
  subjects: () => req("GET", "/api/subjects"),
  createSubject: (id) => req("POST", "/api/subjects", { id }),
  upload: (subject, kind, file) => req("POST", `/api/upload?subject=${encodeURIComponent(subject)}&kind=${kind}`, file, { "content-type": file.type || "application/octet-stream" }),
  jobs: () => req("GET", "/api/jobs"),
  startJob: (type, subject, params = {}) => req("POST", "/api/jobs", { type, subject, params }),
  cancelJob: (id) => req("POST", `/api/jobs/${id}/cancel`),
  jobEvents: (id) => new EventSource(`/api/jobs/${id}/events`),
  scenes: () => req("GET", "/api/scenes"),
  getScene: (name) => req("GET", `/api/scenes/${encodeURIComponent(name)}`),
  putScene: (name, scene) => req("PUT", `/api/scenes/${encodeURIComponent(name)}`, scene),
  renderStart: (opts) => req("POST", "/api/render", opts),
  renderFrame: (id, n, blob) => req("POST", `/api/render/${id}/frame/${n}`, blob, { "content-type": "image/png" }),
  renderFinish: (id) => req("POST", `/api/render/${id}/finish`),
  renderAbort: (id) => req("POST", `/api/render/${id}/abort`),
};
