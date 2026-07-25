# graphl-capture-app

The **capture pipeline** for GraphL: a Puppeteer harness that drives the
[`graphl-render-app`](../graphl-render-app) in its **capture mode** (`?capture=1`) and records a lesson
into **4K (3840×2160)** video. Part of the GraphL platform, alongside the render app and
the content repos.

It ships no content and no UI — it launches a headless Chromium, deep-links each section,
waits for the app's `window.__captureReady` handshake, and screencasts a fully-painted
frame. `ffmpeg` muxes the narration `.wav` and stitches per-section segments into the
module master.

## Prerequisites

- The **render-app dev server running** (`cd ../graphl-render-app && npm run dev`) — capture drives it.
- **ffmpeg / ffprobe** on PATH (Homebrew ffmpeg recommended — has libx264).
- `npm install` here (downloads Chromium via Puppeteer).

**Resolution:** `SCALE` (default `2`) sets the capture resolution — `2` → 3840×2160, `1` →
1920×1080. The render-app scales its fixed 1920×1080 stage to fill a SCALE× viewport, so text
re-rasterizes crisp. `APP_URL` (default `http://localhost:5173`), `CONCEPT`, and `CONTENT_BASE`
are overridable.

## Recording a module

```bash
npm run capture 01-foundations-and-the-cluster           # capture changed sections + merge → 4K master
npm run capture:section 01-foundations-and-the-cluster   # capture only → per-section segment MP4s
npm run capture:merge   01-foundations-and-the-cluster   # merge existing segments → master (no browser)
```

Output: `capture/out/<concept>/<moduleId>.mp4` (H.264/AAC), concatenated with `-c copy` from
the per-section segments in `capture/segments/<concept>/<moduleId>/`. A **cold run records in
real time** (each section lasts its narration `.wav`); a **re-run reuses unchanged segments**
(fingerprinted on audio + slide + timing + `focus`/`highlight` + encode settings) and only
re-records what changed.

- `--only <slug-substr | N>` — scope to matching sections (a re-render of one section)
- `--force` — ignore the cache, re-record every section
- Env: `MAX_SECTIONS` (cap for a smoke test), `WAIT_MS` (fast visual test; desyncs audio),
  `OUT_NAME` (master stem, avoid clobbering a real master), `SECTION_STING_MS`, `OPENER_MS`.

## Thumbnail

```bash
npm run thumb 01-foundations-and-the-cluster              # → capture/out/<concept>/<moduleId>.png (1280×720)
npm run thumb 01-foundations-and-the-cluster -- --full4k  # keep the 3840×2160 grab
```

The **module opener IS the thumbnail** — `thumb.mjs` screenshots the render-app's opener card
(whole scene + concept title panel) at 4K and downscales to 1280×720 (Lanczos), so there's no
separate design to keep in sync. In capture mode the opener holds indefinitely (it waits for a
`capture-opener-start` event the script never sends), so the grab never races the fade.

> Next: the `meta.txt` generator (description + section timings) — likely its own content-gen repo.
