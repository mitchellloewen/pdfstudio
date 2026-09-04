/**
 * End-to-end check of the shipping optimiser path (pdf/shrink.ts), including
 * Form XObjects and in-place stream replacement.
 *
 *   npx tsx test/optimize-e2e.ts "<plan set.pdf>" [out.pdf]
 *
 * shrink.ts uses CompressionStream, which Node exposes globally from v18, so
 * the same code runs here and in the renderer worker.
 */
import { readFileSync, writeFileSync } from 'fs'
import { optimizePdf } from '../src/renderer/src/pdf/shrink'

const inPath = process.argv[2]
const outPath = process.argv[3] || 'test/out-optimized.pdf'
if (!inPath) {
  console.error('usage: npx tsx test/optimize-e2e.ts <in.pdf> [out.pdf]')
  process.exit(2)
}

async function main(): Promise<void> {
  const src = readFileSync(inPath)
  const ab = src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength) as ArrayBuffer
  let lastLabel = ''
  const { bytes, stats } = await optimizePdf(ab, {
    onProgress: (done, total, label) => {
      if (label !== lastLabel) {
        lastLabel = label
        process.stdout.write(`\r  ${done}/${total}  ${label}          `)
      }
    }
  })
  process.stdout.write('\r' + ' '.repeat(60) + '\r')
  writeFileSync(outPath, bytes)

  const pct = stats.segmentsBefore
    ? (100 * (1 - stats.segmentsAfter / stats.segmentsBefore)).toFixed(1)
    : '0.0'
  console.log(`pages            ${stats.pages}`)
  console.log(`streams rewrit.  ${stats.streams}`)
  console.log(`line segments    ${stats.segmentsBefore.toLocaleString()} -> ${stats.segmentsAfter.toLocaleString()}  (-${pct}%)`)
  console.log(`wrappers flat.   ${stats.wrappersFlattened.toLocaleString()}  (${(stats.wrappersFlattened * 2).toLocaleString()} save/restore pairs + matrices removed)`)
  console.log(`strokes merged   ${stats.strokesMerged.toLocaleString()}`)
  console.log(`null strokes     ${stats.degenerateDropped.toLocaleString()}`)
  console.log(`stream bytes     ${(stats.bytesBefore / 1e6).toFixed(0)} MB -> ${(stats.bytesAfter / 1e6).toFixed(0)} MB decompressed`)
  console.log(`file             ${(stats.fileBefore / 1e6).toFixed(2)} MB -> ${(stats.fileAfter / 1e6).toFixed(2)} MB`)
  console.log(`took             ${(stats.ms / 1000).toFixed(1)}s`)
  console.log(`wrote            ${outPath}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
