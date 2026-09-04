/**
 * Parity check for "render from the optimised copy, save from the original".
 *
 *   npx tsx test/optimize-parity.ts <file.pdf> [more.pdf …]
 *
 * PDF Studio draws its own overlays — text layer, form fields, optional-content
 * layers, OCR words, Edit-Text line maps — from whatever document pdf.js has
 * open, but saves through pdf-lib from the ORIGINAL bytes. Swapping only the
 * render document is therefore safe if and only if pdf.js reports the same
 * structure for both. In particular the optional-content ids ("6R", "7R", …)
 * are pdf.js object references: if the optimiser renumbers objects, the Layers
 * panel would toggle the wrong layer on save.
 */
import { readFileSync } from 'fs'
import { optimizePdf } from '../src/renderer/src/pdf/shrink'

/* eslint-disable @typescript-eslint/no-explicit-any */
async function describe(bytes: Uint8Array): Promise<Record<string, unknown>> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: false
  }).promise

  const occ = await doc.getOptionalContentConfig()
  const groups = [...(occ.getGroups?.() ? Object.keys(occ.getGroups()) : [])].sort()

  const pages: unknown[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i)
    const vp = p.getViewport({ scale: 1 })
    const annots = await p.getAnnotations({ intent: 'display' })
    const tc = await p.getTextContent()
    pages.push({
      w: Math.round(vp.width * 100) / 100,
      h: Math.round(vp.height * 100) / 100,
      rotate: p.rotate,
      annots: annots.length,
      widgets: annots.filter((a: any) => a.subtype === 'Widget').map((a: any) => `${a.fieldName}@${a.rect.map((n: number) => Math.round(n)).join(',')}`).sort(),
      textItems: tc.items.length,
      // first and last text item positions catch any coordinate drift
      firstItem: tc.items[0] ? `${(tc.items[0] as any).str}@${(tc.items[0] as any).transform.slice(4).map((n: number) => Math.round(n)).join(',')}` : null,
      lastItem: tc.items.length
        ? `${(tc.items[tc.items.length - 1] as any).str}@${(tc.items[tc.items.length - 1] as any).transform.slice(4).map((n: number) => Math.round(n)).join(',')}`
        : null
    })
  }
  const outline = await doc.getOutline()
  const result = { numPages: doc.numPages, layerIds: groups, outline: outline ? outline.length : 0, pages }
  await doc.destroy()
  return result
}

async function main(): Promise<void> {
  const files = process.argv.slice(2)
  if (!files.length) {
    console.error('usage: npx tsx test/optimize-parity.ts <file.pdf> …')
    process.exit(2)
  }
  let bad = 0
  for (const f of files) {
    const src = readFileSync(f)
    const ab = src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength) as ArrayBuffer
    const { bytes } = await optimizePdf(ab)
    const a = await describe(src)
    const b = await describe(bytes)
    const ja = JSON.stringify(a, null, 1)
    const jb = JSON.stringify(b, null, 1)
    if (ja === jb) {
      console.log(`  ok    ${f}   (${a.numPages} pages, layers [${(a.layerIds as string[]).join(',')}])`)
    } else {
      bad++
      console.log(`  FAIL  ${f}`)
      const la = ja.split('\n')
      const lb = jb.split('\n')
      let shown = 0
      for (let i = 0; i < Math.max(la.length, lb.length) && shown < 12; i++) {
        if (la[i] !== lb[i]) {
          console.log(`        line ${i}:`)
          console.log(`          original:  ${la[i]}`)
          console.log(`          optimised: ${lb[i]}`)
          shown++
        }
      }
    }
  }
  if (bad) {
    console.log(`\n${bad} of ${files.length} differ — swapping the render document is NOT safe for these`)
    process.exit(1)
  }
  console.log(`\nOPTIMIZE-PARITY-OK (${files.length} files)`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
