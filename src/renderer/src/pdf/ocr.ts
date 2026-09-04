import type { PDFDocumentProxy } from './pdfjs'
import { canvasToJpeg, renderPageBitmap } from './pdfjs'
import type { OcrWord } from './types'

/** SHA-256 hex of the document bytes — keys the on-disk OCR cache. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Does this page already contain real (born-digital) text? */
export async function pageHasText(doc: PDFDocumentProxy, srcPage: number): Promise<boolean> {
  const page = await doc.getPage(srcPage)
  const tc = await page.getTextContent()
  return (tc.items as { str?: string }[]).some((it) => typeof it.str === 'string' && it.str.trim() !== '')
}

/**
 * Rasterise one page (~300 dpi, capped) and run it through the bundled OCR
 * engine in the main process. Returns words with rects in PDF user space, or
 * null if recognition failed.
 */
export async function ocrPageWords(doc: PDFDocumentProxy, srcPage: number): Promise<OcrWord[] | null> {
  const { canvas, viewport } = await renderPageBitmap(doc, srcPage, 0, 300, 4000)
  let jpg: Uint8Array
  try {
    jpg = await canvasToJpeg(canvas, 0.9)
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
  const buf = jpg.buffer.slice(jpg.byteOffset, jpg.byteOffset + jpg.byteLength) as ArrayBuffer
  const res = await window.api.ocrPage(buf)
  if (!res.ok) {
    console.warn('OCR failed for page', srcPage, res.error)
    return null
  }
  const out: OcrWord[] = []
  const maxH = viewport.height
  for (const w of res.words) {
    const text = w.text.trim()
    if (!text) continue
    // ignore degenerate or absurdly large boxes (usually noise)
    const pw = Math.abs(w.x1 - w.x0)
    const ph = Math.abs(w.y1 - w.y0)
    if (pw < 2 || ph < 2 || ph > maxH * 0.5) continue
    const [ux1, uy1] = viewport.convertToPdfPoint(w.x0, w.y0)
    const [ux2, uy2] = viewport.convertToPdfPoint(w.x1, w.y1)
    out.push({
      text,
      rect: {
        x: Math.min(ux1, ux2),
        y: Math.min(uy1, uy2),
        w: Math.abs(ux2 - ux1),
        h: Math.abs(uy2 - uy1)
      }
    })
  }
  return out
}

export interface OcrCacheFile {
  v: number
  pages: Record<string, OcrWord[]>
}

export function parseOcrCache(raw: unknown): Record<number, OcrWord[]> | null {
  const c = raw as OcrCacheFile | null
  if (!c || c.v !== 1 || typeof c.pages !== 'object' || !c.pages) return null
  const out: Record<number, OcrWord[]> = {}
  for (const [k, v] of Object.entries(c.pages)) {
    const n = Number(k)
    if (Number.isInteger(n) && Array.isArray(v)) out[n] = v
  }
  return out
}
