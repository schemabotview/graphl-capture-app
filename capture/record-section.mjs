// record-section.mjs — the CAPTURE half of the video pipeline.
//
// Records a module's section(s) to self-contained segment MP4s (+ fingerprint sidecars) in
// capture/segments/<concept>/<module>/NN-slug.mp4. Merging the segments into the module
// master is the other half, record-module.mjs. This file is runnable on its own (records the
// changed / --only / missing sections, reuses the rest) AND is imported by record-module for
// its shared config + helpers + `captureModule` (the --record one-command path).
//
// How one section is recorded: park on the app's dark pre-roll (capture mode), deep-link the
// section and wait until the app flips `window.__captureReady` true (slide fetched + scene
// mounted), THEN start the Puppeteer screencast — so frame 0 is the painted section and the
// camera's overview→focus choreography starts in sync. Hold the sting/opener, wait exactly the
// clip's duration, stop. The segment's audio is its sting + clip; video+audio mux with
// CONCAT-SAFE, constant-frame-rate settings shared by every segment (so record-module can
// `-c copy` them without re-encoding).
//
// Prerequisites: the render-app served at APP_URL (`npm run dev`), and ffmpeg/ffprobe on PATH.
// Usage: node capture/record-section.mjs <moduleId> [--only <tok[,tok]>] [--force]
//   node capture/record-section.mjs 01-foundations-and-the-cluster            # changed/missing only
//   node capture/record-section.mjs 01-foundations-and-the-cluster --only cluster  # slug substring
//   node capture/record-section.mjs 01-foundations-and-the-cluster --only 3   # the 3rd section
//   node capture/record-section.mjs 01-foundations-and-the-cluster --force     # every section

import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))

// ---- config (module-independent; env-overridable) -------------------------------------
export const APP_URL = process.env.APP_URL ?? 'http://localhost:5173'
export const CONCEPT = process.env.CONCEPT ?? 'apache-spark'
export const CONTENT_BASE =
  process.env.CONTENT_BASE ?? 'https://raw.githubusercontent.com/schemabotview/apache-spark-ct/main'

const W = 1920
const H = 1080
// Capture at SCALE× resolution for a crisp master. page.screencast() records at the CSS
// viewport size (it ignores deviceScaleFactor), so we enlarge the VIEWPORT to W·SCALE ×
// H·SCALE: the render-app's StageFrame auto-scales the fixed 1920×1080 stage to fill it, so
// text re-rasterizes crisp at SCALE× and the layout is unchanged. SCALE=2 = a true 4K master.
export const SCALE = process.env.SCALE ? +process.env.SCALE : 2
const CW = W * SCALE
const CH = H * SCALE
// Time the module opener occupies the frame (hold + fade); keep in sync with
// ModuleOpener.OPENER_HOLD_MS (3000) + its 700ms fade. §01's audio gets this lead silence.
export const OPENER_MS = process.env.OPENER_MS ? +process.env.OPENER_MS : 3700
// Per-section lead gap (§02+): the brand bell plays and the frame holds on the section banner
// + whole scene before the camera pans to focus. SECTION_STING_MS=0 disables it;
// NO_SECTION_STING keeps the pause but silent. §01 has none — the opener is its intro.
export const SECTION_STING_MS = process.env.SECTION_STING_MS ? +process.env.SECTION_STING_MS : 2800

// Final-encode quality. Prefer a Homebrew ffmpeg with libx264 (much better than non-GPL
// libopenh264, and the deband filter kills dark-gradient banding). Falls back to Apple
// hardware, then openh264. Override with env if needed.
export const FFMPEG_ENCODE =
  process.env.FFMPEG_ENCODE ??
  ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(existsSync) ??
  'ffmpeg'
const HAS_X264 = FFMPEG_ENCODE !== 'ffmpeg' // brew builds ship libx264
export const VIDEO_CODEC = process.env.VIDEO_CODEC ?? (HAS_X264 ? 'libx264' : 'h264_videotoolbox')
// Constant frame rate for every segment. `-c copy` concat (record-module) needs identical
// codec params AND a stable timebase across segments — the raw screencast is variable-rate,
// so we normalize each segment to CFR at this fps.
export const FPS = process.env.FPS ? +process.env.FPS : 30
const IS_X26X = /^libx26[45]$/.test(VIDEO_CODEC)
// A signature of the encode settings — part of each segment's fingerprint, so a quality/scale
// change invalidates the cached segments and re-records them (keeps the master uniform).
const ENCODE_SIG = IS_X26X
  ? `${VIDEO_CODEC}:crf${process.env.VIDEO_CRF ?? '18'}:${process.env.VIDEO_PRESET ?? 'slow'}`
  : `${VIDEO_CODEC}:b${process.env.VIDEO_BITRATE ?? '16M'}`

// ---- small helpers --------------------------------------------------------------------
export const slugOf = (s) => s.slide.replace(/^.*\//, '').replace(/\.slide$/, '')
export const pad2 = (n) => String(n).padStart(2, '0')
const sha = (data) => createHash('sha256').update(data).digest('hex').slice(0, 16)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}

// Per-module paths. Segments + sidecars persist (NOT in .tmp, which holds regenerable webm/
// wav intermediates) so an incremental re-render reuses the untouched ones.
export function paths(moduleId) {
  return {
    tmp: join(here, '.tmp', moduleId),
    outDir: join(here, 'out', CONCEPT),
    segDir: join(here, 'segments', CONCEPT, moduleId),
  }
}

async function ffprobeDuration(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
  ])
  return parseFloat(stdout.trim())
}

async function fetchBuf(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

// Concatenate audio inputs into one mono 44.1 kHz WAV. Uses the concat FILTER with a
// per-input resample because the clips (24 kHz Chatterbox) and the synthesized sting
// (44.1 kHz) differ, and the concat DEMUXER silently corrupts the timeline on mismatched
// rates. Single-input calls pass through cleanly (n=1).
async function concatAudio(inputs, dst) {
  const inArgs = inputs.flatMap((f) => ['-i', f])
  const chains = inputs.map((_, i) => `[${i}:a]aresample=44100[a${i}]`).join(';')
  const joins = inputs.map((_, i) => `[a${i}]`).join('')
  const filter = `${chains};${joins}concat=n=${inputs.length}:v=0:a=1[out]`
  await run('ffmpeg', ['-y', ...inArgs, '-filter_complex', filter, '-map', '[out]', '-ar', '44100', '-ac', '1', dst])
}

// Mux one segment's webm + audio → MP4 with CONCAT-SAFE settings: forced CFR, a fixed video
// timescale, deband (gradfun), and identical codec/pix/audio params for every segment so the
// record-module `-c copy` concat is glitch-free at the joins.
export async function encodeSegment(webm, audio, outMp4) {
  const quality = IS_X26X
    ? ['-preset', process.env.VIDEO_PRESET ?? 'slow', '-crf', process.env.VIDEO_CRF ?? '18']
    : ['-b:v', process.env.VIDEO_BITRATE ?? '16M']
  await run(FFMPEG_ENCODE, [
    '-y', '-i', webm, '-i', audio,
    '-map', '0:v:0', '-map', '1:a:0',
    '-vf', 'gradfun=strength=0.9:radius=16',
    '-r', String(FPS), '-vsync', 'cfr', '-video_track_timescale', '90000',
    '-c:v', VIDEO_CODEC, ...quality, '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '1',
    '-shortest', outMp4,
  ])
}

// Fetch the concept manifest and return the requested module (MAX_SECTIONS caps it for tests).
export async function fetchModule(moduleId) {
  const manifest = await (await fetch(`${CONTENT_BASE}/manifest.json`)).json()
  const mod = manifest.modules.find((m) => m.id === moduleId)
  if (!mod) throw new Error(`module ${moduleId} not in manifest`)
  if (process.env.MAX_SECTIONS) mod.sections = mod.sections.slice(0, +process.env.MAX_SECTIONS)
  return mod
}

// The brand bell (a synthesized three-note arpeggio — no asset to manage), reused by both the
// opener and the section stings so they're the identical sound. Returns the padded audio beds.
export async function prepareStingAudio(tmp) {
  mkdirSync(tmp, { recursive: true })
  const needBell = !process.env.NO_STING || (SECTION_STING_MS > 0 && !process.env.NO_SECTION_STING)
  const bell = join(tmp, 'bell.wav')
  if (needBell) {
    await run('ffmpeg', ['-y', '-filter_complex',
      'sine=f=587.33:d=2.4:sample_rate=44100,afade=t=out:st=0:d=2.4:curve=exp[a];' +
      'sine=f=880:d=2.4:sample_rate=44100,afade=t=out:st=0:d=2.4:curve=exp,adelay=200[b];' +
      'sine=f=1174.66:d=2.4:sample_rate=44100,afade=t=out:st=0:d=2.4:curve=exp,adelay=400[c];' +
      '[a][b][c]amix=inputs=3:normalize=0,volume=0.22,lowpass=f=3500,aformat=channel_layouts=mono',
      '-t', '2.6', bell])
  }
  const silenceTo = (dst, secs) =>
    run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', secs, dst])
  const bellTo = (dst, secs) =>
    run('ffmpeg', ['-y', '-i', bell, '-af', `apad,atrim=0:${secs}`, '-ar', '44100', '-ac', '1', dst])

  const openerAudio = join(tmp, 'opener-audio.wav')
  const openerSec = (OPENER_MS / 1000).toFixed(2)
  await (process.env.NO_STING ? silenceTo(openerAudio, openerSec) : bellTo(openerAudio, openerSec))

  let sectionAudio = null
  if (SECTION_STING_MS > 0) {
    sectionAudio = join(tmp, 'section-audio.wav')
    const sectionSec = (SECTION_STING_MS / 1000).toFixed(2)
    await (process.env.NO_SECTION_STING
      ? silenceTo(sectionAudio, sectionSec)
      : bellTo(sectionAudio, sectionSec))
  }
  return { openerAudio, sectionAudio }
}

// Plan one section: download its clip (measure duration), fetch its slide, fingerprint the
// inputs, and decide record-vs-reuse. --only scopes to matching sections; --force records all;
// otherwise a section records iff its segment is missing or its fingerprint changed.
export async function planSection(mod, i, { tmp, segDir }, { only = [], force = false } = {}) {
  const s = mod.sections[i]
  const slug = slugOf(s)
  const isFirst = i === 0
  mkdirSync(tmp, { recursive: true })
  mkdirSync(segDir, { recursive: true })
  const clip = join(tmp, `${pad2(i)}.wav`)
  const segMp4 = join(segDir, `${pad2(i)}-${slug}.mp4`)
  const sidecar = join(segDir, `${pad2(i)}-${slug}.json`)

  // Narration is convention: audio/<slug>.wav (matches the app). Missing → 6s of silence.
  let dur
  let audioHash
  try {
    const buf = await fetchBuf(`${CONTENT_BASE}/audio/${slug}.wav`)
    writeFileSync(clip, buf)
    audioHash = sha(buf)
    dur = await ffprobeDuration(clip)
  } catch (e) {
    await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '6', clip])
    audioHash = 'silence6'
    dur = 6
    console.warn(`  ${slug}  no audio (${e.message}) → 6s silence`)
  }

  // Slide text → hash for the fingerprint (a slide edit re-records the section too).
  let slideHash = 'none'
  try {
    slideHash = sha(await fetchBuf(`${CONTENT_BASE}/${s.slide}`))
  } catch { /* slide missing → app shows Loading; leave 'none' */ }

  const leadMs = isFirst ? OPENER_MS : SECTION_STING_MS > 0 ? SECTION_STING_MS : 0
  const leadSilent = isFirst ? !!process.env.NO_STING : !!process.env.NO_SECTION_STING
  const waitMs = process.env.WAIT_MS ? +process.env.WAIT_MS : Math.round(dur * 1000)
  const fp = sha(JSON.stringify({
    v: 1, audioHash, slideHash, waitMs, leadMs, leadSilent,
    focus: s.focus ?? null, highlight: s.highlight ?? null, scene: s.scene ?? null,
    scale: SCALE, fps: FPS, enc: ENCODE_SIG,
  }))

  const matched = only.length > 0 && only.some(
    (t) => slug === t || slug.includes(t) || (/^\d+$/.test(t) && i + 1 === +t))
  const have = existsSync(segMp4) && existsSync(sidecar)
  let record
  let reason
  if (only.length > 0) {
    if (matched) { record = true; reason = '--only' }
    else if (!have) { record = true; reason = 'missing' }
    else { record = false; reason = 'reuse (not selected)' }
  } else if (force) {
    record = true; reason = '--force'
  } else if (!have) {
    record = true; reason = 'missing'
  } else if (readJson(sidecar)?.fp !== fp) {
    record = true; reason = 'changed'
  } else {
    record = false; reason = 'reuse'
  }

  return { i, s, slug, isFirst, clip, segMp4, sidecar, dur, waitMs, fp, record, reason }
}

// Launch a SCALE× headless capture browser, parked on the blank dark pre-roll.
export async function launchBrowser() {
  const puppeteer = (await import('puppeteer')).default
  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: CW, height: CH, deviceScaleFactor: 1 },
    args: [`--window-size=${CW},${CH}`, '--autoplay-policy=no-user-gesture-required'],
  })
  const page = await browser.newPage()
  await page.goto(`${APP_URL}/?capture=1#/`, { waitUntil: 'networkidle2' })
  await sleep(400)
  return { browser, page }
}

// Record one planned section on an already-open capture page → its segment MP4 + sidecar.
export async function recordSectionSegment(page, moduleId, p, audio) {
  const { tmp } = paths(moduleId)
  const webm = join(tmp, `seg-${pad2(p.i)}.webm`)
  const hash = `#/${CONCEPT}/${moduleId}/${p.slug}`

  // Warm: navigate + wait for paint. Setting __captureReady false first guarantees we await
  // THIS section's paint, not a stale true left by the previous section.
  await page.evaluate((h) => {
    window.__captureReady = false
    location.hash = h
  }, hash)
  await page.waitForFunction(() => window.__captureReady === true, { timeout: 20000 }).catch(() => {})
  await page.waitForSelector('.scene-node, .react-flow', { timeout: 15000 }).catch(() => {})

  // Roll — frame 0 is the finished, painted section.
  const recorder = await page.screencast({ path: webm })
  if (p.isFirst) {
    await page.evaluate(() => window.dispatchEvent(new Event('capture-opener-start')))
    console.log(`  ▶ opener (${(OPENER_MS / 1000).toFixed(1)}s)`)
    await sleep(OPENER_MS)
  } else if (SECTION_STING_MS > 0) {
    console.log(`  ♪ sting (${(SECTION_STING_MS / 1000).toFixed(1)}s)`)
    await sleep(SECTION_STING_MS)
  }
  console.log(`  ▶ ${p.slug} (${p.dur.toFixed(1)}s)`)
  await sleep(p.waitMs)
  await recorder.stop()

  // Segment audio: sting/opener lead + this section's clip. Mirrors the video timeline.
  const lead = p.isFirst ? audio.openerAudio : audio.sectionAudio
  const segAudio = join(tmp, `seg-${pad2(p.i)}.wav`)
  await concatAudio(lead ? [lead, p.clip] : [p.clip], segAudio)

  await encodeSegment(webm, segAudio, p.segMp4)
  writeFileSync(p.sidecar, JSON.stringify({ fp: p.fp, builtAt: new Date().toISOString() }, null, 2))
  console.log(`  ✓ segment → ${p.segMp4.replace(here + '/', '')}`)
}

// Plan + record the sections that need it (shared by this CLI and record-module --record).
// Returns { mod, plan } so the caller (merge) can reuse the manifest order.
export async function captureModule(moduleId, { only = [], force = false } = {}) {
  const p = paths(moduleId)
  mkdirSync(p.tmp, { recursive: true })
  mkdirSync(p.segDir, { recursive: true })
  const mod = await fetchModule(moduleId)
  console.log(`Module ${moduleId}: ${mod.sections.length} sections`)

  const plan = []
  for (let i = 0; i < mod.sections.length; i++) plan.push(await planSection(mod, i, p, { only, force }))
  const toRecord = plan.filter((x) => x.record)
  console.log('\nPlan:')
  for (const x of plan) {
    console.log(`  §${pad2(x.i + 1)} ${x.slug.padEnd(34)} ${x.record ? 'RECORD' : 'reuse '} (${x.reason})`)
  }
  console.log(`  → ${toRecord.length}/${plan.length} to record\n`)

  if (toRecord.length > 0) {
    const audio = await prepareStingAudio(p.tmp)
    const { browser, page } = await launchBrowser()
    try {
      for (const x of toRecord) await recordSectionSegment(page, moduleId, x, audio)
    } finally {
      await browser.close()
    }
  } else {
    console.log('  (nothing to record — segments are current)')
  }
  return { mod, plan }
}

// Parse `<moduleId> [--only tok[,tok]] [--force]` (shared with record-module).
export function parseArgs(argv) {
  const only = []
  let force = false
  const pos = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--force') force = true
    else if (a === '--only') only.push(...(argv[++i] ?? '').split(',').filter(Boolean))
    else if (a.startsWith('--only=')) only.push(...a.slice(7).split(',').filter(Boolean))
    else pos.push(a)
  }
  return { only, force, pos }
}

// CLI: capture only (no merge). Guarded so importing this file doesn't fire it.
const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const { only, force, pos } = parseArgs(process.argv.slice(2))
  const moduleId = pos[0] ?? '01-foundations-and-the-cluster'
  captureModule(moduleId, { only, force })
    .then(() => console.log('\n✅ segments up to date — merge with: node capture/record-module.mjs ' + moduleId))
    .catch((e) => {
      console.error(e)
      process.exit(1)
    })
}
