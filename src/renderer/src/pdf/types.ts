// All annotation geometry is stored in *unrotated PDF user-space points* of the
// source page (origin bottom-left, 1pt = 1/72"). This makes geometry invariant
// to view zoom and page rotation, and maps 1:1 onto pdf-lib at save time.

export type ToolId =
  | 'select'
  | 'text'
  | 'check'
  | 'cross'
  | 'circle'
  | 'signature'
  | 'whiteout'
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'calibrate'
  | 'measure-length'
  | 'measure-area'
  | 'measure-arc'
  | 'edit-text'
  | 'draw-line'
  | 'draw-arrow'
  | 'draw-rect'
  | 'draw-ellipse'
  | 'draw-polyline'
  | 'draw-polygon'
  | 'draw-free'

/** Standard-14 font choices for baked text (no embedding needed). */
export type FontKey = 'helv' | 'helvB' | 'times' | 'timesB' | 'cour' | 'courB'

export const MARKUP_TOOLS: ToolId[] = ['highlight', 'underline', 'strikeout']

/** Outline thickness (pt) of a circle/oval annotation, on screen and baked. */
export const CIRCLE_STROKE_PT = 1.8

/** The free-drawing shapes of the Draw tab. */
export type ShapeKind = 'line' | 'arrow' | 'rect' | 'ellipse' | 'polyline' | 'polygon' | 'ink'

/** Pen settings the Draw tab applies to new shapes (and to a selected one). */
export interface DrawStyle {
  /** Stroke thickness in points. */
  width: number
  /** Fill colour for closed shapes, or null for an outline only. */
  fill: string | null
  fillAlpha: number
  dash: boolean
  arrowStart: boolean
  arrowEnd: boolean
}

export const DEFAULT_DRAW_STYLE: DrawStyle = {
  width: 2,
  fill: null,
  fillAlpha: 0.25,
  dash: false,
  arrowStart: false,
  arrowEnd: true
}

export interface Pt {
  x: number
  y: number
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** One entry in the visible page list. Structural page ops act on these. */
export interface PageLeaf {
  id: string
  srcPage: number // 1-based page index in the loaded pdf.js document
  rotation: number // extra user rotation, degrees clockwise (0/90/180/270)
}

export interface StoredImage {
  id: string
  kind: 'png' | 'jpg'
  dataUrl: string
  bytes: ArrayBuffer
  width: number
  height: number
}

interface AnnotBase {
  id: string
  leafId: string
}

export interface RectAnnot extends AnnotBase {
  // 'whiteout' = destructive redaction (page rasterised on save);
  // 'cover' = plain white patch baked as vector (used by Edit Text mode)
  type: 'text' | 'whiteout' | 'cover' | 'check' | 'cross' | 'circle' | 'image'
  a: Pt // one corner (user space)
  b: Pt // opposite corner (user space)
  color?: string // hex, e.g. '#111111'
  // text only:
  text?: string
  fontSize?: number
  font?: FontKey // default 'helv'
  /** Box hugs its text on one line instead of wrapping. Set on boxes placed
   *  with the Text tool (`a` is their top-left corner, which re-fitting relies
   *  on); resizing one by hand clears it, and that turns word-wrap back on. */
  autoWidth?: boolean
  // image only:
  imageId?: string
}

export interface MarkupAnnot extends AnnotBase {
  type: 'markup'
  kind: 'highlight' | 'underline' | 'strikeout'
  rects: Box[] // user space
  color: string
}

export interface MeasureAnnot extends AnnotBase {
  type: 'measure'
  kind: 'length' | 'area' | 'arc'
  pts: Pt[]
  color: string
  value: number // in calibrated units
  label: string
}

/**
 * A free drawing from the Draw tab. Unlike a measurement it carries no scale or
 * label — it is just ink on the page.
 */
export interface ShapeAnnot extends AnnotBase {
  type: 'shape'
  kind: ShapeKind
  /**
   * line/arrow: [start, end] · rect/ellipse: two opposite corners of the box ·
   * polyline/polygon: the vertices · ink: unused (see `strokes`).
   */
  pts: Pt[]
  /** Freehand only: one point list per pen stroke. */
  strokes?: Pt[][]
  color: string
  width: number // stroke thickness, pt
  fill?: string // closed shapes only; absent means outline only
  fillAlpha?: number // 0..1, default 1
  dash?: boolean
  arrowStart?: boolean
  arrowEnd?: boolean
}

export interface FieldAnnot extends AnnotBase {
  type: 'field'
  fieldKind: 'text' | 'checkbox' | 'radio' | 'combo' | 'list'
  fieldName: string
  a: Pt
  b: Pt
  value: string
  exportValue?: string // on-state name for checkbox/radio
  multiline?: boolean
  maxLen?: number
  options?: { value: string; label: string }[]
  fontSize?: number
  order: number // document-wide tab order
}

export type Annotation = RectAnnot | MeasureAnnot | FieldAnnot | MarkupAnnot | ShapeAnnot

/** One OCR-recognised word on a scanned page (rect in PDF user space). */
export interface OcrWord {
  text: string
  rect: Box
}

export interface Calibration {
  unitsPerPoint: number
  unit: string // 'ft', 'm', 'yd', 'in'...
  ratio?: number // set when the scale was entered as a 1:n ratio (kept for display)
}

export interface DocModel {
  fileName: string
  leaves: PageLeaf[]
  annotations: Annotation[]
  images: Record<string, StoredImage>
  calibrations: Record<string, Calibration> // per page, keyed by leaf id
}

let _uidCounter = 0
export const uid = (): string => 'a' + (_uidCounter++).toString(36) + '_' + Math.floor(Math.random() * 1e9).toString(36)
