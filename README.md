# 生成画像の人物 → 3D Gaussian Splatting（最小構成）

AI 生成の人物画像1枚から 3DGS モデルを作り、ブラウザで見るまでの最小パイプライン。
「1枚から多視点を作る」工程を **動画ルート** と **マルチビュールート** の2通りで比較できる。

```
                       ┌─ 動画ルート ──── orbit.mp4 ─→ video_to_dataset.sh (ffmpeg + COLMAP SfM) ─┐
source.png (1枚) ──────┤                                                                         ├→ train.sh (Brush) → publish_model.py → viewer/
                       └─ マルチビュー ── multiview/*_azDDD.png ─→ prep_multiview.py (背景除去+構図合わせ) ─→ known_orbit.py (カメラを円周上に仮定) ┘
```

## なぜ2ルートで前処理が違うか

- **動画ルート**: フレームが多く隣同士がよく似ているので、COLMAP の SfM でカメラ位置を実測できる。
- **マルチビュールート**: 生成された4〜8枚は視点間の対応点が少なく、SfM がまず通らない。
  そこで「方位角 0/45/90…° でカメラが被写体を一周した」と**仮定してカメラ位置を計算で置く**。
  生成画像がその角度・構図を守れていないぶん、ぼやけや破綻として結果に出る（それが比較ポイント）。

座標の約束（全スクリプト共通）: Z が上、被写体は z=0 に立ち -Y を向く。
方位角 0=正面、90=被写体の**左**側から見た図、180=背面、270=右側。

## 環境（Intel Mac / CUDA なし）

| 用途 | ツール | 入れ方 |
|---|---|---|
| 画像生成 | Codex CLI の画像生成 | `codex` にログイン済みであること |
| SfM | COLMAP 4.2 (CPU) | `conda create -p .env/colmap -c conda-forge colmap`（Homebrew 版は macOS 26 の CLT 非対応でビルド不可） |
| 3DGS 学習 | Brush v0.3.0 (wgpu/Metal) | Intel Mac 向けバイナリが無いので `cd .tools/brush && cargo build --release` |
| 表示 | three.js + Spark 2.4 | CDN 読み込み、ビルド不要 |
| 前処理 (Python) | numpy / Pillow / scipy / onnxruntime | `uv venv .env/py --python 3.12 && uv pip install --python .env/py/bin/python numpy pillow scipy onnxruntime`（システムの python3 は 3.14 で未導入） |
| GUI サーバ | Node 24 | npm 不要（依存ゼロ） |

`scripts/prep_multiview.py` は `python3` で起動しても、numpy 等が無ければ自動で `.env/py/bin/python` で
再実行する。背景除去モデル（rembg 配布の `isnet-general-use.onnx`, 約 170MB）は初回に `.tools/models/` へ自動ダウンロード。
（`rembg` パッケージ自体は依存の llvmlite が Intel Mac / py3.12 でビルドできないため使わず、onnxruntime で直接推論する。）

## 手順

```bash
# 0) 元画像
scripts/gen_images.sh source input/subject01 "20代の日本人女性、白T・ジーンズ…"

# --- マルチビュールート ---
scripts/gen_images.sh multiview input/subject01 8            # Codex で 7 方向を生成（正面は source をコピー）
python3 scripts/prep_multiview.py input/subject01/multiview input/subject01/multiview_prep   # 背景を透明化し、頭頂・足元の行を正面に揃える
python3 scripts/known_orbit.py input/subject01/multiview_prep work/subject01_mv --fov-y 30
scripts/train.sh work/subject01_mv work/subject01_mv/out 7000
python3 scripts/publish_model.py subject01_multiview work/subject01_mv/out/splat_7000.ply work/subject01_mv

# --- 動画ルート ---
# input/subject01/orbit.mp4 を用意（source.png を先頭フレームに、カメラが人物の周りを一周する動画）
scripts/video_to_dataset.sh input/subject01/orbit.mp4 work/subject01_video 6
scripts/train.sh work/subject01_video work/subject01_video/out 7000
python3 scripts/publish_model.py subject01_video work/subject01_video/out/splat_7000.ply work/subject01_video

# --- 表示 (単体ビューア) ---
python3 -m http.server -d viewer 8000   # → http://localhost:8000/?model=subject01_video
```

### 透明背景と Brush

`multiview_prep/` の画像は RGBA（背景 alpha=0）。Brush v0.3.0 は RGBA 入力を premultiply して黒背景で描画し、
描画 alpha と入力 alpha の L1 損失を `--match-alpha-weight`（既定 0.1）で加える。0.1 だと背景側の暗い floater が
ほぼ罰されないので、`train.sh` は 1.0 を渡す（`ALPHA_WEIGHT=0.3 scripts/train.sh ...` で変更可）。
合成データ 1500 step で、視体積（全ビューのシルエット）外にある splat の不透明度合計が 108 → 35 に減った。
alpha の無い画像（動画ルート）には影響しない。

カメラ距離: `prep_multiview.py` は正面ビューで人物が縦に占める割合を `multiview_prep/framing.json` に書き、
`known_orbit.py` はそれに合わせて半径を決める（subject01 は縦 93.4% → fovY 30° で半径 3.50、身長 1.75 換算）。
`--radius` を明示すればそちらが優先。

## GUI (Splat Studio)

```bash
node app/server.mjs        # → http://localhost:5180/   (npm install 不要、Node 24 の標準モジュールのみ)
```

API は `app/API.md`。ジョブ（生成・前処理・学習）は1本ずつ FIFO で実行され、ログは SSE で流れる。
レンダリング結果は `renders/`（git 管理外）、アニメーション（シーン）は `scenes/<name>.json`（git 管理）に保存される。

## パイプライン検証用の合成データ

AI 生成なしで全工程を確認するため、Blender で簡易人型を周回レンダリングする。
マルチビュー側は正解カメラ（views.json）付き。

```bash
/Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/blender_testsubject.py -- --out input/synthetic
scripts/video_to_dataset.sh input/synthetic/orbit.mp4 work/synthetic_video 12   # 48/48 枚登録, 再投影誤差 0.35px
python3 scripts/prep_multiview.py input/synthetic/multiview input/synthetic/multiview_prep   # views.json があるので構図合わせはせず背景除去のみ
python3 scripts/known_orbit.py input/synthetic/multiview_prep work/synthetic_multiview
scripts/train.sh work/synthetic_multiview work/synthetic_multiview/out 1500
python3 scripts/publish_model.py synthetic_multiview work/synthetic_multiview/out/splat_1500.ply work/synthetic_multiview   # up=[0,0,1]
```

座標の確認: Brush は COLMAP の座標をそのまま使い、出力 .ply にも変換をかけない（ヘッダの `Vertical axis: y` は
コメントのみ）。synthetic_video で COLMAP 疎点群から最寄り splat 中心までの距離は中央値 0.0005。
したがって `publish_model.py` がカメラから推定する `up` は .ply の座標系でそのまま正しい。
