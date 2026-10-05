/**
 * Oversized raster images — scanned plan sheets at 600 dpi and the like.
 *
 * pdf.js cannot decode an image at reduced resolution. Every time it draws a
 * page, at any zoom, it unpacks the whole image first: a 36″ × 24″ sheet
 * scanned at 600 dpi is ~311 megapixels, so that is ~1–2 GB and 10–20 s of
 * worker time per draw. Thumbnails, OCR and every cancelled-and-restarted
 * render queue behind it on the one pdf.js worker, and the page never shows.
 * Acrobat copes because it subsamples while decoding.
 *
 * The cure mirrors the content-stream optimiser: downsample those images in
 * the *render copy* (App's `applyFastDoc`), leaving the file on disk — and
 * everything saved, printed or extracted from it — at full resolution. The
 * page canvas is capped at 4096 px per side (PageView `MAX_CANVAS_DIM`) and the
 * OCR raster at 4000, so nothing beyond ~8000 px is ever visible anyway.
 *
 * Two halves:
 *  - `countHugeImages` — a byte scan cheap enough to run on every open.
 *  - `downsampleImages` — the rewrite, run inside the optimiser worker.
 */
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
  decodePDFRawStream,
  type PDFObject
} from 'pdf-lib'

/** Above this many pixels an image is worth downsampling for display. */
export const HUGE_IMAGE_PX = 40e6
/** Downsampled images stay within this many pixels per side… */
const TARGET_DIM = 8192
/** …and this many pixels in all. */
const TARGET_PX = 40e6

// ---- open-time detection ---------------------------------------------------

const isWs = (c: number): boolean => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00
const isDelim = (c: number): boolean =>
  isWs(c) || c === 0x2f || c === 0x3e || c === 0x3c || c === 0x5b || c === 0x5d || c === 0x28 || c === 0x29

const IMAGE = [0x2f, 0x49, 0x6d, 0x61, 0x67, 0x65] // "/Image"
const SUBTYPE = [0x2f, 0x53, 0x75, 0x62, 0x74, 0x79, 0x70, 0x65] // "/Subtype"

function matchAt(bytes: Uint8Array, at: number, pat: number[]): boolean {
  if (at < 0 || at + pat.length > bytes.length) return false
  for (let k = 0; k < pat.length; k++) if (bytes[at + k] !== pat[k]) return false
  return true
}

/**
 * Count image XObjects over `HUGE_IMAGE_PX`, straight from the file bytes.
 *
 * Reliable without parsing because an image is a stream, and a stream's
 * dictionary can never sit inside a compressed object stream — it is always
 * plain text in the file, encrypted documents included (encryption covers
 * strings and stream data, not dictionary keys or numbers). A /Width or
 * /Height given as an indirect reference is missed; that is rare enough to
 * leave to the slow-render trigger.
 */
export function countHugeImages(bytes: Uint8Array): number {
  let n = 0
  const dec = new TextDecoder('latin1')
  for (let i = bytes.indexOf(0x2f); i >= 0; i = bytes.indexOf(0x2f, i + 1)) {
    if (!matchAt(bytes, i, IMAGE) || !isDelim(bytes[i + IMAGE.length] ?? 0x20)) continue
    // must be the value of /Subtype — not a resource name like /Image 12 0 R
    let j = i - 1
    while (j >= 0 && isWs(bytes[j])) j--
    if (!matchAt(bytes, j - SUBTYPE.length + 1, SUBTYPE)) continue
    // the enclosing dictionary: back to its `obj`, forward to its `stream`
    const from = Math.max(0, i - 2048)
    const to = Math.min(bytes.length, i + 2048)
    let text = dec.decode(bytes.subarray(from, to))
    const at = i - from
    const objAt = text.lastIndexOf(' obj', at)
    const streamAt = text.indexOf('stream', at)
    text = text.slice(objAt >= 0 ? objAt : 0, streamAt >= 0 ? streamAt : text.length)
    const w = /\/Width\s+(\d+)(?!\s+\d+\s+R)/.exec(text)
    const h = /\/Height\s+(\d+)(?!\s+\d+\s+R)/.exec(text)
    if (w && h && Number(w[1]) * Number(h[1]) > HUGE_IMAGE_PX) n++
  }
  return n
}

// ---- the rewrite -------------------------------------------------------------

export interface ImageStats {
  /** Images replaced with a smaller copy. */
  imagesDownsampled: number
  /** Oversized images left alone (a filter or colour model we don't decode). */
  imagesSkipped: number
  imagePixelsBefore: number
  imagePixelsAfter: number
}

const num = (o: PDFObject | undefined): number | null => (o instanceof PDFNumber ? o.asNumber() : null)
const nameOf = (o: PDFObject | undefined): string | null => (o instanceof PDFName ? o.asString().slice(1) : null)

/** Components per sample for a non-indexed colour space, or null if unknown. */
function componentCount(doc: PDFDocument, cs: PDFObject | undefined): number | null {
  const o = cs instanceof PDFRef ? doc.context.lookup(cs) : cs
  const n = nameOf(o)
  if (n) {
    if (n === 'DeviceGray' || n === 'G' || n === 'CalGray') return 1
    if (n === 'DeviceRGB' || n === 'RGB' || n === 'CalRGB' || n === 'Lab') return 3
    if (n === 'DeviceCMYK' || n === 'CMYK') return 4
    return null
  }
  if (!(o instanceof PDFArray) || !o.size()) return null
  const fam = nameOf(o.get(0))
  if (fam === 'CalGray') return 1
  if (fam === 'CalRGB' || fam === 'Lab') return 3
  if (fam === 'Separation') return 1
  if (fam === 'DeviceN') {
    const names = doc.context.lookup(o.get(1))
    return names instanceof PDFArray ? names.size() : null
  }
  if (fam === 'ICCBased') {
    const s = doc.context.lookup(o.get(1))
    return s instanceof PDFRawStream ? num(s.dict.lookup(PDFName.of('N'))) : null
  }
  return null
}

/** The bytes of an /Indexed lookup table, given as a string or a stream. */
function lookupBytes(doc: PDFDocument, o: PDFObject | undefined): Uint8Array | null {
  const v = o instanceof PDFRef ? doc.context.lookup(o) : o
  if (v instanceof PDFString || v instanceof PDFHexString) return v.asBytes()
  if (v instanceof PDFRawStream) {
    try {
      return decodePDFRawStream(v).decode()
    } catch {
      return null
    }
  }
  return null
}

interface Plan {
  w: number
  h: number
  bpc: number
  /** samples per pixel in the stored image (1 for an indexed image) */
  inComps: number
  /** components written out */
  outComps: number
  /** non-indexed: sample value → 8-bit sample */
  lut: Uint8Array | null
  /** indexed: sample value → `outComps` bytes of the base colour space */
  palette: Uint8Array | null
  /** what the new image dictionary's /ColorSpace becomes */
  outCs: PDFObject
  /** keep the original /Decode (non-indexed: it still applies to 8-bit samples) */
  keepDecode: boolean
  /** PNG predictor in use (Predictor ≥ 10), with its bytes per pixel */
  png: { bpp: number } | null
  /** stream data is Flate-compressed (else stored raw) */
  flate: boolean
}

/** Work out how to decode an image, or return null to leave it alone. */
function planImage(doc: PDFDocument, dict: PDFDict): Plan | null {
  const w = num(dict.lookup(PDFName.of('Width')))
  const h = num(dict.lookup(PDFName.of('Height')))
  if (!w || !h) return null
  // Stencil masks and soft-masked images would need their mask resampled in
  // step; leave them to pdf.js.
  const isMask = dict.lookup(PDFName.of('ImageMask'))
  if (isMask instanceof PDFBool && isMask.asBoolean()) return null
  if (dict.get(PDFName.of('SMask')) || dict.get(PDFName.of('Mask')) || dict.get(PDFName.of('SMaskInData'))) return null

  // one Flate filter, or none — CCITT, JBIG2, JPEG and JPEG 2000 are skipped
  let filter = dict.lookup(PDFName.of('Filter'))
  let parms = dict.lookup(PDFName.of('DecodeParms'))
  if (filter instanceof PDFArray) {
    if (filter.size() > 1) return null
    filter = filter.size() ? filter.lookup(0) : undefined
    if (parms instanceof PDFArray) parms = parms.size() ? parms.lookup(0) : undefined
  }
  const f = nameOf(filter)
  if (filter && f !== 'FlateDecode' && f !== 'Fl') return null
  const flate = !!filter

  const bpc = num(dict.lookup(PDFName.of('BitsPerComponent')))
  if (bpc !== 1 && bpc !== 2 && bpc !== 4 && bpc !== 8) return null
  const levels = (1 << bpc) - 1

  const csObj = dict.get(PDFName.of('ColorSpace'))
  const cs = csObj instanceof PDFRef ? doc.context.lookup(csObj) : csObj
  const decode = dict.lookup(PDFName.of('Decode'))
  const decodeArr = decode instanceof PDFArray ? decode.asArray().map((x) => num(x) ?? NaN) : null
  if (decodeArr && decodeArr.some((x) => !Number.isFinite(x))) return null

  let inComps: number
  let outComps: number
  let lut: Uint8Array | null = null
  let palette: Uint8Array | null = null
  let outCs: PDFObject
  let keepDecode = true

  const fam = cs instanceof PDFArray ? nameOf(cs.get(0)) : null
  if (cs instanceof PDFArray && (fam === 'Indexed' || fam === 'I')) {
    // Indices can't be averaged — expand through the palette instead.
    const baseObj = cs.get(1)
    const baseN = componentCount(doc, baseObj)
    const hival = num(cs.lookup(2))
    const table = lookupBytes(doc, cs.get(3))
    if (!baseN || hival === null || !table) return null
    inComps = 1
    // /Decode on an indexed image remaps the index itself
    const d0 = decodeArr ? decodeArr[0] : 0
    const d1 = decodeArr ? decodeArr[1] : levels
    const entry = (v: number): number => Math.max(0, Math.min(hival, Math.round(d0 + (v * (d1 - d0)) / levels)))
    // a black-and-white or grey palette over RGB comes out as plain grey
    const base = baseObj instanceof PDFRef ? doc.context.lookup(baseObj) : baseObj
    const baseName = nameOf(base)
    let grey = baseN === 3 && (baseName === 'DeviceRGB' || baseName === 'RGB')
    for (let v = 0; v <= levels && grey; v++) {
      const e = entry(v) * 3
      grey = table[e] === table[e + 1] && table[e] === table[e + 2]
    }
    outComps = grey ? 1 : baseN
    palette = new Uint8Array((levels + 1) * outComps)
    for (let v = 0; v <= levels; v++) {
      const e = entry(v) * baseN
      for (let c = 0; c < outComps; c++) palette[v * outComps + c] = table[e + c] ?? 0
    }
    outCs = grey ? PDFName.of('DeviceGray') : baseObj
    keepDecode = false
  } else {
    const n = componentCount(doc, csObj)
    if (!n || !csObj) return null
    inComps = outComps = n
    // Rescale samples to 8 bits. /Decode (if any) maps the full sample range
    // onto the colour range, so it stays valid unchanged.
    lut = new Uint8Array(levels + 1)
    for (let v = 0; v <= levels; v++) lut[v] = Math.round((v * 255) / levels)
    outCs = csObj
  }

  let png: Plan['png'] = null
  if (parms instanceof PDFDict) {
    const predictor = num(parms.lookup(PDFName.of('Predictor'))) ?? 1
    if (predictor >= 10) {
      const colors = num(parms.lookup(PDFName.of('Colors'))) ?? 1
      const pbpc = num(parms.lookup(PDFName.of('BitsPerComponent'))) ?? 8
      const cols = num(parms.lookup(PDFName.of('Columns'))) ?? 1
      // the predictor's row geometry has to be the image's, or rows misalign
      if (colors !== inComps || pbpc !== bpc || cols !== w) return null
      png = { bpp: Math.max(1, Math.ceil((colors * pbpc) / 8)) }
    } else if (predictor !== 1) {
      return null // TIFF predictor — rare in practice, not handled
    }
  }

  return { w, h, bpc, inComps, outComps, lut, palette, outCs, keepDecode, png, flate }
}

/** Undo one row of PNG prediction in place. `row[0]` is the filter-type byte. */
function unpredictRow(row: Uint8Array, prev: Uint8Array, bpp: number): Uint8Array {
  const out = row.subarray(1)
  const n = out.length
  switch (row[0]) {
    case 0:
      break
    case 1:
      for (let i = bpp; i < n; i++) out[i] = (out[i] + out[i - bpp]) & 0xff
      break
    case 2:
      for (let i = 0; i < n; i++) out[i] = (out[i] + prev[i]) & 0xff
      break
    case 3:
      for (let i = 0; i < n; i++) out[i] = (out[i] + (((i >= bpp ? out[i - bpp] : 0) + prev[i]) >> 1)) & 0xff
      break
    case 4:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? out[i - bpp] : 0
        const b = prev[i]
        const c = i >= bpp ? prev[i - bpp] : 0
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        out[i] = (out[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      }
      break
    default:
      throw new Error('bad PNG predictor row')
  }
  return out
}

/**
 * Stream the image's rows through `onRow` without ever holding the whole
 * decoded image — a 311-megapixel RGB scan would be ~1 GB. Resolves true once
 * every row has arrived.
 */
async function forEachRow(data: Uint8Array, plan: Plan, onRow: (row: Uint8Array) => void): Promise<boolean> {
  const rowLen = (plan.w * plan.inComps * plan.bpc + 7) >> 3
  const stride = rowLen + (plan.png ? 1 : 0)
  const buf = new Uint8Array(stride)
  const prev = new Uint8Array(rowLen)
  let fill = 0
  let rows = 0
  const take = (chunk: Uint8Array): void => {
    let o = 0
    while (o < chunk.length && rows < plan.h) {
      const k = Math.min(stride - fill, chunk.length - o)
      buf.set(chunk.subarray(o, o + k), fill)
      fill += k
      o += k
      if (fill === stride) {
        if (plan.png) {
          const row = unpredictRow(buf, prev, plan.png.bpp)
          prev.set(row) // the decoded row is the next row's "previous"
          onRow(row)
        } else {
          onRow(buf)
        }
        rows++
        fill = 0
      }
    }
  }
  if (!plan.flate) {
    take(data)
    return rows === plan.h
  }
  const ds = new DecompressionStream('deflate')
  const writer = ds.writable.getWriter()
  writer.write(data as unknown as BufferSource).catch(() => {})
  writer.close().catch(() => {})
  const reader = ds.readable.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      take(value)
      if (rows === plan.h) {
        void reader.cancel().catch(() => {})
        break
      }
    }
  } catch {
    // A bad checksum or truncated tail is common in the wild. Only the rows
    // matter: if they all arrived, the image is complete.
  }
  return rows === plan.h
}

/** Box-filter one image down by `f` in each direction, to 8-bit samples. */
async function downsample(
  data: Uint8Array,
  plan: Plan,
  f: number
): Promise<{ pixels: Uint8Array; W: number; H: number } | null> {
  const { w, h, bpc, inComps, outComps, lut, palette } = plan
  const W = Math.ceil(w / f)
  const H = Math.ceil(h / f)
  const out = new Uint8Array(W * H * outComps)
  const acc = new Uint32Array(W * outComps)
  const colOf = new Uint32Array(w)
  for (let x = 0; x < w; x++) colOf[x] = (x / f) | 0
  // the last column and row of boxes can be partial
  const colN = new Uint32Array(W)
  for (let x = 0; x < w; x++) colN[colOf[x]]++
  const mask = (1 << bpc) - 1
  const perByte = 8 / bpc

  let bandRows = 0
  let outRow = 0
  const flush = (): void => {
    const base = outRow * W * outComps
    for (let X = 0; X < W; X++) {
      const n = colN[X] * bandRows
      for (let c = 0; c < outComps; c++) {
        const i = X * outComps + c
        out[base + i] = Math.round(acc[i] / n)
      }
    }
    acc.fill(0)
    bandRows = 0
    outRow++
  }
  // sample `s` of a packed sub-byte row
  const sample = (row: Uint8Array, s: number): number =>
    (row[(s / perByte) | 0] >> ((perByte - 1 - (s % perByte)) * bpc)) & mask

  const ok = await forEachRow(data, plan, (row) => {
    if (palette && outComps === 1 && bpc < 8) {
      // The plan-scan case (1-bit, one output channel) — unpack a byte at a
      // time; a divide and modulo per sample costs seconds at 300+ Mpx.
      for (let b = 0, x = 0; x < w; b++) {
        const byte = row[b]
        for (let shift = 8 - bpc; shift >= 0 && x < w; shift -= bpc, x++) {
          acc[colOf[x]] += palette[(byte >> shift) & mask]
        }
      }
    } else if (palette) {
      for (let x = 0; x < w; x++) {
        const p = (bpc === 8 ? row[x] : sample(row, x)) * outComps
        const a = colOf[x] * outComps
        for (let c = 0; c < outComps; c++) acc[a + c] += palette[p + c]
      }
    } else if (bpc === 8) {
      for (let x = 0, s = 0; x < w; x++) {
        const a = colOf[x] * outComps
        for (let c = 0; c < inComps; c++) acc[a + c] += row[s++]
      }
    } else {
      for (let x = 0, s = 0; x < w; x++) {
        const a = colOf[x] * outComps
        for (let c = 0; c < inComps; c++, s++) acc[a + c] += lut![sample(row, s)]
      }
    }
    if (++bandRows === f) flush()
  })
  if (!ok) return null
  if (bandRows) flush()
  return outRow === H ? { pixels: out, W, H } : null
}

/** Integer reduction factor that brings an image within the targets. */
function factorFor(w: number, h: number): number {
  let f = Math.max(2, Math.ceil(Math.max(w, h) / TARGET_DIM))
  while (Math.ceil(w / f) * Math.ceil(h / f) > TARGET_PX) f++
  return f
}

/**
 * Replace every image over `HUGE_IMAGE_PX` with a box-filtered 8-bit copy.
 *
 * The image object is replaced in place (`ctx.assign`), so every page and form
 * that draws it keeps pointing at it, and the image still fills the same unit
 * square — only its sample grid gets coarser. Anything not understood is left
 * exactly as it was.
 */
export async function downsampleImages(
  doc: PDFDocument,
  deflate: (data: Uint8Array) => Promise<Uint8Array>,
  onProgress?: (done: number, total: number) => void
): Promise<ImageStats> {
  const stats: ImageStats = { imagesDownsampled: 0, imagesSkipped: 0, imagePixelsBefore: 0, imagePixelsAfter: 0 }
  const ctx = doc.context
  const work: { ref: PDFRef; stream: PDFRawStream }[] = []
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue
    if (nameOf(obj.dict.get(PDFName.of('Subtype'))) !== 'Image') continue
    const w = num(obj.dict.lookup(PDFName.of('Width'))) ?? 0
    const h = num(obj.dict.lookup(PDFName.of('Height'))) ?? 0
    if (w * h > HUGE_IMAGE_PX) work.push({ ref, stream: obj })
  }
  let done = 0
  for (const { ref, stream } of work) {
    const plan = planImage(doc, stream.dict)
    const res = plan ? await downsample(stream.contents, plan, factorFor(plan.w, plan.h)).catch(() => null) : null
    if (!plan || !res) {
      stats.imagesSkipped++
    } else {
      const packed = await deflate(res.pixels)
      const dict = stream.dict.clone(ctx)
      dict.set(PDFName.of('Width'), PDFNumber.of(res.W))
      dict.set(PDFName.of('Height'), PDFNumber.of(res.H))
      dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8))
      dict.set(PDFName.of('ColorSpace'), plan.outCs)
      dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'))
      dict.set(PDFName.of('Length'), PDFNumber.of(packed.length))
      dict.delete(PDFName.of('DecodeParms'))
      if (!plan.keepDecode) dict.delete(PDFName.of('Decode'))
      ctx.assign(ref, PDFRawStream.of(dict, packed))
      stats.imagesDownsampled++
      stats.imagePixelsBefore += plan.w * plan.h
      stats.imagePixelsAfter += res.W * res.H
    }
    done++
    onProgress?.(done, work.length)
  }
  return stats
}
