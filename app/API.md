# Splat Studio — local API contract

`node app/server.mjs` (no npm dependencies, Node 24) serves the GUI and this API on
`http://localhost:5180`. The workspace root is the repository root.

## Static

| Path | Serves |
|---|---|
| `/` | `app/web/index.html` and everything under `app/web/` |
| `/files/<path>` | read-only files under `input/`, `work/`, `renders/` (path relative to repo root, e.g. `/files/input/subject01/source.png`) |
| `/models/<file>` | `viewer/models/<file>` (trained splats, `.ply`) |

## Subjects

A *subject* is one fictional person: `input/<id>/`.

`GET /api/subjects` →
```json
[{
  "id": "subject01",
  "source": "/files/input/subject01/source.png",            // null if missing
  "multiview": ["/files/input/subject01/multiview/view_00_az000.png", "..."],
  "multiviewPrepared": ["/files/input/subject01/multiview_prep/view_00_az000.png", "..."],
  "video": "/files/input/subject01/orbit.mp4",              // null if missing
  "datasets": [{ "name": "subject01_mv", "route": "multiview", "images": 8 }],
  "models":   [{ "name": "subject01_multiview", "file": "subject01_multiview.ply", "url": "/models/subject01_multiview.ply", "up": [0,0,1] }]
}]
```

`POST /api/subjects` body `{ "id": "subject02" }` → creates `input/subject02/`. `id` must match `^[a-z0-9_]+$`.

`POST /api/upload?subject=<id>&kind=source|video` raw request body (PNG/JPEG or MP4) →
saved as `input/<id>/source.png` (converted to PNG via ffmpeg if needed) or `input/<id>/orbit.mp4`.

## Models

`GET /api/models` → contents of `viewer/models/index.json` with `url` added:
`[{ "name", "file", "url", "up": [x,y,z] }]`. `up` is the subject's up axis in the splat's
own coordinates (rotate it to +Y to stand the subject upright).

## Jobs (long-running pipeline steps)

`POST /api/jobs` body `{ "type": <type>, "subject": "<id>", "params": { ... } }` → `{ "id": "<jobId>" }`

| type | params | runs |
|---|---|---|
| `gen_source` | `{ "prompt": "description of the person" }` | `scripts/gen_images.sh source input/<id> "<prompt>"` |
| `gen_multiview` | `{ "views": 8 }` | `scripts/gen_images.sh multiview input/<id> <views>` |
| `prep_multiview` | `{}` | `scripts/prep_multiview.py` (align framing + remove background) |
| `dataset_multiview` | `{ "fovY": 30 }` | `scripts/known_orbit.py` → `work/<id>_mv` |
| `dataset_video` | `{ "fps": 6 }` | `scripts/video_to_dataset.sh` → `work/<id>_video` |
| `train` | `{ "route": "multiview"|"video", "steps": 7000 }` | `scripts/train.sh` then `scripts/publish_model.py` → model `<id>_<route>` |
| `pipeline_multiview` | `{ "prompt"?, "views": 8, "steps": 7000 }` | gen_source (if prompt given / source missing) → gen_multiview → prep → dataset → train |

`GET /api/jobs` → `[{ "id", "type", "subject", "status": "queued|running|done|error|cancelled", "startedAt", "endedAt", "progress": 0..1|null }]`
(jobs run one at a time, FIFO).

`GET /api/jobs/<id>/events` → Server-Sent Events. Each `message` event is JSON:
`{ "kind": "log", "line": "..." }`, `{ "kind": "progress", "value": 0.42 }`, `{ "kind": "status", "status": "done" }`.
On connect the server replays the log so far.

`POST /api/jobs/<id>/cancel` → kills the process.

## Scenes (animation documents)

`GET /api/scenes` → `["main", ...]` (files `scenes/<name>.json`)
`GET /api/scenes/<name>` → scene JSON (format owned by the frontend; server stores it verbatim)
`PUT /api/scenes/<name>` body scene JSON → `{ "ok": true }`

## Rendering video

Frames are rendered in the browser (deterministic, frame by frame) and uploaded:

1. `POST /api/render` body `{ "name": "shot01", "fps": 30, "width": 1920, "height": 1080, "format": "mp4"|"png"|"webm" }` → `{ "id": "<renderId>" }`
2. `POST /api/render/<renderId>/frame/<n>` raw PNG body (n = 0,1,2,…)
3. `POST /api/render/<renderId>/finish` → `{ "file": "/files/renders/shot01.mp4" }`
   (mp4: H.264 yuv420p crf 18; png: zip-free folder `renders/shot01/` and `file` points to the folder listing)
`POST /api/render/<renderId>/abort` → deletes temp frames.
