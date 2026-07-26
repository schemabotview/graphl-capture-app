# CLAUDE.md — graphl-capture-app (the 4K capture pipeline)

This is one repo in the **GraphL** platform. For the platform-wide context (domain model,
content wiring, the other apps), read the umbrella file `../CLAUDE.md` first — this file is the
working context for *this* repo only. `README.md` here is the user-facing usage guide (CLI, env,
prerequisites); don't duplicate it — this file is the "how it works / what not to break" layer.

---

## Working agreement (HARD RULE — inherited from `../CLAUDE.md`)

The owner drives; build **one reviewed slice at a time**. Propose → get approval → implement one
small slice → stop for review → continue. Explain before writing, no silent scaffolding, keep
diffs small and named.

---

## What this repo is

A Puppeteer harness that drives `graphl-render-app` in **capture mode** (`?capture=1`) and records
a lesson into **4K (3840×2160)** H.264/AAC video. It ships no content and no UI: it launches
headless Chromium, deep-links each section, waits for the app's `window.__captureReady` handshake,
screencasts the painted frame, and muxes narration with `ffmpeg`.

**It does not own content or scenes.** Code (the render app) comes from the dev server at
`APP_URL`; content (manifest / slides / audio) is fetched from GitHub raw (`CONTENT_BASE`). To
run anything here you need the **render-app dev server up** (`cd ../graphl-render-app && npm run dev`)
and **ffmpeg/ffprobe on PATH** (Homebrew ffmpeg preferred — it has libx264).

## Files (everything lives in `capture/`)

- **`record-section.mjs`** — the CAPTURE half + the shared library. Exports config, helpers, and
  `captureModule`. Runnable standalone (records changed/`--only`/missing sections, reuses the rest).
- **`record-module.mjs`** — the MERGE half. `-c copy` concats a module's segments → the master.
  `--record` first runs `captureModule`, making it the one-command full pipeline.
- **`thumb.mjs`** — screenshots the render-app's **module opener** (which *is* the thumbnail) at 4K,
  downscales to 1280×720. No separate design to keep in sync.
- `out/<concept>/<moduleId>.mp4` — module masters (+ `.png` thumbnails). gitignored.
- `segments/<concept>/<moduleId>/NN-slug.mp4` (+ `.json` sidecar) — per-section segments, **persist**
  across runs (this is the incremental cache). gitignored.
- `.tmp/` — regenerable webm/wav intermediates. gitignored.

npm scripts: `capture` = record-module `--record`; `capture:section` = record-section;
`capture:merge` = record-module (merge only); `thumb` = thumb.mjs.

## How one section is recorded (the core invariant)

Park on the dark pre-roll → set `window.__captureReady = false` and set `location.hash` to the
section → `waitForFunction(__captureReady === true)` (slide fetched + scene mounted) → **then**
start `page.screencast()`, so frame 0 is the finished, painted section and the camera's
overview→focus choreography starts in sync. Hold the opener/sting lead, `sleep(waitMs)` (the clip's
duration), stop. Segment audio = lead (opener/sting) + the section's clip, mirroring the video
timeline. §01's lead is the **opener** (`OPENER_MS`, its intro); §02+ get a **section sting**
(`SECTION_STING_MS`).

## Things that are easy to break

- **`-c copy` concat requires uniform segments.** Every segment is muxed with CONCAT-SAFE settings
  (`encodeSegment`): forced CFR at `FPS`, `-video_track_timescale 90000`, gradfun deband, identical
  codec/pix/audio params. If you touch encode settings, they must stay identical across all segments
  or the merge glitches at the joins.
- **The fingerprint cache keys on CONTENT, not render-app code.** A segment re-records only when its
  fingerprint changes: `audioHash`, `slideHash`, `waitMs`, `leadMs`, `focus`/`highlight`/`scene`,
  `scale`, `fps`, `enc` (encode signature). **After changing the render app, pass `--force`** —
  otherwise unchanged content reuses stale segments. Bump the fingerprint `v:` if you change what
  should invalidate the cache.
- **SCALE enlarges the viewport, not deviceScaleFactor.** `page.screencast()` records at CSS
  viewport size and ignores DSF, so we launch at `1920·SCALE × 1080·SCALE`; the render-app's
  StageFrame auto-scales its fixed 1920×1080 stage to fill it. `SCALE=2` = true 4K.
- **Audio rates differ** (24 kHz Chatterbox clips vs 44.1 kHz synthesized sting). `concatAudio` uses
  the concat **filter** with per-input resample — the concat **demuxer** silently corrupts the
  timeline on mismatched rates. Missing audio → 6s of silence (`audioHash = 'silence6'`).
- **The sting/opener bell is synthesized** (a three-note sine arpeggio in `prepareStingAudio`) — no
  audio asset to manage. Keep opener/section stings the identical sound.
- **The two files share config via import.** `record-module.mjs` imports helpers + `captureModule`
  from `record-section.mjs`; keep exports stable when refactoring. Both guard their CLI with an
  `isMain` realpath check so importing doesn't fire the CLI.

## Env knobs (see README for the full list)

`APP_URL`, `CONCEPT` + `CONTENT_BASE` (capture a non-default concept), `SCALE`, `FPS`,
`FFMPEG_ENCODE`/`VIDEO_CODEC`/`VIDEO_CRF`/`VIDEO_PRESET`/`VIDEO_BITRATE`, `OPENER_MS`,
`SECTION_STING_MS` (0 disables; `NO_SECTION_STING` = silent pause), `MAX_SECTIONS` (smoke-test cap),
`WAIT_MS` (fast visual test — desyncs audio), `OUT_NAME` (master stem, avoid clobbering a real one).
CLI: `--only <slug-substr | N[,...]>`, `--force`.

## Reference

`~/Products/graphl-movie/CAPTURE.md` — the mature implementation of this exact pipeline. Use it as
the pattern; we're re-deriving a clean capture app for GraphL, not copying it wholesale.
