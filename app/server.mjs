// Splat Studio local server: static GUI + pipeline API (see app/API.md).
// Node 24, no npm dependencies. Start from the repository root or anywhere:
//   node app/server.mjs            (PORT=5180 by default)
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 5180);
const HOSTS = process.env.HOST ? [process.env.HOST] : ['127.0.0.1', '::1'];
const WEB_DIR = path.join(ROOT, 'app', 'web');
const MODELS_DIR = path.join(ROOT, 'viewer', 'models');
const INPUT_DIR = path.join(ROOT, 'input');
const WORK_DIR = path.join(ROOT, 'work');
const RENDERS_DIR = path.join(ROOT, 'renders');
const RENDER_TMP = path.join(RENDERS_DIR, '.tmp');
const SCENES_DIR = path.join(ROOT, 'scenes');

const MAX_UPLOAD = 500 * 1024 * 1024;
const MAX_JSON = 20 * 1024 * 1024;
const MAX_FRAME = 100 * 1024 * 1024;
const MAX_LOG_LINES = 5000;

const ID_RE = /^[a-z0-9_]+$/;
const NAME_RE = /^[A-Za-z0-9_-]{1,100}$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.ply': 'application/octet-stream',
  '.splat': 'application/octet-stream',
  '.spz': 'application/octet-stream',
  '.ksplat': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
  '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------- helpers

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(body);
}

// Resolve `rel` inside `base`; throws 403 if it escapes. `rel` is already URL-decoded.
function safeJoin(base, rel) {
  if (typeof rel !== 'string' || rel.includes('\0')) throw new HttpError(400, 'bad path');
  const p = path.resolve(base, '.' + path.sep + rel);
  if (p !== base && !p.startsWith(base + path.sep)) throw new HttpError(403, 'path outside root');
  return p;
}

function decodePath(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HttpError(400, 'bad URL encoding');
  }
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function listDir(p) {
  try {
    return (await fsp.readdir(p, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

// Read a request body into a Buffer, rejecting bodies larger than `limit`.
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] || 0);
    if (len > limit) {
      req.resume();
      return reject(new HttpError(413, `body larger than ${limit} bytes`));
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, `body larger than ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Stream a request body to a file, enforcing `limit`. Removes the file on failure.
function bodyToFile(req, file, limit) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] || 0);
    if (len > limit) {
      req.resume();
      return reject(new HttpError(413, `body larger than ${limit} bytes`));
    }
    const out = fs.createWriteStream(file);
    let size = 0;
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      out.destroy();
      fs.rm(file, { force: true }, () => reject(err));
    };
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        fail(new HttpError(413, `body larger than ${limit} bytes`));
        req.destroy();
      }
    });
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => (failed ? null : resolve(size)));
    req.pipe(out);
  });
}

async function readJsonBody(req) {
  const buf = await readBody(req, MAX_JSON);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

// Run a command to completion; resolves { code, out } (stdout+stderr combined).
function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (e) => resolve({ code: -1, out: String(e) }));
    p.on('close', (code) => resolve({ code, out }));
  });
}

const toUrl = (abs) => '/files/' + path.relative(ROOT, abs).split(path.sep).map(encodeURIComponent).join('/');

// ---------------------------------------------------------------- static files

async function serveFile(req, res, file, { listing = false } = {}) {
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    throw new HttpError(404, 'not found');
  }
  if (st.isDirectory()) {
    if (!listing) {
      const index = path.join(file, 'index.html');
      if (await exists(index)) return serveFile(req, res, index);
      throw new HttpError(404, 'not found');
    }
    // JSON directory listing (used for PNG-sequence render output).
    const entries = await listDir(file);
    const items = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(file, e.name);
      const s = await fsp.stat(abs).catch(() => null);
      if (!s) continue;
      items.push({ name: e.name, dir: s.isDirectory(), size: s.size, url: toUrl(abs) + (s.isDirectory() ? '/' : '') });
    }
    return sendJson(res, 200, items);
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'Last-Modified': st.mtime.toUTCString() };
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (start >= st.size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------- subjects & models

async function readModelIndex() {
  try {
    const list = JSON.parse(await fsp.readFile(path.join(MODELS_DIR, 'index.json'), 'utf8'));
    return list.map((m) => ({ ...m, url: '/models/' + encodeURIComponent(m.file) }));
  } catch {
    return [];
  }
}

const isPng = (n) => /\.png$/i.test(n);

async function subjectInfo(id, models) {
  const dir = path.join(INPUT_DIR, id);
  const pngs = async (sub) =>
    (await listDir(path.join(dir, sub))).filter((e) => e.isFile() && isPng(e.name)).map((e) => toUrl(path.join(dir, sub, e.name)));
  const datasets = [];
  for (const [suffix, route] of [['_mv', 'multiview'], ['_video', 'video']]) {
    const imgDir = path.join(WORK_DIR, id + suffix, 'images');
    const imgs = (await listDir(imgDir)).filter((e) => e.isFile() && /\.(png|jpe?g)$/i.test(e.name));
    if (imgs.length) datasets.push({ name: id + suffix, route, images: imgs.length });
  }
  const source = path.join(dir, 'source.png');
  const video = path.join(dir, 'orbit.mp4');
  return {
    id,
    source: (await exists(source)) ? toUrl(source) : null,
    multiview: await pngs('multiview'),
    multiviewPrepared: await pngs('multiview_prep'),
    video: (await exists(video)) ? toUrl(video) : null,
    datasets,
    models: models.filter((m) => m.name === `${id}_multiview` || m.name === `${id}_video`),
  };
}

async function listSubjects() {
  const models = await readModelIndex();
  const out = [];
  for (const e of await listDir(INPUT_DIR)) {
    if (e.isDirectory() && ID_RE.test(e.name)) out.push(await subjectInfo(e.name, models));
  }
  return out;
}

function checkId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new HttpError(400, 'subject id must match ^[a-z0-9_]+$');
  return id;
}

async function handleUpload(req, res, url) {
  const id = checkId(url.searchParams.get('subject'));
  const kind = url.searchParams.get('kind');
  if (kind !== 'source' && kind !== 'video') throw new HttpError(400, 'kind must be source or video');
  const dir = path.join(INPUT_DIR, id);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.upload-${crypto.randomBytes(6).toString('hex')}`);
  await bodyToFile(req, tmp, MAX_UPLOAD);
  try {
    const head = Buffer.alloc(12);
    const fh = await fsp.open(tmp, 'r');
    await fh.read(head, 0, 12, 0);
    await fh.close();
    if (kind === 'source') {
      const dest = path.join(dir, 'source.png');
      if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        await fsp.rename(tmp, dest);
      } else {
        const r = await run('ffmpeg', ['-loglevel', 'error', '-y', '-i', tmp, '-frames:v', '1', dest]);
        if (r.code !== 0) throw new HttpError(400, 'could not convert image: ' + r.out.trim());
      }
      return sendJson(res, 200, { file: toUrl(dest) });
    }
    const dest = path.join(dir, 'orbit.mp4');
    if (head.subarray(4, 8).toString('latin1') === 'ftyp') {
      await fsp.rename(tmp, dest);
    } else {
      const r = await run('ffmpeg', ['-loglevel', 'error', '-y', '-i', tmp, '-an', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', dest]);
      if (r.code !== 0) throw new HttpError(400, 'could not convert video: ' + r.out.trim());
    }
    return sendJson(res, 200, { file: toUrl(dest) });
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

// ---------------------------------------------------------------- jobs

const jobs = new Map(); // id -> job (insertion order = submission order)
const queue = [];
let current = null;

function intParam(v, def, min, max, name) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${name} must be between ${min} and ${max}`);
  return Math.round(n);
}

function numParam(v, def, min, max, name) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${name} must be between ${min} and ${max}`);
  return n;
}

// Progress parsers: each returns a value in 0..1 for a log line, or null.
const countLines = (re, total) => {
  let n = 0;
  return (line) => (re.test(line) ? Math.min(1, ++n / Math.max(1, total)) : null);
};
const brushProgress = (steps) => (line) => {
  const m = /(?:Refine|Eval) iter (\d+)/.exec(line);
  return m ? Math.min(1, Number(m[1]) / steps) : null;
};
const colmapProgress = () => (line) => {
  if (line.startsWith('== extracting')) return 0.02;
  if (line.startsWith('== COLMAP feature')) return 0.1;
  if (line.includes('matching (')) return 0.3;
  if (line.startsWith('== COLMAP mapping')) return 0.5;
  if (line.startsWith('== done')) return 0.98;
  return null;
};

async function countAzPngs(dir) {
  return (await listDir(dir)).filter((e) => e.isFile() && isPng(e.name) && /az\d+/.test(e.name)).length;
}

// Each step: { label, weight, cmd, args, parser } (cmd/args may be built lazily by `prepare`).
function stepGenSource(id, prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new HttpError(400, 'params.prompt required');
  return { label: 'gen_source', weight: 1, cmd: 'bash', args: ['scripts/gen_images.sh', 'source', `input/${id}`, prompt.trim()] };
}
function stepGenMultiview(id, views) {
  return {
    label: 'gen_multiview',
    weight: views,
    cmd: 'bash',
    args: ['scripts/gen_images.sh', 'multiview', `input/${id}`, String(views)],
    parser: () => countLines(/->|skip existing/, views),
  };
}
function stepPrep(id) {
  return {
    label: 'prep_multiview',
    weight: 1,
    cmd: 'python3',
    args: ['scripts/prep_multiview.py', `input/${id}/multiview`, `input/${id}/multiview_prep`],
    prepare: async (step) => {
      const n = await countAzPngs(path.join(INPUT_DIR, id, 'multiview'));
      step.parser = () => countLines(/^\s+\S+\.png: scale/, n);
    },
  };
}
function stepDatasetMultiview(id, fovY) {
  return {
    label: 'dataset_multiview',
    weight: 0.3,
    cmd: 'python3',
    args: [],
    prepare: async (step) => {
      // Prefer the background-removed, aligned views when they exist.
      const prep = path.join(INPUT_DIR, id, 'multiview_prep');
      const src = (await countAzPngs(prep)) ? `input/${id}/multiview_prep` : `input/${id}/multiview`;
      await fsp.rm(path.join(WORK_DIR, `${id}_mv`), { recursive: true, force: true });
      step.args = ['scripts/known_orbit.py', src, `work/${id}_mv`, '--fov-y', String(fovY)];
    },
  };
}
function stepDatasetVideo(id, fps) {
  return {
    label: 'dataset_video',
    weight: 3,
    cmd: 'bash',
    args: ['scripts/video_to_dataset.sh', `input/${id}/orbit.mp4`, `work/${id}_video`, String(fps)],
    parser: colmapProgress,
  };
}
function stepsTrain(id, route, steps) {
  const ds = `work/${id}_${route === 'video' ? 'video' : 'mv'}`;
  return [
    { label: 'train', weight: 6, cmd: 'bash', args: ['scripts/train.sh', ds, `${ds}/out`, String(steps)], parser: () => brushProgress(steps) },
    {
      label: 'publish',
      weight: 0.1,
      cmd: 'python3',
      args: ['scripts/publish_model.py', `${id}_${route}`, `${ds}/out/splat_${steps}.ply`, ds],
      parser: () => null,
    },
  ];
}

async function buildSteps(type, id, params) {
  const p = params && typeof params === 'object' ? params : {};
  switch (type) {
    case 'gen_source':
      return [stepGenSource(id, p.prompt)];
    case 'gen_multiview':
      return [stepGenMultiview(id, intParam(p.views, 8, 1, 36, 'views'))];
    case 'prep_multiview':
      return [stepPrep(id)];
    case 'dataset_multiview':
      return [stepDatasetMultiview(id, numParam(p.fovY, 30, 5, 120, 'fovY'))];
    case 'dataset_video':
      return [stepDatasetVideo(id, numParam(p.fps, 6, 0.1, 60, 'fps'))];
    case 'train': {
      const route = p.route ?? 'multiview';
      if (route !== 'multiview' && route !== 'video') throw new HttpError(400, 'route must be multiview or video');
      return stepsTrain(id, route, intParam(p.steps, 7000, 1, 200000, 'steps'));
    }
    case 'pipeline_multiview': {
      const views = intParam(p.views, 8, 1, 36, 'views');
      const steps = intParam(p.steps, 7000, 1, 200000, 'steps');
      const hasSource = await exists(path.join(INPUT_DIR, id, 'source.png'));
      const hasPrompt = typeof p.prompt === 'string' && p.prompt.trim();
      if (!hasSource && !hasPrompt) throw new HttpError(400, 'no source.png for this subject: params.prompt required');
      const out = [];
      if (hasPrompt) out.push(stepGenSource(id, p.prompt));
      out.push(stepGenMultiview(id, views), stepPrep(id), stepDatasetMultiview(id, numParam(p.fovY, 30, 5, 120, 'fovY')));
      out.push(...stepsTrain(id, 'multiview', steps));
      return out;
    }
    default:
      throw new HttpError(400, `unknown job type ${type}`);
  }
}

function jobSummary(j) {
  return {
    id: j.id,
    type: j.type,
    subject: j.subject,
    params: j.params,
    status: j.status,
    step: j.stepLabel,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    endedAt: j.endedAt,
    progress: j.progress,
    error: j.error,
  };
}

function emit(job, ev) {
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of job.subscribers) res.write(data);
}

function logLine(job, line) {
  job.log.push(line);
  if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES);
  emit(job, { kind: 'log', line });
}

function setProgress(job, value) {
  const v = Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
  if (v === job.progress) return;
  job.progress = v;
  emit(job, { kind: 'progress', value: v });
}

function setStatus(job, status) {
  job.status = status;
  if (status === 'running') job.startedAt = new Date().toISOString();
  if (['done', 'error', 'cancelled'].includes(status)) {
    job.endedAt = new Date().toISOString();
    if (status === 'done') setProgress(job, 1);
  }
  emit(job, { kind: 'status', status });
  if (job.endedAt) {
    for (const res of job.subscribers) res.end();
    job.subscribers.clear();
  }
}

// Strip ANSI escapes; split on \n and \r (progress bars redraw with \r).
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
function lineSplitter(onLine) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk.toString('utf8');
      const parts = buf.split(/\r\n|\n|\r/);
      buf = parts.pop();
      for (const p of parts) {
        const l = p.replace(ANSI, '').trimEnd();
        if (l) onLine(l);
      }
    },
    flush() {
      const l = buf.replace(ANSI, '').trimEnd();
      buf = '';
      if (l) onLine(l);
    },
  };
}

function runStep(job, step, base, span) {
  return new Promise((resolve) => {
    logLine(job, `$ ${step.cmd} ${step.args.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
    const proc = spawn(step.cmd, step.args, {
      cwd: ROOT,
      detached: true, // own process group, so cancel can kill children (codex, colmap, brush)
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    job.proc = proc;
    // step.parser is a factory returning a per-run line parser (or nothing).
    const parse = (step.parser && step.parser()) || (() => null);
    const onLine = (line) => {
      logLine(job, line);
      try {
        const v = parse(line);
        if (typeof v === 'number') setProgress(job, base + span * v);
      } catch {
        /* progress parsing is best effort */
      }
    };
    const out = lineSplitter(onLine);
    const err = lineSplitter(onLine);
    proc.stdout.on('data', (d) => out.push(d));
    proc.stderr.on('data', (d) => err.push(d));
    proc.on('error', (e) => {
      logLine(job, `failed to start ${step.cmd}: ${e.message}`);
    });
    proc.on('close', (code, signal) => {
      out.flush();
      err.flush();
      job.proc = null;
      resolve({ code, signal });
    });
  });
}

async function runJob(job) {
  setStatus(job, 'running');
  setProgress(job, 0);
  const total = job.steps.reduce((s, x) => s + x.weight, 0);
  let done = 0;
  try {
    for (const step of job.steps) {
      if (job.cancelRequested) break;
      job.stepLabel = step.label;
      logLine(job, `== ${step.label}`);
      if (step.prepare) await step.prepare(step);
      const base = done / total;
      const span = step.weight / total;
      const { code, signal } = await runStep(job, step, base, span);
      if (job.cancelRequested) break;
      if (code !== 0) {
        job.error = `${step.label} failed (${signal ? 'signal ' + signal : 'exit code ' + code})`;
        logLine(job, job.error);
        setStatus(job, 'error');
        return;
      }
      done += step.weight;
      setProgress(job, done / total);
    }
    if (job.cancelRequested) {
      logLine(job, 'cancelled');
      setStatus(job, 'cancelled');
    } else {
      job.stepLabel = null;
      setStatus(job, 'done');
    }
  } catch (e) {
    job.error = e.message;
    logLine(job, `error: ${e.message}`);
    setStatus(job, 'error');
  }
}

async function pump() {
  if (current) return;
  const next = queue.shift();
  if (!next) return;
  current = next;
  try {
    await runJob(next);
  } finally {
    current = null;
    setImmediate(pump);
  }
}

async function createJob(body) {
  const type = body.type;
  const id = checkId(body.subject);
  if (!(await exists(path.join(INPUT_DIR, id)))) throw new HttpError(404, `subject ${id} does not exist`);
  const steps = await buildSteps(type, id, body.params);
  const job = {
    id: crypto.randomBytes(6).toString('hex'),
    type,
    subject: id,
    params: body.params ?? {},
    status: 'queued',
    stepLabel: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    endedAt: null,
    progress: null,
    error: null,
    steps,
    log: [],
    subscribers: new Set(),
    proc: null,
    cancelRequested: false,
  };
  jobs.set(job.id, job);
  queue.push(job);
  setImmediate(pump);
  return job;
}

function killGroup(proc, signal) {
  try {
    process.kill(-proc.pid, signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

function cancelJob(job) {
  if (job.status === 'queued') {
    const i = queue.indexOf(job);
    if (i >= 0) queue.splice(i, 1);
    job.cancelRequested = true;
    setStatus(job, 'cancelled');
    return;
  }
  if (job.status !== 'running') return;
  job.cancelRequested = true;
  const proc = job.proc;
  if (proc) {
    killGroup(proc, 'SIGTERM');
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) killGroup(proc, 'SIGKILL');
    }, 3000).unref();
  }
}

function jobEvents(req, res, job) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  for (const line of job.log) send({ kind: 'log', line });
  if (job.progress !== null) send({ kind: 'progress', value: job.progress });
  send({ kind: 'status', status: job.status });
  if (job.endedAt) return res.end();
  job.subscribers.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(ping);
    job.subscribers.delete(res);
  });
}

// ---------------------------------------------------------------- scenes

async function listScenes() {
  return (await listDir(SCENES_DIR)).filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name.slice(0, -5));
}

function sceneFile(name) {
  if (!NAME_RE.test(name)) throw new HttpError(400, 'scene name must match ^[A-Za-z0-9_-]+$');
  return safeJoin(SCENES_DIR, name + '.json');
}

// ---------------------------------------------------------------- rendering

const renders = new Map(); // id -> { name, fps, width, height, format, dir, frames:Set }

async function renderCreate(body) {
  const name = body.name;
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new HttpError(400, 'name must match ^[A-Za-z0-9_-]+$');
  const format = body.format ?? 'mp4';
  if (!['mp4', 'webm', 'png'].includes(format)) throw new HttpError(400, 'format must be mp4, webm or png');
  const r = {
    id: crypto.randomBytes(6).toString('hex'),
    name,
    format,
    fps: numParam(body.fps, 30, 1, 240, 'fps'),
    width: intParam(body.width, null, 1, 16384, 'width'),
    height: intParam(body.height, null, 1, 16384, 'height'),
    frames: new Set(),
  };
  r.dir = path.join(RENDER_TMP, r.id);
  await fsp.mkdir(r.dir, { recursive: true });
  renders.set(r.id, r);
  return r;
}

function getRender(id) {
  const r = renders.get(id);
  if (!r) throw new HttpError(404, 'unknown render id');
  return r;
}

const frameName = (n) => `frame_${String(n).padStart(6, '0')}.png`;

async function renderFrame(req, r, nStr) {
  if (!/^\d{1,6}$/.test(nStr)) throw new HttpError(400, 'frame number must be 0..999999');
  const n = Number(nStr);
  const file = path.join(r.dir, frameName(n));
  await bodyToFile(req, file, MAX_FRAME);
  r.frames.add(n);
  return n;
}

async function renderFinish(r) {
  const count = r.frames.size;
  if (!count) throw new HttpError(400, 'no frames uploaded');
  for (let i = 0; i < count; i++) {
    if (!r.frames.has(i)) throw new HttpError(400, `frames must be numbered 0..${count - 1} without gaps (missing ${i})`);
  }
  await fsp.mkdir(RENDERS_DIR, { recursive: true });
  const pattern = path.join(r.dir, 'frame_%06d.png');
  let dest;
  if (r.format === 'png') {
    dest = path.join(RENDERS_DIR, r.name);
    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.rename(r.dir, dest);
    renders.delete(r.id);
    return { file: toUrl(dest) + '/', frames: count };
  }
  const even = 'pad=ceil(iw/2)*2:ceil(ih/2)*2';
  const args = ['-loglevel', 'error', '-y', '-framerate', String(r.fps), '-start_number', '0', '-i', pattern];
  if (r.format === 'mp4') {
    dest = path.join(RENDERS_DIR, r.name + '.mp4');
    args.push('-vf', even, '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', dest);
  } else {
    dest = path.join(RENDERS_DIR, r.name + '.webm');
    args.push('-vf', even, '-c:v', 'libvpx-vp9', '-crf', '24', '-b:v', '0', '-row-mt', '1', '-pix_fmt', 'yuv420p', dest);
  }
  const res = await run('ffmpeg', args);
  if (res.code !== 0) throw new HttpError(500, 'ffmpeg failed: ' + res.out.trim().slice(-2000));
  await fsp.rm(r.dir, { recursive: true, force: true });
  renders.delete(r.id);
  return { file: toUrl(dest), frames: count };
}

// ---------------------------------------------------------------- router

async function handleApi(req, res, url, parts) {
  const m = req.method;
  // parts: path segments after /api
  const [a, b, c, d] = parts;

  if (a === 'subjects' && parts.length === 1) {
    if (m === 'GET') return sendJson(res, 200, await listSubjects());
    if (m === 'POST') {
      const body = await readJsonBody(req);
      const id = checkId(body.id);
      const dir = path.join(INPUT_DIR, id);
      const existed = await exists(dir);
      await fsp.mkdir(dir, { recursive: true });
      return sendJson(res, existed ? 200 : 201, await subjectInfo(id, await readModelIndex()));
    }
  }
  if (a === 'upload' && parts.length === 1 && m === 'POST') return handleUpload(req, res, url);
  if (a === 'models' && parts.length === 1 && m === 'GET') return sendJson(res, 200, await readModelIndex());

  if (a === 'jobs') {
    if (parts.length === 1 && m === 'GET') return sendJson(res, 200, [...jobs.values()].map(jobSummary));
    if (parts.length === 1 && m === 'POST') {
      const job = await createJob(await readJsonBody(req));
      return sendJson(res, 201, { id: job.id });
    }
    const job = jobs.get(b);
    if (!job) throw new HttpError(404, 'unknown job');
    if (parts.length === 2 && m === 'GET') return sendJson(res, 200, jobSummary(job));
    if (parts.length === 3 && c === 'events' && m === 'GET') return jobEvents(req, res, job);
    if (parts.length === 3 && c === 'cancel' && m === 'POST') {
      cancelJob(job);
      return sendJson(res, 200, { ok: true, status: job.status });
    }
  }

  if (a === 'scenes') {
    if (parts.length === 1 && m === 'GET') return sendJson(res, 200, await listScenes());
    if (parts.length === 2) {
      const file = sceneFile(b);
      if (m === 'GET') {
        let text;
        try {
          text = await fsp.readFile(file, 'utf8');
        } catch {
          throw new HttpError(404, 'scene not found');
        }
        res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
        return res.end(text);
      }
      if (m === 'PUT') {
        const buf = await readBody(req, MAX_JSON);
        try {
          JSON.parse(buf.toString('utf8'));
        } catch {
          throw new HttpError(400, 'invalid JSON body');
        }
        await fsp.mkdir(SCENES_DIR, { recursive: true });
        const tmp = file + '.tmp';
        await fsp.writeFile(tmp, buf);
        await fsp.rename(tmp, file);
        return sendJson(res, 200, { ok: true });
      }
    }
  }

  if (a === 'render') {
    if (parts.length === 1 && m === 'POST') {
      const r = await renderCreate(await readJsonBody(req));
      return sendJson(res, 201, { id: r.id });
    }
    const r = getRender(b);
    if (parts.length === 4 && c === 'frame' && m === 'POST') {
      const n = await renderFrame(req, r, d);
      return sendJson(res, 200, { ok: true, frame: n });
    }
    if (parts.length === 3 && c === 'finish' && m === 'POST') return sendJson(res, 200, await renderFinish(r));
    if (parts.length === 3 && c === 'abort' && m === 'POST') {
      await fsp.rm(r.dir, { recursive: true, force: true });
      renders.delete(r.id);
      return sendJson(res, 200, { ok: true });
    }
  }
  throw new HttpError(404, 'no such endpoint');
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    const parts = pathname.slice(5).split('/').filter(Boolean).map(decodePath);
    return handleApi(req, res, url, parts);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');

  if (pathname.startsWith('/files/')) {
    const rel = decodePath(pathname.slice(7));
    const top = rel.split('/')[0];
    if (!['input', 'work', 'renders'].includes(top)) throw new HttpError(403, 'only input/, work/ and renders/ are served');
    const file = safeJoin(ROOT, rel);
    const topDir = path.join(ROOT, top);
    if (file !== topDir && !file.startsWith(topDir + path.sep)) throw new HttpError(403, 'path outside root');
    return serveFile(req, res, file, { listing: true });
  }
  if (pathname.startsWith('/models/')) {
    return serveFile(req, res, safeJoin(MODELS_DIR, decodePath(pathname.slice(8))));
  }
  const rel = decodePath(pathname === '/' ? 'index.html' : pathname.slice(1));
  return serveFile(req, res, safeJoin(WEB_DIR, rel));
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (res.headersSent) return res.end();
    sendJson(res, status, { error: e.message });
  });
});
server.requestTimeout = 0; // large uploads and long render finishes

let listening = 0;
for (const host of HOSTS) {
  const s = host === HOSTS[0] ? server : http.createServer(server.listeners('request')[0]);
  s.requestTimeout = 0;
  s.on('error', (e) => {
    if (host === HOSTS[0]) {
      console.error(`cannot listen on ${host}:${PORT}: ${e.message}`);
      process.exit(1);
    }
  });
  s.listen(PORT, host, () => {
    if (listening++ === 0) console.log(`Splat Studio server on http://localhost:${PORT}/  (root ${ROOT})`);
  });
}

function shutdown() {
  if (current?.proc) killGroup(current.proc, 'SIGTERM');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
