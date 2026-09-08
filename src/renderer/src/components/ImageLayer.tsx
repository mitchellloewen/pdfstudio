/**
 * The on-screen half of embedded-image editing.
 *
 * Every image the page draws gets an outline you can pick, move, scale, rotate
 * and crop. All of the arithmetic happens in the image's *own* unit square and
 * is folded back into its placement matrix, which is why it keeps behaving
 * sensibly once the image has been rotated, flipped, or dropped on a page that
 * is itself rotated — there is no separate "is it sideways" case to get wrong.
 *
 * Nothing here writes to the document. A drag produces a new placement, the
 * app records it as an `imgedit` annotation, and the save pipeline (and the
 * viewer's own preview) rebuild the page content from that.
 */

import { memo, useCallback, useRef, useState, type JSX } from 'react'
import { applyM, boxM, fullMatrix, invM, mulM, type Matrix, type PageImage } from '../pdf/images'
import { uid, type Box, type ImageEditAnnot, type Pt } from '../pdf/types'

/** Which drawn instance of which image is selected. */
export interface ImageSel {
  drawIndex: number
  /** 0 is the image the file came with; 1, 2, … are copies of it. */
  instance: number
}

export const sameSel = (a: ImageSel | null, b: ImageSel | null): boolean =>
  !!a && !!b && a.drawIndex === b.drawIndex && a.instance === b.instance

interface Props {
  width: number
  height: number
  leafId: string
  images: PageImage[]
  records: ImageEditAnnot[]
  toScreen: (p: Pt) => { x: number; y: number }
  toPdf: (clientX: number, clientY: number) => Pt
  selected: ImageSel | null
  cropMode: boolean
  /** Decoded pixels per draw index, when available — used for the drag ghost. */
  bitmaps: Record<number, HTMLCanvasElement | null>
  onSelect: (sel: ImageSel | null) => void
  onChange: (rec: ImageEditAnnot, tag?: string) => void
}

/** One drawn instance, resolved from the page scan plus the model's edits. */
interface Instance {
  sel: ImageSel
  m: Matrix
  crop: Box
  /** The record backing it, if the user has already touched this instance. */
  rec?: ImageEditAnnot
  base: PageImage
}

const FULL: Box = { x: 0, y: 0, w: 1, h: 1 }
/** Local corners and edge midpoints, in the image's own unit square. */
const HANDLES: { u: number; v: number }[] = [
  { u: 0, v: 0 },
  { u: 0.5, v: 0 },
  { u: 1, v: 0 },
  { u: 1, v: 0.5 },
  { u: 1, v: 1 },
  { u: 0.5, v: 1 },
  { u: 0, v: 1 },
  { u: 0, v: 0.5 }
]
const HANDLE_PX = 8
const ROTATE_REACH_PX = 26
/** Smallest an image may be scaled to, as a fraction of its current size. */
const MIN_SCALE = 0.02
const MIN_CROP = 0.02

type DragKind = 'move' | 'scale' | 'rotate' | 'crop'

interface Drag {
  kind: DragKind
  sel: ImageSel
  handle: { u: number; v: number }
  startPdf: Pt
  origM: Matrix
  origCrop: Box
  /** The whole image's matrix, held still while a crop is dragged. */
  fullM: Matrix
  /** Pointer angle at the start of a rotate, in radians. */
  startAngle: number
  centre: Pt
}

/** Translate a placement by a page-space offset. */
function translated(m: Matrix, dx: number, dy: number): Matrix {
  return mulM(m, [1, 0, 0, 1, dx, dy])
}

/** Rotate a placement about a page-space point. */
function rotated(m: Matrix, centre: Pt, rad: number): Matrix {
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const about = mulM(mulM([1, 0, 0, 1, -centre.x, -centre.y], [cos, sin, -sin, cos, 0, 0]), [1, 0, 0, 1, centre.x, centre.y])
  return mulM(m, about)
}

/** Scale a placement in its own axes, holding the handle's opposite side still. */
function scaledInPlace(m: Matrix, handle: { u: number; v: number }, local: Pt, keepAspect: boolean): Matrix {
  // u = 1 grows to the right of a fixed left edge; u = 0 the other way round;
  // 0.5 leaves that axis alone
  let sx = 1
  let ax = 0
  if (handle.u === 1) {
    sx = local.x
    ax = 0
  } else if (handle.u === 0) {
    sx = 1 - local.x
    ax = 1
  }
  let sy = 1
  let ay = 0
  if (handle.v === 1) {
    sy = local.y
    ay = 0
  } else if (handle.v === 0) {
    sy = 1 - local.y
    ay = 1
  }
  if (keepAspect && handle.u !== 0.5 && handle.v !== 0.5) {
    const s = (sx + sy) / 2
    sx = s
    sy = s
  }
  sx = Math.abs(sx) < MIN_SCALE ? MIN_SCALE * Math.sign(sx || 1) : sx
  sy = Math.abs(sy) < MIN_SCALE ? MIN_SCALE * Math.sign(sy || 1) : sy
  return mulM([sx, 0, 0, sy, ax * (1 - sx), ay * (1 - sy)], m)
}

/** Move one edge or corner of the crop box, in image space. */
function croppedTo(crop: Box, handle: { u: number; v: number }, local: Pt): Box {
  let { x, y, w, h } = crop
  if (handle.u === 0) {
    const nx = Math.min(Math.max(0, local.x), x + w - MIN_CROP)
    w += x - nx
    x = nx
  } else if (handle.u === 1) {
    w = Math.min(Math.max(MIN_CROP, local.x - x), 1 - x)
  }
  if (handle.v === 0) {
    const ny = Math.min(Math.max(0, local.y), y + h - MIN_CROP)
    h += y - ny
    y = ny
  } else if (handle.v === 1) {
    h = Math.min(Math.max(MIN_CROP, local.y - y), 1 - y)
  }
  return { x, y, w, h }
}

function ImageLayer(props: Props): JSX.Element {
  const { width, height, leafId, images, records, toScreen, toPdf, selected, cropMode, bitmaps, onSelect, onChange } = props
  const dragRef = useRef<Drag | null>(null)
  const [live, setLive] = useState<{ sel: ImageSel; m: Matrix; crop: Box } | null>(null)
  const [hover, setHover] = useState<ImageSel | null>(null)

  const instances: Instance[] = []
  for (const img of images) {
    const rec0 = records.find((r) => r.drawIndex === img.index && r.instance === 0)
    if (!rec0?.deleted) {
      instances.push({
        sel: { drawIndex: img.index, instance: 0 },
        m: rec0?.m ?? img.ctm,
        crop: rec0?.crop ?? FULL,
        rec: rec0,
        base: img
      })
    }
    for (const rec of records) {
      if (rec.drawIndex !== img.index || rec.instance === 0) continue
      instances.push({
        sel: { drawIndex: img.index, instance: rec.instance },
        m: rec.m,
        crop: rec.crop ?? FULL,
        rec,
        base: img
      })
    }
  }

  /** Screen positions of a placement's four corners, in unit-square order. */
  const quad = useCallback(
    (m: Matrix): { x: number; y: number }[] =>
      [
        { u: 0, v: 0 },
        { u: 1, v: 0 },
        { u: 1, v: 1 },
        { u: 0, v: 1 }
      ].map(({ u, v }) => toScreen(applyM(m, u, v))),
    [toScreen]
  )

  const centreOf = (m: Matrix): Pt => applyM(m, 0.5, 0.5)

  /** The instance as it stands right now, drag included. */
  const shown = (inst: Instance): { m: Matrix; crop: Box } =>
    live && sameSel(live.sel, inst.sel) ? { m: live.m, crop: live.crop } : { m: inst.m, crop: inst.crop }

  const recordFor = (inst: Instance, m: Matrix, crop: Box): ImageEditAnnot => ({
    ...(inst.rec ?? {
      id: uid(),
      leafId,
      type: 'imgedit' as const,
      drawIndex: inst.sel.drawIndex,
      instance: inst.sel.instance
    }),
    type: 'imgedit',
    leafId,
    drawIndex: inst.sel.drawIndex,
    instance: inst.sel.instance,
    m,
    crop: crop.x === 0 && crop.y === 0 && crop.w === 1 && crop.h === 1 ? undefined : crop
  })

  /** Where a drag has got to, computed from the drag state and this event. */
  const draggedTo = (drag: Drag, pt: Pt, shift: boolean): { m: Matrix; crop: Box } => {
    if (drag.kind === 'move') {
      return { m: translated(drag.origM, pt.x - drag.startPdf.x, pt.y - drag.startPdf.y), crop: drag.origCrop }
    }
    if (drag.kind === 'rotate') {
      let angle = Math.atan2(pt.y - drag.centre.y, pt.x - drag.centre.x) - drag.startAngle
      if (shift) angle = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12)
      return { m: rotated(drag.origM, drag.centre, angle), crop: drag.origCrop }
    }
    if (drag.kind === 'crop') {
      const inv = invM(drag.fullM)
      if (!inv) return { m: drag.origM, crop: drag.origCrop }
      const local = applyM(inv, pt.x, pt.y)
      const crop = croppedTo(drag.origCrop, drag.handle, local)
      return { m: mulM(boxM(crop), drag.fullM), crop }
    }
    const inv = invM(drag.origM)
    if (!inv) return { m: drag.origM, crop: drag.origCrop }
    const local = applyM(inv, pt.x, pt.y)
    // corners hold the aspect ratio unless Shift says otherwise; edge handles
    // only ever move one axis, so the flag means nothing to them
    return { m: scaledInPlace(drag.origM, drag.handle, local, !shift), crop: drag.origCrop }
  }

  const begin = (e: React.PointerEvent, inst: Instance, kind: DragKind, handle: { u: number; v: number }): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    try {
      // capture keeps the drag alive past the edge of the handle; a pointer the
      // browser no longer considers active makes this throw, which must not
      // stop the drag from starting
      ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    } catch {
      /* no capture — the svg's own move/up handlers still see the drag */
    }
    const cur = shown(inst)
    const start = toPdf(e.clientX, e.clientY)
    const centre = centreOf(cur.m)
    dragRef.current = {
      kind,
      sel: inst.sel,
      handle,
      startPdf: start,
      origM: cur.m,
      origCrop: cur.crop,
      fullM: fullMatrix(cur.m, cur.crop),
      startAngle: Math.atan2(start.y - centre.y, start.x - centre.x),
      centre
    }
    onSelect(inst.sel)
  }

  const onMove = (e: React.PointerEvent): void => {
    const drag = dragRef.current
    if (!drag) return
    const next = draggedTo(drag, toPdf(e.clientX, e.clientY), e.shiftKey)
    setLive({ sel: drag.sel, ...next })
  }

  /**
   * Finish from the drag state and this event's own coordinates — never from
   * the `live` state a pointermove set, which on a quick click has not
   * committed yet.
   */
  const onUp = (e: React.PointerEvent): void => {
    const drag = dragRef.current
    dragRef.current = null
    setLive(null)
    if (!drag) return
    const inst = instances.find((i) => sameSel(i.sel, drag.sel))
    if (!inst) return
    const next = draggedTo(drag, toPdf(e.clientX, e.clientY), e.shiftKey)
    const moved = next.m.some((v, i) => Math.abs(v - drag.origM[i]) > 1e-6)
    const cropped = (['x', 'y', 'w', 'h'] as const).some((k) => Math.abs(next.crop[k] - drag.origCrop[k]) > 1e-6)
    if (!moved && !cropped) return
    onChange(recordFor(inst, next.m, next.crop), `img:${drag.sel.drawIndex}:${drag.sel.instance}:${drag.kind}`)
  }

  const cursorFor = (m: Matrix, h: { u: number; v: number }): string => {
    if (h.u === 0.5) return 'ns-resize'
    if (h.v === 0.5) return 'ew-resize'
    const c = toScreen(centreOf(m))
    const p = toScreen(applyM(m, h.u, h.v))
    return (p.x - c.x) * (p.y - c.y) > 0 ? 'nesw-resize' : 'nwse-resize'
  }

  return (
    <svg
      className="img-layer"
      width={width}
      height={height}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onPointerDown={(e) => {
        // a click on bare page clears the selection
        if (e.button === 0 && e.target === e.currentTarget) onSelect(null)
      }}
    >
      {instances.map((inst) => {
        const { m, crop } = shown(inst)
        const isSel = sameSel(selected, inst.sel)
        const isHover = sameSel(hover, inst.sel)
        const pts = quad(m)
        const poly = pts.map((p) => `${p.x},${p.y}`).join(' ')
        const bitmap = bitmaps[inst.sel.drawIndex]
        const dragging = !!live && sameSel(live.sel, inst.sel)
        const showFull = isSel && cropMode

        // in crop mode the whole image is shown, dimmed outside the crop
        const fm = fullMatrix(m, crop)
        const fullPts = quad(fm)
        const key = `${inst.sel.drawIndex}:${inst.sel.instance}`

        return (
          <g key={key}>
            {(showFull || dragging) && bitmap && (
              <ImageGhost
                canvas={bitmap}
                matrix={fm}
                toScreen={toScreen}
                opacity={showFull ? 0.35 : 0.6}
                clipId={showFull ? `imgclip-${key}` : undefined}
                clipPoly={poly}
              />
            )}
            {showFull && (
              <polygon points={fullPts.map((p) => `${p.x},${p.y}`).join(' ')} className="img-full-outline" />
            )}
            <polygon
              points={poly}
              className={`img-outline${isSel ? ' sel' : ''}${isHover && !isSel ? ' hover' : ''}`}
              onPointerEnter={() => setHover(inst.sel)}
              onPointerLeave={() => setHover((h) => (sameSel(h, inst.sel) ? null : h))}
              onPointerDown={(e) => begin(e, inst, 'move', { u: 0.5, v: 0.5 })}
            />
            {isSel && (
              <>
                {!cropMode && (
                  <RotateHandle
                    m={m}
                    toScreen={toScreen}
                    onDown={(e) => begin(e, inst, 'rotate', { u: 0.5, v: 1 })}
                  />
                )}
                {HANDLES.map((h) => {
                  // crop handles ride the crop box within the whole image
                  const at = cropMode
                    ? toScreen(applyM(fm, crop.x + crop.w * h.u, crop.y + crop.h * h.v))
                    : toScreen(applyM(m, h.u, h.v))
                  return (
                    <rect
                      key={`${h.u},${h.v}`}
                      className={`img-handle${cropMode ? ' crop' : ''}`}
                      x={at.x - HANDLE_PX / 2}
                      y={at.y - HANDLE_PX / 2}
                      width={HANDLE_PX}
                      height={HANDLE_PX}
                      style={{ cursor: cursorFor(m, h) }}
                      onPointerDown={(e) => begin(e, inst, cropMode ? 'crop' : 'scale', h)}
                    />
                  )
                })}
              </>
            )}
          </g>
        )
      })}
    </svg>
  )
}

/** Encoding a canvas is slow, and a drag re-renders on every pointer move. */
const hrefCache = new WeakMap<HTMLCanvasElement, string>()
function canvasHref(canvas: HTMLCanvasElement): string {
  let href = hrefCache.get(canvas)
  if (!href) {
    href = canvas.toDataURL('image/png')
    hrefCache.set(canvas, href)
  }
  return href
}

/** The image itself, drawn under a drag or a crop as a translucent guide. */
function ImageGhost({
  canvas,
  matrix,
  toScreen,
  opacity,
  clipId,
  clipPoly
}: {
  canvas: HTMLCanvasElement
  matrix: Matrix
  toScreen: (p: Pt) => { x: number; y: number }
  opacity: number
  clipId?: string
  clipPoly?: string
}): JSX.Element | null {
  // an <image> has its origin at the top-left with y running down, which is
  // (0,1) of the PDF unit square
  const o = toScreen(applyM(matrix, 0, 1))
  const ax = toScreen(applyM(matrix, 1, 1))
  const ay = toScreen(applyM(matrix, 0, 0))
  const href = canvasHref(canvas)
  const t = `matrix(${ax.x - o.x},${ax.y - o.y},${ay.x - o.x},${ay.y - o.y},${o.x},${o.y})`
  return (
    <>
      {clipId && clipPoly && (
        <clipPath id={clipId}>
          <polygon points={clipPoly} />
        </clipPath>
      )}
      <image href={href} x={0} y={0} width={1} height={1} transform={t} opacity={opacity} preserveAspectRatio="none" />
      {clipId && clipPoly && (
        <image
          href={href}
          x={0}
          y={0}
          width={1}
          height={1}
          transform={t}
          clipPath={`url(#${clipId})`}
          preserveAspectRatio="none"
        />
      )}
    </>
  )
}

function RotateHandle({
  m,
  toScreen,
  onDown
}: {
  m: Matrix
  toScreen: (p: Pt) => { x: number; y: number }
  onDown: (e: React.PointerEvent) => void
}): JSX.Element {
  const top = toScreen(applyM(m, 0.5, 1))
  const bottom = toScreen(applyM(m, 0.5, 0))
  const dx = top.x - bottom.x
  const dy = top.y - bottom.y
  const len = Math.hypot(dx, dy) || 1
  const at = { x: top.x + (dx / len) * ROTATE_REACH_PX, y: top.y + (dy / len) * ROTATE_REACH_PX }
  return (
    <>
      <line x1={top.x} y1={top.y} x2={at.x} y2={at.y} className="img-rot-stem" />
      <circle cx={at.x} cy={at.y} r={5.5} className="img-rot-handle" onPointerDown={onDown} />
    </>
  )
}

export default memo(ImageLayer)
