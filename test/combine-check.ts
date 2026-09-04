/**
 * Combine files — pdf + picture → one document, page sizes and counts.
 *   npx tsx test/combine-check.ts
 */
import { readFileSync, writeFileSync } from 'fs'
import { PDFDocument } from 'pdf-lib'
import { buildCombined, describeFile } from '../src/renderer/src/pdf/combine'

const buf = (p: string): ArrayBuffer => {
  const b = readFileSync(p)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
}

async function main(): Promise<void> {
  const pdfA = await describeFile('out-baked.pdf', buf('test/out-baked.pdf'))
  const png = await describeFile('ocr-sample.png', buf('test/ocr-sample.png'))
  const pdfB = await describeFile('out-extract.pdf', buf('test/out-extract.pdf'))
  const junk = await describeFile('notes.txt', new TextEncoder().encode('hello').buffer as ArrayBuffer)
  const fakeImg = await describeFile('fake.jpg', new Uint8Array([1, 2, 3, 4]).buffer)

  console.log('rows:', [pdfA, png, pdfB, junk, fakeImg].map((r) => `${r.name}: ${r.kind} pages=${r.pages} ${r.error ?? ''}`))
  if (pdfA.error || png.error || pdfB.error) throw new Error('good inputs were rejected')
  if (!junk.error || !fakeImg.error) throw new Error('bad inputs were accepted')

  const out = await buildCombined([pdfA, png, pdfB, junk, fakeImg])
  const doc = await PDFDocument.load(out)
  const expected = (pdfA.pages ?? 0) + 1 + (pdfB.pages ?? 0)
  console.log('combined pages:', doc.getPageCount(), 'expected', expected)
  if (doc.getPageCount() !== expected) throw new Error('page count mismatch')

  const imgPage = doc.getPage(pdfA.pages ?? 0)
  const { width, height } = imgPage.getSize()
  console.log('picture page size:', width, 'x', height)
  const letter = (width === 612 && height === 792) || (width === 792 && height === 612)
  if (!letter) throw new Error('picture page is not Letter-sized')

  writeFileSync('test/out-combined.pdf', out)
  console.log('OK → test/out-combined.pdf', out.byteLength, 'bytes')
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
