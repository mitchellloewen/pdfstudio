/**
 * Measure the content-stream optimiser against a real CAD plan set.
 *
 *   npx tsx test/optimize-check.ts "<plan set.pdf>" [outDir]
 *
 * Writes one optimised copy per variant so they can be rendered side by side,
 * and drops a test/bench/pdfs.json manifest for the pdf.js bench page.
 */
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { deflateSync, constants as Z } from 'zlib'
import { PDFDocument, PDFName, PDFRawStream, PDFArray, decodePDFRawStream } from 'pdf-lib'
import { optimizeContentStream, type OptimizeOptions } from '../src/renderer/src/pdf/optimize'

const inPath = process.argv[2]
const outDir = process.argv[3] || 'test'
if (!inPath) {
  console.error('usage: npx tsx test/optimize-check.ts <in.pdf> [outDir]')
  process.exit(2)
}

const VARIANTS: { key: string; label: string; opts: OptimizeOptions }[] = [
  { key: 'geom', label: 'geometry only', opts: { flatten: false, mergeStrokes: false } },
  { key: 'flat', label: 'geometry + flatten', opts: { flatten: true, mergeStrokes: false } },
  { key: 'full', label: 'geometry + flatten + merge', opts: { flatten: true, mergeStrokes: true } }
]

/** Pull a page's content streams out as one decompressed buffer. */
function pageContent(doc: PDFDocument, i: number): Uint8Array | null {
  const ctx = doc.context
  const page = doc.getPages()[i]
  const contents = page.node.get(PDFName.of('Contents'))
  const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : []
  const chunks: Uint8Array[] = []
  for (const r of refs) {
    const st = ctx.lookup(r)
    if (st instanceof PDFRawStream) chunks.push(decodePDFRawStream(st).decode())
  }
  if (!chunks.length) return null
  const total = chunks.reduce((n, c) => n + c.length + 1, 0)
  const joined = new Uint8Array(total)
  let o = 0
  for (const c of chunks) {
    joined.set(c, o)
    o += c.length
    joined[o++] = 0x0a
  }
  return joined
}

async function main(): Promise<void> {
  const srcBytes = readFileSync(inPath)
  const manifest: { key: string; label: string; path: string }[] = [
    { key: 'orig', label: 'original', path: resolve(inPath) }
  ]

  for (const v of VARIANTS) {
    const doc = await PDFDocument.load(srcBytes, { updateMetadata: false })
    const ctx = doc.context
    let sb = 0
    let sa = 0
    let bb = 0
    let ba = 0
    let flat = 0
    let merged = 0
    let nulls = 0
    const t0 = Date.now()

    console.log(`\n--- ${v.label} ---`)
    doc.getPages().forEach((page, i) => {
      const joined = pageContent(doc, i)
      if (!joined) return
      const { out, stats } = optimizeContentStream(joined, v.opts)
      sb += stats.segmentsBefore
      sa += stats.segmentsAfter
      bb += stats.bytesBefore
      ba += stats.bytesAfter
      flat += stats.wrappersFlattened
      merged += stats.strokesMerged
      nulls += stats.degenerateDropped

      const pct = stats.segmentsBefore
        ? (100 * (1 - stats.segmentsAfter / stats.segmentsBefore)).toFixed(1)
        : '0.0'
      console.log(
        `p${String(i + 1).padStart(2)}: ` +
          `seg ${String(stats.segmentsBefore).padStart(9)}->${String(stats.segmentsAfter).padStart(7)} (-${pct.padStart(4)}%)  ` +
          `stream ${(stats.bytesBefore / 1e6).toFixed(2).padStart(6)}->${(stats.bytesAfter / 1e6).toFixed(2).padStart(5)} MB  ` +
          `flat ${String(stats.wrappersFlattened).padStart(7)}  ` +
          `merged ${String(stats.strokesMerged).padStart(7)}  ` +
          `nulls ${String(stats.degenerateDropped).padStart(6)}`
      )

      const packed = deflateSync(Buffer.from(out), { level: Z.Z_BEST_COMPRESSION })
      const ref = ctx.register(
        ctx.stream(packed, { Filter: PDFName.of('FlateDecode'), Length: packed.length })
      )
      page.node.set(PDFName.of('Contents'), ref)
    })

    const outBytes = await doc.save({ useObjectStreams: true })
    const outPath = resolve(outDir, `out-opt-${v.key}.pdf`)
    writeFileSync(outPath, outBytes)
    const pct = sb ? (100 * (1 - sa / sb)).toFixed(1) : '0.0'
    console.log(
      `  segments ${sb.toLocaleString()} -> ${sa.toLocaleString()} (-${pct}%)  |  ` +
        `stream ${(bb / 1e6).toFixed(0)} -> ${(ba / 1e6).toFixed(0)} MB  |  ` +
        `flat ${flat.toLocaleString()}  merged ${merged.toLocaleString()}  nulls ${nulls.toLocaleString()}`
    )
    console.log(
      `  file ${(srcBytes.length / 1e6).toFixed(2)} -> ${(outBytes.length / 1e6).toFixed(2)} MB  |  ` +
        `${((Date.now() - t0) / 1000).toFixed(1)}s  |  ${outPath}`
    )
    manifest.push({ key: v.key, label: v.label, path: outPath })
  }

  writeFileSync(resolve('test/bench/pdfs.json'), JSON.stringify(manifest, null, 2))
  console.log('\nwrote test/bench/pdfs.json')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
