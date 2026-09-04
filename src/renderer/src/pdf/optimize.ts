/**
 * Content-stream optimiser — makes CAD-plotted PDFs render fast.
 *
 * Plan sheets exported from AutoCAD / Civil 3D / a plotter driver are slow for
 * reasons that have nothing to do with file size. Three pathologies show up
 * over and over, and this module undoes all three:
 *
 *  1. **Over-sampled polylines.** A dead-straight property line is emitted as
 *     hundreds of `l` segments 0.7 units apart, all exactly collinear. One
 *     sheet can carry 8 million line segments — 156 MB of decompressed content
 *     stream — of which ~93% sit exactly on the segment either side of them.
 *
 *  2. **Per-primitive graphics-state wrappers.** Hatching and contour ticks
 *     come out as `q <scale> cm q <translate> cm 0 0 m dx dy l S Q Q`, once per
 *     tick. On one sheet that is 325,000 repetitions — 15 MB of the 23 MB
 *     stream is the wrapper text alone, and it costs the renderer 650,000
 *     save/restore pairs and 650,000 matrix concatenations.
 *
 *  3. **One stroke call per hair.** Those 325,000 wrappers also mean 325,000
 *     separate stroke operations, where a single path carrying 325,000
 *     subpaths would paint identically. In a canvas-backed renderer like
 *     pdf.js that difference is most of the render time.
 *
 * Shrinking images — what the online "compress PDF" services do — does nothing
 * for these files. On the sample sheet that provoked this module the entire
 * image payload was 0.56 MB out of 12 MB.
 *
 * Everything the optimiser doesn't positively recognise is copied through
 * untouched, including inline images, text runs and shading dictionaries.
 */

/** Max perpendicular deviation, in page points, allowed when dropping a point.
 *  0.05 pt is 1/1440 inch — about 1/10 of a pixel at 150 dpi, and still under
 *  half a pixel at 600 dpi print resolution. */
export const DEFAULT_TOLERANCE_PT = 0.05

/** Cap on subpaths merged into one stroke, so we never hand the renderer a
 *  single pathological path object. */
const MAX_MERGED_SUBPATHS = 20000

/** Cap on tokens buffered while testing a `q … Q` block for flattening. Bigger
 *  blocks are not the micro-primitive pattern this targets, and buffering them
 *  would cost more memory than the flattening saves. */
const MAX_BLOCK_TOKENS = 4096

export interface OptimizeStats {
  /** Line segments (`l` operators) before and after. */
  segmentsBefore: number
  segmentsAfter: number
  /** `q`/`Q` pairs removed by flattening micro-primitive wrappers. */
  wrappersFlattened: number
  /** Separate stroke operations folded into a shared path. */
  strokesMerged: number
  /** Zero-length butt-capped strokes dropped (they paint nothing). */
  degenerateDropped: number
  bytesBefore: number
  bytesAfter: number
}

const isWhite = (c: number): boolean =>
  c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00
const isDelim = (c: number): boolean =>
  c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d ||
  c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25

const PATH_OPS = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're'])
/** Path-painting operators. `n` ends a path without painting. */
const PAINT_OPS = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n'])
/** Painting operators that stroke — these are the mergeable ones. */
const STROKE_ONLY = new Set(['S', 's'])

type Mat = [number, number, number, number, number, number]
const IDENT: Mat = [1, 0, 0, 1, 0, 0]

/** m × ctm, in PDF order (the new matrix applies first). */
function matMul(m: Mat, c: Mat): Mat {
  return [
    m[0] * c[0] + m[1] * c[2],
    m[0] * c[1] + m[1] * c[3],
    m[2] * c[0] + m[3] * c[2],
    m[2] * c[1] + m[3] * c[3],
    m[4] * c[0] + m[5] * c[2] + c[4],
    m[4] * c[1] + m[5] * c[3] + c[5]
  ]
}
const matScale = (m: Mat): number => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))

/**
 * True when the matrix is a similarity — uniform scale, rotation, translation,
 * no shear. Stroke width transforms predictably only under a similarity; under
 * a general matrix the pen becomes an ellipse and the block can't be flattened.
 */
function isSimilarity(m: Mat): boolean {
  const s2 = Math.abs(m[0] * m[3] - m[1] * m[2])
  if (!(s2 > 1e-12)) return false
  const eps = s2 * 1e-6
  return Math.abs(m[0] * m[0] + m[1] * m[1] - (m[2] * m[2] + m[3] * m[3])) < eps &&
    Math.abs(m[0] * m[2] + m[1] * m[3]) < eps
}

/**
 * Simplify one polyline run, returning the indices of the points to keep.
 *
 * Uses a sleeve/wedge fit (Zhao-Saalfeld): walk forward from the anchor
 * maintaining the angular window in which a single straight segment can still
 * pass within tolerance of every point seen so far. When the window closes, the
 * last point that fitted becomes the new anchor. O(n), single pass.
 *
 * Two extra guards keep it honest on CAD linework:
 *  - the window is fitted at tol/2, because the segment actually emitted is
 *    anchor->last rather than the best-fit ray, which can double the deviation;
 *  - distance from the anchor may not *decrease* by more than tol, so a
 *    polyline that runs out and doubles back can never collapse into the short
 *    leg.
 */
function simplifyRun(xs: number[], ys: number[], tol: number): number[] {
  const n = xs.length
  if (n <= 2) return n === 2 ? [0, 1] : [0]
  const half = tol / 2
  const keep: number[] = [0]
  let anchor = 0
  while (anchor < n - 1) {
    let lo = -Infinity
    let hi = Infinity
    let ref = NaN
    let dmax = 0
    let best = anchor + 1
    for (let j = anchor + 1; j < n; j++) {
      const dx = xs[j] - xs[anchor]
      const dy = ys[j] - ys[anchor]
      const d = Math.hypot(dx, dy)
      // Never collapse an excursion: the run has to keep moving away.
      if (d < dmax - tol) break
      if (d > dmax) dmax = d
      if (d <= half) {
        // Inside the tolerance disc around the anchor — any direction works.
        best = j
        continue
      }
      let th = Math.atan2(dy, dx)
      if (Number.isNaN(ref)) ref = th
      // Unwrap into [ref-pi, ref+pi] so the window arithmetic stays linear.
      while (th - ref > Math.PI) th -= 2 * Math.PI
      while (th - ref < -Math.PI) th += 2 * Math.PI
      const a = Math.asin(Math.min(1, half / d))
      const nlo = th - a
      const nhi = th + a
      if (nlo > hi || nhi < lo) break
      if (nlo > lo) lo = nlo
      if (nhi < hi) hi = nhi
      best = j
    }
    // The emitted segment's own direction must lie in the window, or the
    // deviation bound doesn't hold for it.
    while (best > anchor + 1) {
      const dx = xs[best] - xs[anchor]
      const dy = ys[best] - ys[anchor]
      const d = Math.hypot(dx, dy)
      if (d <= half) break
      let th = Math.atan2(dy, dx)
      while (th - ref > Math.PI) th -= 2 * Math.PI
      while (th - ref < -Math.PI) th += 2 * Math.PI
      if (th >= lo - 1e-12 && th <= hi + 1e-12) break
      best--
    }
    keep.push(best)
    anchor = best
  }
  return keep
}

/** Format a number back into a content stream as compactly as possible. */
function fmt(v: number, dp: number): string {
  if (!Number.isFinite(v)) return '0'
  let s = v.toFixed(dp)
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '')
  if (s === '-0' || s === '') s = '0'
  return s
}

interface Token {
  op: string
  args: string[]
}

/** One path-construction step, in whatever space it was written. */
interface Seg {
  op: string
  n: number[]
}

export interface OptimizeOptions {
  /** Max perpendicular deviation, in page points, when dropping polyline points. */
  tolerancePt?: number
  /** Flatten per-primitive `q … Q` wrappers into the parent space. */
  flatten?: boolean
  /** Coalesce consecutive stroked paths into a shared path with one `S`. */
  mergeStrokes?: boolean
  /** Transform already in force around this stream — a Form XObject's /Matrix
   *  and the CTM it is drawn under. Only its scale matters, and only for
   *  converting the page-space tolerance into stream units. */
  initialCtm?: [number, number, number, number, number, number]
}

/**
 * Rewrite one content stream: drop redundant polyline points, flatten
 * per-primitive `q … Q` wrappers, and merge consecutive strokes.
 *
 * `tolerancePt` is in page points and is divided by the live CTM scale before
 * use, so a path drawn under `0.18 0 0 0.18 0 0 cm` is simplified in its own
 * units to the same visual precision as an unscaled one.
 */
export function optimizeContentStream(
  src: Uint8Array,
  opts: OptimizeOptions = {}
): { out: Uint8Array; stats: OptimizeStats } {
  const tolerancePt = opts.tolerancePt ?? DEFAULT_TOLERANCE_PT
  const doFlatten = opts.flatten ?? true
  const doMerge = opts.mergeStrokes ?? true
  const N = src.length
  const dec = new TextDecoder('latin1')

  // --- output accumulation -------------------------------------------------
  // Tokens are pushed here and periodically packed into `chunks`, so a 156 MB
  // stream doesn't hold 30 million live strings at once.
  const chunks: string[] = []
  let lineLen = 0
  const packed: string[] = []
  const emit = (t: string): void => {
    if (lineLen > 0 && lineLen + t.length + 1 > 240) {
      packed.push('\n')
      lineLen = 0
    } else if (lineLen > 0) {
      packed.push(' ')
      lineLen += 1
    }
    packed.push(t)
    lineLen += t.length
    if (packed.length > 1 << 16) {
      chunks.push(packed.join(''))
      packed.length = 0
    }
  }

  const stats: OptimizeStats = {
    segmentsBefore: 0,
    segmentsAfter: 0,
    wrappersFlattened: 0,
    strokesMerged: 0,
    degenerateDropped: 0,
    bytesBefore: N,
    bytesAfter: 0
  }

  // --- graphics state we must track ---------------------------------------
  let ctm: Mat = opts.initialCtm ? ([...opts.initialCtm] as Mat) : IDENT
  const ctmStack: Mat[] = []
  let lineWidth = 1
  const widthStack: number[] = []
  let lineCap = 0
  const capStack: number[] = []
  let dashOn = false
  const dashStack: boolean[] = []

  // --- pending stroke merge ------------------------------------------------
  // Consecutive stroked paths drawn under identical graphics state paint the
  // same as one path with the same subpaths, so we hold them here and emit a
  // single `S`.
  let mergeBuf: string[] = []
  let mergeCount = 0
  const flushMerge = (): void => {
    if (!mergeCount) return
    for (const t of mergeBuf) emit(t)
    emit('S')
    if (mergeCount > 1) stats.strokesMerged += mergeCount - 1
    mergeBuf = []
    mergeCount = 0
  }

  /** Decimal places that resolve `tol` in the space coordinates are written in. */
  // Round to a fifth of the tolerance: the extra half-quantum of error is
  // negligible next to the simplification budget, and every decimal place
  // dropped is bytes off the file across millions of coordinates.
  const dpFor = (tol: number): number => Math.max(0, Math.min(6, Math.ceil(-Math.log10(tol / 5))))

  /**
   * Simplify a buffered path and render it to tokens in the space defined by
   * `xf` (null = leave coordinates as written).
   *
   * Returns the tokens plus whether every subpath was zero-length, which lets
   * the caller drop butt-capped hairline no-ops entirely.
   */
  function renderPath(path: Seg[], xf: Mat | null, tol: number): { toks: string[]; empty: boolean } {
    const dp = dpFor(tol)
    const toks: string[] = []
    const tx = xf ? (x: number, y: number): [number, number] => [
      xf[0] * x + xf[2] * y + xf[4],
      xf[1] * x + xf[3] * y + xf[5]
    ] : (x: number, y: number): [number, number] => [x, y]

    let curX = 0
    let curY = 0
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const note = (x: number, y: number): void => {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }

    let i = 0
    while (i < path.length) {
      const s = path[i]
      if (s.op === 'l') {
        const xs = [curX]
        const ys = [curY]
        let j = i
        while (j < path.length && path[j].op === 'l') {
          xs.push(path[j].n[0])
          ys.push(path[j].n[1])
          j++
        }
        stats.segmentsBefore += xs.length - 1
        const keep = simplifyRun(xs, ys, tol)
        for (let k = 1; k < keep.length; k++) {
          const [px, py] = tx(xs[keep[k]], ys[keep[k]])
          note(px, py)
          toks.push(fmt(px, dp), fmt(py, dp), 'l')
        }
        stats.segmentsAfter += keep.length - 1
        curX = xs[xs.length - 1]
        curY = ys[ys.length - 1]
        i = j
        continue
      }
      if (s.op === 're' && xf) {
        // A rectangle is only axis-aligned in its own space; once transformed
        // it may be a parallelogram, so expand it into an explicit subpath.
        const [x, y, w, h] = s.n
        const corners: [number, number][] = [
          tx(x, y),
          tx(x + w, y),
          tx(x + w, y + h),
          tx(x, y + h)
        ]
        toks.push(fmt(corners[0][0], dp), fmt(corners[0][1], dp), 'm')
        for (let k = 1; k < 4; k++) toks.push(fmt(corners[k][0], dp), fmt(corners[k][1], dp), 'l')
        toks.push('h')
        for (const c of corners) note(c[0], c[1])
        curX = x
        curY = y
        i++
        continue
      }
      // m / c / v / y / h / re (untransformed)
      const nums = s.n
      for (let k = 0; k + 1 < nums.length; k += 2) {
        const [px, py] = tx(nums[k], nums[k + 1])
        note(px, py)
        toks.push(fmt(px, dp), fmt(py, dp))
      }
      if (nums.length % 2 === 1) toks.push(fmt(nums[nums.length - 1], dp))
      toks.push(s.op)
      switch (s.op) {
        case 'm':
          curX = nums[0]
          curY = nums[1]
          break
        case 'c':
          curX = nums[4]
          curY = nums[5]
          break
        case 'v':
        case 'y':
          curX = nums[2]
          curY = nums[3]
          break
        case 're':
          curX = nums[0]
          curY = nums[1]
          break
      }
      i++
    }
    const empty = !(maxX - minX > 1e-9 || maxY - minY > 1e-9)
    return { toks, empty }
  }

  // --- tokeniser -----------------------------------------------------------
  // Pull-based, one Token per operator. Inline images come back verbatim as a
  // pseudo-token whose `op` is '' and whose single arg is the raw text.
  //
  // This *must* stay streaming. Materialising the whole token list first costs
  // about 3 GB of heap on a single 150 MB plan sheet — roughly 8 million token
  // objects, each with its own operand array — which is over the renderer's
  // limit and takes the window down with it. Only the bounded lookahead below
  // is ever held in memory.
  let pending: string[] = []
  let p = 0

  /** Scan the next operator. Returns null at end of stream. */
  function nextToken(): Token | null {
    for (;;) {
      if (p >= N) {
        if (pending.length) {
          const t: Token = { op: '', args: [pending.join(' ')] }
          pending = []
          return t
        }
        return null
      }
      const c = src[p]
      if (isWhite(c)) {
        p++
        continue
      }
    if (c === 0x25) {
      while (p < N && src[p] !== 0x0a && src[p] !== 0x0d) p++
      continue
    }
    if (c === 0x28) {
      const start = p
      let depth = 0
      while (p < N) {
        const ch = src[p]
        if (ch === 0x5c) {
          p += 2
          continue
        }
        if (ch === 0x28) depth++
        else if (ch === 0x29) {
          depth--
          if (depth === 0) {
            p++
            break
          }
        }
        p++
      }
      pending.push(dec.decode(src.subarray(start, p)))
      continue
    }
    if (c === 0x3c) {
      const start = p
      if (src[p + 1] === 0x3c) {
        let depth = 0
        while (p < N) {
          if (src[p] === 0x3c && src[p + 1] === 0x3c) {
            depth++
            p += 2
            continue
          }
          if (src[p] === 0x3e && src[p + 1] === 0x3e) {
            depth--
            p += 2
            if (depth === 0) break
            continue
          }
          p++
        }
      } else {
        while (p < N && src[p] !== 0x3e) p++
        p++
      }
      pending.push(dec.decode(src.subarray(start, p)))
      continue
    }
    if (c === 0x5b) {
      const start = p
      let depth = 0
      while (p < N) {
        const ch = src[p]
        if (ch === 0x28) {
          let d2 = 0
          while (p < N) {
            const s2 = src[p]
            if (s2 === 0x5c) {
              p += 2
              continue
            }
            if (s2 === 0x28) d2++
            else if (s2 === 0x29) {
              d2--
              if (d2 === 0) {
                p++
                break
              }
            }
            p++
          }
          continue
        }
        if (ch === 0x5b) depth++
        else if (ch === 0x5d) {
          depth--
          if (depth === 0) {
            p++
            break
          }
        }
        p++
      }
      pending.push(dec.decode(src.subarray(start, p)))
      continue
    }
    const start = p
    if (c === 0x2f) p++
    while (p < N && !isWhite(src[p]) && !isDelim(src[p])) p++
    if (p === start) p++
    const tok = dec.decode(src.subarray(start, p))
    if (tok.charCodeAt(0) === 0x2f || /^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) {
      pending.push(tok)
      continue
    }
    if (tok === 'BI') {
      // Copy BI … ID <binary> EI through untouched.
      let q = p
      while (
        q < N - 1 &&
        !(src[q] === 0x49 && src[q + 1] === 0x44 && (q === 0 || isWhite(src[q - 1]) || isDelim(src[q - 1])))
      )
        q++
      q += 2
      if (q < N && isWhite(src[q])) q++
      while (q < N - 1) {
        if (
          src[q] === 0x45 &&
          src[q + 1] === 0x49 &&
          isWhite(src[q - 1]) &&
          (q + 2 >= N || isWhite(src[q + 2]) || isDelim(src[q + 2]))
        ) {
          q += 2
          break
        }
        q++
      }
      const raw = dec.decode(src.subarray(start, Math.min(q, N)))
      p = Math.min(q, N)
      pending = []
      return { op: '', args: [raw] }
    }
      const args = pending
      pending = []
      return { op: tok, args }
    }
  }

  // Bounded lookahead over the token stream. Only ever holds the tokens of the
  // `q … Q` block currently being tested for flattening, so memory stays flat
  // no matter how large the content stream is.
  const look: Token[] = []
  let lookHead = 0
  const compactLook = (): void => {
    if (lookHead > 0 && lookHead === look.length) {
      look.length = 0
      lookHead = 0
    } else if (lookHead > 4096) {
      look.splice(0, lookHead)
      lookHead = 0
    }
  }
  /** Token `i` places ahead of the cursor, or null past the end. */
  const peek = (i: number): Token | null => {
    while (look.length - lookHead <= i) {
      const t = nextToken()
      if (!t) return null
      look.push(t)
    }
    return look[lookHead + i]
  }
  /** Advance the cursor by `n` tokens. */
  const drop = (n: number): void => {
    lookHead += n
    compactLook()
  }

  // --- flattening pass -----------------------------------------------------
  /**
   * Try to rewrite a complete `q … Q` block into the parent coordinate space,
   * dropping the save/restore and the matrix concatenations.
   *
   * Only blocks built purely from `q`, `Q`, `cm`, path construction and path
   * painting qualify — anything that touches colour, text, clipping, an
   * XObject or an ExtGState is left alone. Stroking blocks additionally need a
   * similarity matrix, and a hairline (`0 w`) or unscaled pen, so the stroke
   * width and dash phase survive the change of space.
   */
  function tryFlatten(block: Token[]): { group: Mat | null; toks: string[] } | null {
    // The block's leading `cm`s — before any drawing — are hoisted out as a
    // shared "group" matrix rather than baked into every coordinate. That
    // matters more than it sounds: these wrappers are usually
    // `q <page scale> cm q <translate> cm …`, and baking the page scale in
    // turns tidy small integers into unique long decimals, which costs more in
    // file size than the wrapper ever did. Hoisting keeps the numbers as
    // written and still removes the per-primitive save/restore.
    let group: Mat | null = null
    let local: Mat = IDENT
    let leading = true
    const stack: Mat[] = []
    let path: Seg[] = []
    const toks: string[] = []
    let sawPaint = false

    for (const t of block) {
      const { op, args } = t
      if (op === 'cm') {
        if (path.length || args.length !== 6) return null
        const m = args.map(Number) as Mat
        if (!m.every((v) => Number.isFinite(v))) return null
        if (leading && stack.length === 0) {
          // Still in the prologue — fold into the group instead of the body.
          group = group ? matMul(m, group) : m
          continue
        }
        local = matMul(m, local)
        continue
      }
      leading = false
      if (op === 'q') {
        if (path.length) return null
        stack.push(local)
        continue
      }
      if (op === 'Q') {
        if (path.length) return null
        local = stack.pop() ?? IDENT
        continue
      }
      if (PATH_OPS.has(op)) {
        const arity = op === 'h' ? 0 : op === 'm' || op === 'l' ? 2 : op === 'c' ? 6 : 4
        if (args.length !== arity) return null
        const n = args.map(Number)
        if (!n.every((v) => Number.isFinite(v))) return null
        path.push({ op, n })
        continue
      }
      if (PAINT_OPS.has(op)) {
        if (args.length) return null
        const strokes = op !== 'n' && op !== 'f' && op !== 'F' && op !== 'f*'
        // Only the residual matrix is baked into the coordinates; the group
        // matrix is re-emitted, so it can't change the effective pen at all.
        const sc = matScale(local)
        if (strokes) {
          if (!isSimilarity(local)) return null
          // A residual scale change rewrites the pen width and dash phase.
          if (Math.abs(sc - 1) > 1e-9 && (lineWidth !== 0 || dashOn)) return null
        }
        // Tolerance is a page-space quantity; convert it into the space the
        // coordinates will actually be written in — parent CTM plus group.
        const groupScale = matScale(ctm) * (group ? matScale(group) : 1)
        const tol = tolerancePt / (groupScale > 1e-9 ? groupScale : 1e-9)
        const r = renderPath(path, local, tol)
        path = []
        if (r.empty && STROKE_ONLY.has(op) && lineCap === 0) {
          // Zero-length butt-capped stroke — paints nothing at all.
          stats.degenerateDropped++
          sawPaint = true
          continue
        }
        for (const x of r.toks) toks.push(x)
        toks.push(op)
        sawPaint = true
        continue
      }
      return null
    }
    if (path.length || stack.length) return null
    if (!sawPaint && toks.length) return null
    return { group, toks }
  }

  /** Matrices are equal for grouping purposes when they'd format identically. */
  const sameMat = (a: Mat | null, b: Mat | null): boolean => {
    if (!a || !b) return a === b
    for (let k = 0; k < 6; k++) if (Math.abs(a[k] - b[k]) > 1e-9) return false
    return true
  }

  // --- emit pass -----------------------------------------------------------
  let path: Seg[] = []

  // A `q <group matrix> cm` we opened ourselves and are holding open across a
  // run of flattened primitives that all share it.
  let openGroup: Mat | null = null
  const closeGroup = (): void => {
    if (!openGroup) return
    flushMerge()
    emit('Q')
    openGroup = null
  }

  const flushPathVerbatim = (): void => {
    if (!path.length) return
    const sc = matScale(ctm)
    const tol = tolerancePt / (sc > 1e-9 ? sc : 1e-9)
    const r = renderPath(path, null, tol)
    path = []
    for (const t of r.toks) emit(t)
  }

  for (;;) {
    const t = peek(0)
    if (!t) break
    const { op, args } = t

    // Inline image passthrough
    if (op === '') {
      closeGroup()
      flushPathVerbatim()
      flushMerge()
      emit(args[0])
      drop(1)
      continue
    }

    // --- try to capture a flattenable q … Q block ---
    if (doFlatten && op === 'q' && !path.length) {
      let depth = 0
      let j = 0
      let ok = true
      let closed = false
      for (; j <= MAX_BLOCK_TOKENS; j++) {
        const nt = peek(j)
        if (!nt) {
          ok = false
          break
        }
        const o = nt.op
        if (o === 'q') depth++
        else if (o === 'Q') {
          depth--
          if (depth === 0) {
            closed = true
            break
          }
        } else if (!(o === 'cm' || PATH_OPS.has(o) || PAINT_OPS.has(o))) {
          ok = false
          break
        }
      }
      if (ok && closed) {
        // tryFlatten counts segments as it renders paths, but can still bail
        // out partway through. Roll the counters back on failure so the
        // verbatim re-processing below doesn't count the same block twice.
        const mark = {
          sb: stats.segmentsBefore,
          sa: stats.segmentsAfter,
          nd: stats.degenerateDropped
        }
        const block: Token[] = []
        for (let x = 1; x < j; x++) block.push(peek(x) as Token)
        const flat = tryFlatten(block)
        if (!flat) {
          stats.segmentsBefore = mark.sb
          stats.segmentsAfter = mark.sa
          stats.degenerateDropped = mark.nd
        }
        if (flat) {
          // Keep a shared `q <group> cm` open across the whole run of
          // primitives that use it; only switch when the matrix changes.
          if (!sameMat(flat.group, openGroup)) {
            closeGroup()
            if (flat.group) {
              emit('q')
              for (const v of flat.group) emit(fmt(v, 6))
              emit('cm')
              openGroup = flat.group
            }
          }
          // Feed the flattened tokens through the stroke merger: a trailing
          // `S` on a lone subpath is exactly what we want to coalesce.
          const ft = flat.toks
          let k = 0
          while (k < ft.length) {
            // find the next paint op
            let e = k
            while (e < ft.length && !PAINT_OPS.has(ft[e])) e++
            if (e >= ft.length) {
              for (; k < ft.length; k++) emit(ft[k])
              break
            }
            const paint = ft[e]
            if (doMerge && STROKE_ONLY.has(paint) && mergeCount < MAX_MERGED_SUBPATHS) {
              for (let x = k; x < e; x++) mergeBuf.push(ft[x])
              if (paint === 's') mergeBuf.push('h')
              mergeCount++
            } else {
              flushMerge()
              for (let x = k; x <= e; x++) emit(ft[x])
            }
            k = e + 1
          }
          stats.wrappersFlattened++
          drop(j + 1)
          continue
        }
      }
    }

    // Any token that isn't another flattenable primitive ends the group.
    closeGroup()

    if (PATH_OPS.has(op)) {
      const arity = op === 'h' ? 0 : op === 'm' || op === 'l' ? 2 : op === 'c' ? 6 : 4
      const n = args.map(Number)
      if (args.length === arity && n.every((v) => Number.isFinite(v))) {
        path.push({ op, n })
        drop(1)
        continue
      }
      flushPathVerbatim()
      flushMerge()
      for (const a of args) emit(a)
      emit(op)
      drop(1)
      continue
    }

    if (PAINT_OPS.has(op) && !args.length) {
      const sc = matScale(ctm)
      const tol = tolerancePt / (sc > 1e-9 ? sc : 1e-9)
      const r = renderPath(path, null, tol)
      path = []
      if (r.empty && STROKE_ONLY.has(op) && lineCap === 0) {
        stats.degenerateDropped++
        drop(1)
        continue
      }
      if (doMerge && STROKE_ONLY.has(op) && mergeCount < MAX_MERGED_SUBPATHS) {
        for (const x of r.toks) mergeBuf.push(x)
        if (op === 's') mergeBuf.push('h')
        mergeCount++
        drop(1)
        continue
      }
      flushMerge()
      for (const x of r.toks) emit(x)
      emit(op)
      drop(1)
      continue
    }

    // --- anything else: a state change, text, clip, XObject … ---
    flushPathVerbatim()
    flushMerge()

    if (op === 'q') {
      ctmStack.push(ctm)
      widthStack.push(lineWidth)
      capStack.push(lineCap)
      dashStack.push(dashOn)
    } else if (op === 'Q') {
      ctm = ctmStack.pop() ?? IDENT
      lineWidth = widthStack.pop() ?? lineWidth
      lineCap = capStack.pop() ?? lineCap
      dashOn = dashStack.pop() ?? dashOn
    } else if (op === 'cm' && args.length === 6) {
      const m = args.map(Number) as Mat
      if (m.every((v) => Number.isFinite(v))) ctm = matMul(m, ctm)
    } else if (op === 'w' && args.length === 1) {
      const v = Number(args[0])
      if (Number.isFinite(v)) lineWidth = v
    } else if (op === 'J' && args.length === 1) {
      const v = Number(args[0])
      if (Number.isFinite(v)) lineCap = v
    } else if (op === 'd' && args.length === 2) {
      dashOn = /[1-9]/.test(args[0])
    } else if (op === 'gs') {
      // An ExtGState can set width, cap and dash out of band — assume the worst.
      lineWidth = NaN
      dashOn = true
      lineCap = -1
    }

    for (const a of args) emit(a)
    emit(op)
    drop(1)
  }
  closeGroup()
  flushPathVerbatim()
  flushMerge()

  if (packed.length) chunks.push(packed.join(''))
  const text = chunks.join('')
  const buf = new Uint8Array(text.length)
  for (let k = 0; k < text.length; k++) buf[k] = text.charCodeAt(k) & 0xff
  stats.bytesAfter = buf.length
  return { out: buf, stats }
}
