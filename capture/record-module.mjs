// record-module.mjs — the MERGE half of the video pipeline.
//
// Concatenates a module's section segments (capture/segments/<concept>/<module>/NN-slug.mp4,
// produced by record-section.mjs) into the module master capture/out/<concept>/<module>.mp4
// with `-c copy` — no re-encode, since every segment shares codec/pix/CFR/timescale/audio
// params, so the joins are clean and the merge takes seconds.
//
//   node capture/record-module.mjs <moduleId>                    # merge existing segments
//   node capture/record-module.mjs <moduleId> --record           # capture changed sections, then merge
//   node capture/record-module.mjs <moduleId> --record --only 5  # re-capture §5, then merge
//
// Default is merge-only (fast, no browser). `--record` first runs the capture half
// (record-section's `captureModule`) so it's the one-command full pipeline. Env: OUT_NAME
// overrides the master's stem (avoid clobbering a real master with a test capture).

import { mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  run, FFMPEG_ENCODE, slugOf, pad2, paths, fetchModule, parseArgs, captureModule,
} from './record-section.mjs'

// Concat the module's segments (in manifest order) → the master. `mod` may be passed in (from
// a preceding --record capture) to avoid re-fetching the manifest.
export async function mergeModule(moduleId, mod) {
  const p = paths(moduleId)
  mkdirSync(p.tmp, { recursive: true })
  mkdirSync(p.outDir, { recursive: true })
  mod = mod ?? (await fetchModule(moduleId))

  const segs = mod.sections.map((s, i) => join(p.segDir, `${pad2(i)}-${slugOf(s)}.mp4`))
  const missing = segs.filter((f) => !existsSync(f))
  if (missing.length) {
    throw new Error(
      `missing ${missing.length} segment(s):\n  ` +
        missing.map((f) => f.replace(/^.*segments\//, 'segments/')).join('\n  ') +
        `\n→ capture them first: node capture/record-section.mjs ${moduleId}`,
    )
  }

  // concat demuxer + stream copy. Paths quoted for the list file (single-quote escaped).
  const listFile = join(p.tmp, 'concat.txt')
  writeFileSync(listFile, segs.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n')
  const out = join(p.outDir, `${process.env.OUT_NAME ?? moduleId}.mp4`)
  console.log(`Merging ${segs.length} segments → ${out.replace(/^.*\/out\//, 'out/')}`)
  await run(FFMPEG_ENCODE, [
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c', 'copy', '-movflags', '+faststart', out,
  ])
  console.log(`\n✅ ${out}`)
  return out
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const argv = process.argv.slice(2)
  const record = argv.includes('--record')
  const { only, force, pos } = parseArgs(argv.filter((a) => a !== '--record'))
  const moduleId = pos[0] ?? '01-foundations-and-the-cluster'
  const runPipeline = async () => {
    let mod
    if (record) ({ mod } = await captureModule(moduleId, { only, force }))
    await mergeModule(moduleId, mod)
  }
  runPipeline().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
