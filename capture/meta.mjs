// meta.mjs — the YouTube-description generator for a module master.
//
// Builds the text you paste into YouTube: a templated blurb, a 0:00-anchored CHAPTERS list
// (so YouTube renders chapter markers), and hashtags. Chapter timestamps are read straight
// off the per-section segment MP4s (capture/segments/<concept>/<module>/NN-slug.mp4) with
// ffprobe, in manifest order, so they match the merged master exactly (leads baked in).
//
//   node capture/meta.mjs <moduleId>
//   CONCEPT=data-warehousing CONTENT_BASE=https://raw.githubusercontent.com/schemabotview/data-warehousing-ct/main \
//     node capture/meta.mjs 02-normalization-and-keys
//
// Writes capture/out/<concept>/<moduleId>.txt (alongside the master) and prints it. Requires
// the module's segments to exist (capture them first with record-section/record-module) and
// ffprobe on PATH. Content (manifest headings/titles) comes from CONTENT_BASE; no browser.

import { mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run, slugOf, pad2, paths, fetchModule, parseArgs, CONCEPT, CONTENT_BASE } from './record-section.mjs'

async function ffprobeDuration(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
  ])
  return parseFloat(stdout.trim())
}

// seconds → chapter timestamp: M:SS, or H:MM:SS past an hour.
function stamp(sec) {
  const t = Math.floor(sec)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`
}

// The descriptive half of a heading: "Normalization — why we split tables" → "why we split
// tables". Falls back to the whole heading when there's no em dash.
const topicOf = (heading) => {
  const parts = heading.split(/\s+—\s+/)
  return (parts.length > 1 ? parts.slice(1).join(' — ') : heading).trim()
}

// "Data Warehousing" / "Normalization & Keys" → hashtag words. Drops connectors and short bits.
const STOP = new Set(['and', 'the', 'of', 'to', 'a', 'an', 'for', 'in', 'on', 'with', 'amp'])
function tagWords(text) {
  return text
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 2 && !STOP.has(w.toLowerCase()))
    .map((w) => w[0].toUpperCase() + w.slice(1))
}

// Join a list into prose: "a, b, and c".
function proseList(items) {
  if (items.length <= 1) return items.join('')
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

export async function buildMeta(moduleId) {
  const p = paths(moduleId)
  const mod = await fetchModule(moduleId)
  const manifest = await (await fetch(`${CONTENT_BASE}/manifest.json`)).json()
  const conceptName = manifest.concept ?? CONCEPT

  // Chapter timestamps from the segments, in manifest order (cumulative; first is 0:00).
  const segs = mod.sections.map((s, i) => join(p.segDir, `${pad2(i)}-${slugOf(s)}.mp4`))
  const missing = segs.filter((f) => !existsSync(f))
  if (missing.length) {
    throw new Error(
      `missing ${missing.length} segment(s) — capture the module first:\n  ` +
        missing.map((f) => f.replace(/^.*segments\//, 'segments/')).join('\n  ') +
        `\n→ node capture/record-section.mjs ${moduleId}`,
    )
  }

  const chapters = []
  let t = 0
  for (let i = 0; i < mod.sections.length; i++) {
    chapters.push(`${stamp(t)}  ${mod.sections[i].heading}`)
    t += await ffprobeDuration(segs[i])
  }

  // Blurb (templated from the manifest — edit the .txt if you want richer prose).
  const covers = proseList(mod.sections.map((s) => topicOf(s.heading)))
  const blurb =
    `Learn ${mod.title} — part of the ${conceptName} course. ` +
    `This lesson covers ${covers}. ` +
    `Presented as a video-first, node-graph lesson: an interactive scene on the left and an ` +
    `authored slide on the right, with narrated walkthroughs.`

  // Hashtags: concept + module words, plus fixed platform tags. Deduped, order-stable.
  const tags = []
  const push = (w) => { const h = `#${w}`; if (!tags.includes(h)) tags.push(h) }
  push(tagWords(conceptName).join(''))         // #DataWarehousing
  for (const w of tagWords(mod.title)) push(w)  // #Normalization #Keys
  for (const w of ['DataEngineering', 'DataModeling', 'SQL', 'GraphL']) push(w)
  const hashtags = tags.slice(0, 10).join(' ')

  const text =
    `${mod.title} — ${conceptName}\n\n` +
    `${blurb}\n\n` +
    `CHAPTERS\n${chapters.join('\n')}\n\n` +
    `${hashtags}\n`

  mkdirSync(p.outDir, { recursive: true })
  const out = join(p.outDir, `${process.env.OUT_NAME ?? moduleId}.txt`)
  writeFileSync(out, text)
  return { out, text }
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const { pos } = parseArgs(process.argv.slice(2))
  const moduleId = pos[0] ?? '01-foundations-and-the-cluster'
  buildMeta(moduleId)
    .then(({ out, text }) => {
      console.log(text)
      console.log(`\n✅ ${out.replace(/^.*\/out\//, 'out/')}`)
    })
    .catch((e) => {
      console.error(e)
      process.exit(1)
    })
}
