/**
 * Oversized-image downsampling for the render copy (src/renderer/src/pdf/hugeimages.ts).
 *
 *   npx tsx test/hugeimages-check.ts [real-file.pdf …]
 *
 * Builds a fixture with one image of each kind the pass handles — 1-bit
 * indexed (the 600 dpi plan-scan case), 8-bit RGB under every PNG predictor
 * row type, 1-bit grey with an inverting /Decode — plus a small image and a
 * huge JPEG that must both be left alone. Checks the open-time byte scan, the
 * new dimensions and colour spaces, and actual pixel values.
 *
 * Any real files given are run through the same pass and their image counts
 * and timings printed.
 */
import { readFileSync } from 'fs'
import { deflateSync } from 'zlib'
import { PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFArray, PDFHexString, decodePDFRawStream, type PDFRef } from 'pdf-lib'
import { countHugeImages } from '../src/renderer/src/pdf/hugeimages'
import { optimizePdf } from '../src/renderer/src/pdf/shrink'

let failures = 0
function check(ok: boolean, msg: string): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}`)
  if (!ok) failures++
}

/** PNG-filter rows, cycling through filter types 0–4 so each is exercised. */
function pngEncode(raw: Uint8Array, rowLen: number, bpp: number): Uint8Array {
  const rows = raw.length / rowLen
  const out = new Uint8Array(rows * (rowLen + 1))
  const zero = new Uint8Array(rowLen)
  for (let y = 0; y < rows; y++) {
    const cur = raw.subarray(y * rowLen, (y + 1) * rowLen)
    const prev = y ? raw.subarray((y - 1) * rowLen, y * rowLen) : zero
    const type = y % 5
    const o = y * (rowLen + 1)
    out[o] = type
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      let pred = 0
      if (type === 1) pred = a
      else if (type === 2) pred = b
      else if (type === 3) pred = (a + b) >> 1
      else if (type === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[o + 1 + i] = (cur[i] - pred) & 0xff
    }
  }
  return out
}

async function buildFixture(): Promise<{ bytes: Uint8Array; refs: Record<string, PDFRef> }> {
  const doc = await PDFDocument.create()
  const ctx = doc.context
  const refs: Record<string, PDFRef> = {}
  const add = (key: string, data: Uint8Array, dict: Record<string, unknown>): void => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    refs[key] = ctx.register(ctx.stream(data, { Type: 'XObject', Subtype: 'Image', ...dict } as any))
  }

  // 1) 9000×6000 1-bit indexed: white with a black block at x 3000–5999, y 2000–3999
  {
    const w = 9000
    const h = 6000
    const rowLen = Math.ceil(w / 8)
    const raw = new Uint8Array(rowLen * h).fill(0xff) // index 1 = white
    for (let y = 2000; y < 4000; y++) for (let x = 3000; x < 6000; x++) raw[y * rowLen + (x >> 3)] &= ~(0x80 >> (x & 7))
    const cs = ctx.obj([PDFName.of('Indexed'), PDFName.of('DeviceRGB'), PDFNumber.of(1), PDFHexString.of('000000FFFFFF')])
    add('indexed', deflateSync(raw), { Width: w, Height: h, BitsPerComponent: 1, ColorSpace: cs, Filter: 'FlateDecode' })
  }
  // 2) 7000×6000 8-bit RGB, PNG predictors: red left half, blue right half, green bottom stripe
  {
    const w = 7000
    const h = 6000
    const rowLen = w * 3
    const raw = new Uint8Array(rowLen * h)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * rowLen + x * 3
        if (y >= 5000) raw[i + 1] = 200
        else if (x < 3500) raw[i] = 255
        else raw[i + 2] = 255
      }
    const parms = ctx.obj({ Predictor: 15, Colors: 3, BitsPerComponent: 8, Columns: w })
    add('rgb', deflateSync(pngEncode(raw, rowLen, 3)), {
      Width: w,
      Height: h,
      BitsPerComponent: 8,
      ColorSpace: 'DeviceRGB',
      Filter: 'FlateDecode',
      DecodeParms: parms
    })
  }
  // 3) 8000×6000 1-bit grey, all zero bits, /Decode [1 0] → paints white; stored raw (no filter)
  {
    const w = 8000
    const h = 6000
    const raw = new Uint8Array((w / 8) * h)
    add('grey', raw, { Width: w, Height: h, BitsPerComponent: 1, ColorSpace: 'DeviceGray', Decode: [1, 0] })
  }
  // 4) small image — must be untouched
  add('small', deflateSync(new Uint8Array(100 * 100).fill(128)), {
    Width: 100,
    Height: 100,
    BitsPerComponent: 8,
    ColorSpace: 'DeviceGray',
    Filter: 'FlateDecode'
  })
  // 5) huge JPEG (bytes are a stand-in; it is never decoded) — must be skipped
  add('jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
    Width: 10000,
    Height: 10000,
    BitsPerComponent: 8,
    ColorSpace: 'DeviceRGB',
    Filter: 'DCTDecode'
  })

  for (const key of Object.keys(refs)) {
    const page = doc.addPage([600, 400])
    page.node.setXObject(PDFName.of('Im0'), refs[key])
    page.node.addContentStream(ctx.register(ctx.flateStream('q 600 0 0 400 0 0 cm /Im0 Do Q')))
  }
  return { bytes: await doc.save({ useObjectStreams: true }), refs }
}

function pixel(data: Uint8Array, w: number, comps: number, x: number, y: number): number[] {
  const i = (y * w + x) * comps
  return Array.from(data.subarray(i, i + comps))
}

async function main(): Promise<void> {
  console.log('fixture')
  const { bytes, refs } = await buildFixture()
  check(countHugeImages(bytes) === 4, `byte scan finds the 4 oversized images (got ${countHugeImages(bytes)})`)

  const t0 = Date.now()
  const { bytes: out, stats } = await optimizePdf(bytes, { images: true })
  console.log(`        pass took ${Date.now() - t0} ms`)
  check(stats.imagesDownsampled === 3, `3 images downsampled (got ${stats.imagesDownsampled})`)
  check(stats.imagesSkipped === 1, `1 image skipped — the JPEG (got ${stats.imagesSkipped})`)
  check(countHugeImages(out) === 1, `byte scan on the result finds only the JPEG (got ${countHugeImages(out)})`)

  const doc = await PDFDocument.load(out)
  const img = (key: string): PDFRawStream => doc.context.lookup(refs[key]) as PDFRawStream
  const dims = (s: PDFRawStream): string =>
    `${s.dict.lookup(PDFName.of('Width'))}x${s.dict.lookup(PDFName.of('Height'))}`

  {
    const s = img('indexed')
    check(dims(s) === '4500x3000', `indexed → 4500x3000 (got ${dims(s)})`)
    check(s.dict.lookup(PDFName.of('ColorSpace'))?.toString() === '/DeviceGray', 'black/white palette → DeviceGray')
    const d = decodePDFRawStream(s).decode()
    check(pixel(d, 4500, 1, 100, 100)[0] === 255, 'paper stays white')
    check(pixel(d, 4500, 1, 2000, 1500)[0] === 0, 'inside the block is black')
  }
  {
    const s = img('rgb')
    check(dims(s) === '3500x3000', `rgb → 3500x3000 (got ${dims(s)})`)
    check(!s.dict.get(PDFName.of('DecodeParms')), 'predictor parameters dropped')
    const d = decodePDFRawStream(s).decode()
    check(pixel(d, 3500, 3, 500, 500).join() === '255,0,0', `left half red (got ${pixel(d, 3500, 3, 500, 500)})`)
    check(pixel(d, 3500, 3, 3000, 500).join() === '0,0,255', `right half blue (got ${pixel(d, 3500, 3, 3000, 500)})`)
    check(pixel(d, 3500, 3, 1000, 2800).join() === '0,200,0', `bottom stripe green (got ${pixel(d, 3500, 3, 1000, 2800)})`)
  }
  {
    const s = img('grey')
    check(dims(s) === '4000x3000', `grey → 4000x3000 (got ${dims(s)})`)
    const dec = s.dict.lookup(PDFName.of('Decode'))
    check(dec instanceof PDFArray && dec.toString().replace(/\s+/g, ' ') === '[ 1 0 ]', `/Decode [1 0] kept (got ${dec})`)
    const d = decodePDFRawStream(s).decode()
    check(d.length === 4000 * 3000 && d.every((v) => v === 0), 'samples stay 0 (white through the Decode)')
  }
  check(dims(img('small')) === '100x100', 'small image untouched')
  check(dims(img('jpeg')) === '10000x10000', 'JPEG untouched')

  for (const f of process.argv.slice(2)) {
    console.log(f)
    const src = new Uint8Array(readFileSync(f))
    const t = Date.now()
    const found = countHugeImages(src)
    const scanMs = Date.now() - t
    const r = await optimizePdf(src, { images: true })
    console.log(
      `        scan: ${found} oversized in ${scanMs} ms · pass: ${r.stats.imagesDownsampled} downsampled, ` +
        `${r.stats.imagesSkipped} skipped, ${(r.stats.imagePixelsBefore / 1e6).toFixed(0)} → ` +
        `${(r.stats.imagePixelsAfter / 1e6).toFixed(0)} Mpx, ${(r.stats.fileBefore / 1e6).toFixed(1)} → ` +
        `${(r.stats.fileAfter / 1e6).toFixed(1)} MB in ${r.stats.ms} ms`
    )
    check(countHugeImages(r.bytes) === r.stats.imagesSkipped, 'only skipped images remain oversized')
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall ok')
  process.exit(failures ? 1 : 0)
}

void main()
