import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FORM_ANNOT_MODE, TextLayer, type PDFDocumentProxy, type PDFPageProxy } from '../pdf/pdfjs'
import {
  CIRCLE_STROKE_PT,
  MARKUP_TOOLS,
  type Annotation,
  type Calibration,
  type DrawStyle,
  type FieldAnnot,
  type FontKey,
  type ImageEditAnnot,
  type MarkupAnnot,
  type MeasureAnnot,
  type OcrWord,
  type PageLeaf,
  type Pt,
  type RectAnnot,
  type ShapeAnnot,
  type ShapeKind,
  type StoredImage,
  type ToolId,
  uid
} from '../pdf/types'
import {
  CLOSED_KINDS,
  DRAW_TOOL_KIND,
  POLY_DRAW_TOOLS,
  arrowHead,
  arrowHeadLen,
  bounds,
  constrain,
  dashPattern,
  isDrawTool,
  shapePathData,
  shapePoints,
  translateShape
} from '../pdf/draw'
import { arcThrough, dist, formatMeasure, polygonArea, polylineLength } from '../pdf/measure'
import { getEditableLines, type EditableLine } from '../pdf/edit'
import type { PageImage } from '../pdf/images'
import ImageLayer, { type ImageSel } from './ImageLayer'
import type { HRect } from '../pdf/search'

/** CSS equivalents of the PDF standard fonts used for baking. */
export const FONT_CSS: Record<FontKey, { family: string; weight: number }> = {
  helv: { family: 'Helvetica, Arial, sans-serif', weight: 400 },
  helvB: { family: 'Helvetica, Arial, sans-serif', weight: 700 },
  times: { family: "'Times New Roman', Times, serif", weight: 400 },
  timesB: { family: "'Times New Roman', Times, serif", weight: 700 },
  cour: { family: "'Courier New', Courier, monospace", weight: 400 },
  courB: { family: "'Courier New', Courier, monospace", weight: 700 }
}

interface Props {
  pdfDoc: PDFDocumentProxy
  leaf: PageLeaf
  index: number
  zoom: number
  tool: ToolId
  color: string
  fontSize: number
  /** Pen settings from the Draw tab (thickness, fill, dashes, arrow ends). */
  drawStyle: DrawStyle
  annotations: Annotation[]
  highlights?: { rects: HRect[]; current: boolean }[]
  images: Record<string, StoredImage>
  calibration: Calibration | null
  selectedId: string | null
  editingId: string | null
  setTool: (t: ToolId) => void
  onSelect: (id: string | null) => void
  onEdit: (id: string | null) => void
  /** A text editor lost focus: stop editing that box, discarding it if empty. */
  onFinishEdit: (id: string, text: string) => void
  onCreate: (a: Annotation) => void
  onUpdate: (a: Annotation, coalesceTag?: string) => void
  onDelete: (id: string) => void
  onChangeField: (field: FieldAnnot, value: string) => void
  onCalibrateLine: (leafId: string, pointDistance: number) => void
  onPlaceSignature: (leafId: string, a: Pt, b: Pt) => void
  onNeedSignature: () => Promise<{ w: number; h: number } | null>
  signatureAspect: number | null
  /** OCR words for scanned pages — rendered as a selectable invisible layer. */
  ocrWords?: OcrWord[]
  /** Edit Text mode: replace an existing line with an editable copy. */
  onEditLine: (leafId: string, line: EditableLine) => void
  /** pdf.js OptionalContentConfig reflecting layer toggles (+ version bump). */
  layerConfig?: unknown
  layerVersion: number
  /** Reports how long a page took to rasterise, so the app can spot a
   *  document that is too heavy for pdf.js and offer to speed it up. */
  onRenderTime?: (ms: number) => void
  /** Images embedded in this page, once the app has scanned for them. */
  pageImages?: PageImage[] | null
  /** Which embedded image is selected, and whether its crop is being adjusted. */
  imageSel?: ImageSel | null
  imageCrop?: boolean
  /** Decoded pixels per draw index, for the drag preview. */
  imageBitmaps?: Record<number, HTMLCanvasElement | null>
  onImageSelect?: (sel: ImageSel | null) => void
  onImageChange?: (rec: ImageEditAnnot, tag?: string) => void
  /** Asks the app to scan this page for embedded images (image tool only). */
  onNeedImages?: (srcPage: number) => void
}

// shared measurer for fitting OCR span widths to their word boxes
let ocrMeasureCtx: CanvasRenderingContext2D | null = null
function ocrScaleX(text: string, targetW: number, fontPx: number): number {
  if (!ocrMeasureCtx) ocrMeasureCtx = document.createElement('canvas').getContext('2d')
  if (!ocrMeasureCtx || !text) return 1
  ocrMeasureCtx.font = `${fontPx}px Arial, sans-serif`
  const m = ocrMeasureCtx.measureText(text).width
  return m > 0 ? targetW / m : 1
}

/**
 * Screen-space size a text box needs to hug its content: as wide as the
 * longest line, as tall as the line count. Used to keep new text boxes on one
 * line (they grow as you type) instead of wrapping inside a fixed-width box.
 */
let textMeasureCtx: CanvasRenderingContext2D | null = null
function fitSize(text: string, fontPx: number, font: FontKey): { w: number; h: number } {
  if (!textMeasureCtx) textMeasureCtx = document.createElement('canvas').getContext('2d')
  const css = FONT_CSS[font]
  const lines = (text || '').split('\n')
  let w = 0
  if (textMeasureCtx) {
    textMeasureCtx.font = `${css.weight >= 700 ? 'bold ' : ''}${fontPx}px ${css.family}`
    for (const l of lines) w = Math.max(w, textMeasureCtx.measureText(l).width)
  }
  // Slack on the width covers the 1px text padding, leaves room for the caret
  // past the last character, and absorbs any small metric difference between
  // the screen font and the standard-14 font used when baking — without it a
  // trailing word can wrap on save even though it fitted on screen.
  return {
    w: Math.max(fontPx * 1.5, w + fontPx * 0.5 + 4),
    h: lines.length * fontPx * 1.18 + fontPx * 0.35
  }
}

function focusFieldByOrder(delta: number, current: HTMLElement): void {
  const inputs = Array.from(document.querySelectorAll<HTMLElement>('.field-input'))
  inputs.sort((a, b) => Number(a.dataset.order) - Number(b.dataset.order))
  const idx = inputs.indexOf(current)
  if (idx < 0) return
  let next = idx + delta
  if (next < 0) next = inputs.length - 1
  if (next >= inputs.length) next = 0
  const el = inputs[next]
  if (!el) return
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  el.focus()
  if (el instanceof HTMLInputElement && el.type === 'text') el.select()
}

function onFieldTabKey(e: React.KeyboardEvent): void {
  if (e.key !== 'Tab') return
  e.preventDefault()
  focusFieldByOrder(e.shiftKey ? -1 : 1, e.currentTarget as HTMLElement)
}

type Viewport = ReturnType<PDFPageProxy['getViewport']>

interface DragState {
  mode: 'move' | 'resize' | 'whiteout' | 'circle' | 'draw' | 'shape-move' | 'vertex'
  id?: string
  startPt: Pt
  orig?: RectAnnot
  drawStart?: Pt
  /** Draw tools: the shape being dragged out, and freehand's collected points. */
  kind?: ShapeKind
  ink?: Pt[]
  /** Editing an existing shape: the original, plus which vertex is being pulled. */
  origShape?: ShapeAnnot
  vertexPath?: number
  vertexIdx?: number
}

const isShape = (a: Annotation): a is ShapeAnnot => a.type === 'shape'

/**
 * Where a shape ends up when the pointer reaches `pt` — moved bodily, or with
 * the one vertex being pulled. Derived purely from the drag state, so pointerup
 * can recompute it instead of reading state its own pointermove set.
 */
function shapeDraggedTo(drag: DragState, pt: Pt): ShapeAnnot | null {
  const o = drag.origShape
  if (!o) return null
  if (drag.mode === 'shape-move') return translateShape(o, pt.x - drag.startPt.x, pt.y - drag.startPt.y)
  const pi = drag.vertexPath ?? 0
  const vi = drag.vertexIdx ?? 0
  if (o.kind === 'ink') {
    return { ...o, strokes: (o.strokes || []).map((s, i) => (i === pi ? s.map((p, k) => (k === vi ? pt : p)) : s)) }
  }
  return { ...o, pts: o.pts.map((p, k) => (k === vi ? pt : p)) }
}

/**
 * The I-beam cursor's hotspot is its middle, so its *foot* sits a few screen
 * pixels below the point you click. New text drops by that much so the bottom
 * of the text lines up with the bottom of the cursor. This is cursor artwork,
 * not document geometry — hence a flat pixel count, unscaled by zoom.
 */
const CARET_FOOT_PX = 6

const effCal = (c: Calibration | null): Calibration => c ?? { unitsPerPoint: 1, unit: 'pt' }

// Cap the rasterised backing store so huge plan sheets at high zoom can't
// exceed canvas limits — the bitmap is CSS-scaled up beyond this point.
const MAX_CANVAS_DIM = 4096

function PageView(props: Props): JSX.Element {
  const {
    pdfDoc,
    leaf,
    index,
    zoom,
    tool,
    color,
    fontSize,
    drawStyle,
    annotations,
    highlights,
    images,
    calibration,
    selectedId,
    editingId,
    setTool,
    onSelect,
    onEdit,
    onFinishEdit,
    onCreate,
    onUpdate,
    onDelete,
    onChangeField,
    onCalibrateLine,
    onPlaceSignature,
    onNeedSignature,
    signatureAspect,
    ocrWords,
    onEditLine,
    layerConfig,
    layerVersion,
    onRenderTime,
    pageImages,
    imageSel,
    imageCrop,
    imageBitmaps,
    onImageSelect,
    onImageChange,
    onNeedImages
  } = props

  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const textHostRef = useRef<HTMLDivElement>(null)
  const [page, setPage] = useState<PDFPageProxy | null>(null)
  const [visible, setVisible] = useState(index < 3)
  const [renderVp, setRenderVp] = useState<Viewport | null>(null)
  const [pending, setPending] = useState<Pt[]>([])
  const [hoverPt, setHoverPt] = useState<Pt | null>(null)
  const [liveDrag, setLiveDrag] = useState<RectAnnot | null>(null)
  const [liveShape, setLiveShape] = useState<ShapeAnnot | null>(null)
  const [editLines, setEditLines] = useState<EditableLine[] | null>(null)
  const [hoverLine, setHoverLine] = useState(-1)
  const dragRef = useRef<DragState | null>(null)
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null)

  const totalRotation = ((leaf.rotation % 360) + 360) % 360

  // Load page proxy
  useEffect(() => {
    let alive = true
    pdfDoc.getPage(leaf.srcPage).then((p) => {
      if (alive) setPage(p)
    })
    return () => {
      alive = false
    }
  }, [pdfDoc, leaf.srcPage])

  // Compute viewport synchronously so page sizes update in the same commit as a
  // zoom change (needed for cursor-anchored zoom to read correct dimensions).
  const viewport = useMemo<Viewport | null>(() => {
    if (!page) return null
    const rot = (page.rotate + totalRotation) % 360
    return page.getViewport({ scale: zoom, rotation: rot })
  }, [page, zoom, totalRotation])

  // Visibility drives both lazy rasterising *and* releasing far-offscreen
  // bitmaps, so a 300-page set doesn't accumulate gigabytes of canvases.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setVisible(e.isIntersecting)
      },
      { root: null, rootMargin: '1500px 0px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (visible) return
    renderTaskRef.current?.cancel()
    const c = canvasRef.current
    if (c) {
      c.width = 0
      c.height = 0
    }
  }, [visible])

  // Canvas display size follows the current zoom instantly (the browser scales
  // the existing bitmap), so zooming feels immediate. The crisp re-rasterise is
  // debounced below so we don't re-render on every wheel tick.
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas && viewport) {
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
    }
  }, [viewport])

  // Debounce the resolution we actually rasterise at.
  useEffect(() => {
    if (!viewport) return
    const delay = renderVp ? 130 : 0
    const id = window.setTimeout(() => setRenderVp(viewport), delay)
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport])

  // Rasterise the page at the debounced resolution.
  //
  // The new bitmap is drawn into an offscreen canvas and blitted over the
  // visible one only once it is complete. Rendering straight into the visible
  // canvas means resizing it first, which clears it — on a dense plan sheet
  // that leaves the page blank for the whole render (seconds, not frames)
  // every time the zoom changes. Painting offscreen keeps the previous bitmap
  // on screen, CSS-scaled, until there is something better to show.
  useEffect(() => {
    if (!page || !renderVp || !visible) return
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const k = Math.min(1, MAX_CANVAS_DIM / (renderVp.width * dpr), MAX_CANVAS_DIM / (renderVp.height * dpr))
    const sc = dpr * k
    const w = Math.max(1, Math.floor(renderVp.width * sc))
    const h = Math.max(1, Math.floor(renderVp.height * sc))

    const off = document.createElement('canvas')
    off.width = w
    off.height = h
    const ctx = off.getContext('2d')!
    // A fresh canvas is transparent; the page itself paints no background.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)

    renderTaskRef.current?.cancel()
    const task = page.render({
      canvasContext: ctx,
      viewport: renderVp,
      // form fields are drawn by the field overlay below, not by the canvas
      annotationMode: FORM_ANNOT_MODE,
      transform: sc !== 1 ? [sc, 0, 0, sc, 0, 0] : undefined,
      optionalContentConfigPromise: layerConfig ? Promise.resolve(layerConfig as never) : undefined
    })
    renderTaskRef.current = task
    let alive = true
    const startedAt = performance.now()
    task.promise.then(
      () => {
        if (!alive) return
        onRenderTime?.(performance.now() - startedAt)
        const dst = canvasRef.current
        if (!dst) return
        dst.width = w
        dst.height = h
        dst.getContext('2d')!.drawImage(off, 0, 0)
        // Release the offscreen backing store now the pixels are copied.
        off.width = 0
        off.height = 0
      },
      (e: unknown) => {
        if ((e as { name?: string })?.name !== 'RenderingCancelledException') console.error(e)
      }
    )
    return () => {
      alive = false
      task.cancel()
    }
    // onRenderTime is a stable callback from App; excluded so a new identity
    // can never force a re-rasterise of an expensive page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, renderVp, visible, layerConfig, layerVersion])

  // Edit Text mode: load the clickable line map for this page
  useEffect(() => {
    if (tool !== 'edit-text' || !visible) {
      setHoverLine(-1)
      return
    }
    let alive = true
    getEditableLines(pdfDoc, leaf.srcPage, ocrWords)
      .then((lines) => {
        if (alive) setEditLines(lines)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [tool, visible, pdfDoc, leaf.srcPage, ocrWords])

  // Selectable text layer (also powers highlight/underline/strikeout).
  useEffect(() => {
    const host = textHostRef.current
    if (!host) return
    host.textContent = ''
    if (!page || !renderVp || !visible) return
    host.style.setProperty('--scale-factor', String(renderVp.scale))
    const tl = new TextLayer({
      textContentSource: page.streamTextContent(),
      container: host,
      viewport: renderVp
    })
    let cancelled = false
    tl.render().catch((e: unknown) => {
      if (!cancelled) console.warn('text layer failed', e)
    })
    return () => {
      cancelled = true
      tl.cancel()
    }
  }, [page, renderVp, visible])

  // ---- coordinate helpers ----------------------------------------------
  const toScreen = useCallback(
    (pt: Pt): { x: number; y: number } => {
      if (!viewport) return { x: 0, y: 0 }
      const [x, y] = viewport.convertToViewportPoint(pt.x, pt.y)
      return { x, y }
    },
    [viewport]
  )

  const toPdf = useCallback(
    (clientX: number, clientY: number): Pt => {
      const rect = overlayRef.current!.getBoundingClientRect()
      const vx = clientX - rect.left
      const vy = clientY - rect.top
      const [x, y] = viewport!.convertToPdfPoint(vx, vy)
      return { x, y }
    },
    [viewport]
  )

  const rectScreen = useCallback(
    (a: Pt, b: Pt) => {
      const p1 = toScreen(a)
      const p2 = toScreen(b)
      return {
        left: Math.min(p1.x, p2.x),
        top: Math.min(p1.y, p2.y),
        width: Math.abs(p2.x - p1.x),
        height: Math.abs(p2.y - p1.y)
      }
    },
    [toScreen]
  )

  // ---- creation helpers -------------------------------------------------
  const offsetByScreen = useCallback(
    (origin: Pt, screenDx: number, screenDy: number): Pt => {
      // shift a user-space point by a screen-space offset (rotation-aware, so
      // "down" always means down on screen even on a rotated page)
      const o = toScreen(origin)
      return toPdf(
        overlayRef.current!.getBoundingClientRect().left + o.x + screenDx,
        overlayRef.current!.getBoundingClientRect().top + o.y + screenDy
      )
    },
    [toScreen, toPdf]
  )

  /** Resize an auto-width text box around `text` (no-op for any other box). */
  const fitTextBox = useCallback(
    (an: RectAnnot, text: string): RectAnnot => {
      if (!an.autoWidth) return { ...an, text }
      const f = fitSize(text, (an.fontSize || 12) * zoom, an.font || 'helv')
      return { ...an, text, b: offsetByScreen(an.a, f.w, f.h) }
    },
    [zoom, offsetByScreen]
  )

  const addText = useCallback(
    (at: Pt) => {
      // The click marks the *baseline* of the first line, so the bottom of what
      // gets typed sits on the cursor instead of a line lower. Baked text puts
      // the first baseline one em below the box top (drawTextLines in
      // pdf/save.ts), less the I-beam's foot — see CARET_FOOT_PX.
      const top = offsetByScreen(at, 0, CARET_FOOT_PX - fontSize * zoom)
      const a = fitTextBox(
        { id: uid(), leafId: leaf.id, type: 'text', a: top, b: top, fontSize, color, autoWidth: true },
        ''
      )
      onCreate(a)
      onEdit(a.id)
    },
    [offsetByScreen, fitTextBox, leaf.id, fontSize, zoom, color, onCreate, onEdit]
  )

  const addGlyph = useCallback(
    (kind: 'check' | 'cross', at: Pt) => {
      const b = offsetByScreen(at, 20, 20)
      onCreate({ id: uid(), leafId: leaf.id, type: kind, a: at, b, color: kind === 'check' ? '#0a7d29' : '#b91c1c' })
    },
    [offsetByScreen, leaf.id, onCreate]
  )

  /** Circle/oval: drag to size it, or a bare click drops a default oval. */
  const addCircle = useCallback(
    (p0: Pt, p1: Pt) => {
      const s0 = toScreen(p0)
      const s1 = toScreen(p1)
      const tiny = Math.abs(s1.x - s0.x) < 4 || Math.abs(s1.y - s0.y) < 4
      const a = tiny ? offsetByScreen(p0, -24, -14) : p0
      const b = tiny ? offsetByScreen(p0, 24, 14) : p1
      onCreate({ id: uid(), leafId: leaf.id, type: 'circle', a, b, color })
    },
    [toScreen, offsetByScreen, leaf.id, color, onCreate]
  )

  const placeSignature = useCallback(
    async (at: Pt) => {
      let aspect = signatureAspect
      if (aspect == null) {
        const dims = await onNeedSignature()
        if (!dims) return
        aspect = dims.h / dims.w
      }
      const screenW = 180
      const b = offsetByScreen(at, screenW, screenW * aspect)
      onPlaceSignature(leaf.id, at, b)
      setTool('select')
    },
    [signatureAspect, onNeedSignature, offsetByScreen, leaf.id, onPlaceSignature, setTool]
  )

  /** A new drawing, carrying the Draw tab's current pen settings. */
  const makeShape = useCallback(
    (kind: ShapeKind, pts: Pt[], strokes?: Pt[][]): ShapeAnnot => {
      const closed = CLOSED_KINDS.includes(kind)
      return {
        id: uid(),
        leafId: leaf.id,
        type: 'shape',
        kind,
        pts,
        strokes,
        color,
        width: drawStyle.width,
        fill: closed && drawStyle.fill ? drawStyle.fill : undefined,
        fillAlpha: closed && drawStyle.fill ? drawStyle.fillAlpha : undefined,
        dash: drawStyle.dash || undefined,
        arrowStart: kind === 'arrow' && drawStyle.arrowStart ? true : undefined,
        arrowEnd: kind === 'arrow' && drawStyle.arrowEnd ? true : undefined
      }
    },
    [leaf.id, color, drawStyle]
  )

  /** Finish a click-by-click polyline / polygon (double-click, or Enter). */
  const finishPoly = useCallback(
    (pts: Pt[]) => {
      const kind = DRAW_TOOL_KIND[tool] as ShapeKind | undefined
      // the finishing double-click lands on the last vertex twice — drop the
      // zero-length segments that would otherwise be stored
      const clean = pts.filter((p, i) => i === 0 || dist(p, pts[i - 1]) > 0.01)
      if (kind && clean.length >= 2) onCreate(makeShape(kind, clean))
      setPending([])
      setHoverPt(null)
    },
    [tool, makeShape, onCreate]
  )

  const finishMeasure = useCallback(
    (pts: Pt[], kind: 'length' | 'area' | 'arc') => {
      const cal = effCal(calibration)
      let value = 0
      let stored = pts
      if (kind === 'length') value = polylineLength(pts) * cal.unitsPerPoint
      else if (kind === 'area') value = polygonArea(pts) * cal.unitsPerPoint * cal.unitsPerPoint
      else {
        const arc = arcThrough(pts[0], pts[1], pts[2])
        stored = arc.points
        value = arc.length * cal.unitsPerPoint
      }
      onCreate({
        id: uid(),
        leafId: leaf.id,
        type: 'measure',
        kind,
        pts: stored,
        color,
        value,
        label: formatMeasure(value, cal.unit, kind)
      })
      setPending([])
    },
    [calibration, leaf.id, color, onCreate]
  )

  // ---- pointer handling on the page background -------------------------
  const onOverlayPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!viewport || e.button !== 0) return
      // Tools that work on existing annotations let those clicks through to the
      // annotation itself. A placement tool doesn't care what's underneath — it
      // drops a new one on top, rather than the click doing nothing (which used
      // to happen when an oversized text box sat where you wanted the next one).
      // The one exception is the Text tool over existing text, which startMove
      // claims so you can carry on typing in that box.
      const target = e.target as HTMLElement
      const onAnnot = !!(target.dataset.annot || target.closest?.('[data-annot]'))
      if (onAnnot && (tool === 'select' || tool === 'edit-text' || MARKUP_TOOLS.includes(tool))) return
      // Drawing tools: cancel the default mousedown focus action, otherwise the
      // browser blurs the just-focused text editor and the empty box deletes
      // itself before the user can type.
      if (tool !== 'select') e.preventDefault()
      const pt = toPdf(e.clientX, e.clientY)

      switch (tool) {
        case 'select':
          onSelect(null)
          onEdit(null)
          break
        case 'text':
          addText(pt)
          break
        case 'check':
          addGlyph('check', pt)
          break
        case 'cross':
          addGlyph('cross', pt)
          break
        case 'signature':
          void placeSignature(pt)
          break
        case 'whiteout':
        case 'circle':
          dragRef.current = { mode: tool, startPt: pt, drawStart: pt }
          setPending([pt, pt])
          ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
          break
        case 'draw-line':
        case 'draw-arrow':
        case 'draw-rect':
        case 'draw-ellipse':
        case 'draw-free':
          dragRef.current = {
            mode: 'draw',
            kind: DRAW_TOOL_KIND[tool] as ShapeKind,
            startPt: pt,
            drawStart: pt,
            ink: tool === 'draw-free' ? [pt] : undefined
          }
          setPending([pt, pt])
          ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
          break
        case 'draw-polyline':
        case 'draw-polygon':
          setPending((p) => [...p, pt])
          break
        case 'calibrate': {
          const next = [...pending, pt]
          if (next.length >= 2) {
            onCalibrateLine(leaf.id, dist(next[0], next[1]))
            setPending([])
          } else setPending(next)
          break
        }
        case 'measure-length':
        case 'measure-area':
          setPending((p) => [...p, pt])
          break
        case 'measure-arc': {
          const next = [...pending, pt]
          if (next.length >= 3) finishMeasure(next, 'arc')
          else setPending(next)
          break
        }
        case 'edit-text': {
          const lines = editLines || []
          const idx = lines.findIndex(
            (l) => pt.x >= l.rect.x - 2 && pt.x <= l.rect.x + l.rect.w + 2 && pt.y >= l.rect.y - 2 && pt.y <= l.rect.y + l.rect.h + 2
          )
          if (idx >= 0) onEditLine(leaf.id, lines[idx])
          break
        }
      }
    },
    [viewport, tool, toPdf, pending, editLines, leaf.id, onSelect, onEdit, addText, addGlyph, placeSignature, onCalibrateLine, finishMeasure, onEditLine]
  )

  const onOverlayPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!viewport) return
      const drag = dragRef.current
      if (!drag && !(tool.startsWith('measure') || tool === 'calibrate' || tool === 'edit-text' || isDrawTool(tool))) {
        return
      }
      const pt = toPdf(e.clientX, e.clientY)
      if (drag?.mode === 'whiteout' || drag?.mode === 'circle') {
        setPending([drag.drawStart!, pt])
        return
      }
      if (drag?.mode === 'draw') {
        if (drag.ink) {
          // thin the trail: one point per ~2 screen px keeps freehand smooth
          // without storing hundreds of near-identical points
          const last = drag.ink[drag.ink.length - 1]
          const a = toScreen(last)
          const b = toScreen(pt)
          if (Math.hypot(b.x - a.x, b.y - a.y) >= 2) {
            drag.ink.push(pt)
            setPending([...drag.ink])
          }
        } else {
          setPending([drag.drawStart!, e.shiftKey ? constrain(drag.kind!, drag.drawStart!, pt) : pt])
        }
        return
      }
      if (drag?.mode === 'shape-move' || drag?.mode === 'vertex') {
        setLiveShape(shapeDraggedTo(drag, pt))
        return
      }
      // move/resize track locally and commit once on pointer-up, so the rest
      // of the document doesn't re-render on every mouse move
      if (drag?.mode === 'move' && drag.orig) {
        const dx = pt.x - drag.startPt.x
        const dy = pt.y - drag.startPt.y
        const o = drag.orig
        setLiveDrag({ ...o, a: { x: o.a.x + dx, y: o.a.y + dy }, b: { x: o.b.x + dx, y: o.b.y + dy } })
        return
      }
      if (drag?.mode === 'resize' && drag.orig) {
        setLiveDrag({ ...drag.orig, b: pt })
        return
      }
      if (tool.startsWith('measure') || tool === 'calibrate' || POLY_DRAW_TOOLS.includes(tool)) {
        setHoverPt(pt)
      } else if (tool === 'edit-text') {
        const lines = editLines || []
        setHoverLine(
          lines.findIndex(
            (l) => pt.x >= l.rect.x - 2 && pt.x <= l.rect.x + l.rect.w + 2 && pt.y >= l.rect.y - 2 && pt.y <= l.rect.y + l.rect.h + 2
          )
        )
      }
    },
    [viewport, toPdf, tool, editLines]
  )

  const onOverlayPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current
      if (drag?.mode === 'whiteout' || drag?.mode === 'circle') {
        // Take the geometry from the drag ref and this event rather than the
        // pending state: on a quick click pointerup can arrive before the
        // pointerdown's state update has been committed.
        const p0 = drag.drawStart
        const p1 = viewport ? toPdf(e.clientX, e.clientY) : null
        if (p0 && p1) {
          if (drag.mode === 'circle') addCircle(p0, p1)
          else if (dist(p0, p1) > 2) {
            onCreate({ id: uid(), leafId: leaf.id, type: 'whiteout', a: p0, b: p1, color: '#ffffff' })
          }
        }
        setPending([])
        // the circle tool stays armed so several can be drawn in a row
        if (drag.mode === 'whiteout') setTool('select')
      } else if (drag?.mode === 'draw' && viewport) {
        // geometry comes from the drag ref and this event, never from `pending`
        // — on a quick click that state update hasn't landed yet
        const p0 = drag.drawStart!
        const p1raw = toPdf(e.clientX, e.clientY)
        const p1 = e.shiftKey ? constrain(drag.kind!, p0, p1raw) : p1raw
        if (drag.ink) {
          const pts = drag.ink
          if (pts.length >= 2) onCreate(makeShape('ink', [], [pts]))
        } else {
          const s0 = toScreen(p0)
          const s1 = toScreen(p1)
          // a stray click shouldn't leave an invisible speck behind
          if (Math.hypot(s1.x - s0.x, s1.y - s0.y) >= 4) onCreate(makeShape(drag.kind!, [p0, p1]))
        }
        setPending([])
        // draw tools stay armed so several shapes can be drawn in a row
      } else if ((drag?.mode === 'move' || drag?.mode === 'resize') && liveDrag) {
        onUpdate(liveDrag)
      } else if ((drag?.mode === 'shape-move' || drag?.mode === 'vertex') && viewport) {
        const moved = shapeDraggedTo(drag, toPdf(e.clientX, e.clientY))
        if (moved) onUpdate(moved)
      }
      setLiveDrag(null)
      setLiveShape(null)
      dragRef.current = null
      try {
        ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
    },
    [viewport, toPdf, toScreen, leaf.id, liveDrag, addCircle, makeShape, onCreate, onUpdate, setTool]
  )

  const onOverlayDoubleClick = useCallback(() => {
    if (tool === 'measure-length' && pending.length >= 2) finishMeasure(pending, 'length')
    else if (tool === 'measure-area' && pending.length >= 3) finishMeasure(pending, 'area')
    else if (POLY_DRAW_TOOLS.includes(tool)) finishPoly(pending)
  }, [tool, pending, finishMeasure, finishPoly])

  // Changing tool abandons anything half-drawn (Escape also switches to Select).
  useEffect(() => {
    setPending([])
    setHoverPt(null)
  }, [tool])

  // Enter closes an in-progress polyline / polygon without a double-click.
  useEffect(() => {
    if (!POLY_DRAW_TOOLS.includes(tool) || pending.length < 2) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      finishPoly(pending)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tool, pending, finishPoly])

  // ---- shape editing (select tool) --------------------------------------
  const startShapeMove = useCallback(
    (e: React.PointerEvent, sh: ShapeAnnot) => {
      if (e.button !== 0 || tool !== 'select') return
      e.stopPropagation()
      onSelect(sh.id)
      dragRef.current = { mode: 'shape-move', id: sh.id, startPt: toPdf(e.clientX, e.clientY), origShape: sh }
      ;(e.currentTarget as unknown as Element).setPointerCapture(e.pointerId)
    },
    [tool, toPdf, onSelect]
  )

  const startVertexDrag = useCallback(
    (e: React.PointerEvent, sh: ShapeAnnot, pathIdx: number, vertexIdx: number) => {
      if (e.button !== 0) return
      e.stopPropagation()
      dragRef.current = {
        mode: 'vertex',
        id: sh.id,
        startPt: toPdf(e.clientX, e.clientY),
        origShape: sh,
        vertexPath: pathIdx,
        vertexIdx
      }
      ;(e.currentTarget as unknown as Element).setPointerCapture(e.pointerId)
    },
    [toPdf]
  )

  // ---- annotation drag start (select tool) -----------------------------
  const startMove = useCallback(
    (e: React.PointerEvent, an: RectAnnot) => {
      if (e.button !== 0) return
      // Text tool over existing text: carry on typing in that box rather than
      // stacking a new one on top of it. Only text — you can't retype a check.
      if (tool === 'text' && an.type === 'text') {
        e.stopPropagation()
        e.preventDefault() // the editor focuses itself on mount
        onSelect(an.id)
        onEdit(an.id)
        return
      }
      if (tool !== 'select') return
      e.stopPropagation()
      onSelect(an.id)
      dragRef.current = { mode: 'move', id: an.id, startPt: toPdf(e.clientX, e.clientY), orig: an }
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    },
    [tool, toPdf, onSelect, onEdit]
  )

  const startResize = useCallback(
    (e: React.PointerEvent, an: RectAnnot) => {
      if (e.button !== 0) return
      e.stopPropagation()
      // Sizing a text box by hand is how you ask for word-wrap: stop the box
      // auto-hugging its text from here on.
      const orig = an.type === 'text' && an.autoWidth ? { ...an, autoWidth: false } : an
      dragRef.current = { mode: 'resize', id: an.id, startPt: toPdf(e.clientX, e.clientY), orig }
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    },
    [toPdf]
  )

  /** The shape being drawn right now, rendered exactly like a finished one. */
  const previewShape = useMemo<ShapeAnnot | null>(() => {
    if (!isDrawTool(tool) || pending.length === 0) return null
    const kind = DRAW_TOOL_KIND[tool] as ShapeKind
    const closed = CLOSED_KINDS.includes(kind)
    const pts = POLY_DRAW_TOOLS.includes(tool) && hoverPt ? [...pending, hoverPt] : pending
    const common = {
      id: 'preview',
      leafId: leaf.id,
      type: 'shape' as const,
      kind,
      color,
      width: drawStyle.width,
      fill: closed && drawStyle.fill ? drawStyle.fill : undefined,
      fillAlpha: closed && drawStyle.fill ? drawStyle.fillAlpha : undefined,
      dash: drawStyle.dash || undefined,
      arrowStart: kind === 'arrow' && drawStyle.arrowStart ? true : undefined,
      arrowEnd: kind === 'arrow' && drawStyle.arrowEnd ? true : undefined
    }
    if (kind === 'ink') return pts.length >= 2 ? { ...common, pts: [], strokes: [pts] } : null
    return pts.length >= 2 ? { ...common, pts } : null
  }, [tool, pending, hoverPt, leaf.id, color, drawStyle])

  // Deselect when clicking page background while the overlay is in
  // pass-through mode (select / markup tools let the text layer take clicks).
  const onStagePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (tool !== 'select' && !MARKUP_TOOLS.includes(tool)) return
      const target = e.target as HTMLElement
      if (target.closest?.('[data-annot]')) return
      onSelect(null)
      onEdit(null)
    },
    [tool, onSelect, onEdit]
  )

  // The image tool needs to know what this page draws; the scan runs in the
  // app (it owns the pdf-lib copy of the file) and is cached there per page.
  const wantImages = tool === 'image-edit' && visible && !pageImages
  useEffect(() => {
    if (wantImages) onNeedImages?.(leaf.srcPage)
  }, [wantImages, leaf.srcPage, onNeedImages])

  if (!viewport) {
    return <div className="page-wrap" ref={wrapRef} data-page-index={index} style={{ minHeight: 400 }} />
  }

  const cal = effCal(calibration)
  const measuring = tool.startsWith('measure') || tool === 'calibrate'
  const isMarkupTool = MARKUP_TOOLS.includes(tool)
  const editingImages = tool === 'image-edit'
  const imageRecords = annotations.filter((a): a is ImageEditAnnot => a.type === 'imgedit')
  const passthru = tool === 'select' || isMarkupTool || editingImages
  const cursor =
    tool === 'select' || editingImages
      ? 'default'
      : tool === 'text' || tool === 'edit-text'
        ? 'text'
        : measuring || tool === 'whiteout' || tool === 'circle' || isDrawTool(tool)
          ? 'crosshair'
          : 'copy'
  const textScale = renderVp ? viewport.width / renderVp.width : 1

  return (
    <div className="page-wrap" ref={wrapRef} data-page-index={index}>
      <div className="page-num">Page {index + 1}</div>
      <div
        className="page-stage"
        style={{ width: viewport.width, height: viewport.height }}
        onPointerDown={onStagePointerDown}
      >
        <canvas ref={canvasRef} className="page-canvas" />
        <div
          ref={textHostRef}
          className="textLayer"
          style={{
            width: renderVp?.width ?? viewport.width,
            height: renderVp?.height ?? viewport.height,
            transform: textScale !== 1 ? `scale(${textScale})` : undefined,
            pointerEvents: passthru ? 'auto' : 'none'
          }}
        />
        {ocrWords && ocrWords.length > 0 && (
          <div
            className="textLayer ocr"
            style={{
              width: viewport.width,
              height: viewport.height,
              pointerEvents: passthru ? 'auto' : 'none'
            }}
          >
            {ocrWords.map((w, i) => {
              const s = rectScreen(
                { x: w.rect.x, y: w.rect.y },
                { x: w.rect.x + w.rect.w, y: w.rect.y + w.rect.h }
              )
              const fs = Math.max(4, s.height * 0.85)
              return (
                <span
                  key={i}
                  style={{
                    left: s.left,
                    top: s.top,
                    fontSize: fs,
                    fontFamily: 'Arial, sans-serif',
                    transform: `scaleX(${ocrScaleX(w.text, s.width, fs)})`
                  }}
                >
                  {w.text + ' '}
                </span>
              )
            })}
          </div>
        )}
        <div
          ref={overlayRef}
          className={`page-overlay ${passthru ? 'passthru' : ''}`}
          style={{ width: viewport.width, height: viewport.height, cursor }}
          onPointerDown={onOverlayPointerDown}
          onPointerMove={onOverlayPointerMove}
          onPointerUp={onOverlayPointerUp}
          onDoubleClick={onOverlayDoubleClick}
        >
          {/* vector overlay: search highlights + markup + measures + pending + whiteout preview */}
          <svg className="vec" width={viewport.width} height={viewport.height}>
            {highlights?.map((h, hi) =>
              h.rects.map((r, ri) => {
                const s = rectScreen({ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h })
                return (
                  <rect
                    key={`hl${hi}-${ri}`}
                    x={s.left}
                    y={s.top}
                    width={s.width}
                    height={s.height}
                    fill={h.current ? '#ff9500' : '#ffe14d'}
                    opacity={h.current ? 0.55 : 0.4}
                  />
                )
              })
            )}
            {annotations
              .filter((a): a is MarkupAnnot => a.type === 'markup')
              .map((mk) => {
                const isSel = selectedId === mk.id
                return (
                  <g
                    key={mk.id}
                    data-annot="1"
                    onPointerDown={(e) => {
                      if (e.button !== 0) return
                      e.stopPropagation()
                      onSelect(mk.id)
                    }}
                  >
                    {mk.rects.map((r, i) => {
                      const s = rectScreen({ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h })
                      if (mk.kind === 'highlight') {
                        return (
                          <rect
                            key={i}
                            x={s.left}
                            y={s.top}
                            width={s.width}
                            height={s.height}
                            fill={mk.color}
                            opacity={0.4}
                            style={{ mixBlendMode: 'multiply' }}
                          />
                        )
                      }
                      const t = Math.max(1.2, s.height * 0.08)
                      const y = mk.kind === 'underline' ? s.top + s.height - t : s.top + s.height * 0.55 - t / 2
                      return <rect key={i} x={s.left} y={y} width={s.width} height={t} fill={mk.color} />
                    })}
                    {isSel &&
                      (() => {
                        const xs = mk.rects.map((r) => rectScreen({ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h }))
                        const left = Math.min(...xs.map((s) => s.left))
                        const top = Math.min(...xs.map((s) => s.top))
                        const right = Math.max(...xs.map((s) => s.left + s.width))
                        const bottom = Math.max(...xs.map((s) => s.top + s.height))
                        return (
                          <rect
                            x={left - 2}
                            y={top - 2}
                            width={right - left + 4}
                            height={bottom - top + 4}
                            fill="none"
                            stroke="#3b82f6"
                            strokeDasharray="4 3"
                          />
                        )
                      })()}
                  </g>
                )
              })}
            {annotations
              .filter((a): a is MeasureAnnot => a.type === 'measure')
              .map((m) => {
                const scr = m.pts.map(toScreen)
                const d =
                  scr.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ') +
                  (m.kind === 'area' ? ' Z' : '')
                const mid = scr[Math.floor(scr.length / 2)] || scr[0]
                const isSel = selectedId === m.id
                return (
                  <g
                    key={m.id}
                    data-annot="1"
                    onPointerDown={(e) => {
                      e.stopPropagation()
                      onSelect(m.id)
                    }}
                  >
                    <path
                      d={d}
                      fill={m.kind === 'area' ? m.color + '22' : 'none'}
                      stroke={m.color}
                      strokeWidth={isSel ? 2.5 : 1.5}
                    />
                    {scr.map((p, i) => (
                      <circle key={i} cx={p.x} cy={p.y} r={2.5} fill={m.color} />
                    ))}
                    <g transform={`translate(${mid.x + 6},${mid.y - 6})`}>
                      <rect x={-2} y={-11} width={m.label.length * 6.2 + 6} height={15} rx={2} fill="#fff" opacity={0.9} />
                      <text x={1} y={0} fontSize={11} fill={m.color} fontFamily="sans-serif">
                        {m.label}
                      </text>
                    </g>
                  </g>
                )
              })}

            {/* Draw-tab shapes */}
            {annotations.filter(isShape).map((base) => {
              const sh = liveShape && liveShape.id === base.id ? liveShape : base
              return (
                <ShapeView
                  key={sh.id}
                  shape={sh}
                  zoom={zoom}
                  selected={selectedId === sh.id}
                  editable={tool === 'select'}
                  toScreen={toScreen}
                  onPointerDown={(e) => startShapeMove(e, sh)}
                  onVertexDown={(e, pi, vi) => startVertexDrag(e, sh, pi, vi)}
                  onDelete={() => onDelete(sh.id)}
                />
              )
            })}

            {/* Edit Text mode: outline every editable line, highlight hover */}
            {tool === 'edit-text' &&
              (editLines || []).map((l, i) => {
                const s = rectScreen({ x: l.rect.x, y: l.rect.y }, { x: l.rect.x + l.rect.w, y: l.rect.y + l.rect.h })
                const hot = i === hoverLine
                return (
                  <rect
                    key={`el${i}`}
                    x={s.left - 2}
                    y={s.top - 2}
                    width={s.width + 4}
                    height={s.height + 4}
                    fill={hot ? 'rgba(59,130,246,0.16)' : 'none'}
                    stroke={hot ? '#3b82f6' : 'rgba(59,130,246,0.35)'}
                    strokeWidth={hot ? 1.5 : 0.75}
                    strokeDasharray={hot ? undefined : '3 3'}
                  />
                )
              })}

            {/* pending preview */}
            {pending.length > 0 && tool !== 'whiteout' && tool !== 'circle' && !isDrawTool(tool) && (
              <PendingPreview pts={pending} hover={hoverPt} tool={tool} toScreen={toScreen} cal={cal} />
            )}
            {previewShape && <ShapeView shape={previewShape} zoom={zoom} toScreen={toScreen} preview />}
            {POLY_DRAW_TOOLS.includes(tool) &&
              pending.map((p, i) => {
                const s = toScreen(p)
                return <circle key={`dv${i}`} cx={s.x} cy={s.y} r={3} fill={color} />
              })}
            {tool === 'whiteout' && pending.length === 2 && (
              (() => {
                const r = rectScreen(pending[0], pending[1])
                return <rect x={r.left} y={r.top} width={r.width} height={r.height} fill="#ffffff" stroke="#888" strokeDasharray="4 3" />
              })()
            )}
            {tool === 'circle' && pending.length === 2 && (
              (() => {
                const r = rectScreen(pending[0], pending[1])
                return (
                  <ellipse
                    cx={r.left + r.width / 2}
                    cy={r.top + r.height / 2}
                    rx={Math.max(0.5, r.width / 2)}
                    ry={Math.max(0.5, r.height / 2)}
                    fill="none"
                    stroke={color}
                    strokeWidth={CIRCLE_STROKE_PT * zoom}
                  />
                )
              })()
            )}
          </svg>

          {/* rect-based annotations (text / image / check / cross / whiteout / cover) */}
          {annotations
            .filter(
              (a): a is RectAnnot =>
                a.type === 'text' ||
                a.type === 'whiteout' ||
                a.type === 'cover' ||
                a.type === 'check' ||
                a.type === 'cross' ||
                a.type === 'circle' ||
                a.type === 'image'
            )
            .map((base) => {
              const an = liveDrag && liveDrag.id === base.id ? liveDrag : base
              const r = rectScreen(an.a, an.b)
              const isSel = selectedId === an.id
              const common: React.CSSProperties = {
                left: r.left,
                top: r.top,
                width: r.width,
                height: r.height
              }
              return (
                <div
                  key={an.id}
                  data-annot="1"
                  className={`annot ${an.type} ${isSel ? 'sel' : ''}`}
                  style={common}
                  onPointerDown={(e) => startMove(e, an)}
                  onDoubleClick={(e) => {
                    if (an.type === 'text') {
                      e.stopPropagation()
                      onEdit(an.id)
                    }
                  }}
                >
                  {(an.type === 'whiteout' || an.type === 'cover') && (
                    <div className="whiteout-fill" style={{ background: an.color || '#fff' }} />
                  )}
                  {an.type === 'image' && images[an.imageId!] && (
                    <img src={images[an.imageId!].dataUrl} alt="stamp" draggable={false} />
                  )}
                  {an.type === 'check' && (
                    <svg viewBox="0 0 24 24" width={r.width} height={r.height}>
                      <path d="M3 12 L9 19 L21 4" fill="none" stroke={an.color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                  {an.type === 'cross' && (
                    <svg viewBox="0 0 24 24" width={r.width} height={r.height}>
                      <path d="M4 4 L20 20 M20 4 L4 20" fill="none" stroke={an.color} strokeWidth={3} strokeLinecap="round" />
                    </svg>
                  )}
                  {an.type === 'circle' &&
                    (() => {
                      // stroke is a fixed thickness in points, so it sits inside
                      // the box the same way the baked ellipse does
                      const t = CIRCLE_STROKE_PT * zoom
                      return (
                        <svg width={r.width} height={r.height}>
                          <ellipse
                            cx={r.width / 2}
                            cy={r.height / 2}
                            rx={Math.max(0.5, r.width / 2 - t / 2)}
                            ry={Math.max(0.5, r.height / 2 - t / 2)}
                            fill="none"
                            stroke={an.color || '#111111'}
                            strokeWidth={t}
                          />
                        </svg>
                      )
                    })()}
                  {an.type === 'text' &&
                    (editingId === an.id ? (
                      <TextEditor
                        value={an.text || ''}
                        fontSize={(an.fontSize || 12) * zoom}
                        color={an.color || '#111111'}
                        fontCss={FONT_CSS[an.font || 'helv']}
                        nowrap={!!an.autoWidth}
                        onChange={(text) => onUpdate(fitTextBox(an, text), `text:${an.id}`)}
                        onDone={(text) => onFinishEdit(an.id, text)}
                      />
                    ) : (
                      <div
                        className="text-show"
                        style={{
                          fontSize: (an.fontSize || 12) * zoom,
                          color: an.color,
                          fontFamily: FONT_CSS[an.font || 'helv'].family,
                          fontWeight: FONT_CSS[an.font || 'helv'].weight,
                          whiteSpace: an.autoWidth ? 'pre' : 'pre-wrap'
                        }}
                      >
                        {an.text || <span className="placeholder">Text…</span>}
                      </div>
                    ))}

                  {isSel && tool === 'select' && (
                    <>
                      <div className="handle br" onPointerDown={(e) => startResize(e, an)} />
                      <button
                        className="annot-del"
                        onPointerDown={(e) => {
                          e.stopPropagation()
                          onDelete(an.id)
                        }}
                        title="Delete"
                      >
                        ×
                      </button>
                    </>
                  )}
                </div>
              )
            })}

          {/* fillable form fields (always interactive in Select mode) */}
          {annotations
            .filter((a): a is FieldAnnot => a.type === 'field')
            .map((f) => {
              const r = rectScreen(f.a, f.b)
              const typing = f.fieldKind === 'text' || f.fieldKind === 'combo' || f.fieldKind === 'list'
              const ticking = f.fieldKind === 'checkbox' || f.fieldKind === 'radio'
              // Acrobat behaviour: a real form field wins over placing our own
              // mark, so the Text tool fills a text field and Check/X tick a box
              // instead of stamping something on top of it.
              const interactive =
                tool === 'select' ||
                (typing && tool === 'text') ||
                (ticking && (tool === 'check' || tool === 'cross'))
              const style: React.CSSProperties = {
                left: r.left,
                top: r.top,
                width: r.width,
                height: r.height,
                pointerEvents: interactive ? 'auto' : 'none'
              }
              // field font sizes are PDF points, so they scale with zoom like the
              // rest of the page; fontSize 0 means "auto" in the PDF, which Acrobat
              // fits to the box height — measured unzoomed, then scaled back up
              const autoPt = Math.min(13, r.height / zoom - 3)
              const fs = Math.max(6, (f.fontSize || autoPt) * zoom)
              const stop = (e: React.PointerEvent): void => e.stopPropagation()
              if (f.fieldKind === 'checkbox' || f.fieldKind === 'radio') {
                const checked = f.fieldKind === 'checkbox' ? !!f.value : f.value === f.exportValue
                return (
                  <div key={f.id} className="field-widget cb" style={style} data-annot="1" onPointerDown={stop}>
                    <input
                      type={f.fieldKind === 'radio' ? 'radio' : 'checkbox'}
                      className="field-input"
                      data-order={f.order}
                      checked={checked}
                      onKeyDown={onFieldTabKey}
                      onChange={(e) =>
                        onChangeField(
                          f,
                          f.fieldKind === 'checkbox'
                            ? e.target.checked
                              ? f.exportValue || 'On'
                              : ''
                            : f.exportValue || 'On'
                        )
                      }
                    />
                  </div>
                )
              }
              if ((f.fieldKind === 'combo' || f.fieldKind === 'list') && f.options && f.options.length) {
                return (
                  <div key={f.id} className="field-widget" style={style} data-annot="1" onPointerDown={stop}>
                    <select
                      className="field-input"
                      data-order={f.order}
                      value={f.value}
                      style={{ fontSize: fs }}
                      onKeyDown={onFieldTabKey}
                      onChange={(e) => onChangeField(f, e.target.value)}
                    >
                      <option value="" />
                      {f.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )
              }
              return (
                <div key={f.id} className="field-widget" style={style} data-annot="1" onPointerDown={stop}>
                  {f.multiline ? (
                    <textarea
                      className="field-input"
                      data-order={f.order}
                      value={f.value}
                      maxLength={f.maxLen}
                      style={{ fontSize: fs }}
                      onKeyDown={onFieldTabKey}
                      onChange={(e) => onChangeField(f, e.target.value)}
                    />
                  ) : (
                    <input
                      type="text"
                      className="field-input"
                      data-order={f.order}
                      value={f.value}
                      maxLength={f.maxLen}
                      style={{ fontSize: fs }}
                      onKeyDown={onFieldTabKey}
                      onChange={(e) => onChangeField(f, e.target.value)}
                    />
                  )}
                </div>
              )
            })}
        </div>
        {editingImages && (
          <ImageLayer
            width={viewport.width}
            height={viewport.height}
            leafId={leaf.id}
            images={pageImages ?? []}
            records={imageRecords}
            toScreen={toScreen}
            toPdf={toPdf}
            selected={imageSel ?? null}
            cropMode={!!imageCrop}
            bitmaps={imageBitmaps ?? {}}
            onSelect={onImageSelect ?? (() => {})}
            onChange={onImageChange ?? (() => {})}
          />
        )}
      </div>
    </div>
  )
}

export default memo(PageView)

/**
 * One Draw-tab shape on screen. Kept deliberately close to the appearance
 * builder in pdf/annots.ts — same inset outlines, same arrow-head geometry —
 * so what is drawn here is what ends up in the file.
 */
function ShapeView({
  shape: sh,
  zoom,
  selected,
  editable,
  preview,
  toScreen,
  onPointerDown,
  onVertexDown,
  onDelete
}: {
  shape: ShapeAnnot
  zoom: number
  selected?: boolean
  /** Select tool: the shape can be dragged and its vertices pulled. */
  editable?: boolean
  /** Half-drawn: no hit area, no handles. */
  preview?: boolean
  toScreen: (p: Pt) => { x: number; y: number }
  onPointerDown?: (e: React.PointerEvent) => void
  onVertexDown?: (e: React.PointerEvent, pathIdx: number, vertexIdx: number) => void
  onDelete?: () => void
}): JSX.Element | null {
  const pts = shapePoints(sh)
  if (pts.length < 2) return null
  const sw = Math.max(0.5, sh.width * zoom)
  const dash = sh.dash ? dashPattern(sh.width).map((d) => d * zoom).join(' ') : undefined
  const fill = sh.fill || 'none'
  const fillOpacity = sh.fill ? (sh.fillAlpha ?? 1) : undefined
  const hitWidth = Math.max(12, sw + 8)

  let body: JSX.Element
  let hit: JSX.Element
  if (sh.kind === 'rect' || sh.kind === 'ellipse') {
    const p1 = toScreen(sh.pts[0])
    const p2 = toScreen(sh.pts[1])
    const left = Math.min(p1.x, p2.x)
    const top = Math.min(p1.y, p2.y)
    const w = Math.abs(p2.x - p1.x)
    const h = Math.abs(p2.y - p1.y)
    // the outline sits inside the dragged box, matching the baked appearance
    const ix = left + sw / 2
    const iy = top + sw / 2
    const iw = Math.max(0.5, w - sw)
    const ih = Math.max(0.5, h - sw)
    const common = { fill, fillOpacity, stroke: sh.color, strokeWidth: sw, strokeDasharray: dash }
    body =
      sh.kind === 'rect' ? (
        <rect x={ix} y={iy} width={iw} height={ih} {...common} style={{ pointerEvents: sh.fill ? 'fill' : 'none' }} />
      ) : (
        <ellipse
          cx={ix + iw / 2}
          cy={iy + ih / 2}
          rx={iw / 2}
          ry={ih / 2}
          {...common}
          style={{ pointerEvents: sh.fill ? 'fill' : 'none' }}
        />
      )
    hit =
      sh.kind === 'rect' ? (
        <rect x={ix} y={iy} width={iw} height={ih} fill="none" stroke="transparent" strokeWidth={hitWidth} />
      ) : (
        <ellipse cx={ix + iw / 2} cy={iy + ih / 2} rx={iw / 2} ry={ih / 2} fill="none" stroke="transparent" strokeWidth={hitWidth} />
      )
  } else {
    const d = shapePathData(sh, toScreen)
    body = (
      <path
        d={d}
        fill={sh.kind === 'polygon' ? fill : 'none'}
        fillOpacity={sh.kind === 'polygon' ? fillOpacity : undefined}
        stroke={sh.color}
        strokeWidth={sw}
        strokeDasharray={dash}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ pointerEvents: sh.kind === 'polygon' && sh.fill ? 'fill' : 'none' }}
      />
    )
    hit = <path d={d} fill="none" stroke="transparent" strokeWidth={hitWidth} strokeLinecap="round" strokeLinejoin="round" />
  }

  // arrow heads, in screen space so they scale with the zoom exactly as the
  // baked ones scale with the page
  const heads: string[] = []
  if (sh.kind === 'arrow' && sh.pts.length >= 2) {
    const s = sh.pts.map(toScreen)
    const len = arrowHeadLen(sh.width) * zoom
    const tri = (from: { x: number; y: number }, to: { x: number; y: number }): void => {
      const t = arrowHead(from, to, len)
      if (t.length === 3) heads.push(`M${t[0].x},${t[0].y} L${t[1].x},${t[1].y} L${t[2].x},${t[2].y} Z`)
    }
    if (sh.arrowEnd) tri(s[s.length - 2], s[s.length - 1])
    if (sh.arrowStart) tri(s[1], s[0])
  }

  const box = bounds(pts.map(toScreen))
  const showVertices = editable && selected && sh.kind !== 'ink' && pts.length <= 40

  return (
    <g
      data-annot={preview ? undefined : '1'}
      style={{ pointerEvents: preview ? 'none' : undefined, cursor: editable ? 'move' : undefined }}
      onPointerDown={onPointerDown}
    >
      {body}
      {heads.map((d, i) => (
        <path key={i} d={d} fill={sh.color} style={{ pointerEvents: 'none' }} />
      ))}
      {!preview && hit}
      {selected && (
        <rect
          x={box.x - 4}
          y={box.y - 4}
          width={box.w + 8}
          height={box.h + 8}
          fill="none"
          stroke="#3b82f6"
          strokeWidth={1}
          strokeDasharray="4 3"
          style={{ pointerEvents: 'none' }}
        />
      )}
      {showVertices &&
        sh.pts.map((p, i) => {
          const s = toScreen(p)
          return (
            <circle
              key={`v${i}`}
              cx={s.x}
              cy={s.y}
              r={5}
              fill="#fff"
              stroke="#3b82f6"
              strokeWidth={1.5}
              style={{ cursor: 'crosshair' }}
              onPointerDown={(e) => onVertexDown?.(e, 0, i)}
            />
          )
        })}
      {selected && editable && onDelete && (
        <g
          transform={`translate(${box.x + box.w + 10},${box.y - 10})`}
          style={{ cursor: 'pointer' }}
          onPointerDown={(e) => {
            e.stopPropagation()
            onDelete()
          }}
        >
          <circle r={8} fill="#dc2626" />
          <path d="M-3.2,-3.2 L3.2,3.2 M3.2,-3.2 L-3.2,3.2" stroke="#fff" strokeWidth={1.8} strokeLinecap="round" />
        </g>
      )}
    </g>
  )
}

function TextEditor({
  value,
  fontSize,
  color,
  fontCss,
  nowrap,
  onChange,
  onDone
}: {
  value: string
  fontSize: number
  color: string
  fontCss: { family: string; weight: number }
  /** Auto-width box: never soft-wrap, the box grows with the text instead. */
  nowrap: boolean
  onChange: (text: string) => void
  onDone: (text: string) => void
}): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) {
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }
  }, [])
  return (
    <textarea
      ref={ref}
      className="text-edit"
      value={value}
      wrap={nowrap ? 'off' : 'soft'}
      style={{
        fontSize,
        color,
        fontFamily: fontCss.family,
        fontWeight: fontCss.weight,
        whiteSpace: nowrap ? 'pre' : 'pre-wrap'
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value)}
      onBlur={(e) => onDone(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          ref.current?.blur()
        }
      }}
    />
  )
}

function PendingPreview({
  pts,
  hover,
  tool,
  toScreen,
  cal
}: {
  pts: Pt[]
  hover: Pt | null
  tool: ToolId
  toScreen: (p: Pt) => { x: number; y: number }
  cal: Calibration
}): JSX.Element {
  const all = hover ? [...pts, hover] : pts
  const scr = all.map(toScreen)
  const closed = tool === 'measure-area'
  const d = scr.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ') + (closed ? ' Z' : '')
  // live readout
  let readout = ''
  if (tool === 'measure-length') readout = formatMeasure(polylineLength(all) * cal.unitsPerPoint, cal.unit, 'length')
  else if (tool === 'measure-area' && all.length >= 3)
    readout = formatMeasure(polygonArea(all) * cal.unitsPerPoint * cal.unitsPerPoint, cal.unit, 'area')
  else if (tool === 'calibrate' && all.length >= 2)
    readout = `${dist(all[0], all[1]).toFixed(1)} pt`
  const last = scr[scr.length - 1]
  return (
    <g>
      <path d={d} fill={closed ? '#2563eb22' : 'none'} stroke="#2563eb" strokeWidth={1.5} strokeDasharray="5 3" />
      {scr.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={3} fill="#2563eb" />
      ))}
      {readout && last && (
        <g transform={`translate(${last.x + 8},${last.y - 8})`}>
          <rect x={-2} y={-11} width={readout.length * 6.4 + 6} height={15} rx={2} fill="#111" opacity={0.85} />
          <text x={1} y={0} fontSize={11} fill="#fff" fontFamily="sans-serif">
            {readout}
          </text>
        </g>
      )}
    </g>
  )
}
