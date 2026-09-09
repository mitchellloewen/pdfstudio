/**
 * Getting the actual pixels of an image that is embedded in a page.
 *
 * Scanners emit CCITT G4 and JBIG2, cameras emit JPEG, and plan sets can carry
 * JPEG 2000 — decoding those by hand is not worth it when pdf.js already has
 * decoders for all of them. So the pixels come out of pdf.js's own object
 * store: building a page's operator list makes the worker ship every image it
 * paints, keyed by an object id, and the Nth image op on the page is the Nth
 * image `scanPageImages` found (both walk the content in render order).
 *
 * Used for the drag preview, and for turning a crop from a clip region into
 * genuinely trimmed pixels.
 */

import { pdfjsLib, type PDFDocumentProxy } from './pdfjs'
import type { Box, StoredImage } from './types'
import { uid } from './types'

const OPS = pdfjsLib.OPS

/**
 * Biggest bitmap kept for the crop guide, per side.
 *
 * It is drawn translucent behind a crop box, so screen resolution is plenty —
 * and the cost is not the pixels but the PNG the SVG <image> needs: encoding a
 * 2400px scan took ~130 ms and made every crop drag stutter.
 */
const MAX_PREVIEW_DIM = 700

interface RawImage {
  width: number
  height: number
  bitmap?: ImageBitmap
  data?: Uint8ClampedArray
  kind?: number
}

/** Wait for one of pdf.js's page objects, giving up rather than hanging. */
function pageObject(objs: { get: (id: string, cb: (v: unknown) => void) => unknown }, id: string, timeoutMs = 15000): Promise<RawImage | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (v: unknown): void => {
      if (settled) return
      settled = true
      resolve((v as RawImage) ?? null)
    }
    try {
      objs.get(id, done)
    } catch {
      done(null)
    }
    setTimeout(() => done(null), timeoutMs)
  })
}

/** pdf.js image kinds, from its util module. */
const GRAYSCALE_1BPP = 1
const RGB_24BPP = 2
const RGBA_32BPP = 3

function toCanvas(img: RawImage): HTMLCanvasElement | null {
  const w = img.width
  const h = img.height
  if (!w || !h) return null
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  if (img.bitmap) {
    ctx.drawImage(img.bitmap, 0, 0)
    return canvas
  }
  if (!img.data) return null

  const out = ctx.createImageData(w, h)
  const dst = out.data
  const src = img.data
  if (img.kind === RGBA_32BPP) {
    dst.set(src.subarray(0, dst.length))
  } else if (img.kind === RGB_24BPP) {
    for (let i = 0, j = 0; i < w * h; i++, j += 3) {
      dst[i * 4] = src[j]
      dst[i * 4 + 1] = src[j + 1]
      dst[i * 4 + 2] = src[j + 2]
      dst[i * 4 + 3] = 255
    }
  } else if (img.kind === GRAYSCALE_1BPP) {
    // one bit per pixel, rows padded to whole bytes; 0 is black
    const rowBytes = (w + 7) >> 3
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const bit = (src[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1
        const v = bit ? 255 : 0
        const o = (y * w + x) * 4
        dst[o] = v
        dst[o + 1] = v
        dst[o + 2] = v
        dst[o + 3] = 255
      }
    }
  } else {
    return null
  }
  ctx.putImageData(out, 0, 0)
  return canvas
}

const cache = new WeakMap<PDFDocumentProxy, Map<string, HTMLCanvasElement | null>>()

/**
 * The pixels of the `drawIndex`-th image drawn on a page, at their native
 * resolution (capped for previews). Returns null when pdf.js could not hand
 * the image over — a caller that needs real pixels should say so rather than
 * silently substituting something else.
 */
export async function decodeEmbeddedImage(
  doc: PDFDocumentProxy,
  srcPage: number,
  drawIndex: number,
  opts: { cap?: number } = {}
): Promise<HTMLCanvasElement | null> {
  const key = `${srcPage}:${drawIndex}:${opts.cap ?? 0}`
  let perDoc = cache.get(doc)
  if (!perDoc) {
    perDoc = new Map()
    cache.set(doc, perDoc)
  }
  if (perDoc.has(key)) return perDoc.get(key) ?? null

  let result: HTMLCanvasElement | null = null
  try {
    const page = await doc.getPage(srcPage)
    const ops = await page.getOperatorList()
    let seen = -1
    let raw: RawImage | null = null
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i]
      const isImage =
        fn === OPS.paintImageXObject ||
        fn === OPS.paintImageMaskXObject ||
        fn === OPS.paintInlineImageXObject
      if (!isImage) continue
      seen++
      if (seen !== drawIndex) continue
      const arg = (ops.argsArray[i] as unknown[])[0]
      if (typeof arg === 'string') {
        raw = await pageObject(page.objs as never, arg)
      } else if (arg && typeof arg === 'object') {
        raw = arg as RawImage // inline images arrive whole
      }
      break
    }
    if (raw) {
      const canvas = toCanvas(raw)
      const cap = opts.cap ?? 0
      if (canvas && cap > 0 && (canvas.width > cap || canvas.height > cap)) {
        const s = Math.min(cap / canvas.width, cap / canvas.height)
        const small = document.createElement('canvas')
        small.width = Math.max(1, Math.round(canvas.width * s))
        small.height = Math.max(1, Math.round(canvas.height * s))
        small.getContext('2d')?.drawImage(canvas, 0, 0, small.width, small.height)
        canvas.width = 0
        canvas.height = 0
        result = small
      } else {
        result = canvas
      }
    }
  } catch (e) {
    console.warn('could not decode embedded image', e)
  }
  perDoc.set(key, result)
  return result
}

/** A low-resolution copy for the drag preview. */
export function previewImage(doc: PDFDocumentProxy, srcPage: number, drawIndex: number): Promise<HTMLCanvasElement | null> {
  return decodeEmbeddedImage(doc, srcPage, drawIndex, { cap: MAX_PREVIEW_DIM })
}

function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return resolve(null)
        blob.arrayBuffer().then((ab) => resolve(new Uint8Array(ab)), () => resolve(null))
      },
      type,
      quality
    )
  })
}

/** Rough test for artwork that PNG will compress well (line art, scans). */
function looksFlat(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d')
  if (!ctx) return true
  const w = Math.min(canvas.width, 160)
  const h = Math.min(canvas.height, 160)
  const sample = document.createElement('canvas')
  sample.width = w
  sample.height = h
  sample.getContext('2d')?.drawImage(canvas, 0, 0, w, h)
  const data = sample.getContext('2d')?.getImageData(0, 0, w, h).data
  if (!data) return true
  const seen = new Set<number>()
  for (let i = 0; i < data.length; i += 4) {
    seen.add((data[i] >> 3) << 10 | (data[i + 1] >> 3) << 5 | data[i + 2] >> 3)
    if (seen.size > 600) return false
  }
  return true
}

/**
 * Trim an embedded image to its crop for real, producing a stored image the
 * save pipeline embeds in place of the original.
 *
 * `crop` is in image space with the origin at the bottom-left, matching the
 * PDF unit square — the top row of pixels is v = 1.
 */
export async function cropToStoredImage(canvas: HTMLCanvasElement, crop: Box): Promise<StoredImage | null> {
  const W = canvas.width
  const H = canvas.height
  const sx = Math.max(0, Math.round(crop.x * W))
  const sy = Math.max(0, Math.round((1 - crop.y - crop.h) * H))
  const sw = Math.max(1, Math.min(W - sx, Math.round(crop.w * W)))
  const sh = Math.max(1, Math.min(H - sy, Math.round(crop.h * H)))

  const out = document.createElement('canvas')
  out.width = sw
  out.height = sh
  const ctx = out.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh)

  // Line art and scans stay sharp (and small) as PNG; photographs would balloon,
  // so those go back out as JPEG.
  const flat = looksFlat(out)
  let bytes = await encode(out, flat ? 'image/png' : 'image/jpeg', flat ? undefined : 0.92)
  let kind: 'png' | 'jpg' = flat ? 'png' : 'jpg'
  if (!bytes) {
    bytes = await encode(out, 'image/png')
    kind = 'png'
  }
  if (!bytes) return null

  const dataUrl = out.toDataURL(kind === 'png' ? 'image/png' : 'image/jpeg', 0.92)
  const buf = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buf).set(bytes)
  out.width = 0
  out.height = 0
  return { id: uid(), kind, dataUrl, bytes: buf, width: sw, height: sh }
}
