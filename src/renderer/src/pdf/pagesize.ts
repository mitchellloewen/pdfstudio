/**
 * Putting every page on a standard sheet size.
 *
 * A scanner that says "Letter" rarely produces exactly 612x792, and a document
 * assembled from several sources ends up a few points different page to page.
 * This normalises them: pick a standard size, then either scale the content to
 * fit the new sheet or leave it at its true size and let the sheet crop or pad
 * around it.
 *
 * The content is never rasterised or redrawn — the page's existing stream is
 * wrapped in `q <scale/translate> cm … Q` and the boxes are reset. Text stays
 * text, images stay images, and every image on the page is still editable
 * afterwards (its placement simply carries the same transform).
 */

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFStream } from 'pdf-lib'
import { mulM } from './images'
import type { Annotation, Box, Calibration, DocModel, Matrix, OcrWord, Pt } from './types'

export interface SheetSize {
  id: string
  label: string
  /** Portrait dimensions in points. */
  w: number
  h: number
}

export const SHEET_SIZES: SheetSize[] = [
  { id: 'letter', label: 'Letter — 8.5 × 11 in', w: 612, h: 792 },
  { id: 'legal', label: 'Legal — 8.5 × 14 in', w: 612, h: 1008 },
  { id: 'tabloid', label: 'Tabloid — 11 × 17 in', w: 792, h: 1224 },
  { id: 'a4', label: 'A4 — 210 × 297 mm', w: 595.276, h: 841.89 },
  { id: 'a3', label: 'A3 — 297 × 420 mm', w: 841.89, h: 1190.551 }
]

export type Orientation = 'auto' | 'portrait' | 'landscape'

/** What happens to the content when the sheet changes size. */
export type FitMode =
  /** Scale it proportionally so it fills the new sheet. */
  | 'scale'
  /** Leave it at its printed size; the sheet crops or adds white around it. */
  | 'keep'

export interface ResizeOptions {
  size: { w: number; h: number }
  orientation: Orientation
  fit: FitMode
  /** Zero-based source page indices to change. Others are left exactly as they are. */
  pages: number[]
  /**
   * Extra viewer rotation per source page, for pages the user has turned but
   * not yet saved. Only the orientation decision cares — the page's boxes are
   * always in its own unrotated space.
   */
  extraRotation?: Record<number, number>
}

/** How one page's size compares with the target, for the dialog's summary. */
export interface PageSizeInfo {
  /** Displayed size in points, i.e. after the page's own /Rotate. */
  w: number
  h: number
}

const pt2in = (v: number): number => v / 72

/** "8.50 × 11.00 in" — the label the size dialog groups pages by. */
export function sizeLabel(w: number, h: number): string {
  return `${pt2in(w).toFixed(2)} × ${pt2in(h).toFixed(2)} in`
}

/** True when a page is already the target size, within a scanner's tolerance. */
export function matchesSize(info: PageSizeInfo, target: { w: number; h: number }, orientation: Orientation, tol = 1): boolean {
  const { w, h } = targetFor(info, target, orientation)
  return Math.abs(info.w - w) <= tol && Math.abs(info.h - h) <= tol
}

/** The displayed target dimensions for one page under an orientation rule. */
export function targetFor(info: PageSizeInfo, target: { w: number; h: number }, orientation: Orientation): { w: number; h: number } {
  const portrait =
    orientation === 'portrait' ? true : orientation === 'landscape' ? false : info.h >= info.w
  const w = Math.min(target.w, target.h)
  const h = Math.max(target.w, target.h)
  return portrait ? { w, h } : { w: h, h: w }
}

function rectOf(dict: PDFDict, key: string): Box | null {
  const arr = dict.lookupMaybe(PDFName.of(key), PDFArray)
  if (!arr || arr.size() !== 4) return null
  const v: number[] = []
  for (let i = 0; i < 4; i++) {
    const n = arr.lookup(i, PDFNumber)
    v.push(n instanceof PDFNumber ? n.asNumber() : 0)
  }
  return { x: Math.min(v[0], v[2]), y: Math.min(v[1], v[3]), w: Math.abs(v[2] - v[0]), h: Math.abs(v[3] - v[1]) }
}

/** Read a page box, walking /Parent for an inherited one. */
function inheritedBox(dict: PDFDict, key: string): Box | null {
  let d: PDFDict | undefined = dict
  for (let hops = 0; d && hops < 32; hops++) {
    const r = rectOf(d, key)
    if (r) return r
    d = d.lookupMaybe(PDFName.of('Parent'), PDFDict)
  }
  return null
}

/** Transform an axis-aligned rect through a scale/translate matrix. */
function mapBox(m: Matrix, b: Box): Box {
  const x1 = m[0] * b.x + m[4]
  const y1 = m[3] * b.y + m[5]
  const x2 = m[0] * (b.x + b.w) + m[4]
  const y2 = m[3] * (b.y + b.h) + m[5]
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }
}

/** Move an annotation's own geometry onto the resized page. */
function retargetAnnots(doc: PDFDocument, pageDict: PDFDict, m: Matrix): void {
  const annots = pageDict.lookupMaybe(PDFName.of('Annots'), PDFArray)
  if (!annots) return
  const numberPairs = (key: string, dict: PDFDict): void => {
    const arr = dict.lookupMaybe(PDFName.of(key), PDFArray)
    if (!arr) return
    for (let i = 0; i + 1 < arr.size(); i += 2) {
      const x = arr.lookup(i, PDFNumber)
      const y = arr.lookup(i + 1, PDFNumber)
      if (!(x instanceof PDFNumber) || !(y instanceof PDFNumber)) continue
      arr.set(i, PDFNumber.of(m[0] * x.asNumber() + m[4]))
      arr.set(i + 1, PDFNumber.of(m[3] * y.asNumber() + m[5]))
    }
  }
  for (let i = 0; i < annots.size(); i++) {
    const dict = doc.context.lookupMaybe(annots.get(i), PDFDict)
    if (!dict) continue
    const rect = rectOf(dict, 'Rect')
    if (rect) {
      const r = mapBox(m, rect)
      dict.set(PDFName.of('Rect'), doc.context.obj([r.x, r.y, r.x + r.w, r.y + r.h]))
    }
    // the appearance stream is scaled into /Rect by the viewer, so only the
    // point lists that live in page space need moving
    for (const key of ['QuadPoints', 'Vertices', 'L', 'CL']) numberPairs(key, dict)
    const ink = dict.lookupMaybe(PDFName.of('InkList'), PDFArray)
    if (ink) {
      for (let k = 0; k < ink.size(); k++) {
        const stroke = ink.lookup(k, PDFArray)
        if (!(stroke instanceof PDFArray)) continue
        for (let j = 0; j + 1 < stroke.size(); j += 2) {
          const x = stroke.lookup(j, PDFNumber)
          const y = stroke.lookup(j + 1, PDFNumber)
          if (!(x instanceof PDFNumber) || !(y instanceof PDFNumber)) continue
          stroke.set(j, PDFNumber.of(m[0] * x.asNumber() + m[4]))
          stroke.set(j + 1, PDFNumber.of(m[3] * y.asNumber() + m[5]))
        }
      }
    }
  }
}

export interface ResizeResult {
  bytes: Uint8Array
  /** Old user space -> new user space, per source page. Identity where unchanged. */
  transforms: Matrix[]
  changed: number
}

/**
 * Put the chosen pages on a standard sheet.
 *
 * Returns the new bytes plus, for each source page, the transform its content
 * went through — the caller needs it to move annotations, calibrations and
 * image edits onto the new geometry.
 */
export async function resizePages(srcBytes: ArrayBuffer, opts: ResizeOptions): Promise<ResizeResult> {
  const doc = await PDFDocument.load(srcBytes, { ignoreEncryption: true })
  const pages = doc.getPages()
  const transforms: Matrix[] = pages.map(() => [1, 0, 0, 1, 0, 0] as Matrix)
  const wanted = new Set(opts.pages)
  let changed = 0

  for (let i = 0; i < pages.length; i++) {
    if (!wanted.has(i)) continue
    const page = pages[i]
    const dict = page.node
    const box = inheritedBox(dict, 'CropBox') ?? inheritedBox(dict, 'MediaBox')
    if (!box || box.w <= 0 || box.h <= 0) continue

    const rotation = (((page.getRotation().angle + (opts.extraRotation?.[i] ?? 0)) % 360) + 360) % 360
    const sideways = rotation === 90 || rotation === 270
    const shown: PageSizeInfo = sideways ? { w: box.h, h: box.w } : { w: box.w, h: box.h }
    const target = targetFor(shown, opts.size, opts.orientation)
    // back out of display space: the box itself is unrotated
    const newW = sideways ? target.h : target.w
    const newH = sideways ? target.w : target.h

    const s = opts.fit === 'scale' ? Math.min(newW / box.w, newH / box.h) : 1
    const tx = (newW - box.w * s) / 2 - box.x * s
    const ty = (newH - box.h * s) / 2 - box.y * s
    const m: Matrix = [s, 0, 0, s, tx, ty]
    // nothing to do for a page already exactly right
    if (s === 1 && Math.abs(tx) < 1e-6 && Math.abs(ty) < 1e-6 && Math.abs(newW - box.w) < 1e-6 && Math.abs(newH - box.h) < 1e-6) {
      continue
    }

    wrapContent(doc, page.node, m)
    retargetAnnots(doc, dict, m)
    dict.set(PDFName.of('MediaBox'), doc.context.obj([0, 0, newW, newH]))
    dict.set(PDFName.of('CropBox'), doc.context.obj([0, 0, newW, newH]))
    for (const key of ['BleedBox', 'TrimBox', 'ArtBox']) dict.delete(PDFName.of(key))
    transforms[i] = m
    changed++
  }

  const bytes = await doc.save({ updateFieldAppearances: false })
  return { bytes, transforms, changed }
}

/**
 * Put `q <m> cm` in front of a page's content and `Q` after it, as two extra
 * streams around whatever is already there. Bracketing rather than rewriting
 * keeps the original stream objects — and any shared ones — untouched.
 */
function wrapContent(doc: PDFDocument, pageDict: PDFDict, m: Matrix): void {
  const fmt = (v: number): string => {
    const s = v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
    return s === '-0' ? '0' : s
  }
  const pre = doc.context.register(
    doc.context.flateStream(`q\n${fmt(m[0])} ${fmt(m[1])} ${fmt(m[2])} ${fmt(m[3])} ${fmt(m[4])} ${fmt(m[5])} cm\n`)
  )
  const post = doc.context.register(doc.context.flateStream('\nQ\n'))

  const contents = pageDict.get(PDFName.of('Contents'))
  const parts: (PDFRef | PDFStream)[] = [pre]
  const existing = doc.context.lookup(contents)
  if (existing instanceof PDFArray) {
    for (let i = 0; i < existing.size(); i++) parts.push(existing.get(i) as PDFRef)
  } else if (contents instanceof PDFRef) {
    parts.push(contents)
  } else if (existing instanceof PDFStream) {
    parts.push(doc.context.register(existing))
  }
  parts.push(post)
  pageDict.set(PDFName.of('Contents'), doc.context.obj(parts))
}

// ---------------------------------------------------------------------------
// moving the model onto the resized pages
// ---------------------------------------------------------------------------

const mapPt = (m: Matrix, p: Pt): Pt => ({ x: m[0] * p.x + m[4], y: m[3] * p.y + m[5] })

function mapAnnotation(a: Annotation, m: Matrix): Annotation {
  const s = m[0]
  switch (a.type) {
    case 'markup':
      return { ...a, rects: a.rects.map((r) => mapBox(m, r)) }
    case 'measure':
      return { ...a, pts: a.pts.map((p) => mapPt(m, p)) }
    case 'shape':
      return {
        ...a,
        pts: a.pts.map((p) => mapPt(m, p)),
        strokes: a.strokes?.map((st) => st.map((p) => mapPt(m, p))),
        width: a.width * s
      }
    case 'imgedit':
      // the crop is in the image's own space, so only the placement moves
      return { ...a, m: mulM(a.m, m) }
    default: {
      const r = a as Extract<Annotation, { a: Pt; b: Pt }>
      const out = { ...r, a: mapPt(m, r.a), b: mapPt(m, r.b) }
      if ('fontSize' in out && typeof out.fontSize === 'number') out.fontSize = out.fontSize * s
      return out as Annotation
    }
  }
}

/**
 * Move a whole document model onto resized pages. `transforms` is indexed by
 * source page, as returned by `resizePages`.
 */
export function remapModel(model: DocModel, transforms: Matrix[]): DocModel {
  const byLeaf = new Map<string, Matrix>()
  for (const leaf of model.leaves) {
    const m = transforms[leaf.srcPage - 1]
    if (m) byLeaf.set(leaf.id, m)
  }
  const calibrations: Record<string, Calibration> = {}
  for (const [leafId, cal] of Object.entries(model.calibrations)) {
    const m = byLeaf.get(leafId)
    const s = m ? m[0] : 1
    calibrations[leafId] = s === 1 ? cal : { ...cal, unitsPerPoint: cal.unitsPerPoint / s }
  }
  return {
    ...model,
    calibrations,
    annotations: model.annotations.map((a) => {
      const m = byLeaf.get(a.leafId)
      return m && m.join() !== '1,0,0,1,0,0' ? mapAnnotation(a, m) : a
    })
  }
}

/** Move OCR words for one source page onto its resized geometry. */
export function remapOcr(words: OcrWord[], m: Matrix): OcrWord[] {
  if (m.join() === '1,0,0,1,0,0') return words
  return words.map((w) => ({ ...w, rect: mapBox(m, w.rect) }))
}
