/** Per-page decompressed vs stored size for the optimised output. */
import { readFileSync, writeFileSync } from 'fs'
import { deflateSync, constants as Z } from 'zlib'
import { PDFDocument, PDFName, PDFRawStream, PDFArray, PDFRef, decodePDFRawStream } from 'pdf-lib'
import { optimizeContentStream } from '../src/renderer/src/pdf/optimize'

const inPath = process.argv[2]
const outPath = process.argv[3] || 'test/out-opt-full.pdf'

async function main(): Promise<void> {
  const src = readFileSync(inPath)
  const doc = await PDFDocument.load(src, { updateMetadata: false })
  const ctx = doc.context
  let dec = 0
  let comp = 0
  let origComp = 0
  doc.getPages().forEach((page, i) => {
    const c = page.node.get(PDFName.of('Contents'))
    const refs = c instanceof PDFArray ? c.asArray() : c ? [c] : []
    const chunks: Uint8Array[] = []
    const streamRefs: PDFRef[] = []
    for (const r of refs) {
      const st = ctx.lookup(r)
      if (st instanceof PDFRawStream) {
        chunks.push(decodePDFRawStream(st).decode())
        origComp += st.getContents().length
        if (r instanceof PDFRef) streamRefs.push(r)
      }
    }
    if (!chunks.length) return
    const tot = chunks.reduce((n, x) => n + x.length + 1, 0)
    const j = new Uint8Array(tot)
    let o = 0
    for (const x of chunks) {
      j.set(x, o)
      o += x.length
      j[o++] = 10
    }
    const { out } = optimizeContentStream(j, {})
    const packed = deflateSync(Buffer.from(out), { level: Z.Z_BEST_COMPRESSION })
    dec += out.length
    comp += packed.length
    console.log(
      `p${String(i + 1).padStart(2)}  decompressed ${(out.length / 1e6).toFixed(2).padStart(6)} MB   stored ${(packed.length / 1e6).toFixed(2).padStart(5)} MB   ratio ${(out.length / packed.length).toFixed(1)}:1`
    )
    // Replace the first stream in place and drop the rest. Registering a new
    // object instead would leave the originals in the file as orphans —
    // pdf-lib never garbage-collects — and the output carries both copies.
    const fresh = ctx.stream(packed, { Filter: PDFName.of('FlateDecode'), Length: packed.length })
    if (streamRefs.length) {
      ctx.assign(streamRefs[0], fresh)
      for (let k = 1; k < streamRefs.length; k++) ctx.delete(streamRefs[k])
      page.node.set(PDFName.of('Contents'), streamRefs[0])
    } else {
      page.node.set(PDFName.of('Contents'), ctx.register(fresh))
    }
  })
  const b = await doc.save({ useObjectStreams: true })
  writeFileSync(outPath, b)
  console.log(
    `\nstreams ${(dec / 1e6).toFixed(0)} MB decompressed -> ${(comp / 1e6).toFixed(2)} MB stored ` +
      `(original streams stored ${(origComp / 1e6).toFixed(2)} MB)`
  )
  console.log(`file ${(src.length / 1e6).toFixed(2)} -> ${(b.length / 1e6).toFixed(2)} MB`)
}
main()
