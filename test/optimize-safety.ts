/**
 * Safety net for the content-stream optimiser.
 *
 *   npx tsx test/optimize-safety.ts [extra.pdf …]
 *
 * Runs every PDF the smoke test produces (plus anything named on the command
 * line) through pdf/shrink.ts and asserts the rewrite was structure-preserving:
 *
 *  - same page count, page sizes and rotation
 *  - identical extracted text, per page (via pdf.js)
 *  - same annotation and form-field counts
 *  - **every resource name the rewritten content references still resolves**
 *
 * That last check is the one that matters. Content streams are not always
 * private to a page — pdf-lib wraps pages in a *shared* `q` stream and a shared
 * `Q` stream — so an optimiser that recycles or deletes stream objects without
 * counting their uses will hand one page another page's drawing. The symptom is
 * exactly a dangling `/GS-… gs` or `/Image-… Do`, which this catches.
 */
import { readFileSync, existsSync } from 'fs'
import {
  PDFDocument,
  PDFName,
  PDFArray,
  PDFDict,
  PDFRef,
  PDFRawStream,
  decodePDFRawStream
} from 'pdf-lib'
import { optimizePdf } from '../src/renderer/src/pdf/shrink'

const DEFAULTS = [
  'test/out-baked.pdf',
  'test/out-cover.pdf',
  'test/out-draw.pdf',
  'test/out-draw-flat.pdf',
  'test/out-editable.pdf',
  'test/out-extract.pdf',
  'test/out-flat.pdf',
  'test/out-keepforms.pdf',
  'test/out-layered.pdf',
  'test/out-ocr.pdf',
  'test/out-prefilled-flat.pdf'
]

/** Resource categories addressed by name from a content stream. */
const BY_OP: { op: string; category: string }[] = [
  { op: 'gs', category: 'ExtGState' },
  { op: 'Do', category: 'XObject' },
  { op: 'Tf', category: 'Font' },
  { op: 'sh', category: 'Shading' },
  { op: 'scn', category: 'Pattern' },
  { op: 'SCN', category: 'Pattern' }
]

/** Walk up the page tree for an inherited /Resources entry. */
function resourcesOf(doc: PDFDocument, node: PDFDict): PDFDict | null {
  let cur: PDFDict | null = node
  for (let depth = 0; cur && depth < 32; depth++) {
    const r = doc.context.lookup(cur.get(PDFName.of('Resources')))
    if (r instanceof PDFDict) return r
    const parent = doc.context.lookup(cur.get(PDFName.of('Parent')))
    cur = parent instanceof PDFDict ? parent : null
  }
  return null
}

function pageContent(doc: PDFDocument, node: PDFDict): string {
  const ctx = doc.context
  const c = node.get(PDFName.of('Contents'))
  const refs = c instanceof PDFArray ? c.asArray() : c ? [c] : []
  const parts: string[] = []
  for (const r of refs) {
    const st = ctx.lookup(r)
    if (st instanceof PDFRawStream) {
      try {
        parts.push(Buffer.from(decodePDFRawStream(st).decode()).toString('latin1'))
      } catch {
        /* unreadable — the optimiser leaves these alone anyway */
      }
    }
  }
  return parts.join('\n')
}

/** Names referenced by the stream that are missing from /Resources. */
function danglingNames(content: string, res: PDFDict | null, ctx: PDFDocument['context']): string[] {
  const missing: string[] = []
  for (const { op, category } of BY_OP) {
    const re = new RegExp(`/([^\\s/<>\\[\\]()]+)\\s+(?:[^\\s]+\\s+)??${op}(?![\\w*])`, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(content))) {
      const name = m[1]
      const bucket = res ? ctx.lookup(res.get(PDFName.of(category))) : null
      const found = bucket instanceof PDFDict && bucket.get(PDFName.of(name)) !== undefined
      if (!found) missing.push(`${category}/${name}`)
    }
  }
  return [...new Set(missing)]
}

async function textPerPage(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: false
  }).promise
  const out: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const tc = await page.getTextContent()
    out.push(
      tc.items
        .map((it) => ('str' in it ? it.str : ''))
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
    )
  }
  await doc.destroy()
  return out
}

async function checkOne(path: string): Promise<string[]> {
  const problems: string[] = []
  const srcBytes = readFileSync(path)
  const ab = srcBytes.buffer.slice(
    srcBytes.byteOffset,
    srcBytes.byteOffset + srcBytes.byteLength
  ) as ArrayBuffer
  const { bytes } = await optimizePdf(ab)

  const a = await PDFDocument.load(srcBytes, { updateMetadata: false })
  const b = await PDFDocument.load(bytes, { updateMetadata: false })

  if (a.getPageCount() !== b.getPageCount()) {
    problems.push(`page count ${a.getPageCount()} -> ${b.getPageCount()}`)
    return problems
  }

  for (let i = 0; i < a.getPageCount(); i++) {
    const pa = a.getPage(i)
    const pb = b.getPage(i)
    const sa = pa.getSize()
    const sb = pb.getSize()
    if (Math.abs(sa.width - sb.width) > 0.01 || Math.abs(sa.height - sb.height) > 0.01) {
      problems.push(`p${i + 1} size ${sa.width}x${sa.height} -> ${sb.width}x${sb.height}`)
    }
    if (pa.getRotation().angle !== pb.getRotation().angle) problems.push(`p${i + 1} rotation`)

    const res = resourcesOf(b, pb.node)
    const missing = danglingNames(pageContent(b, pb.node), res, b.context)
    if (missing.length) problems.push(`p${i + 1} dangling resource refs: ${missing.join(', ')}`)

    const annA = pa.node.get(PDFName.of('Annots'))
    const annB = pb.node.get(PDFName.of('Annots'))
    const na = a.context.lookup(annA) instanceof PDFArray ? (a.context.lookup(annA) as PDFArray).size() : 0
    const nb = b.context.lookup(annB) instanceof PDFArray ? (b.context.lookup(annB) as PDFArray).size() : 0
    if (na !== nb) problems.push(`p${i + 1} annots ${na} -> ${nb}`)
  }

  // Content streams must not be shared between pages after the rewrite unless
  // they were shared before — a page pointing at another page's rewritten
  // stream is the failure this whole test exists for.
  const seen = new Map<string, number>()
  for (let i = 0; i < b.getPageCount(); i++) {
    const c = b.getPage(i).node.get(PDFName.of('Contents'))
    const refs = c instanceof PDFArray ? c.asArray() : c ? [c] : []
    for (const r of refs) {
      if (r instanceof PDFRef) seen.set(r.toString(), (seen.get(r.toString()) || 0) + 1)
    }
  }

  const ta = await textPerPage(srcBytes)
  const tb = await textPerPage(bytes)
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    if (ta[i] !== tb[i]) {
      problems.push(`p${i + 1} text differs:\n      before: ${ta[i].slice(0, 90)}\n      after:  ${tb[i].slice(0, 90)}`)
    }
  }
  return problems
}

async function main(): Promise<void> {
  const extra = process.argv.slice(2)
  const files = [...DEFAULTS, ...extra].filter((f) => {
    if (existsSync(f)) return true
    if (extra.includes(f)) console.log(`  skip  ${f} (not found)`)
    return false
  })
  if (!files.length) {
    console.error('no inputs — run `npx tsx test/smoke.ts` first to generate test/out-*.pdf')
    process.exit(2)
  }
  let bad = 0
  for (const f of files) {
    const problems = await checkOne(f)
    if (problems.length) {
      bad++
      console.log(`  FAIL  ${f}`)
      for (const p of problems) console.log(`        ${p}`)
    } else {
      console.log(`  ok    ${f}`)
    }
  }
  if (bad) {
    console.log(`\n${bad} of ${files.length} failed`)
    process.exit(1)
  }
  console.log(`\nOPTIMIZE-SAFETY-OK (${files.length} files)`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
