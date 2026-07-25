# graphl-capture-app

The **capture pipeline** for GraphL: a Puppeteer harness that drives the
[`render-app`](../render-app) in its **capture mode** (`?capture=1`) and records a lesson
into **4K (3840×2160)** video. Part of the GraphL platform, alongside the render app and
the content repos.

It ships no content and no UI — it launches a headless Chromium, deep-links each section,
waits for the app's `window.__captureReady` handshake, and screencasts a fully-painted
frame. `ffmpeg` muxes the narration `.wav` and stitches per-section segments into the
module master.

## Prerequisites

- The **render-app dev server running** (`cd ../render-app && npm run dev`) — capture drives it.
- **ffmpeg / ffprobe** on PATH (Homebrew ffmpeg recommended — has libx264).
- `npm install` here (downloads Chromium via Puppeteer).

## Scripts

```bash
npm run shot 01-03-the-cluster        # 4K PNG of one section (capture-mode smoke test)
SCALE=1 npm run shot 01-03-the-cluster # 1080p instead of 4K
```

`SCALE` (default `2`) sets the capture resolution: `2` → 3840×2160, `1` → 1920×1080. The
render-app scales its fixed 1920×1080 stage to fill a SCALE× viewport, so text re-rasterizes
crisp. `APP_URL` (default `http://localhost:5173`), `CONCEPT`, and `MODULE` are overridable.

> The full video recorder (`record-section.mjs` per-section 4K segments + `record-module.mjs`
> `-c copy` merge → module master) is the next slice.
