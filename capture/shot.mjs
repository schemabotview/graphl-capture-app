// shot.mjs — a quick 4K review screenshot of one section, through the render-app's
// capture mode. Validates the headless render + capture handshake + SCALE× viewport
// before the full video recorder. Saves a PNG after the intro choreography settles.
//
// Prereq: the render-app dev server running (npm run dev). ffmpeg not needed here.
// Usage: node capture/shot.mjs [section-slug] [waitMs]
//   node capture/shot.mjs 01-03-the-cluster
//   SCALE=1 node capture/shot.mjs 01-03-the-cluster   # 1080p instead of 4K
import puppeteer from 'puppeteer'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// The render-app scales its fixed 1920×1080 stage to fill the window, so a SCALE× viewport
// re-rasterizes the stage crisp at SCALE× (SCALE=2 → 3840×2160, a true 4K frame).
const SCALE = process.env.SCALE ? +process.env.SCALE : 2
const CW = 1920 * SCALE
const CH = 1080 * SCALE

const APP = process.env.APP_URL ?? 'http://localhost:5173'
const CONCEPT = process.env.CONCEPT ?? 'apache-spark'
const MODULE = process.env.MODULE ?? '01-foundations-and-the-cluster'
const slug = process.argv[2] ?? '01-03-the-cluster'
const wait = +(process.argv[3] ?? 4000)

const browser = await puppeteer.launch({
  headless: true,
  defaultViewport: { width: CW, height: CH, deviceScaleFactor: 1 },
  args: [`--window-size=${CW},${CH}`, '--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage()

// Park on the dark pre-roll, then deep-link the section and wait for the capture handshake
// (slide fetched + scene mounted) so we shoot a fully-painted frame.
await page.goto(`${APP}/?capture=1#/`, { waitUntil: 'networkidle2' })
await page.evaluate(
  (h) => {
    window.__captureReady = false
    location.hash = h
  },
  `#/${CONCEPT}/${MODULE}/${slug}`,
)
await page.waitForFunction(() => window.__captureReady === true, { timeout: 20000 }).catch(() => {})
await page.waitForSelector('.scene-node, .react-flow', { timeout: 15000 }).catch(() => {})
await new Promise((r) => setTimeout(r, wait)) // let the camera settle into focus

const outDir = join(here, 'out')
mkdirSync(outDir, { recursive: true })
const out = join(outDir, `shot-${slug}.png`)
await page.screenshot({ path: out })
await browser.close()
console.log(`${out}  (${CW}×${CH})`)
