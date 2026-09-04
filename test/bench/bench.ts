/**
 * Times page rasterisation in pdf.js — the engine PDF Studio actually uses —
 * for the original file against each optimised variant. Served by
 * test/bench/vite.config.ts, which exposes the PDFs under /pdf/<key>.
 */
import * as pdfjsLib from 'pdfjs-dist'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'

pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker()

const status = document.getElementById('status') as HTMLDivElement
const out = document.getElementById('out') as HTMLDivElement

/** Same sizing rule PageView uses, so the numbers reflect the real app. */
const MAX_CANVAS_DIM = 4096

async function timePage(doc: pdfjsLib.PDFDocumentProxy, n: number, zoom: number): Promise<number> {
  const page = await doc.getPage(n)
  const vp = page.getViewport({ scale: zoom, rotation: page.rotate })
  const dpr = 1
  const k = Math.min(1, MAX_CANVAS_DIM / (vp.width * dpr), MAX_CANVAS_DIM / (vp.height * dpr))
  const sc = dpr * k
  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(vp.width * sc)
  canvas.height = Math.floor(vp.height * sc)
  const ctx = canvas.getContext('2d')!
  const t0 = performance.now()
  await page.render({
    canvasContext: ctx,
    viewport: vp,
    transform: sc !== 1 ? [sc, 0, 0, sc, 0, 0] : undefined,
    annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS,
    // 'print' skips pdf.js's requestAnimationFrame pacing. Without it a
    // backgrounded tab is throttled to ~1 chunk/second and the numbers measure
    // the throttle, not the renderer.
    intent: 'print'
  }).promise
  const t = performance.now() - t0
  page.cleanup()
  return t
}

async function run(): Promise<void> {
  const listed: { key: string; label: string; size: number }[] = await (
    await fetch('/pdfs.json')
  ).json()
  const pages = [4, 5, 7, 8]
  const zoom = 1.5

  const results: Record<string, Record<number, number>> = {}
  for (const v of listed) {
    status.textContent = `loading ${v.label}…`
    const buf = await (await fetch(`/pdf/${v.key}`)).arrayBuffer()
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false })
      .promise
    results[v.key] = {}
    for (const p of pages) {
      status.textContent = `${v.label}: page ${p} (cold)…`
      // Cold = first ever render of the page: includes building the operator
      // list. That is what the user feels when a sheet first appears.
      const cold = await timePage(doc, p, zoom)
      status.textContent = `${v.label}: page ${p} (warm)…`
      // Warm = re-render at the same zoom with the operator list cached, i.e.
      // what every subsequent zoom/scroll step costs.
      const warm = await timePage(doc, p, zoom)
      results[v.key][p] = cold
      results[v.key][-p] = warm
      console.log(`${v.label} p${p}: cold ${(cold / 1000).toFixed(2)}s  warm ${(warm / 1000).toFixed(2)}s`)
      render(listed, pages, results)
    }
    await doc.destroy()
  }
  status.textContent = `done — zoom ${zoom}x, ${pages.length} pages`
  ;(window as unknown as { BENCH: unknown }).BENCH = { listed, pages, results }
}

function render(
  listed: { key: string; label: string; size: number }[],
  pages: number[],
  results: Record<string, Record<number, number>>
): void {
  const base = listed[0].key
  let h = '<table><tr><th>variant</th><th>file MB</th>'
  for (const p of pages) h += `<th>p${p} cold</th><th>p${p} warm</th>`
  h += '<th>total</th><th>speedup</th></tr>'
  for (const v of listed) {
    const r = results[v.key] || {}
    const tot = pages.reduce((s, p) => s + (r[p] || 0) + (r[-p] || 0), 0)
    const btot = pages.reduce(
      (s, p) => s + ((results[base] || {})[p] || 0) + ((results[base] || {})[-p] || 0),
      0
    )
    h += `<tr><td>${v.label}</td><td>${(v.size / 1e6).toFixed(2)}</td>`
    for (const p of pages) {
      h += `<td>${r[p] ? (r[p] / 1000).toFixed(2) : '—'}</td>`
      h += `<td>${r[-p] ? (r[-p] / 1000).toFixed(2) : '—'}</td>`
    }
    h += `<td>${tot ? (tot / 1000).toFixed(2) : '—'}</td>`
    const sp = tot && btot ? btot / tot : 0
    h += `<td class="${sp > 1.5 ? 'win' : ''}">${sp ? sp.toFixed(2) + '×' : '—'}</td></tr>`
  }
  out.innerHTML = h + '</table>'
}

run().catch((e) => {
  status.textContent = 'ERROR: ' + (e as Error).message
  console.error(e)
})
