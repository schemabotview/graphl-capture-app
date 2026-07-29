// thumb.mjs — generate a crisp 1280×720 thumbnail for a module's video, by screenshotting
// the render-app's MODULE OPENER directly (no video re-compression — grabbing a frame from
// the encoded mp4 softens text). The opener IS the thumbnail design (whole scene on the left
// + concept title panel on the right, src/frame/ModuleOpener.tsx), so there's nothing to keep
// in sync. Mirrors record-section.mjs's supersampling: render the fixed 1920×1080 stage at
// SCALE× (→ 4K), screenshot lossless, then downscale to 720p (Lanczos = razor-sharp).
//
// In capture mode the opener waits for a `capture-opener-start` event we never send, so it
// holds on screen indefinitely — no race against its fade.
//
// Prerequisites: the render-app served at APP_URL (`npm run dev`) + ffmpeg on PATH.
// Usage:  node capture/thumb.mjs [moduleId]
//   e.g.  node capture/thumb.mjs 01-foundations-and-the-cluster
//   Env:    APP_URL · CONCEPT · CONTENT_BASE · SCALE (=2) — same as record-section.mjs
//   Flags:  --out <file>  bare name lands in capture/out/<concept>/ (default <moduleId>.png)
//           --at <ms>     settle delay before the shot (default 1800)
//           --full4k      keep the 3840×2160 screenshot instead of downscaling to 720p

import puppeteer from 'puppeteer'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
const flag = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : def
}
const has = (name) => args.includes(name)
// Positional moduleId = the first bare arg (skipping flags + their values).
const VALUE_FLAGS = new Set(['--out', '--at'])
const positionals = []
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    if (VALUE_FLAGS.has(args[i])) i++
  } else positionals.push(args[i])
}

const APP_URL = process.env.APP_URL ?? 'http://localhost:5173'
const CONCEPT = process.env.CONCEPT ?? 'apache-spark'
const CONTENT_BASE =
  process.env.CONTENT_BASE ?? 'https://raw.githubusercontent.com/schemabotview/apache-spark-ct/main'
const MODULE_ID = positionals[0] ?? '01-foundations-and-the-cluster'

// Same supersampling as record-section.mjs: render the 1920×1080 stage at SCALE× device pixels.
const SCALE = process.env.SCALE ? +process.env.SCALE : 2
const CW = 1920 * SCALE
const CH = 1080 * SCALE
const settleMs = +flag('--at', '1800')
const full4k = has('--full4k')
const outArg = flag('--out', `${MODULE_ID}.png`)
const outDir = join(here, 'out', CONCEPT)
const out = outArg.includes('/') || isAbsolute(outArg) ? outArg : join(outDir, outArg)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const slugOf = (s) => s.slide.replace(/^.*\//, '').replace(/\.slide$/, '')

// 1. First section slug from the manifest — the opener renders when landing on section 0.
const manifest = await (await fetch(`${CONTENT_BASE}/manifest.json`)).json()
const mod = manifest.modules.find((m) => m.id === MODULE_ID)
if (!mod) throw new Error(`module ${MODULE_ID} not in manifest`)
const firstSlug = slugOf(mod.sections[0])

// 2. Launch at SCALE× and drive to the opener, exactly like record-section.mjs's pre-roll.
const browser = await puppeteer.launch({
  headless: true,
  defaultViewport: { width: CW, height: CH, deviceScaleFactor: 1 },
  args: [`--window-size=${CW},${CH}`, '--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--disable-setuid-sandbox'],
})
const page = await browser.newPage()
await page.goto(`${APP_URL}/?capture=1#/`, { waitUntil: 'networkidle2' })
await sleep(300)
await page.evaluate((h) => {
  window.__captureReady = false
  location.hash = h
}, `#/${CONCEPT}/${MODULE_ID}/${firstSlug}`)
await page.waitForFunction(() => window.__captureReady === true, { timeout: 20000 }).catch(() => {})
await page.waitForSelector('.scene-node, .react-flow', { timeout: 15000 }).catch(() => {})
await sleep(settleMs) // scene settles into whole-scene overview under the held opener

// 3. Lossless screenshot of the 4K opener frame.
mkdirSync(dirname(out), { recursive: true })
const shot = full4k ? out : join(tmpdir(), `thumb-4k-${Date.now()}.png`)
await page.screenshot({ path: shot })
await browser.close()

// 4. Downscale 4K → 1280×720 (Lanczos supersample) unless --full4k keeps the master.
if (!full4k) {
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', shot, '-vf', 'scale=1280:720:flags=lanczos', out])
  rmSync(shot, { force: true })
}
console.log(`${out}  (${full4k ? `${CW}×${CH}` : '1280×720'})`)
