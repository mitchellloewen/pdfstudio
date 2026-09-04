/**
 * Real PDF annotations for the marks PDF Studio adds.
 *
 * Saving writes text boxes, checks, X's, circles and text markup as genuine
 * annotation objects in the page's /Annots array, so they stay editable — here
 * and in Acrobat — until the document is flattened. Everything else (
 * measurements, whiteout redaction, Edit-Text cover patches, signature stamps,
 * form-field values) is still burned into the page content by save.ts.
 *
 * One appearance builder serves both paths: an editable annotation gets the
 * appearance as its /AP normal stream, and flattening stamps that *same* Form
 * XObject into the page content. A flattened mark is therefore identical to the
 * editable one it replaced, by construction rather than by keeping two
 * drawing routines in step.
 *
 * Appearances are always drawn upright in a local box — [0,0,w,h] with the
 * mark's own bottom-left at the origin — and carried onto a rotated page by the
 * XObject /Matrix (editable) or the concatenated matrix (flattened), which is
 * why nothing in here needs to know about page rotation beyond the angle.
 */
import {
  LineCapStyle,
  LineJoinStyle,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  appendBezierCurve,
  beginText,
  closePath,
  concatTransformationMatrix,
  drawObject,
  endText,
  fill,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  setDashPattern,
  setFillingRgbColor,
  setFontAndSize,
  setGraphicsState,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  setTextMatrix,
  showText,
  stroke,
  fillAndStroke,
  type PDFFont,
  type PDFObject,
  type PDFOperator,
  type PDFPage,
  type RGB
} from 'pdf-lib'
import {
  CIRCLE_STROKE_PT,
  type Annotation,
  type Box,
  type FontKey,
  type MarkupAnnot,
  type Pt,
  type RectAnnot,
  type ShapeAnnot,
  type ShapeKind,
  uid
} from './types'
import { arrowHead, arrowHeadLen, bounds, dashPattern } from './draw'

/** What `context.obj()` accepts — pdf-lib doesn't export its own Literal type. */
type Lit = string | number | boolean | null | undefined | PDFObject | Lit[] | { [k: string]: Lit }
type LitDict = { [k: string]: Lit }

/** Private key holding the fields a standard annotation can't carry. */
const META = 'PDFStudio'
/** /T on every annotation we write — also how a foreign annotation is told apart. */
const AUTHOR = 'PDF Studio'
/**
 * Added to the document's Keywords when a save leaves editable annotations
 * behind, so opening a file can skip the import pass (a full pdf-lib parse)
 * unless there is something to import.
 */
export const EDITABLE_KEYWORD = 'PDFStudio:editable'

/** Annotation kinds that round-trip as real PDF annotations. */
export type StudioKind =
  | 'text'
  | 'check'
  | 'cross'
  | 'circle'
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | ShapeKind

const SUBTYPE: Record<StudioKind, string> = {
  text: 'FreeText',
  check: 'Stamp',
  cross: 'Stamp',
  circle: 'Circle',
  highlight: 'Highlight',
  underline: 'Underline',
  strikeout: 'StrikeOut',
  // Draw-tab shapes map onto the standard drawing annotations
  line: 'Line',
  arrow: 'Line',
  rect: 'Square',
  ellipse: 'Circle',
  polyline: 'PolyLine',
  polygon: 'Polygon',
  ink: 'Ink'
}

/** The Draw tab's shapes, told apart from the Home tab's fixed marks. */
const SHAPE_KINDS: StudioKind[] = ['line', 'arrow', 'rect', 'ellipse', 'polyline', 'polygon', 'ink']
const isShapeKind = (k: StudioKind): k is ShapeKind => SHAPE_KINDS.includes(k)

const TEXT_LINE_HEIGHT = 1.18
/** Text markup opacity, matching the on-screen highlight. */
const HIGHLIGHT_ALPHA = 0.4

export function hexToRgb(hex?: string): RGB {
  if (!hex) return rgb(0.1, 0.1, 0.1)
  const m = hex.replace('#', '')
  const r = parseInt(m.substring(0, 2), 16) / 255
  const g = parseInt(m.substring(2, 4), 16) / 255
  const b = parseInt(m.substring(4, 6), 16) / 255
  return rgb(r || 0, g || 0, b || 0)
}

/** Simple greedy word-wrap, shared by baked text and text appearances. */
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = []
  for (const rawLine of text.split('\n')) {
    const words = rawLine.split(/(\s+)/)
    let line = ''
    for (const w of words) {
      const test = line + w
      if (font.widthOfTextAtSize(test.trimEnd(), size) > maxWidth && line.trim() !== '') {
        out.push(line.trimEnd())
        line = w.trimStart()
      } else {
        line = test
      }
    }
    out.push(line.trimEnd())
  }
  return out
}

/** The kind an annotation saves as, or null if it has to be baked. */
export function studioKind(a: Annotation): StudioKind | null {
  if (a.type === 'text' || a.type === 'check' || a.type === 'cross' || a.type === 'circle') return a.type
  if (a.type === 'markup') return a.kind
  if (a.type === 'shape') return a.kind
  return null
}

/** How many marks in this document would survive a save as editable objects. */
export function countEditable(anns: Annotation[]): number {
  let n = 0
  for (const a of anns) if (studioKind(a)) n++
  return n
}

// ---------------------------------------------------------------------------
// Appearances

export interface AnnotCtx {
  doc: PDFDocument
  /** Standard-14 fonts already embedded for this save, by model font key. */
  fonts: Partial<Record<FontKey, PDFFont>>
  font: PDFFont
}

/** Geometry for one mark, worked out by the caller from its page Frame. */
export interface AnnotGeom {
  /** Axis-aligned /Rect in default user space. */
  rect: Box
  /** Upright on-screen width/height of the mark (the appearance's local box). */
  w: number
  h: number
  /** CCW degrees the appearance is rotated by to stay upright (Frame.textRotate). */
  rotate: number
  /** Markup only: the highlighted bands, relative to the mark's bottom-left. */
  bands?: Box[]
  /** Shapes only: the point paths inside the appearance box (local coords). */
  paths?: Pt[][]
  /** Shapes only: the same paths in the target page's user space, for round-trip. */
  outPaths?: Pt[][]
}

interface Appearance {
  ops: PDFOperator[]
  resources: LitDict
}

/** Bezier control-point ratio for approximating a quarter ellipse. */
const KAPPA = 0.5523

function ellipseOps(w: number, h: number, t: number, color: RGB): PDFOperator[] {
  const cx = w / 2
  const cy = h / 2
  const rx = Math.max(0.5, w / 2 - t / 2)
  const ry = Math.max(0.5, h / 2 - t / 2)
  const kx = rx * KAPPA
  const ky = ry * KAPPA
  return [
    pushGraphicsState(),
    setStrokingRgbColor(color.red, color.green, color.blue),
    setLineWidth(t),
    moveTo(cx + rx, cy),
    appendBezierCurve(cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry),
    appendBezierCurve(cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy),
    appendBezierCurve(cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry),
    appendBezierCurve(cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy),
    closePath(),
    stroke(),
    popGraphicsState()
  ]
}

function strokeOps(color: RGB, t: number, paths: [number, number][][]): PDFOperator[] {
  const ops: PDFOperator[] = [
    pushGraphicsState(),
    setStrokingRgbColor(color.red, color.green, color.blue),
    setLineWidth(t),
    setLineCap(LineCapStyle.Round),
    setLineJoin(LineJoinStyle.Round)
  ]
  for (const path of paths) {
    path.forEach(([x, y], i) => ops.push(i === 0 ? moveTo(x, y) : lineTo(x, y)))
    ops.push(stroke())
  }
  ops.push(popGraphicsState())
  return ops
}

function textOps(an: RectAnnot, w: number, h: number, ctx: AnnotCtx): Appearance {
  const font = ctx.fonts[an.font || 'helv'] || ctx.font
  const size = an.fontSize || 12
  const color = hexToRgb(an.color)
  const ops: PDFOperator[] = [
    pushGraphicsState(),
    setFillingRgbColor(color.red, color.green, color.blue),
    beginText(),
    setFontAndSize('F0', size)
  ]
  // top-aligned, first baseline one em below the top — same as baked text
  let y = h - size
  for (const line of wrapText(an.text || '', font, size, Math.max(8, w))) {
    if (y < -size) break
    ops.push(setTextMatrix(1, 0, 0, 1, 1, y), showText(font.encodeText(line)))
    y -= size * TEXT_LINE_HEIGHT
  }
  ops.push(endText(), popGraphicsState())
  return { ops, resources: { Font: { F0: font.ref } } }
}

function markupOps(kind: StudioKind, bands: Box[], color: RGB): Appearance {
  if (kind === 'highlight') {
    const ops: PDFOperator[] = [
      pushGraphicsState(),
      setGraphicsState('GSm'),
      setFillingRgbColor(color.red, color.green, color.blue)
    ]
    for (const b of bands) ops.push(rectangle(b.x, b.y, b.w, b.h))
    ops.push(fill(), popGraphicsState())
    return {
      ops,
      resources: {
        ExtGState: { GSm: { Type: 'ExtGState', BM: 'Multiply', ca: HIGHLIGHT_ALPHA } }
      }
    }
  }
  const ops: PDFOperator[] = [pushGraphicsState(), setFillingRgbColor(color.red, color.green, color.blue)]
  for (const b of bands) {
    const t = Math.max(0.8, b.h * 0.07)
    const y = kind === 'underline' ? b.y + t * 0.5 : b.y + b.h * 0.42
    ops.push(rectangle(b.x, y - t / 2, b.w, t))
  }
  ops.push(fill(), popGraphicsState())
  return { ops, resources: {} }
}

/** Bezier ellipse inscribed in a box, as a path (no painting operator). */
function ellipsePath(x: number, y: number, w: number, h: number): PDFOperator[] {
  const cx = x + w / 2
  const cy = y + h / 2
  const rx = Math.max(0.1, w / 2)
  const ry = Math.max(0.1, h / 2)
  const kx = rx * KAPPA
  const ky = ry * KAPPA
  return [
    moveTo(cx + rx, cy),
    appendBezierCurve(cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry),
    appendBezierCurve(cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy),
    appendBezierCurve(cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry),
    appendBezierCurve(cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy),
    closePath()
  ]
}

const polyPath = (pts: Pt[]): PDFOperator[] => pts.map((p, i) => (i === 0 ? moveTo(p.x, p.y) : lineTo(p.x, p.y)))

/**
 * Appearance for a Draw-tab shape. The paths arrive in the appearance box's own
 * coordinates, so this only has to decide how they are painted: outlines stay
 * inside the box (like the circle tool), fills go underneath, and arrow heads
 * are solid triangles in the stroke colour.
 */
function shapeOps(an: ShapeAnnot, g: AnnotGeom): Appearance {
  const paths = g.paths || []
  if (!paths.length) return { ops: [], resources: {} }
  const color = hexToRgb(an.color)
  const fillCol = an.fill ? hexToRgb(an.fill) : null
  const alpha = an.fillAlpha ?? 1
  const t = Math.max(0.2, an.width)
  const resources: LitDict = {}
  const ops: PDFOperator[] = [pushGraphicsState()]
  if (fillCol && alpha < 1) {
    resources.ExtGState = { GSf: { Type: 'ExtGState', ca: alpha } }
    ops.push(setGraphicsState('GSf'))
  }
  ops.push(
    setStrokingRgbColor(color.red, color.green, color.blue),
    setLineWidth(t),
    setLineCap(LineCapStyle.Round),
    setLineJoin(LineJoinStyle.Round)
  )
  if (fillCol) ops.push(setFillingRgbColor(fillCol.red, fillCol.green, fillCol.blue))
  if (an.dash) {
    const [on, off] = dashPattern(t)
    ops.push(setDashPattern([on, off], 0))
  }
  const paint = (): PDFOperator => (fillCol ? fillAndStroke() : stroke())

  if (an.kind === 'rect' || an.kind === 'ellipse') {
    // half the stroke sits either side of the path, so inset by t/2 to keep the
    // drawn outline inside the box the user dragged
    const b = bounds(paths[0])
    const x = b.x + t / 2
    const y = b.y + t / 2
    const w = Math.max(0.2, b.w - t)
    const h = Math.max(0.2, b.h - t)
    ops.push(...(an.kind === 'rect' ? [rectangle(x, y, w, h)] : ellipsePath(x, y, w, h)), paint())
  } else if (an.kind === 'polygon') {
    ops.push(...polyPath(paths[0]), closePath(), paint())
  } else {
    for (const path of paths) {
      if (path.length < 2) continue
      ops.push(...polyPath(path), stroke())
    }
  }

  // arrow heads: solid triangles in the stroke colour, drawn undashed
  if (an.kind === 'arrow' && paths[0].length >= 2) {
    const p = paths[0]
    const len = arrowHeadLen(t)
    const heads: Pt[][] = []
    if (an.arrowEnd) heads.push(arrowHead(p[p.length - 2], p[p.length - 1], len))
    if (an.arrowStart) heads.push(arrowHead(p[1], p[0], len))
    if (heads.length) {
      ops.push(pushGraphicsState(), setFillingRgbColor(color.red, color.green, color.blue))
      for (const tri of heads) {
        if (tri.length !== 3) continue
        ops.push(...polyPath(tri), closePath(), fill())
      }
      ops.push(popGraphicsState())
    }
  }

  ops.push(popGraphicsState())
  return { ops, resources }
}

function appearance(kind: StudioKind, an: Annotation, g: AnnotGeom, ctx: AnnotCtx): Appearance {
  if (isShapeKind(kind)) return shapeOps(an as ShapeAnnot, g)
  const color = hexToRgb((an as RectAnnot).color || (an as MarkupAnnot).color)
  if (kind === 'text') return textOps(an as RectAnnot, g.w, g.h, ctx)
  if (kind === 'circle') return { ops: ellipseOps(g.w, g.h, CIRCLE_STROKE_PT, color), resources: {} }
  if (kind === 'check' || kind === 'cross') {
    const t = Math.max(1.2, Math.min(g.w, g.h) * 0.12)
    const paths: [number, number][][] =
      kind === 'check'
        ? [
            [
              [g.w * 0.12, g.h * 0.5],
              [g.w * 0.42, g.h * 0.18],
              [g.w * 0.9, g.h * 0.86]
            ]
          ]
        : [
            [
              [g.w * 0.15, g.h * 0.15],
              [g.w * 0.85, g.h * 0.85]
            ],
            [
              [g.w * 0.85, g.h * 0.15],
              [g.w * 0.15, g.h * 0.85]
            ]
          ]
    return { ops: strokeOps(color, t, paths), resources: {} }
  }
  return markupOps(kind, g.bands || [], color)
}

/** Rotation matrix for an appearance that must sit upright on a rotated page. */
function rotMatrix(deg: number): number[] {
  switch (((deg % 360) + 360) % 360) {
    case 90:
      return [0, 1, -1, 0, 0, 0]
    case 180:
      return [-1, 0, 0, -1, 0, 0]
    case 270:
      return [0, -1, 1, 0, 0, 0]
    default:
      return [1, 0, 0, 1, 0, 0]
  }
}

/**
 * Matrix that drops an appearance onto the page at `rect` when it is stamped
 * into the content stream — the same placement a viewer computes for /AP from
 * BBox, Matrix and Rect (PDF 32000-1 §12.5.5).
 */
function placeMatrix(rect: Box, w: number, h: number, deg: number): number[] {
  switch (((deg % 360) + 360) % 360) {
    case 90:
      return [0, 1, -1, 0, rect.x + h, rect.y]
    case 180:
      return [-1, 0, 0, -1, rect.x + w, rect.y + h]
    case 270:
      return [0, -1, 1, 0, rect.x, rect.y + w]
    default:
      return [1, 0, 0, 1, rect.x, rect.y]
  }
}

// ---------------------------------------------------------------------------
// Writing

/**
 * Write one mark. Returns false if this annotation type has no editable form,
 * leaving the caller to bake it the old way.
 *
 * `flatten` stamps the appearance into the page content instead of attaching it
 * as an annotation — visually identical, but no longer an object.
 */
export function writeStudioAnnot(
  page: PDFPage,
  an: Annotation,
  g: AnnotGeom,
  ctx: AnnotCtx,
  flatten: boolean
): boolean {
  const kind = studioKind(an)
  if (!kind) return false
  if (g.w <= 0 || g.h <= 0) return true

  const { ops, resources } = appearance(kind, an, g, ctx)
  const doc = ctx.doc
  const xobj = doc.context.formXObject(ops, {
    BBox: [0, 0, g.w, g.h],
    Matrix: rotMatrix(g.rotate),
    Resources: resources
  })
  const xref = doc.context.register(xobj)

  if (flatten) {
    const name = doc.context.addRandomSuffix('PS', 6)
    page.node.setXObject(PDFName.of(name), xref)
    const m = placeMatrix(g.rect, g.w, g.h, g.rotate)
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(m[0], m[1], m[2], m[3], m[4], m[5]),
      drawObject(name),
      popGraphicsState()
    )
    return true
  }

  const color = hexToRgb((an as RectAnnot).color || (an as MarkupAnnot).color)
  const meta: LitDict = {
    App: PDFString.of(AUTHOR),
    Kind: PDFString.of(kind),
    Color: PDFString.of((an as RectAnnot).color || (an as MarkupAnnot).color || '')
  }
  const dict: LitDict = {
    Type: 'Annot',
    Subtype: SUBTYPE[kind],
    Rect: [g.rect.x, g.rect.y, g.rect.x + g.rect.w, g.rect.y + g.rect.h],
    F: 4, // print
    NM: PDFString.of(an.id),
    T: PDFString.of(AUTHOR),
    C: [color.red, color.green, color.blue],
    AP: { N: xref }
  }

  if (isShapeKind(kind)) {
    writeShapeKeys(an as ShapeAnnot, kind, g, meta, dict)
  } else if (kind === 'text') {
    const t = an as RectAnnot
    const size = t.fontSize || 12
    meta.FontSize = size
    meta.FontKey = PDFString.of(t.font || 'helv')
    if (t.autoWidth) meta.AutoWidth = true
    dict.Contents = PDFHexString.fromText(t.text || '')
    dict.DA = PDFString.of(`/F0 ${size} Tf ${color.red} ${color.green} ${color.blue} rg`)
    dict.Q = 0
  } else if (kind === 'circle') {
    dict.BS = { W: CIRCLE_STROKE_PT }
  } else if (kind === 'check' || kind === 'cross') {
    dict.Name = kind === 'check' ? 'PDFStudioCheck' : 'PDFStudioCross'
  } else {
    // markup: QuadPoints in default user space, in the order the spec expects
    // (upper-left, upper-right, lower-left, lower-right per quad)
    const quads: number[] = []
    for (const r of (an as MarkupAnnot).rects) {
      quads.push(r.x, r.y + r.h, r.x + r.w, r.y + r.h, r.x, r.y, r.x + r.w, r.y)
    }
    dict.QuadPoints = quads
    dict.CA = kind === 'highlight' ? HIGHLIGHT_ALPHA : 1
  }
  dict[META] = meta

  page.node.addAnnot(doc.context.register(doc.context.obj(dict)))
  return true
}

const flat = (pts: Pt[]): number[] => pts.flatMap((p) => [p.x, p.y])

/**
 * Fill in the shape-specific half of an annotation dictionary: the private
 * metadata we read back (exact points and pen settings) plus the standard
 * geometry keys — /L, /Vertices, /InkList — so other editors see a real Line,
 * Polygon or Ink annotation rather than a bare appearance.
 */
function writeShapeKeys(an: ShapeAnnot, kind: ShapeKind, g: AnnotGeom, meta: LitDict, dict: LitDict): void {
  const out = g.outPaths || []
  meta.Width = an.width
  if (kind === 'ink') meta.Ink = out.map(flat)
  else meta.Pts = flat(out[0] || [])
  if (an.fill) {
    meta.Fill = PDFString.of(an.fill)
    meta.FillAlpha = an.fillAlpha ?? 1
  }
  if (an.dash) meta.Dash = true
  if (an.arrowStart) meta.ArrowStart = true
  if (an.arrowEnd) meta.ArrowEnd = true

  dict.BS = an.dash ? { W: an.width, S: 'D', D: dashPattern(an.width) } : { W: an.width }
  if (an.fill) {
    // /IC is the interior colour only — the fill's transparency lives in the
    // appearance's ExtGState, not in /CA (which would fade the outline too)
    const ic = hexToRgb(an.fill)
    dict.IC = [ic.red, ic.green, ic.blue]
  }
  const pts = out[0] || []
  if (kind === 'line' || kind === 'arrow') {
    if (pts.length >= 2) dict.L = [pts[0].x, pts[0].y, pts[1].x, pts[1].y]
    if (kind === 'arrow') dict.LE = [an.arrowStart ? 'ClosedArrow' : 'None', an.arrowEnd ? 'ClosedArrow' : 'None']
  } else if (kind === 'polyline' || kind === 'polygon') {
    dict.Vertices = flat(pts)
  } else if (kind === 'ink') {
    dict.InkList = out.map(flat)
  }
}

// ---------------------------------------------------------------------------
// Reading

function str(dict: PDFDict, key: string): string | undefined {
  const v = dict.lookup(PDFName.of(key))
  if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText()
  return undefined
}

function num(dict: PDFDict, key: string): number | undefined {
  const v = dict.lookup(PDFName.of(key))
  return v instanceof PDFNumber ? v.asNumber() : undefined
}

function numbers(dict: PDFDict, key: string): number[] | null {
  const arr = dict.lookup(PDFName.of(key))
  if (!(arr instanceof PDFArray)) return null
  const out: number[] = []
  for (let i = 0; i < arr.size(); i++) {
    const n = arr.lookup(i)
    if (!(n instanceof PDFNumber)) return null
    out.push(n.asNumber())
  }
  return out
}

const FONT_KEYS: FontKey[] = ['helv', 'helvB', 'times', 'timesB', 'cour', 'courB']

const unflat = (n: number[]): Pt[] => {
  const out: Pt[] = []
  for (let i = 0; i + 1 < n.length; i += 2) out.push({ x: n[i], y: n[i + 1] })
  return out
}

/** Rebuild a Draw-tab shape from the exact points we stored alongside it. */
function readShape(meta: PDFDict, kind: ShapeKind, id: string, color: string): Annotation | null {
  const width = num(meta, 'Width') || 2
  const fill = str(meta, 'Fill') || undefined
  const common = {
    id,
    leafId: '',
    type: 'shape' as const,
    kind,
    color,
    width,
    fill,
    fillAlpha: fill ? (num(meta, 'FillAlpha') ?? 1) : undefined,
    dash: meta.has(PDFName.of('Dash')) || undefined,
    arrowStart: meta.has(PDFName.of('ArrowStart')) || undefined,
    arrowEnd: meta.has(PDFName.of('ArrowEnd')) || undefined
  }
  if (kind === 'ink') {
    const list = meta.lookup(PDFName.of('Ink'))
    if (!(list instanceof PDFArray)) return null
    const strokes: Pt[][] = []
    for (let i = 0; i < list.size(); i++) {
      const sub = list.lookup(i)
      if (!(sub instanceof PDFArray)) continue
      const nums: number[] = []
      for (let k = 0; k < sub.size(); k++) {
        const v = sub.lookup(k)
        if (v instanceof PDFNumber) nums.push(v.asNumber())
      }
      if (nums.length >= 2) strokes.push(unflat(nums))
    }
    if (!strokes.length) return null
    return { ...common, pts: [], strokes }
  }
  const nums = numbers(meta, 'Pts')
  if (!nums || nums.length < 4) return null
  return { ...common, pts: unflat(nums) }
}

/** Rebuild one model annotation from an annotation dictionary we wrote. */
function readStudioAnnot(dict: PDFDict): Annotation | null {
  const meta = dict.lookup(PDFName.of(META))
  if (!(meta instanceof PDFDict) || str(meta, 'App') !== AUTHOR) return null
  const kind = str(meta, 'Kind') as StudioKind | undefined
  if (!kind || !SUBTYPE[kind]) return null
  const id = str(dict, 'NM') || uid()
  const color = str(meta, 'Color') || '#111111'

  if (isShapeKind(kind)) return readShape(meta, kind, id, color)

  if (kind === 'highlight' || kind === 'underline' || kind === 'strikeout') {
    const q = numbers(dict, 'QuadPoints')
    if (!q || q.length < 8) return null
    const rects: Box[] = []
    for (let i = 0; i + 7 < q.length; i += 8) {
      const xs = [q[i], q[i + 2], q[i + 4], q[i + 6]]
      const ys = [q[i + 1], q[i + 3], q[i + 5], q[i + 7]]
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      rects.push({ x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y })
    }
    return { id, leafId: '', type: 'markup', kind, rects, color }
  }

  const r = numbers(dict, 'Rect')
  if (!r || r.length < 4) return null
  const a = { x: Math.min(r[0], r[2]), y: Math.min(r[1], r[3]) }
  const b = { x: Math.max(r[0], r[2]), y: Math.max(r[1], r[3]) }
  if (kind === 'text') {
    const fontKey = str(meta, 'FontKey') as FontKey | undefined
    return {
      id,
      leafId: '',
      type: 'text',
      // a is the box's top-left on screen; model text boxes anchor there
      a: { x: a.x, y: b.y },
      b: { x: b.x, y: a.y },
      text: str(dict, 'Contents') || '',
      fontSize: num(meta, 'FontSize') || 12,
      font: fontKey && FONT_KEYS.includes(fontKey) ? fontKey : undefined,
      autoWidth: meta.has(PDFName.of('AutoWidth')) ? true : undefined,
      color
    }
  }
  return { id, leafId: '', type: kind, a, b, color }
}

export interface ImportResult {
  /** Document bytes with our annotations removed (they live in the model now). */
  bytes: ArrayBuffer
  /** Imported annotations per page index, still needing a leafId. */
  byPage: Annotation[][]
}

/**
 * Pull PDF Studio's own annotations out of a file and back into model objects,
 * removing them from the pages so they aren't drawn twice (once by the viewer,
 * once by our overlay). Foreign annotations — someone else's Acrobat comments —
 * are left completely alone. Returns null when there is nothing of ours.
 */
export async function importStudioAnnots(bytes: ArrayBuffer): Promise<ImportResult | null> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const pages = doc.getPages()
  const byPage: Annotation[][] = pages.map(() => [])
  let found = 0

  pages.forEach((page, pi) => {
    const annots = page.node.Annots()
    if (!annots) return
    for (let i = annots.size() - 1; i >= 0; i--) {
      const entry = annots.get(i)
      const dict = doc.context.lookupMaybe(entry, PDFDict)
      if (!dict) continue
      const an = readStudioAnnot(dict)
      if (!an) continue
      byPage[pi].unshift(an)
      annots.remove(i)
      if (entry instanceof PDFRef) doc.context.delete(entry)
      found++
    }
  })

  if (!found) return null
  stripEditableKeyword(doc)
  const out = await doc.save({ useObjectStreams: true })
  return {
    bytes: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer,
    byPage
  }
}

/** Keywords marker: set when a save leaves editable annotations in the file. */
export function setEditableKeyword(doc: PDFDocument, on: boolean): void {
  const raw = (() => {
    try {
      return doc.getKeywords() ?? ''
    } catch {
      return ''
    }
  })()
  const cleaned = raw
    .split(/\s+/)
    .filter((w) => w && w !== EDITABLE_KEYWORD)
    .join(' ')
  const next = on ? (cleaned ? `${cleaned} ${EDITABLE_KEYWORD}` : EDITABLE_KEYWORD) : cleaned
  if (!next && !raw) return
  doc.setKeywords([next])
}

function stripEditableKeyword(doc: PDFDocument): void {
  setEditableKeyword(doc, false)
}
