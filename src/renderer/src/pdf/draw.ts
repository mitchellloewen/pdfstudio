/**
 * Geometry for the Draw tab's shapes, shared by the on-screen overlay
 * (components/PageView) and the save path (pdf/annots), so a drawing bakes
 * exactly as it looked. Everything here works on plain points and is unit
 * agnostic: the viewer feeds it screen pixels, the writer feeds it points.
 */
import type { Box, Pt, ShapeAnnot, ShapeKind, ToolId } from './types'

/** Draw tools, in ribbon order, and the shape each one produces. */
export const DRAW_TOOL_KIND: Record<string, ShapeKind> = {
  'draw-line': 'line',
  'draw-arrow': 'arrow',
  'draw-rect': 'rect',
  'draw-ellipse': 'ellipse',
  'draw-polyline': 'polyline',
  'draw-polygon': 'polygon',
  'draw-free': 'ink'
}

export const isDrawTool = (t: ToolId): boolean => t in DRAW_TOOL_KIND

/** Tools built click-by-click (double-click finishes), rather than by dragging. */
export const POLY_DRAW_TOOLS: ToolId[] = ['draw-polyline', 'draw-polygon']

/** Shapes whose outline closes back on itself — the ones a fill applies to. */
export const CLOSED_KINDS: ShapeKind[] = ['rect', 'ellipse', 'polygon']

/** The point lists that make up a shape (one per stroke for freehand ink). */
export function shapePaths(an: ShapeAnnot): Pt[][] {
  if (an.kind === 'ink') return (an.strokes || []).filter((s) => s.length > 0)
  return an.pts.length ? [an.pts] : []
}

/** Every point that defines the shape — bounding boxes and hit tests use these. */
export function shapePoints(an: ShapeAnnot): Pt[] {
  return shapePaths(an).flat()
}

export function bounds(pts: Pt[]): Box {
  if (!pts.length) return { x: 0, y: 0, w: 0, h: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** How long an arrow head is for a given stroke thickness. */
export const arrowHeadLen = (width: number): number => Math.max(7, width * 4)

/**
 * How far the drawn ink strays outside the bare geometry: half the stroke sits
 * either side of the path, and an arrow head reaches out past its end point.
 * The appearance box is padded by this so nothing is clipped.
 */
export function shapePad(an: Pick<ShapeAnnot, 'kind' | 'width' | 'arrowStart' | 'arrowEnd'>): number {
  const head = an.kind === 'arrow' && (an.arrowStart || an.arrowEnd) ? arrowHeadLen(an.width) * 0.6 : 0
  return an.width / 2 + head + 0.5
}

/**
 * Triangle for an arrow head sitting at `to`, pointing away from `from`.
 * Returned tip-first, so the caller can move-to the tip and close the path.
 */
export function arrowHead(from: Pt, to: Pt, len: number): Pt[] {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const d = Math.hypot(dx, dy)
  if (d < 1e-6) return []
  const ux = dx / d
  const uy = dy / d
  // don't let the head swallow a very short line
  const l = Math.min(len, d * 0.9)
  const hw = l * 0.42
  const bx = to.x - ux * l
  const by = to.y - uy * l
  return [to, { x: bx - uy * hw, y: by + ux * hw }, { x: bx + uy * hw, y: by - ux * hw }]
}

/** Dash pattern (on, off) for a dashed stroke of this thickness. */
export const dashPattern = (width: number): [number, number] => [Math.max(3, width * 3), Math.max(2, width * 2)]

/** Move every point of a shape by (dx, dy). */
export function translateShape(an: ShapeAnnot, dx: number, dy: number): ShapeAnnot {
  const move = (p: Pt): Pt => ({ x: p.x + dx, y: p.y + dy })
  return {
    ...an,
    pts: an.pts.map(move),
    strokes: an.strokes?.map((s) => s.map(move))
  }
}

/**
 * Screen-space SVG path data for a shape. `to` projects a document point to
 * screen; rect and ellipse are handled by the caller (they are drawn as their
 * own SVG elements) — everything else is a polyline.
 */
export function shapePathData(an: ShapeAnnot, to: (p: Pt) => { x: number; y: number }): string {
  const paths = an.kind === 'rect' ? [rectCorners(an.pts)] : shapePaths(an)
  return paths
    .map((path) => {
      const d = path.map((p, i) => `${i === 0 ? 'M' : 'L'}${round(to(p).x)},${round(to(p).y)}`).join(' ')
      return an.kind === 'polygon' || an.kind === 'rect' ? `${d} Z` : d
    })
    .join(' ')
}

const round = (n: number): number => Math.round(n * 100) / 100

/** The four corners of a rectangle given two opposite ones. */
export function rectCorners(pts: Pt[]): Pt[] {
  if (pts.length < 2) return pts
  const b = bounds(pts)
  return [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x, y: b.y + b.h }
  ]
}

/**
 * Constrain a drag for the Shift key: lines snap to 15° steps, boxes and
 * ellipses become squares and circles.
 */
export function constrain(kind: ShapeKind, a: Pt, b: Pt): Pt {
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (kind === 'rect' || kind === 'ellipse') {
    const s = Math.max(Math.abs(dx), Math.abs(dy))
    return { x: a.x + Math.sign(dx || 1) * s, y: a.y + Math.sign(dy || 1) * s }
  }
  const step = Math.PI / 12 // 15°
  const ang = Math.round(Math.atan2(dy, dx) / step) * step
  const d = Math.hypot(dx, dy)
  return { x: a.x + Math.cos(ang) * d, y: a.y + Math.sin(ang) * d }
}
