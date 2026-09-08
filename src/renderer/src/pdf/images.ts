/**
 * Editing the images that live *inside* a page's content stream.
 *
 * Everything else PDF Studio draws is an overlay: a model annotation that gets
 * written on top of the page when it saves. An embedded image is different —
 * it is already page content, drawn by a `/Im0 Do` operator whose placement is
 * whatever the graphics state's CTM happened to be at that point. To move one
 * you have to edit the content stream itself.
 *
 * The trick that makes this safe is that we never rewrite the surrounding
 * content. At the draw site the accumulated matrix is `C`; to land the image on
 * a new matrix `T` we wrap just that operator:
 *
 *     q  <T·C⁻¹> cm  [crop re W n]  /Im0 Do  Q
 *
 * Inside the wrapper the CTM works out to exactly `T`, and the `q`/`Q` pair
 * puts everything back afterwards. Z-order, clipping, colour, soft masks and
 * every neighbouring operator are untouched, and the image's own bytes are
 * never re-encoded. Deleting is dropping that span; duplicating is emitting a
 * second wrapper next to it, which costs nothing because both draws point at
 * the same XObject.
 *
 * Images nested inside Form XObjects are editable too, but a form can be shared
 * by several pages, so writing into one would move the image on all of them.
 * The chain of forms from the page down to the edited draw is therefore
 * copy-on-written first (see `cloneChain`) — cheap, since a clone only copies
 * the little content stream, not the image data it references.
 */

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
  type PDFPage
} from 'pdf-lib'
import type { Box, ImageEditAnnot, Matrix, Pt } from './types'

// ---------------------------------------------------------------------------
// affine matrices, in PDF order [a b c d e f]
// ---------------------------------------------------------------------------

export type { Matrix }

export const IDENT: Matrix = [1, 0, 0, 1, 0, 0]

/** The matrix that applies `m` first and then `n` (PDF's `cm` concatenation). */
export function mulM(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5]
  ]
}

/** Inverse, or null for a degenerate (zero-area) matrix. */
export function invM(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2]
  if (!det || !Number.isFinite(det)) return null
  const [a, b, c, d, e, f] = m
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]
}

export function applyM(m: Matrix, x: number, y: number): Pt {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }
}

/** The matrix that maps the unit square onto `box`. */
export function boxM(box: Box): Matrix {
  return [box.w, 0, 0, box.h, box.x, box.y]
}

export const FULL_CROP: Box = { x: 0, y: 0, w: 1, h: 1 }

/**
 * The matrix that places the *whole* image, given where its visible (cropped)
 * part sits. Cropping keeps the remaining pixels exactly where they were, so
 * this is what actually gets written; the model stores the visible quad
 * because that is what the handles on screen work with.
 */
export function fullMatrix(visible: Matrix, crop?: Box): Matrix {
  if (!crop || (crop.x === 0 && crop.y === 0 && crop.w === 1 && crop.h === 1)) return visible
  const inv = invM(boxM(crop))
  return inv ? mulM(inv, visible) : visible
}

/** The reverse: where the cropped part of an image sits. */
export function visibleMatrix(full: Matrix, crop?: Box): Matrix {
  return crop ? mulM(boxM(crop), full) : full
}

/**
 * Size and angle of a placement, for the properties bar. `w`/`h` are the
 * lengths of the image's own axes on the page, so they stay meaningful when it
 * is rotated; `rotation` is degrees counter-clockwise.
 */
export function decomposeM(m: Matrix): { w: number; h: number; rotation: number; flipped: boolean } {
  const w = Math.hypot(m[0], m[1])
  const h = Math.hypot(m[2], m[3])
  const rotation = (Math.atan2(m[1], m[0]) * 180) / Math.PI
  return { w, h, rotation, flipped: m[0] * m[3] - m[1] * m[2] < 0 }
}

/** A placement built from a size, position and rotation about the box centre. */
export function composeM(cx: number, cy: number, w: number, h: number, deg: number, flipX = false, flipY = false): Matrix {
  const r = (deg * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  const sx = flipX ? -1 : 1
  const sy = flipY ? -1 : 1
  // unit square -> centred, flipped, scaled, rotated, then translated
  const local: Matrix = [w * sx, 0, 0, h * sy, (-w * sx) / 2, (-h * sy) / 2]
  const rot: Matrix = [cos, sin, -sin, cos, cx, cy]
  return mulM(local, rot)
}

// ---------------------------------------------------------------------------
// content stream lexer
// ---------------------------------------------------------------------------

const WS = new Uint8Array(256)
for (const c of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) WS[c] = 1
const DELIM = new Uint8Array(256)
for (const c of [0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]) DELIM[c] = 1

type TokKind = 'num' | 'name' | 'op' | 'other'

interface Tok {
  kind: TokKind
  start: number
  end: number
  num: number
  text: string
}

/**
 * A minimal reader for the PDF content-stream grammar. It is not a full parser
 * — dictionaries and strings are only skipped correctly, never interpreted —
 * because all this needs to recognise is `q`, `Q`, `cm`, `Do` and inline
 * images, with everything else stepped over without being mistaken for an
 * operator.
 */
class Lexer {
  pos = 0

  constructor(private readonly b: Uint8Array) {}

  private skipSpace(): void {
    const b = this.b
    while (this.pos < b.length) {
      const c = b[this.pos]
      if (WS[c]) {
        this.pos++
      } else if (c === 0x25) {
        // comment to end of line
        while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos++
      } else {
        return
      }
    }
  }

  /** Step over a literal `(...)` string, honouring escapes and nesting. */
  private skipString(): void {
    const b = this.b
    this.pos++ // the '('
    let depth = 1
    while (this.pos < b.length && depth > 0) {
      const c = b[this.pos++]
      if (c === 0x5c) this.pos++ // backslash escape
      else if (c === 0x28) depth++
      else if (c === 0x29) depth--
    }
  }

  /** Step over `<<...>>` (or a `<hex>` string, which has no nesting). */
  private skipAngle(): void {
    const b = this.b
    if (b[this.pos + 1] !== 0x3c) {
      while (this.pos < b.length && b[this.pos] !== 0x3e) this.pos++
      this.pos++
      return
    }
    let depth = 0
    while (this.pos < b.length) {
      const c = b[this.pos]
      if (c === 0x3c && b[this.pos + 1] === 0x3c) {
        depth++
        this.pos += 2
      } else if (c === 0x3e && b[this.pos + 1] === 0x3e) {
        depth--
        this.pos += 2
        if (depth <= 0) return
      } else if (c === 0x28) {
        this.skipString()
      } else {
        this.pos++
      }
    }
  }

  next(): Tok | null {
    this.skipSpace()
    const b = this.b
    if (this.pos >= b.length) return null
    const start = this.pos
    const c = b[start]

    if (c === 0x2f) {
      // name
      this.pos++
      let text = ''
      while (this.pos < b.length && !WS[b[this.pos]] && !DELIM[b[this.pos]]) {
        if (b[this.pos] === 0x23 && this.pos + 2 < b.length) {
          const hex = String.fromCharCode(b[this.pos + 1], b[this.pos + 2])
          const v = parseInt(hex, 16)
          if (!Number.isNaN(v)) {
            text += String.fromCharCode(v)
            this.pos += 3
            continue
          }
        }
        text += String.fromCharCode(b[this.pos++])
      }
      return { kind: 'name', start, end: this.pos, num: 0, text }
    }

    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {
      let text = ''
      while (this.pos < b.length && !WS[b[this.pos]] && !DELIM[b[this.pos]]) text += String.fromCharCode(b[this.pos++])
      const num = parseFloat(text)
      return { kind: 'num', start, end: this.pos, num: Number.isFinite(num) ? num : 0, text }
    }

    if (c === 0x28) {
      this.skipString()
      return { kind: 'other', start, end: this.pos, num: 0, text: '' }
    }

    if (c === 0x3c) {
      this.skipAngle()
      return { kind: 'other', start, end: this.pos, num: 0, text: '' }
    }

    if (DELIM[c]) {
      // [ ] { } > ) — structural, never an operator
      this.pos++
      return { kind: 'other', start, end: this.pos, num: 0, text: String.fromCharCode(c) }
    }

    let text = ''
    while (this.pos < b.length && !WS[b[this.pos]] && !DELIM[b[this.pos]]) text += String.fromCharCode(b[this.pos++])
    if (this.pos === start) this.pos++ // never stall
    return { kind: 'op', start, end: this.pos, num: 0, text }
  }
}

const CS_COMPONENTS: Record<string, number> = { G: 1, DeviceGray: 1, RGB: 3, DeviceRGB: 3, CMYK: 4, DeviceCMYK: 4, I: 1, Indexed: 1 }

/**
 * Walk past the binary payload of an inline image. `pos` is just after the `ID`
 * operator. Returns the offset one byte past `EI`.
 *
 * An unfiltered image's length is arithmetic, so that case is exact. A
 * compressed one has to be found by searching for a delimited `EI`, which is
 * what every other PDF tool does too.
 */
function skipInlineData(b: Uint8Array, pos: number, dict: Record<string, Tok[]>): number {
  let p = pos
  if (p < b.length && WS[b[p]]) p++ // the single separator byte after ID

  const filtered = !!(dict.F || dict.Filter)
  if (!filtered) {
    const w = dict.W?.[0]?.num ?? dict.Width?.[0]?.num ?? 0
    const h = dict.H?.[0]?.num ?? dict.Height?.[0]?.num ?? 0
    const bpc = dict.IM || dict.ImageMask ? 1 : (dict.BPC?.[0]?.num ?? dict.BitsPerComponent?.[0]?.num ?? 8)
    const csTok = dict.CS?.[0] ?? dict.ColorSpace?.[0]
    const ncomp = dict.IM || dict.ImageMask ? 1 : (csTok && CS_COMPONENTS[csTok.text]) || 1
    const len = Math.ceil((w * bpc * ncomp) / 8) * h
    if (len > 0 && p + len <= b.length) {
      let q = p + len
      while (q < b.length && WS[b[q]]) q++
      if (b[q] === 0x45 && b[q + 1] === 0x49) return q + 2
    }
  }

  // fall back to scanning for a whitespace-delimited EI
  for (let q = p; q + 1 < b.length; q++) {
    if (b[q] !== 0x45 || b[q + 1] !== 0x49) continue
    if (q > p && !WS[b[q - 1]]) continue
    const after = q + 2 < b.length ? b[q + 2] : 0x20
    if (!WS[after] && !DELIM[after]) continue
    return q + 2
  }
  return b.length
}

// ---------------------------------------------------------------------------
// scanning a page for its image draws
// ---------------------------------------------------------------------------

/** One image draw found in a content stream. */
interface Draw {
  index: number
  ctm: Matrix
  /** byte span of `/Name Do` (or the whole `BI…EI`) within its own stream */
  start: number
  end: number
  inline: boolean
  pxWidth: number
  pxHeight: number
}

/** A content stream we may have to rewrite: the page's own, or a Form XObject. */
interface StreamNode {
  /** null for the page's own content stream */
  formRef: PDFRef | null
  bytes: Uint8Array
  resources: PDFDict | null
  draws: Draw[]
  children: StreamNode[]
  parent: StreamNode | null
  /** the name this form is filed under in its parent's /XObject dict */
  nameInParent: string | null
  /** true once `resources` is a private copy this node may write into */
  ownedResources: boolean
}

/** What the UI needs to know about one editable image on a page. */
export interface PageImage {
  /** Draw order on the page — the stable identity an edit refers to. */
  index: number
  /** Unit square -> page user space, exactly as the file draws it today. */
  ctm: Matrix
  pxWidth: number
  pxHeight: number
  inline: boolean
  /** Drawn from inside a Form XObject (still editable, via copy-on-write). */
  nested: boolean
}

function streamBytes(doc: PDFDocument, obj: unknown): Uint8Array | null {
  const stream = obj instanceof PDFStream ? obj : null
  if (!stream) return null
  try {
    if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode()
    return stream.getContents()
  } catch {
    return null
  }
}

/** A page's content, with a multi-part /Contents array joined into one buffer. */
function pageContentBytes(doc: PDFDocument, page: PDFPage): Uint8Array {
  const contents = page.node.Contents()
  if (!contents) return new Uint8Array(0)
  const parts: Uint8Array[] = []
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      const b = streamBytes(doc, doc.context.lookup(contents.get(i)))
      if (b) parts.push(b)
    }
  } else {
    const b = streamBytes(doc, doc.context.lookup(contents))
    if (b) parts.push(b)
  }
  if (parts.length === 1) return parts[0]
  const nl = new Uint8Array([0x0a])
  const total = parts.reduce((s, p) => s + p.length + 1, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
    out.set(nl, at)
    at += 1
  }
  return out
}

/** Resources for a page, walking up the page tree for an inherited dict. */
function pageResources(doc: PDFDocument, page: PDFPage): PDFDict | null {
  let node: PDFDict | undefined = page.node
  for (let hops = 0; node && hops < 32; hops++) {
    const res = node.lookupMaybe(PDFName.of('Resources'), PDFDict)
    if (res) return res
    node = node.lookupMaybe(PDFName.of('Parent'), PDFDict)
  }
  return null
}

function lookupXObject(doc: PDFDocument, resources: PDFDict | null, name: string): { ref: PDFRef | null; stream: PDFStream | null } {
  if (!resources) return { ref: null, stream: null }
  const xo = resources.lookupMaybe(PDFName.of('XObject'), PDFDict)
  if (!xo) return { ref: null, stream: null }
  const entry = xo.get(PDFName.of(name))
  const ref = entry instanceof PDFRef ? entry : null
  const stream = doc.context.lookup(entry)
  return { ref, stream: stream instanceof PDFStream ? stream : null }
}

function numArray(dict: PDFDict, key: string): Matrix | null {
  const arr = dict.lookupMaybe(PDFName.of(key), PDFArray)
  if (!arr || arr.size() !== 6) return null
  const out: number[] = []
  for (let i = 0; i < 6; i++) {
    const n = arr.lookup(i, PDFNumber)
    out.push(n instanceof PDFNumber ? n.asNumber() : 0)
  }
  return out as Matrix
}

interface ScanResult {
  root: StreamNode
  images: PageImage[]
  /** where each draw index lives, so an edit knows which stream to rewrite */
  owner: Map<number, StreamNode>
}

/**
 * Find every image drawn on a page, in render order, together with the matrix
 * that places it. Recurses through Form XObjects the same way a renderer does,
 * so the indices line up with what the user sees.
 */
function scanTree(doc: PDFDocument, page: PDFPage): ScanResult {
  const images: PageImage[] = []
  const owner = new Map<number, StreamNode>()
  const root: StreamNode = {
    formRef: null,
    bytes: pageContentBytes(doc, page),
    resources: pageResources(doc, page),
    draws: [],
    children: [],
    parent: null,
    nameInParent: null,
    ownedResources: false
  }

  const walk = (node: StreamNode, baseCtm: Matrix, depth: number, seen: Set<string>): void => {
    if (depth > 12) return
    const lex = new Lexer(node.bytes)
    const stack: Matrix[] = []
    let ctm = baseCtm
    let operands: Tok[] = []

    for (;;) {
      const t = lex.next()
      if (!t) break
      if (t.kind !== 'op') {
        operands.push(t)
        if (operands.length > 64) operands = operands.slice(-16)
        continue
      }

      switch (t.text) {
        case 'q':
          stack.push(ctm)
          break
        case 'Q':
          ctm = stack.pop() ?? ctm
          break
        case 'cm': {
          const n = operands.slice(-6)
          if (n.length === 6 && n.every((o) => o.kind === 'num')) {
            ctm = mulM(n.map((o) => o.num) as Matrix, ctm)
          }
          break
        }
        case 'Do': {
          const nameTok = operands[operands.length - 1]
          if (nameTok?.kind !== 'name') break
          const { ref, stream } = lookupXObject(doc, node.resources, nameTok.text)
          if (!stream) break
          const sub = stream.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString()
          if (sub === '/Image') {
            const idx = images.length
            const draw: Draw = {
              index: idx,
              ctm,
              start: nameTok.start,
              end: t.end,
              inline: false,
              pxWidth: stream.dict.lookupMaybe(PDFName.of('Width'), PDFNumber)?.asNumber() ?? 0,
              pxHeight: stream.dict.lookupMaybe(PDFName.of('Height'), PDFNumber)?.asNumber() ?? 0
            }
            node.draws.push(draw)
            owner.set(idx, node)
            images.push({
              index: idx,
              ctm,
              pxWidth: draw.pxWidth,
              pxHeight: draw.pxHeight,
              inline: false,
              nested: node.formRef !== null
            })
          } else if (sub === '/Form' && ref) {
            const key = ref.toString()
            if (seen.has(key)) break // a form that draws itself
            const bytes = streamBytes(doc, stream)
            if (!bytes) break
            const child: StreamNode = {
              formRef: ref,
              bytes,
              resources: stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? node.resources,
              draws: [],
              children: [],
              parent: node,
              nameInParent: nameTok.text,
              ownedResources: false
            }
            node.children.push(child)
            const fm = numArray(stream.dict, 'Matrix')
            const next = new Set(seen)
            next.add(key)
            walk(child, fm ? mulM(fm, ctm) : ctm, depth + 1, next)
          }
          break
        }
        case 'BI': {
          // inline image: collect the abbreviated dict, then skip the payload
          const entries: Record<string, Tok[]> = {}
          let key: string | null = null
          let vals: Tok[] = []
          let end = node.bytes.length
          for (;;) {
            const d = lex.next()
            if (!d) break
            if (d.kind === 'op' && d.text === 'ID') {
              if (key) entries[key] = vals
              end = skipInlineData(node.bytes, d.end, entries)
              lex.pos = end
              break
            }
            if (d.kind === 'name' && key === null) {
              key = d.text
              vals = []
            } else if (d.kind === 'name' && key !== null && vals.length > 0) {
              entries[key] = vals
              key = d.text
              vals = []
            } else if (key !== null) {
              vals.push(d)
            }
          }
          const idx = images.length
          const w = entries.W?.[0]?.num ?? entries.Width?.[0]?.num ?? 0
          const h = entries.H?.[0]?.num ?? entries.Height?.[0]?.num ?? 0
          const draw: Draw = { index: idx, ctm, start: t.start, end, inline: true, pxWidth: w, pxHeight: h }
          node.draws.push(draw)
          owner.set(idx, node)
          images.push({ index: idx, ctm, pxWidth: w, pxHeight: h, inline: true, nested: node.formRef !== null })
          break
        }
        default:
          break
      }
      operands = []
    }
  }

  walk(root, IDENT, 0, new Set())
  return { root, images, owner }
}

/** Every image drawn on a page, in render order. */
export function scanPageImages(doc: PDFDocument, pageIndex: number): PageImage[] {
  const pages = doc.getPages()
  const page = pages[pageIndex]
  if (!page) return []
  try {
    return scanTree(doc, page).images
  } catch (e) {
    console.warn('image scan failed', e)
    return []
  }
}

// ---------------------------------------------------------------------------
// writing the edits back
// ---------------------------------------------------------------------------

/** Where one instance of an image sits: its visible quad, and what of it shows. */
export interface ImagePlace {
  /** Unit square -> page user space for the *visible* (cropped) part. */
  m: Matrix
  /** The part of the image that shows, in 0..1 image space. Defaults to all. */
  crop?: Box
  /** Draw this image instead of the original (a cropped re-encode). */
  imageRef?: PDFRef
}

export interface ImageDrawEdit {
  /** Drop the original draw. Copies of it, if any, still draw. */
  deleted?: boolean
  /** New placement for the original draw; absent means leave it alone. */
  place?: ImagePlace
  /** Extra draws of the same image, emitted right after the original. */
  copies?: ImagePlace[]
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '0'
  const s = v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
  return s === '-0' ? '0' : s
}

function matrixOps(m: Matrix): string {
  return `${fmt(m[0])} ${fmt(m[1])} ${fmt(m[2])} ${fmt(m[3])} ${fmt(m[4])} ${fmt(m[5])} cm`
}

const enc = new TextEncoder()

/**
 * The wrapper that re-places one draw. `ctm` is the matrix in force where the
 * draw sits, `body` the original operator bytes (or a substitute).
 */
function wrap(place: ImagePlace, ctm: Matrix, body: Uint8Array, substituteName: string | null): Uint8Array[] {
  const crop = place.crop ?? FULL_CROP
  const kInv = invM(boxM(crop))
  const inv = invM(ctm)
  if (!kInv || !inv) return [body]
  // `m` places the visible part; the image's own full matrix backs the crop out
  const full = mulM(kInv, place.m)
  const rel = mulM(full, inv)

  const head: string[] = ['q', matrixOps(rel)]
  if (crop.x !== 0 || crop.y !== 0 || crop.w !== 1 || crop.h !== 1) {
    head.push(`${fmt(crop.x)} ${fmt(crop.y)} ${fmt(crop.w)} ${fmt(crop.h)} re W n`)
  }
  const out: Uint8Array[] = [enc.encode('\n' + head.join('\n') + '\n')]
  out.push(substituteName ? enc.encode(`/${substituteName} Do`) : body)
  out.push(enc.encode('\nQ\n'))
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** Rebuild one stream's bytes with its edited draws wrapped, dropped or copied. */
function rewriteStream(
  node: StreamNode,
  edits: Map<number, ImageDrawEdit>,
  nameFor: (node: StreamNode, ref: PDFRef) => string
): Uint8Array {
  const draws = node.draws.filter((d) => edits.has(d.index)).sort((a, b) => a.start - b.start)
  if (!draws.length) return node.bytes
  const parts: Uint8Array[] = []
  let at = 0
  for (const d of draws) {
    const edit = edits.get(d.index)!
    parts.push(node.bytes.subarray(at, d.start))
    const body = node.bytes.subarray(d.start, d.end)

    if (!edit.deleted) {
      if (edit.place) {
        const sub = edit.place.imageRef ? nameFor(node, edit.place.imageRef) : null
        parts.push(...wrap(edit.place, d.ctm, body, sub))
      } else {
        parts.push(body)
      }
    }
    for (const copy of edit.copies ?? []) {
      const sub = copy.imageRef ? nameFor(node, copy.imageRef) : null
      // an inline image can't be referenced twice — repeat its bytes verbatim
      parts.push(...wrap(copy, d.ctm, body, sub))
    }
    at = d.end
  }
  parts.push(node.bytes.subarray(at))
  return concat(parts)
}

/** A stream dict's entries minus the ones that describe its *encoded* bytes. */
function carriedEntries(dict: PDFDict): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of dict.entries()) {
    const key = k.asString()
    if (key === '/Length' || key === '/Filter' || key === '/DecodeParms') continue
    out[key.slice(1)] = v
  }
  return out
}

/**
 * Give `node` a Resources dict of its own, so adding an entry to it cannot
 * disturb a dict some other page shares. Copying one is cheap: it copies the
 * references, not the objects behind them.
 */
function ownResources(doc: PDFDocument, node: StreamNode, page: PDFPage): PDFDict {
  if (node.ownedResources) return node.resources!
  const src = node.resources
  const copy = src ? (src.clone(doc.context) as PDFDict) : (doc.context.obj({}) as PDFDict)
  const xo = copy.lookupMaybe(PDFName.of('XObject'), PDFDict)
  copy.set(PDFName.of('XObject'), xo ? (xo.clone(doc.context) as PDFDict) : (doc.context.obj({}) as PDFDict))
  node.resources = copy
  node.ownedResources = true
  if (node.formRef === null) {
    page.node.set(PDFName.of('Resources'), copy)
  } else {
    const stream = doc.context.lookup(node.formRef)
    if (stream instanceof PDFStream) stream.dict.set(PDFName.of('Resources'), copy)
  }
  return copy
}

/**
 * Apply a page's image edits to the document, in place.
 *
 * Indices are the draw order `scanPageImages` reports for the same document.
 * Safe to call with no edits, or with edits that name draws this page doesn't
 * have (they are ignored).
 */
export function applyImageEdits(doc: PDFDocument, page: PDFPage, edits: Map<number, ImageDrawEdit>): void {
  if (!edits.size) return
  const { root, owner } = scanTree(doc, page)

  // every stream that has to be rebuilt, and its ancestors with it
  const dirty = new Set<StreamNode>()
  for (const index of edits.keys()) {
    const node = owner.get(index)
    if (!node) continue
    for (let n: StreamNode | null = node; n; n = n.parent) dirty.add(n)
  }
  if (!dirty.has(root)) return

  // Phase 1, outermost first: give every dirty Form XObject a private copy, so
  // rewriting its content can't move the image on another page that draws the
  // same form. Each clone is rewired into its parent's (also private)
  // Resources, which is why the parent has to be done first.
  const topDown: StreamNode[] = []
  const collect = (n: StreamNode): void => {
    if (dirty.has(n)) topDown.push(n)
    for (const c of n.children) collect(c)
  }
  collect(root)

  for (const node of topDown) {
    if (node.formRef === null) continue
    const original = doc.context.lookup(node.formRef)
    if (!(original instanceof PDFStream)) continue
    const clone = doc.context.flateStream(node.bytes, carriedEntries(original.dict) as never)
    const ref = doc.context.register(clone)
    const parentRes = ownResources(doc, node.parent!, page)
    parentRes.lookup(PDFName.of('XObject'), PDFDict).set(PDFName.of(node.nameInParent!), ref)
    node.formRef = ref
    // the clone carries the parent's Resources reference if it had none of its
    // own; either way it is now this node's to own
    node.ownedResources = false
  }

  const nameCache = new Map<StreamNode, Map<string, string>>()

  /** Make `ref` reachable from `node`'s resources, and give back its name. */
  const nameFor = (node: StreamNode, ref: PDFRef): string => {
    let cache = nameCache.get(node)
    if (!cache) {
      cache = new Map()
      nameCache.set(node, cache)
    }
    const hit = cache.get(ref.toString())
    if (hit) return hit
    const xo = ownResources(doc, node, page).lookup(PDFName.of('XObject'), PDFDict)
    let n = 0
    let name = 'PSimg0'
    while (xo.get(PDFName.of(name))) name = `PSimg${++n}`
    xo.set(PDFName.of(name), ref)
    cache.set(ref.toString(), name)
    return name
  }

  // Phase 2: rewrite the content of each dirty stream into the object it now
  // owns. Order no longer matters — every reference is already in place.
  for (const node of topDown) {
    const bytes = rewriteStream(node, edits, nameFor)
    if (node.formRef === null) {
      if (bytes === node.bytes) continue
      page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(bytes)))
    } else {
      const stream = doc.context.lookup(node.formRef)
      if (stream instanceof PDFStream) {
        doc.context.assign(node.formRef, doc.context.flateStream(bytes, carriedEntries(stream.dict) as never))
      }
    }
  }
}

/**
 * Where a page's draw ends up in the *rebuilt* document the viewer renders.
 *
 * Deleting a draw shifts everything after it down, and each copy adds a draw
 * right after the original it came from — so the index pdf.js sees is not the
 * index the model uses. Anything that reads pixels back out of the rendered
 * document (the drag preview, applying a crop) has to go through this, or it
 * will cheerfully decode the wrong picture.
 *
 * Returns the first surviving draw for `drawIndex`, or -1 if none survives.
 */
export function previewDrawIndex(recs: ImageEditAnnot[], drawIndex: number): number {
  let idx = 0
  for (let i = 0; i < drawIndex; i++) {
    if (!recs.some((r) => r.drawIndex === i && r.instance === 0 && r.deleted)) idx++
    idx += recs.filter((r) => r.drawIndex === i && r.instance > 0).length
  }
  const originalGone = recs.some((r) => r.drawIndex === drawIndex && r.instance === 0 && r.deleted)
  const copies = recs.filter((r) => r.drawIndex === drawIndex && r.instance > 0).length
  if (originalGone && copies === 0) return -1
  return idx
}

/**
 * Turn a page's `imgedit` records into the per-draw instructions above.
 *
 * Instance 0 is the image the file came with — it can be re-placed or dropped.
 * Higher instances are copies the user made, which are emitted alongside it.
 * `refFor` resolves a stored image (a crop applied for real) to the XObject it
 * was embedded as.
 */
export function buildDrawEdits(
  recs: ImageEditAnnot[],
  refFor: (imageId: string) => PDFRef | undefined
): Map<number, ImageDrawEdit> {
  const out = new Map<number, ImageDrawEdit>()
  for (const r of [...recs].sort((a, b) => a.instance - b.instance)) {
    const entry = out.get(r.drawIndex) ?? {}
    const place: ImagePlace = { m: r.m, crop: r.crop, imageRef: r.imageId ? refFor(r.imageId) : undefined }
    if (r.instance === 0) {
      if (r.deleted) entry.deleted = true
      else entry.place = place
    } else {
      entry.copies = [...(entry.copies ?? []), place]
    }
    out.set(r.drawIndex, entry)
  }
  return out
}
