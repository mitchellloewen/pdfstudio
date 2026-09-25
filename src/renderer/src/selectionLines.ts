/**
 * Selected text → one clean bar per line.
 *
 * pdf.js's text layer is a pile of transparent spans, one per text run the PDF
 * author wrote (sometimes a word, sometimes half of one). Painting each span's
 * box — what the browser's native ::selection does, and what we used to store
 * as markup rects — gives ragged edges, darker slivers where neighbouring spans
 * overlap, and bars that run on over trailing spaces. Here we measure only the
 * non-blank characters of each text node, then fold those boxes into one bar
 * per line, the way Acrobat and Chrome's PDF viewer draw a selection.
 */

export interface Bar {
  left: number
  top: number
  right: number
  bottom: number
}

const BLANK = /\s/

/**
 * Client-space boxes of the selected, non-blank text inside `root` (only text
 * that lives in a `.textLayer`). Leading/trailing whitespace of every text node
 * is trimmed, so spaces a span ends with never widen a bar.
 */
export function selectionGlyphRects(sel: Selection, root: Element): Bar[] {
  const out: Bar[] = []
  for (let ri = 0; ri < sel.rangeCount; ri++) {
    const range = sel.getRangeAt(ri)
    if (range.collapsed || !range.intersectsNode(root)) continue
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n as Text
      if (!range.intersectsNode(text)) continue
      if (!text.parentElement?.closest('.textLayer')) continue
      const s = text.data
      let a = text === range.startContainer ? range.startOffset : 0
      let b = text === range.endContainer ? range.endOffset : s.length
      while (a < b && BLANK.test(s[a])) a++
      while (b > a && BLANK.test(s[b - 1])) b--
      if (a >= b) continue
      const sub = document.createRange()
      sub.setStart(text, a)
      sub.setEnd(text, b)
      for (const r of Array.from(sub.getClientRects())) {
        if (r.width < 0.5 || r.height < 0.5) continue
        out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })
      }
    }
  }
  return out
}

/**
 * How neighbouring lines meet:
 *  - 'fill'  close small gaps and split overlaps at the midpoint, so a
 *            paragraph reads as one even block (selection, highlight)
 *  - 'none'  leave each line's height alone (underline / strikeout, where the
 *            stroke sits on the bar's own bottom / middle)
 */
export type LineJoin = 'fill' | 'none'

interface Line {
  left: number
  right: number
  tops: number[]
  bottoms: number[]
  top: number // running band for matching (union)
  bottom: number
}

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const flip = (r: Bar): Bar => ({ left: r.top, top: r.left, right: r.bottom, bottom: r.right })

/** Fold glyph boxes into one bar per line (per column — wide gaps stay split). */
export function mergeIntoLines(rects: Bar[], join: LineJoin = 'fill'): Bar[] {
  if (!rects.length) return []
  // Rotated pages put text lines vertical on screen: merge in the flipped frame.
  let sw = 0
  let sh = 0
  for (const r of rects) {
    sw += r.right - r.left
    sh += r.bottom - r.top
  }
  const vertical = sh > sw * 1.5
  const src = vertical ? rects.map(flip) : rects

  const sorted = [...src].sort((p, q) => p.left - q.left)
  const lines: Line[] = []
  for (const r of sorted) {
    const h = r.bottom - r.top
    const line = lines.find((l) => {
      const lh = l.bottom - l.top
      const overlap = Math.min(l.bottom, r.bottom) - Math.max(l.top, r.top)
      if (overlap < 0.5 * Math.min(h, lh)) return false
      // a gutter wider than ~1.5 line heights is a column break, not a space
      const gap = Math.max(r.left - l.right, l.left - r.right)
      return gap <= 1.5 * Math.max(h, lh)
    })
    if (line) {
      line.left = Math.min(line.left, r.left)
      line.right = Math.max(line.right, r.right)
      line.tops.push(r.top)
      line.bottoms.push(r.bottom)
      line.top = Math.min(line.top, r.top)
      line.bottom = Math.max(line.bottom, r.bottom)
    } else {
      lines.push({ left: r.left, right: r.right, tops: [r.top], bottoms: [r.bottom], top: r.top, bottom: r.bottom })
    }
  }

  // The band is the line's typical glyph box, so a superscript or one larger
  // run doesn't fatten the whole bar.
  const bars: Bar[] = lines
    .map((l) => ({ left: l.left, right: l.right, top: median(l.tops), bottom: median(l.bottoms) }))
    .sort((p, q) => p.top - q.top || p.left - q.left)

  if (join === 'fill') {
    for (let i = 0; i < bars.length; i++) {
      const a = bars[i]
      // the nearest bar below that shares some horizontal extent
      let next: Bar | null = null
      for (let j = i + 1; j < bars.length; j++) {
        const b = bars[j]
        if (b.top <= a.top) continue
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) <= 0) continue
        if (!next || b.top < next.top) next = b
      }
      if (!next) continue
      const gap = next.top - a.bottom
      const lh = Math.min(a.bottom - a.top, next.bottom - next.top)
      if (gap < 0.45 * lh) {
        const mid = (a.bottom + next.top) / 2
        a.bottom = mid
        next.top = mid
      }
    }
  }

  return vertical ? bars.map(flip) : bars
}
