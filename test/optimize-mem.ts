/**
 * Heap ceiling for the optimiser. Fails if one page costs too much.
 *
 *   npx tsx test/optimize-mem.ts "<plan set.pdf>" [pageNumber]
 *
 * This test exists because the first version materialised the whole token list
 * before rewriting anything — roughly 8 million token objects for one 150 MB
 * plan sheet, 2.9 GB of heap. It passed every correctness test on a dev box
 * running `--max-old-space-size=12288`, then blacked out the app window in the
 * real build, where the renderer gets nothing like that much. The tokeniser is
 * streaming now (~200 MB for the same page) and must stay that way.
 */
import { readFileSync } from 'fs'
import { PDFDocument, PDFName, PDFRawStream, PDFArray, decodePDFRawStream } from 'pdf-lib'
import { optimizeContentStream } from '../src/renderer/src/pdf/optimize'

const inPath = process.argv[2]
const pno = Number(process.argv[3] || 7)

const mb = (n: number): string => (n / 1024 / 1024).toFixed(0).padStart(6) + ' MB'

async function main(): Promise<void> {
  const doc = await PDFDocument.load(readFileSync(inPath), { updateMetadata: false })
  const ctx = doc.context
  const page = doc.getPages()[pno - 1]
  const c = page.node.get(PDFName.of('Contents'))
  const refs = c instanceof PDFArray ? c.asArray() : [c]
  const chunks: Uint8Array[] = []
  for (const r of refs) {
    const st = ctx.lookup(r)
    if (st instanceof PDFRawStream) chunks.push(decodePDFRawStream(st).decode())
  }
  const total = chunks.reduce((n, x) => n + x.length + 1, 0)
  const joined = new Uint8Array(total)
  let o = 0
  for (const x of chunks) {
    joined.set(x, o)
    o += x.length
    joined[o++] = 0x0a
  }

  // optimizeContentStream is synchronous, so a timer-based sampler never runs.
  // heapTotal / rss after the call are what the process actually had to reserve.
  const before = process.memoryUsage()
  console.log(`page ${pno}: ${mb(joined.length)} of decompressed content stream`)
  const t0 = Date.now()
  const { out, stats } = optimizeContentStream(joined)
  const m = process.memoryUsage()
  console.log(`  segments ${stats.segmentsBefore.toLocaleString()} -> ${stats.segmentsAfter.toLocaleString()}`)
  console.log(`  output   ${mb(out.length)}`)
  console.log(`  heapTotal ${mb(before.heapTotal)} -> ${mb(m.heapTotal)}    rss ${mb(before.rss)} -> ${mb(m.rss)}`)
  console.log(`  took ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  console.log(`\n  v8 heap limit here: ${mb(require('v8').getHeapStatistics().heap_size_limit)}`)

  // Generous next to the ~210 MB the streaming tokeniser needs, but far below
  // anything that could threaten a renderer process.
  const CEILING = 700 * 1024 * 1024
  if (m.heapTotal > CEILING) {
    console.error(
      `\nFAIL: heapTotal ${mb(m.heapTotal)} exceeds the ${mb(CEILING)} ceiling — ` +
        `the optimiser is holding the whole stream in memory again.`
    )
    process.exit(1)
  }
  console.log('OPTIMIZE-MEM-OK')
}
main()
