import type { PDFDocumentProxy } from './pdfjs'
import type { Box, OcrWord } from './types'

/** One clickable line of existing page text (Edit Text mode). */
export interface EditableLine {
  text: string
  rect: Box // user space
  fontSize: number // estimated, in points
}

interface Piece {
  str: string
  x: number
  x2: number
  bottom: number
  top: number
  h: number
}

const cache = new WeakMap<PDFDocumentProxy, Map<number, EditableLine[]>>()

/**
 * Extract existing text as editable lines: native text items when present,
 * OCR words on scanned pages. Lines are grouped by baseline and split into
 * segments on large horizontal gaps (columns / tables).
 */
export async function getEditableLines(
  doc: PDFDocumentProxy,
  srcPage: number,
  ocrWords?: OcrWord[]
): Promise<EditableLine[]> {
  let m = cache.get(doc)
  if (!m) {
    m = new Map()
    cache.set(doc, m)
  }
  const hit = m.get(srcPage)
  if (hit && (hit.length > 0 || !ocrWords?.length)) return hit

  const page = await doc.getPage(srcPage)
  const tc = await page.getTextContent()
  const pieces: Piece[] = []
  for (const it of tc.items as any[]) {
    if (typeof it.str !== 'string' || !it.str.trim()) continue
    const tr = it.transform as number[]
    const h = it.height || Math.hypot(tr[2], tr[3]) || 10
    // tr[5] is the baseline; approximate the glyph box around it
    pieces.push({ str: it.str, x: tr[4], x2: tr[4] + (it.width || 0), bottom: tr[5] - h * 0.25, top: tr[5] + h * 0.85, h })
  }
  const fromOcr = pieces.length === 0 && !!ocrWords?.length
  if (fromOcr) {
    for (const w of ocrWords!) {
      pieces.push({ str: w.text, x: w.rect.x, x2: w.rect.x + w.rect.w, bottom: w.rect.y, top: w.rect.y + w.rect.h, h: w.rect.h })
    }
  }

  const lines: EditableLine[] = []
  if (pieces.length) {
    // group into rows by vertical center proximity
    pieces.sort((a, b) => (b.top + b.bottom) / 2 - (a.top + a.bottom) / 2 || a.x - b.x)
    const rows: Piece[][] = []
    for (const p of pieces) {
      const cy = (p.top + p.bottom) / 2
      const row = rows[rows.length - 1]
      if (row) {
        const rc = row.reduce((s, q) => s + (q.top + q.bottom) / 2, 0) / row.length
        const rh = row.reduce((s, q) => s + q.h, 0) / row.length
        if (Math.abs(cy - rc) < Math.max(rh, p.h) * 0.6) {
          row.push(p)
          continue
        }
      }
      rows.push([p])
    }
    // split each row into segments on big horizontal gaps (columns)
    for (const row of rows) {
      row.sort((a, b) => a.x - b.x)
      let seg: Piece[] = []
      const flush = (): void => {
        if (!seg.length) return
        const x1 = Math.min(...seg.map((p) => p.x))
        const x2 = Math.max(...seg.map((p) => p.x2))
        const y1 = Math.min(...seg.map((p) => p.bottom))
        const y2 = Math.max(...seg.map((p) => p.top))
        const text = seg
          .map((p) => p.str)
          .join(fromOcr ? ' ' : '')
          .replace(/\s+/g, ' ')
          .trim()
        if (text && x2 - x1 > 1 && y2 - y1 > 1) {
          const medH = seg.map((p) => p.h).sort((a, b) => a - b)[Math.floor(seg.length / 2)]
          lines.push({
            text,
            rect: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 },
            fontSize: Math.min(96, Math.max(5, Math.round(medH * (fromOcr ? 1.1 : 1))))
          })
        }
        seg = []
      }
      for (const p of row) {
        const prev = seg[seg.length - 1]
        if (prev && p.x - prev.x2 > Math.max(prev.h, p.h) * 2) flush()
        seg.push(p)
      }
      flush()
    }
  }
  m.set(srcPage, lines)
  return lines
}
