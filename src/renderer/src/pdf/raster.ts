import type { PDFDocumentProxy } from './pdfjs'
import { canvasToJpeg, FORM_ANNOT_MODE } from './pdfjs'
import type { Pt } from './types'
import type { RasterizeLeaf } from './save'

/**
 * Build the save-pipeline callback that rasterises a page *with its whiteout
 * boxes burned in*, so the covered content is permanently destroyed (true
 * redaction). Quality: ~200 dpi, capped at 4000px per side for big sheets.
 */
export function makeRasterizer(doc: PDFDocumentProxy, optionalContentConfig?: unknown): RasterizeLeaf {
  return async (leaf, whiteouts) => {
    const page = await doc.getPage(leaf.srcPage)
    const rot = (((page.rotate + leaf.rotation) % 360) + 360) % 360
    const vp1 = page.getViewport({ scale: 1, rotation: rot })
    const scale = Math.min(200 / 72, 4000 / vp1.width, 4000 / vp1.height)
    const vp = page.getViewport({ scale, rotation: rot })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(vp.width))
    canvas.height = Math.max(1, Math.floor(vp.height))
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({
      canvasContext: ctx,
      viewport: vp,
      intent: 'print',
      // the save pass redraws field values as page content on rasterised
      // pages, so keep the widgets' baked appearances out of the bitmap
      annotationMode: FORM_ANNOT_MODE,
      // honour the user's layer visibility toggles in the rasterised page
      optionalContentConfigPromise: optionalContentConfig ? Promise.resolve(optionalContentConfig as never) : undefined
    }).promise

    for (const w of whiteouts) {
      const [x1, y1] = vp.convertToViewportPoint(w.a.x, w.a.y)
      const [x2, y2] = vp.convertToViewportPoint(w.b.x, w.b.y)
      ctx.fillStyle = w.color || '#ffffff'
      ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1))
    }

    const jpg = await canvasToJpeg(canvas, 0.92)
    canvas.width = 0 // release the backing store promptly
    canvas.height = 0
    const toDisp = (p: Pt): Pt => {
      const [vx, vy] = vp1.convertToViewportPoint(p.x, p.y)
      return { x: vx, y: vp1.height - vy }
    }
    return { jpg, wPt: vp1.width, hPt: vp1.height, toDisp }
  }
}
