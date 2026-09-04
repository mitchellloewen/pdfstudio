import type { Pt } from './types'

export const dist = (a: Pt, b: Pt): number => Math.hypot(b.x - a.x, b.y - a.y)

export function polylineLength(pts: Pt[]): number {
  let d = 0
  for (let i = 1; i < pts.length; i++) d += dist(pts[i - 1], pts[i])
  return d
}

/** Shoelace area (absolute) of a polygon in point units. */
export function polygonArea(pts: Pt[]): number {
  if (pts.length < 3) return 0
  let s = 0
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length
    s += pts[i].x * pts[j].y - pts[j].x * pts[i].y
  }
  return Math.abs(s) / 2
}

export function centroid(pts: Pt[]): Pt {
  const c = { x: 0, y: 0 }
  for (const p of pts) {
    c.x += p.x
    c.y += p.y
  }
  return { x: c.x / pts.length, y: c.y / pts.length }
}

/** Circle through three points; null if collinear. */
export function circleFrom3(a: Pt, b: Pt, c: Pt): { center: Pt; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y))
  if (Math.abs(d) < 1e-9) return null
  const ux =
    ((a.x * a.x + a.y * a.y) * (b.y - c.y) +
      (b.x * b.x + b.y * b.y) * (c.y - a.y) +
      (c.x * c.x + c.y * c.y) * (a.y - b.y)) /
    d
  const uy =
    ((a.x * a.x + a.y * a.y) * (c.x - b.x) +
      (b.x * b.x + b.y * b.y) * (a.x - c.x) +
      (c.x * c.x + c.y * c.y) * (b.x - a.x)) /
    d
  const center = { x: ux, y: uy }
  return { center, r: dist(center, a) }
}

/**
 * Arc through 3 points (start, mid, end). Returns the sampled polyline and the
 * arc length. Falls back to a straight segment if the points are collinear.
 */
export function arcThrough(a: Pt, mid: Pt, c: Pt, samples = 48): { points: Pt[]; length: number } {
  const circ = circleFrom3(a, mid, c)
  if (!circ) {
    return { points: [a, c], length: dist(a, c) }
  }
  const { center, r } = circ
  const ang = (p: Pt): number => Math.atan2(p.y - center.y, p.x - center.x)
  let a0 = ang(a)
  const am = ang(mid)
  let a1 = ang(c)
  // Choose sweep direction so the arc passes through `mid`.
  const norm = (x: number): number => {
    while (x <= -Math.PI) x += 2 * Math.PI
    while (x > Math.PI) x -= 2 * Math.PI
    return x
  }
  // total sweep from a0 to a1 going through am
  let sweep = norm(a1 - a0)
  const sweepMid = norm(am - a0)
  if (Math.sign(sweep) !== Math.sign(sweepMid) || Math.abs(sweepMid) > Math.abs(sweep)) {
    sweep = sweep > 0 ? sweep - 2 * Math.PI : sweep + 2 * Math.PI
  }
  const points: Pt[] = []
  for (let i = 0; i <= samples; i++) {
    const t = a0 + (sweep * i) / samples
    points.push({ x: center.x + r * Math.cos(t), y: center.y + r * Math.sin(t) })
  }
  return { points, length: Math.abs(sweep) * r }
}

export function formatMeasure(value: number, unit: string, kind: 'length' | 'area' | 'arc'): string {
  const v = value.toLocaleString(undefined, { maximumFractionDigits: 2 })
  if (kind === 'area') return `${v} ${unit}²`
  return `${v} ${unit}`
}
