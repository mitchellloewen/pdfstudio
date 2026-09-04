import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
// Vite bundles the worker as a separate module and gives us a Worker constructor.
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'

pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker()

export interface LoadResult {
  doc: PDFDocumentProxy
  encrypted: boolean
}

/**
 * Load a PDF for rendering. pdf.js ignores permission (owner-password) locks
 * entirely, so those open transparently. Documents with a *user* (open)
 * password throw a PasswordException — surfaced to the caller.
 */
export async function loadPdf(bytes: ArrayBuffer, password?: string): Promise<PDFDocumentProxy> {
  const task = pdfjsLib.getDocument({
    data: new Uint8Array(bytes.slice(0)),
    password,
    // be permissive with slightly malformed files
    stopAtErrors: false,
    isEvalSupported: false
  })
  return task.promise
}

export function isPasswordException(err: unknown): { needsPassword: boolean; wrong: boolean } {
  const name = (err as { name?: string })?.name
  const code = (err as { code?: number })?.code
  if (name === 'PasswordException') {
    // code 1 = NEED_PASSWORD, 2 = INCORRECT_PASSWORD
    return { needsPassword: true, wrong: code === 2 }
  }
  return { needsPassword: false, wrong: false }
}

/**
 * Rasterise one page (with an optional extra user rotation) to a canvas.
 * `targetDpi` is a quality hint; the result is capped at `maxDim` px per side
 * so huge plan sheets can't blow past canvas limits. Returns the viewport the
 * bitmap was rendered with, so pixel coords can be mapped back to user space.
 */
export async function renderPageBitmap(
  doc: PDFDocumentProxy,
  srcPage: number,
  extraRotation: number,
  targetDpi = 150,
  maxDim = 4000
): Promise<{ canvas: HTMLCanvasElement; viewport: ReturnType<PDFPageProxy['getViewport']> }> {
  const page = await doc.getPage(srcPage)
  const rot = (((page.rotate + extraRotation) % 360) + 360) % 360
  const viewport1 = page.getViewport({ scale: 1, rotation: rot })
  const scale = Math.min(targetDpi / 72, maxDim / viewport1.width, maxDim / viewport1.height)
  const vp = page.getViewport({ scale, rotation: rot })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.floor(vp.width))
  canvas.height = Math.max(1, Math.floor(vp.height))
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  // 'print' intent: no requestAnimationFrame pacing — required for reliable
  // offscreen rendering, and faster for batch work
  await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise
  return { canvas, viewport: vp }
}

export function canvasToJpeg(canvas: HTMLCanvasElement, quality = 0.92): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error('toBlob failed'))
        blob.arrayBuffer().then((ab) => resolve(new Uint8Array(ab)), reject)
      },
      'image/jpeg',
      quality
    )
  })
}

/**
 * Annotation mode for every canvas render in the app.
 *
 * ENABLE_FORMS tells pdf.js *not* to paint AcroForm widget appearance streams
 * onto the page canvas — we draw those fields ourselves (an HTML overlay on
 * screen, real content on save). With the default ENABLE mode a form that was
 * already filled in elsewhere (Nitro, Acrobat, PDF-XChange…) shows every value
 * twice: once from the baked /AP, once from our own field layer.
 *
 * Widgets pdf.js still paints in this mode — read-only fields, push buttons and
 * signatures (`hasOwnCanvas` / `noHTML`) — are deliberately left out of our
 * field overlay by detectFields(), so each one is drawn exactly once.
 */
export const FORM_ANNOT_MODE = pdfjsLib.AnnotationMode.ENABLE_FORMS

export const TextLayer = pdfjsLib.TextLayer
export type { PDFDocumentProxy, PDFPageProxy }
export { pdfjsLib }
