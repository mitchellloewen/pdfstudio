import type { PDFDocumentProxy } from './pdfjs'
import type { OcrWord, PageLeaf } from './types'

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface HRect {
  x: number
  y: number
  w: number
  h: number
}

export interface SearchMatch {
  id: string
  leafId: string
  pageIndex: number // display index
  yFrac: number // 0 = top of page, 1 = bottom (for scrolling)
  rects: HRect[] // user-space (bottom-left origin), unrotated
}

interface ItemBox {
  str: string
  start: number
  e: number // baseline x (user space)
  f: number // baseline y (user space)
  width: number
  height: number
}

interface PageText {
  joined: string
  items: ItemBox[]
  pageHeight: number
}

const cache = new WeakMap<PDFDocumentProxy, Map<number, PageText>>()

async function getPageText(doc: PDFDocumentProxy, srcPage: number, ocrWords?: OcrWord[]): Promise<PageText> {
  let m = cache.get(doc)
  if (!m) {
    m = new Map()
    cache.set(doc, m)
  }
  const hit = m.get(srcPage)
  // a page cached as empty gets rebuilt once OCR results become available
  if (hit && (hit.joined !== '' || !ocrWords?.length)) return hit

  const page = await doc.getPage(srcPage)
  const view = page.view // [x0, y0, x1, y1] unrotated MediaBox
  const pageHeight = view[3] - view[1]
  const tc = await page.getTextContent()
  let joined = ''
  const items: ItemBox[] = []
  for (const it of tc.items as any[]) {
    if (typeof it.str !== 'string') continue
    const tr = it.transform as number[]
    items.push({
      str: it.str,
      start: joined.length,
      e: tr[4],
      f: tr[5],
      width: it.width || 0,
      height: it.height || Math.hypot(tr[2], tr[3]) || 10
    })
    joined += it.str
    if (it.hasEOL) joined += '\n'
  }
  // scanned page: synthesise the text stream from OCR words
  if (items.length === 0 && ocrWords?.length) {
    for (const w of ocrWords) {
      items.push({
        str: w.text,
        start: joined.length,
        e: w.rect.x,
        f: w.rect.y + w.rect.h * 0.2,
        width: w.rect.w,
        height: w.rect.h * 0.85
      })
      joined += w.text + ' '
    }
  }
  const pt: PageText = { joined, items, pageHeight }
  m.set(srcPage, pt)
  return pt
}

function findExact(text: string, q: string): [number, number][] {
  const hay = text.toLowerCase()
  const needle = q.toLowerCase()
  const res: [number, number][] = []
  let i = 0
  for (;;) {
    const idx = hay.indexOf(needle, i)
    if (idx < 0) break
    res.push([idx, idx + needle.length])
    i = idx + needle.length
  }
  return res
}

/** Fuzzy = ignore case, whitespace and punctuation. */
function findFuzzy(text: string, q: string): [number, number][] {
  const map: number[] = []
  let norm = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i].toLowerCase()
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
      norm += c
      map.push(i)
    }
  }
  const nq = q.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!nq) return []
  const res: [number, number][] = []
  let i = 0
  for (;;) {
    const idx = norm.indexOf(nq, i)
    if (idx < 0) break
    res.push([map[idx], map[idx + nq.length - 1] + 1])
    i = idx + nq.length
  }
  return res
}

function rectsForRange(pt: PageText, s: number, e: number): HRect[] {
  const rects: HRect[] = []
  for (const it of pt.items) {
    const iStart = it.start
    const iEnd = it.start + it.str.length
    const os = Math.max(s, iStart)
    const oe = Math.min(e, iEnd)
    if (oe <= os) continue
    const len = it.str.length || 1
    const x = it.e + it.width * ((os - iStart) / len)
    const w = it.width * ((oe - os) / len)
    const h = it.height
    rects.push({ x, y: it.f - h * 0.22, w, h: h * 1.08 })
  }
  return rects
}

export async function runSearch(
  doc: PDFDocumentProxy,
  leaves: PageLeaf[],
  query: string,
  opts: { fuzzy: boolean; isCancelled?: () => boolean; ocr?: (srcPage: number) => OcrWord[] | undefined }
): Promise<SearchMatch[]> {
  const q = query.trim()
  if (!q) return []
  const out: SearchMatch[] = []
  let counter = 0
  for (let pi = 0; pi < leaves.length; pi++) {
    // bail out between pages so stale queries stop burning the worker
    if (opts.isCancelled?.()) return out
    const leaf = leaves[pi]
    let pt: PageText
    try {
      pt = await getPageText(doc, leaf.srcPage, opts.ocr?.(leaf.srcPage))
    } catch {
      continue
    }
    const ranges = opts.fuzzy ? findFuzzy(pt.joined, q) : findExact(pt.joined, q)
    for (const [s, e] of ranges) {
      const rects = rectsForRange(pt, s, e)
      if (!rects.length) continue
      const topY = Math.max(...rects.map((r) => r.y + r.h))
      const yFrac = pt.pageHeight ? Math.min(1, Math.max(0, (pt.pageHeight - topY) / pt.pageHeight)) : 0
      out.push({ id: 'm' + counter++, leafId: leaf.id, pageIndex: pi, yFrac, rects })
    }
  }
  return out
}
