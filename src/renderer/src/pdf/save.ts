import {
  PDFDocument,
  StandardFonts,
  rgb,
  degrees,
  PDFName,
  PDFDict,
  PDFNumber,
  PDFRef,
  BlendMode,
  type PDFPage,
  type PDFFont,
  type PDFImage,
  type RGB
} from 'pdf-lib'
import type { FontKey } from './types'
import { bounds, shapePad, shapePaths } from './draw'
import { applyImageEdits, buildDrawEdits, type ImageDrawEdit } from './images'
import {
  countEditable,
  hexToRgb,
  setEditableKeyword,
  studioKind,
  wrapText,
  writeStudioAnnot,
  type AnnotCtx,
  type AnnotGeom
} from './annots'
import type {
  Annotation,
  Box,
  DocModel,
  FieldAnnot,
  ImageEditAnnot,
  MarkupAnnot,
  MeasureAnnot,
  OcrWord,
  PageLeaf,
  Pt,
  RectAnnot
} from './types'

/**
 * A Frame maps between the *display space* the user annotated in (the page as
 * shown on screen, y-up, origin bottom-left of the visible area) and the
 * coordinates of the page being written. Doing all drawing through display
 * space makes text/images come out upright on rotated pages, and lets a
 * rasterised replacement page (whiteout redaction) share the same code path.
 */
interface Frame {
  W: number // display width (pt)
  H: number // display height (pt)
  toDisp: (p: Pt) => Pt // source user space -> display space
  out: (dx: number, dy: number) => Pt // display space -> target page space
  textRotate: number // CCW degrees for pdf-lib text/image draws
}

/** Frame for a real (non-rasterised) page with effective display rotation R. */
function pageFrame(page: PDFPage, extraRotation: number): Frame {
  const crop = page.getCropBox()
  const x0 = crop.x
  const y0 = crop.y
  const W0 = crop.width
  const H0 = crop.height
  const base = ((page.getRotation().angle % 360) + 360) % 360
  const R = (((base + extraRotation) % 360) + 360) % 360
  switch (R) {
    case 90:
      return {
        W: H0,
        H: W0,
        toDisp: (p) => ({ x: p.y - y0, y: W0 - (p.x - x0) }),
        out: (dx, dy) => ({ x: x0 + W0 - dy, y: y0 + dx }),
        textRotate: 90
      }
    case 180:
      return {
        W: W0,
        H: H0,
        toDisp: (p) => ({ x: W0 - (p.x - x0), y: H0 - (p.y - y0) }),
        out: (dx, dy) => ({ x: x0 + W0 - dx, y: y0 + H0 - dy }),
        textRotate: 180
      }
    case 270:
      return {
        W: H0,
        H: W0,
        toDisp: (p) => ({ x: H0 - (p.y - y0), y: p.x - x0 }),
        out: (dx, dy) => ({ x: x0 + dy, y: y0 + H0 - dx }),
        textRotate: 270
      }
    default:
      return {
        W: W0,
        H: H0,
        toDisp: (p) => ({ x: p.x - x0, y: p.y - y0 }),
        out: (dx, dy) => ({ x: x0 + dx, y: y0 + dy }),
        textRotate: 0
      }
  }
}

function dispBox(frame: Frame, a: Pt, b: Pt): Box {
  const A = frame.toDisp(a)
  const B = frame.toDisp(b)
  return {
    x: Math.min(A.x, B.x),
    y: Math.min(A.y, B.y),
    w: Math.abs(B.x - A.x),
    h: Math.abs(B.y - A.y)
  }
}

/** Map a display-space rect to an axis-aligned rect on the target page. */
function outRect(frame: Frame, r: Box): Box {
  const p1 = frame.out(r.x, r.y)
  const p2 = frame.out(r.x + r.w, r.y + r.h)
  return {
    x: Math.min(p1.x, p2.x),
    y: Math.min(p1.y, p2.y),
    w: Math.abs(p2.x - p1.x),
    h: Math.abs(p2.y - p1.y)
  }
}

function drawTextLines(
  page: PDFPage,
  font: PDFFont,
  frame: Frame,
  rect: Box,
  text: string,
  size: number,
  color: RGB,
  vCenterSingle = false
): void {
  const lines = wrapText(text, font, size, Math.max(8, rect.w))
  const lineHeight = size * 1.18
  let cursorY: number
  if (vCenterSingle && lines.length === 1) {
    cursorY = rect.y + (rect.h - size) / 2 + size * 0.15
  } else {
    cursorY = rect.y + rect.h - size // top-aligned inside the box
  }
  for (const line of lines) {
    if (cursorY < rect.y - size) break
    const at = frame.out(rect.x + 1, cursorY)
    page.drawText(line, { x: at.x, y: at.y, size, font, color, rotate: degrees(frame.textRotate) })
    cursorY -= lineHeight
  }
}

/** Standard-14 fonts available for baked text (no embedding required). */
export const STD_FONTS: Record<FontKey, StandardFonts> = {
  helv: StandardFonts.Helvetica,
  helvB: StandardFonts.HelveticaBold,
  times: StandardFonts.TimesRoman,
  timesB: StandardFonts.TimesRomanBold,
  cour: StandardFonts.Courier,
  courB: StandardFonts.CourierBold
}

function lineOut(page: PDFPage, frame: Frame, a: Pt, b: Pt, thickness: number, color: RGB, opacity?: number): void {
  page.drawLine({
    start: frame.out(a.x, a.y),
    end: frame.out(b.x, b.y),
    thickness,
    color,
    opacity
  })
}

function drawCheck(page: PDFPage, frame: Frame, an: RectAnnot, forceColor?: string): void {
  const { x, y, w, h } = dispBox(frame, an.a, an.b)
  const color = hexToRgb(forceColor || an.color || '#0a7d29')
  const t = Math.max(1.2, Math.min(w, h) * 0.12)
  lineOut(page, frame, { x: x + w * 0.12, y: y + h * 0.5 }, { x: x + w * 0.42, y: y + h * 0.18 }, t, color)
  lineOut(page, frame, { x: x + w * 0.42, y: y + h * 0.18 }, { x: x + w * 0.9, y: y + h * 0.86 }, t, color)
}

function drawLabel(page: PDFPage, font: PDFFont, frame: Frame, at: Pt, text: string, color: RGB): void {
  const size = 9
  const tw = font.widthOfTextAtSize(text, size)
  const pad = 2
  const bg = outRect(frame, { x: at.x - pad, y: at.y - pad, w: tw + pad * 2, h: size + pad * 2 })
  page.drawRectangle({ x: bg.x, y: bg.y, width: bg.w, height: bg.h, color: rgb(1, 1, 1), opacity: 0.85 })
  const p = frame.out(at.x, at.y)
  page.drawText(text, { x: p.x, y: p.y, size, font, color, rotate: degrees(frame.textRotate) })
}

function drawField(page: PDFPage, font: PDFFont, frame: Frame, an: FieldAnnot): void {
  if (an.fieldKind === 'checkbox') {
    if (an.value) drawCheck(page, frame, an as unknown as RectAnnot, '#111111')
    return
  }
  if (an.fieldKind === 'radio') {
    if (an.value && an.value === an.exportValue) {
      const { x, y, w, h } = dispBox(frame, an.a, an.b)
      const c = frame.out(x + w / 2, y + h / 2)
      page.drawCircle({ x: c.x, y: c.y, size: Math.min(w, h) * 0.3, color: rgb(0.07, 0.07, 0.07) })
    }
    return
  }
  // text / combo / list -> render the value like a text overlay
  if (!an.value) return
  const rect = dispBox(frame, an.a, an.b)
  const size = an.fontSize && an.fontSize >= 6 ? an.fontSize : Math.min(12, Math.max(8, rect.h - 4))
  drawTextLines(page, font, frame, rect, an.value, size, rgb(0.06, 0.06, 0.06), !an.multiline)
}

function drawMeasure(page: PDFPage, font: PDFFont, frame: Frame, an: MeasureAnnot): void {
  const color = hexToRgb(an.color)
  const t = 1.3
  const pts = an.pts.map((p) => frame.toDisp(p))
  for (let i = 1; i < pts.length; i++) lineOut(page, frame, pts[i - 1], pts[i], t, color)
  if (an.kind === 'area' && pts.length >= 3) lineOut(page, frame, pts[pts.length - 1], pts[0], t, color)
  let lx = 0
  let ly = 0
  for (const p of pts) {
    lx += p.x
    ly += p.y
  }
  drawLabel(page, font, frame, { x: lx / pts.length, y: ly / pts.length }, an.label, color)
}

/**
 * Geometry for a mark that saves as a real annotation: its /Rect in user space
 * plus the upright on-screen box its appearance is drawn in.
 */
function annotGeom(frame: Frame, an: Annotation): AnnotGeom {
  if (an.type === 'shape') {
    // The appearance box has to be padded: half the stroke sits outside the
    // path, and an arrow head reaches past its end point.
    const pad = shapePad(an)
    const disp = shapePaths(an).map((path) => path.map((p) => frame.toDisp(p)))
    const b = bounds(disp.flat())
    const x = b.x - pad
    const y = b.y - pad
    const w = b.w + pad * 2
    const h = b.h + pad * 2
    return {
      rect: outRect(frame, { x, y, w, h }),
      w,
      h,
      rotate: frame.textRotate,
      paths: disp.map((path) => path.map((p) => ({ x: p.x - x, y: p.y - y }))),
      // round-trip geometry lives in the written page's own user space, which
      // for a rasterised (redacted) page is not the space we started in
      outPaths: disp.map((path) => path.map((p) => frame.out(p.x, p.y)))
    }
  }
  if (an.type === 'markup') {
    const ds = an.rects.map((r) => dispBox(frame, { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h }))
    const x = Math.min(...ds.map((d) => d.x))
    const y = Math.min(...ds.map((d) => d.y))
    const w = Math.max(...ds.map((d) => d.x + d.w)) - x
    const h = Math.max(...ds.map((d) => d.y + d.h)) - y
    return {
      rect: outRect(frame, { x, y, w, h }),
      w,
      h,
      rotate: frame.textRotate,
      bands: ds.map((d) => ({ x: d.x - x, y: d.y - y, w: d.w, h: d.h }))
    }
  }
  const r = an as RectAnnot
  const d = dispBox(frame, r.a, r.b)
  return { rect: outRect(frame, d), w: d.w, h: d.h, rotate: frame.textRotate }
}

const FF_READ_ONLY = 1 << 0
const FF_PUSH_BUTTON = 1 << 16
const F_LOCKED = 1 << 7
const F_LOCKED_CONTENTS = 1 << 9

/** Read an inheritable key off a widget, walking /Parent up the field tree. */
function inherited<T>(dict: PDFDict, key: string, read: (d: PDFDict) => T | undefined): T | undefined {
  let d: PDFDict | undefined = dict
  for (let hops = 0; d && hops < 16; hops++) {
    const v = read(d)
    if (v !== undefined) return v
    d = d.lookupMaybe(PDFName.of('Parent'), PDFDict)
  }
  return undefined
}

/**
 * True for widgets whose own appearance is the only copy of what the user sees:
 * read-only and locked fields, push buttons (icons) and signatures. The viewer
 * leaves these on the canvas and detectFields() keeps them out of the model, so
 * a flatten must keep the annotation rather than strip it.
 */
function keepsOwnAppearance(dict: PDFDict): boolean {
  const ft = inherited(dict, 'FT', (d) => d.lookupMaybe(PDFName.of('FT'), PDFName)?.asString())
  if (ft === '/Sig') return true
  const ff = inherited(dict, 'Ff', (d) => d.lookupMaybe(PDFName.of('Ff'), PDFNumber)?.asNumber()) ?? 0
  if (ff & FF_READ_ONLY) return true
  if (ft === '/Btn' && ff & FF_PUSH_BUTTON) return true
  const f = dict.lookupMaybe(PDFName.of('F'), PDFNumber)?.asNumber() ?? 0
  return !!(f & F_LOCKED) && !!(f & F_LOCKED_CONTENTS)
}

/** Remove interactive Widget annotations from a page so baked values stand alone. */
function stripWidgetAnnots(page: PDFPage): void {
  const annots = page.node.Annots()
  if (!annots) return
  const ctx = page.doc.context
  for (let i = annots.size() - 1; i >= 0; i--) {
    const ref = annots.get(i)
    const dict = ctx.lookupMaybe(ref, PDFDict)
    if (!dict || dict.get(PDFName.of('Subtype')) !== PDFName.of('Widget')) continue
    if (keepsOwnAppearance(dict)) continue
    annots.remove(i)
  }
}

// ---------------------------------------------------------------------------

/** Result of rasterising one page in the renderer (for whiteout redaction). */
export interface RasterResult {
  jpg: Uint8Array
  wPt: number // display width in points
  hPt: number // display height in points
  toDisp: (p: Pt) => Pt // source user space -> display space of the raster
}

/**
 * Renderer-supplied callback that rasterises a page *including its whiteout
 * boxes*, so the covered content is truly destroyed. Returns null to fall
 * back to a plain cover-up rectangle.
 */
export type RasterizeLeaf = (leaf: PageLeaf, whiteouts: RectAnnot[]) => Promise<RasterResult | null>

/**
 * Note for callers: on a rasterised page the embedded-image edits have to come
 * from the document the rasteriser renders — the app keeps the viewer's pdf.js
 * document in step with them, so `makeRasterizer(tab.pdfDoc)` already has them
 * burned in. They are deliberately not re-applied here, which would draw the
 * moved image twice.
 */

export interface BakeOptions {
  /** Keep AcroForm fields interactive (fill values) instead of flattening them. */
  keepForms?: boolean
  rasterizeLeaf?: RasterizeLeaf
  /** OCR words per source page — baked as an invisible text layer so the saved
   *  file is searchable/selectable in any PDF reader. */
  ocrWords?: (srcPage: number) => OcrWord[] | undefined
  /** Optional-content (layer) visibility to persist into the saved file's
   *  default viewing config. Ids are pdf.js OCG ids ("<num>R" / "<num>R<gen>"). */
  layers?: { id: string; visible: boolean }[]
  /**
   * Burn text boxes, checks, X's, circles and markup into the page content
   * instead of writing them as editable annotations. Default false — a plain
   * save keeps them editable, and flattening is a deliberate act.
   */
  flatten?: boolean
}

/** Persist layer on/off states into the catalog's /OCProperties default config. */
function applyLayerStates(doc: PDFDocument, layers: { id: string; visible: boolean }[]): void {
  const ocProps = doc.catalog.lookupMaybe(PDFName.of('OCProperties'), PDFDict)
  if (!ocProps) return
  let d = ocProps.lookupMaybe(PDFName.of('D'), PDFDict)
  if (!d) {
    d = doc.context.obj({}) as PDFDict
    ocProps.set(PDFName.of('D'), d)
  }
  const on: PDFRef[] = []
  const off: PDFRef[] = []
  for (const l of layers) {
    const m = /^(\d+)R(\d*)$/.exec(l.id)
    if (!m) continue
    const ref = PDFRef.of(Number(m[1]), m[2] ? Number(m[2]) : 0)
    ;(l.visible ? on : off).push(ref)
  }
  d.set(PDFName.of('BaseState'), PDFName.of('ON'))
  d.set(PDFName.of('ON'), doc.context.obj(on))
  d.set(PDFName.of('OFF'), doc.context.obj(off))
}

/**
 * Bake OCR words as invisible text. Words under a whiteout are skipped —
 * redacted content must never come back as searchable text.
 */
function drawOcrText(page: PDFPage, font: PDFFont, frame: Frame, words: OcrWord[], whiteouts: RectAnnot[]): void {
  const covers = whiteouts.map((an) => ({
    x: Math.min(an.a.x, an.b.x),
    y: Math.min(an.a.y, an.b.y),
    w: Math.abs(an.b.x - an.a.x),
    h: Math.abs(an.b.y - an.a.y)
  }))
  for (const wd of words) {
    // pdf-lib's standard fonts only encode WinAnsi — strip anything else
    const text = wd.text.replace(/[^ -~ -ÿ]/g, '').trim()
    if (!text) continue
    const r = wd.rect
    if (covers.some((b) => r.x < b.x + b.w && b.x < r.x + r.w && r.y < b.y + b.h && b.y < r.y + r.h)) continue
    const d = dispBox(frame, { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h })
    const size = Math.max(3, d.h * 0.85)
    const at = frame.out(d.x, d.y + d.h * 0.12)
    try {
      page.drawText(text, { x: at.x, y: at.y, size, font, opacity: 0, rotate: degrees(frame.textRotate) })
    } catch {
      /* unencodable despite the filter — skip the word */
    }
  }
}

interface DrawCtx {
  doc: PDFDocument
  font: PDFFont
  fonts: Partial<Record<FontKey, PDFFont>>
  images: Record<string, PDFImage>
  keepForms: boolean
  /** Burn the editable marks into the page instead of writing annotations. */
  flatten: boolean
}

function drawAnnots(page: PDFPage, frame: Frame, anns: Annotation[], ctx: DrawCtx, isRaster: boolean): void {
  // whiteout cover-ups first (raster pages already destroyed the content);
  // 'cover' patches (Edit Text) are plain vector rects on every page kind
  for (const an of anns) {
    if (an.type === 'cover' || (an.type === 'whiteout' && !isRaster)) {
      const o = outRect(frame, dispBox(frame, an.a, an.b))
      page.drawRectangle({ x: o.x, y: o.y, width: o.w, height: o.h, color: hexToRgb(an.color || '#ffffff') })
    }
  }
  const annotCtx: AnnotCtx = { doc: ctx.doc, fonts: ctx.fonts, font: ctx.font }
  for (const an of anns) {
    // text / check / X / circle / markup keep their identity as real PDF
    // annotations unless this save is flattening
    if (studioKind(an)) {
      writeStudioAnnot(page, an, annotGeom(frame, an), annotCtx, ctx.flatten)
      continue
    }
    switch (an.type) {
      case 'image': {
        if (an.imageId && ctx.images[an.imageId]) {
          const d = dispBox(frame, an.a, an.b)
          const at = frame.out(d.x, d.y)
          page.drawImage(ctx.images[an.imageId], {
            x: at.x,
            y: at.y,
            width: d.w,
            height: d.h,
            rotate: degrees(frame.textRotate)
          })
        }
        break
      }
      case 'measure':
        drawMeasure(page, ctx.font, frame, an)
        break
      case 'field':
        // In keep-forms mode live widgets carry the values — except on raster
        // pages, whose widgets were destroyed together with the original page.
        if (!ctx.keepForms || isRaster) drawField(page, ctx.font, frame, an)
        break
      default:
        break
    }
  }
}

/** A page's image edits, in the shape the content-stream editor wants. */
function imageEditsFor(anns: Annotation[], images: Record<string, PDFImage>): Map<number, ImageDrawEdit> {
  return buildDrawEdits(
    anns.filter((a): a is ImageEditAnnot => a.type === 'imgedit'),
    (id) => images[id]?.ref
  )
}

/** Source pages (0-based) that any leaf edits the embedded images of. */
function pagesWithImageEdits(model: DocModel): Set<number> {
  const byId = new Map(model.leaves.map((l) => [l.id, l]))
  const out = new Set<number>()
  for (const a of model.annotations) {
    if (a.type !== 'imgedit') continue
    const leaf = byId.get(a.leafId)
    if (leaf) out.add(leaf.srcPage - 1)
  }
  return out
}

function groupByLeaf(model: DocModel): Map<string, Annotation[]> {
  const map = new Map<string, Annotation[]>()
  for (const a of model.annotations) {
    const arr = map.get(a.leafId) || []
    arr.push(a)
    map.set(a.leafId, arr)
  }
  return map
}

async function embedImages(doc: PDFDocument, model: DocModel): Promise<Record<string, PDFImage>> {
  const out: Record<string, PDFImage> = {}
  for (const [id, img] of Object.entries(model.images)) {
    out[id] = img.kind === 'png' ? await doc.embedPng(img.bytes) : await doc.embedJpg(img.bytes)
  }
  return out
}

/** Fill live AcroForm field values from the model (keep-forms mode). */
function fillFormValues(doc: PDFDocument, model: DocModel, font: PDFFont): void {
  let form
  try {
    form = doc.getForm()
  } catch {
    return
  }
  const doneRadios = new Set<string>()
  for (const a of model.annotations) {
    if (a.type !== 'field') continue
    try {
      if (a.fieldKind === 'text') {
        form.getTextField(a.fieldName).setText(a.value || '')
      } else if (a.fieldKind === 'checkbox') {
        const cb = form.getCheckBox(a.fieldName)
        if (a.value) cb.check()
        else cb.uncheck()
      } else if (a.fieldKind === 'radio') {
        if (doneRadios.has(a.fieldName)) continue
        doneRadios.add(a.fieldName)
        if (a.value) form.getRadioGroup(a.fieldName).select(a.value)
      } else if (a.fieldKind === 'combo') {
        if (a.value) form.getDropdown(a.fieldName).select(a.value)
      } else if (a.fieldKind === 'list') {
        if (a.value) form.getOptionList(a.fieldName).select(a.value)
      }
    } catch {
      // field missing / renamed / wrong type — skip it rather than fail the save
    }
  }
  try {
    form.updateFieldAppearances(font)
  } catch {
    /* ignore appearance failures */
  }
}

/**
 * Bake the model into the document *in place*: pages are reordered / removed /
 * duplicated inside the source document, so bookmarks, links, metadata and all
 * untouched content survive. Pages with whiteouts are replaced by a
 * high-resolution raster (true redaction) when `rasterizeLeaf` is provided.
 */
export async function bakeAndSave(srcBytes: ArrayBuffer, model: DocModel, opts: BakeOptions = {}): Promise<Uint8Array> {
  if (model.leaves.length === 0) throw new Error('Document has no pages left.')
  const doc = await PDFDocument.load(srcBytes, { ignoreEncryption: true })
  const fonts = await embedStdFonts(doc, model)
  const font = fonts.helv!
  const images = await embedImages(doc, model)
  const ctx: DrawCtx = { doc, font, fonts, images, keepForms: !!opts.keepForms, flatten: !!opts.flatten }
  const srcPages = doc.getPages()
  const origCount = srcPages.length
  const byLeaf = groupByLeaf(model)
  const usedSrc = new Set<number>()
  // A page whose embedded images were edited must not be shared between two
  // leaves — the edit is written into its content stream, so each leaf that
  // shows it needs a page object of its own.
  const imageEdited = pagesWithImageEdits(model)
  const leafCount = new Map<number, number>()
  for (const l of model.leaves) leafCount.set(l.srcPage - 1, (leafCount.get(l.srcPage - 1) ?? 0) + 1)

  for (const leaf of model.leaves) {
    const srcIdx = leaf.srcPage - 1
    if (srcIdx < 0 || srcIdx >= origCount) continue
    const anns = byLeaf.get(leaf.id) || []
    const whiteouts = anns.filter((a): a is RectAnnot => a.type === 'whiteout')
    // OCR text never bakes under whiteouts (redaction) or covers (replaced text)
    const ocrBlockers = anns.filter((a): a is RectAnnot => a.type === 'whiteout' || a.type === 'cover')

    let raster: RasterResult | null = null
    if (whiteouts.length && opts.rasterizeLeaf) {
      try {
        raster = await opts.rasterizeLeaf(leaf, whiteouts)
      } catch (e) {
        console.warn('rasterize failed, falling back to cover-up', e)
      }
    }

    const ocr = opts.ocrWords?.(leaf.srcPage)
    if (raster) {
      const page = doc.addPage([raster.wPt, raster.hPt])
      const img = await doc.embedJpg(raster.jpg)
      page.drawImage(img, { x: 0, y: 0, width: raster.wPt, height: raster.hPt })
      const frame: Frame = {
        W: raster.wPt,
        H: raster.hPt,
        toDisp: raster.toDisp,
        out: (dx, dy) => ({ x: dx, y: dy }),
        textRotate: 0
      }
      if (ocr?.length) drawOcrText(page, ctx.font, frame, ocr, ocrBlockers)
      drawAnnots(page, frame, anns, ctx, true)
    } else {
      let page: PDFPage
      const mustClone = imageEdited.has(srcIdx) && (leafCount.get(srcIdx) ?? 0) > 1
      if (usedSrc.has(srcIdx) || mustClone) {
        // leaf duplicated in the viewer — clone the page objects
        const [dup] = await doc.copyPages(doc, [srcIdx])
        page = doc.addPage(dup)
      } else {
        usedSrc.add(srcIdx)
        page = doc.addPage(srcPages[srcIdx])
      }
      // Re-place the images embedded in the page before anything is drawn over
      // it: this replaces /Contents, which would throw away pdf-lib's own
      // appended content stream if it ran the other way round.
      const imgEdits = imageEditsFor(anns, ctx.images)
      if (imgEdits.size) applyImageEdits(doc, page, imgEdits)
      const frame = pageFrame(page, leaf.rotation)
      if (leaf.rotation) {
        const cur = page.getRotation().angle
        page.setRotation(degrees((((cur + leaf.rotation) % 360) + 360) % 360))
      }
      if (ocr?.length) drawOcrText(page, ctx.font, frame, ocr, ocrBlockers)
      drawAnnots(page, frame, anns, ctx, false)
      if (!opts.keepForms) stripWidgetAnnots(page)
    }
  }

  // drop the original page list (the kept ones were re-added above, in order)
  for (let i = 0; i < origCount; i++) doc.removePage(0)

  if (opts.keepForms) {
    fillFormValues(doc, model, font)
  } else {
    // flatten: values were drawn as content; drop the form definition entirely
    doc.catalog.delete(PDFName.of('AcroForm'))
  }

  if (opts.layers?.length) applyLayerStates(doc, opts.layers)

  // Marker so opening this file knows whether to run the (comparatively
  // expensive) annotation import pass at all.
  setEditableKeyword(doc, !opts.flatten && countEditable(model.annotations) > 0)

  doc.setProducer('PDF Studio')
  // pdf-lib's save-time field appearance pass walks the AcroForm with strict
  // lookups and no guards — a dangling ref in /Fields (which real-world signed
  // or incrementally-updated PDFs do have, and pdf.js shrugs off) kills the
  // whole save. fillFormValues already regenerates appearances, guarded.
  return doc.save({ updateFieldAppearances: false })
}

async function embedStdFonts(doc: PDFDocument, model: DocModel): Promise<Partial<Record<FontKey, PDFFont>>> {
  const keys = new Set<FontKey>(['helv'])
  for (const a of model.annotations) {
    if (a.type === 'text' && a.font) keys.add(a.font)
  }
  const out: Partial<Record<FontKey, PDFFont>> = {}
  for (const k of keys) out[k] = await doc.embedFont(STD_FONTS[k])
  return out
}

/** Extract selected leaves (by id) into a fresh, compact PDF (always flattened). */
export async function extractPages(
  srcBytes: ArrayBuffer,
  model: DocModel,
  leafIds: string[],
  opts: BakeOptions = {}
): Promise<Uint8Array> {
  const chosen = model.leaves.filter((l) => leafIds.includes(l.id))
  if (chosen.length === 0) throw new Error('No pages selected.')
  const src = await PDFDocument.load(srcBytes, { ignoreEncryption: true })
  const out = await PDFDocument.create()
  const fonts = await embedStdFonts(out, model)
  const font = fonts.helv!
  const images = await embedImages(out, model)
  // an extract is a hand-off copy: everything burned in, nothing left editable
  const ctx: DrawCtx = { doc: out, font, fonts, images, keepForms: false, flatten: true }
  const byLeaf = groupByLeaf(model)

  for (const leaf of chosen) {
    const anns = byLeaf.get(leaf.id) || []
    const whiteouts = anns.filter((a): a is RectAnnot => a.type === 'whiteout')
    const ocrBlockers = anns.filter((a): a is RectAnnot => a.type === 'whiteout' || a.type === 'cover')
    let raster: RasterResult | null = null
    if (whiteouts.length && opts.rasterizeLeaf) {
      try {
        raster = await opts.rasterizeLeaf(leaf, whiteouts)
      } catch {
        raster = null
      }
    }
    const ocr = opts.ocrWords?.(leaf.srcPage)
    if (raster) {
      const page = out.addPage([raster.wPt, raster.hPt])
      const img = await out.embedJpg(raster.jpg)
      page.drawImage(img, { x: 0, y: 0, width: raster.wPt, height: raster.hPt })
      const frame: Frame = {
        W: raster.wPt,
        H: raster.hPt,
        toDisp: raster.toDisp,
        out: (dx, dy) => ({ x: dx, y: dy }),
        textRotate: 0
      }
      if (ocr?.length) drawOcrText(page, ctx.font, frame, ocr, ocrBlockers)
      drawAnnots(page, frame, anns, ctx, true)
    } else {
      const [copied] = await out.copyPages(src, [leaf.srcPage - 1])
      const page = out.addPage(copied)
      const imgEdits = imageEditsFor(anns, ctx.images)
      if (imgEdits.size) applyImageEdits(out, page, imgEdits)
      const frame = pageFrame(page, leaf.rotation)
      if (leaf.rotation) {
        const cur = page.getRotation().angle
        page.setRotation(degrees((((cur + leaf.rotation) % 360) + 360) % 360))
      }
      if (ocr?.length) drawOcrText(page, ctx.font, frame, ocr, ocrBlockers)
      drawAnnots(page, frame, anns, ctx, false)
      stripWidgetAnnots(page)
    }
  }

  out.setTitle(model.fileName.replace(/\.pdf$/i, ''))
  out.setProducer('PDF Studio')
  return out.save()
}
