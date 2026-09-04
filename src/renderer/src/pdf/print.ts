import { loadPdf } from './pdfjs'

/**
 * Render final (baked) PDF bytes to a print-ready HTML document — one JPEG per
 * page at ~150 dpi. The main process loads it in a hidden window and opens the
 * system print dialog, so what prints is exactly what a save would produce.
 */
export async function buildPrintHtml(
  bytes: Uint8Array,
  onProgress?: (done: number, total: number) => void
): Promise<string> {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const doc = await loadPdf(ab)
  const parts: string[] = []
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const vp1 = page.getViewport({ scale: 1 })
      const scale = Math.min(150 / 72, 4000 / vp1.width, 4000 / vp1.height)
      const vp = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.floor(vp.width))
      canvas.height = Math.max(1, Math.floor(vp.height))
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise
      const dataUrl = canvas.toDataURL('image/jpeg', 0.92)
      canvas.width = 0
      canvas.height = 0
      parts.push(`<div class="pg"><img src="${dataUrl}"></div>`)
      onProgress?.(i, doc.numPages)
    }
  } finally {
    doc.destroy().catch(() => {})
  }
  return (
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    '@page{margin:0}html,body{margin:0;padding:0}' +
    '.pg{page-break-after:always;break-after:page}.pg:last-child{page-break-after:auto}' +
    'img{display:block;width:100%}' +
    '</style></head><body>' +
    parts.join('') +
    '</body></html>'
  )
}
