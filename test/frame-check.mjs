// Verify save.ts Frame math (display-space mapping) against pdf.js viewports,
// and that baked text on rotated pages comes out upright in display space.
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

// --- copy of the pageFrame math from save.ts (kept in sync manually) --------
function frameFor(R, x0, y0, W0, H0) {
  switch (R) {
    case 90:
      return {
        W: H0, H: W0,
        toDisp: (p) => ({ x: p.y - y0, y: W0 - (p.x - x0) }),
        out: (dx, dy) => ({ x: x0 + W0 - dy, y: y0 + dx })
      }
    case 180:
      return {
        W: W0, H: H0,
        toDisp: (p) => ({ x: W0 - (p.x - x0), y: H0 - (p.y - y0) }),
        out: (dx, dy) => ({ x: x0 + W0 - dx, y: y0 + H0 - dy })
      }
    case 270:
      return {
        W: H0, H: W0,
        toDisp: (p) => ({ x: H0 - (p.y - y0), y: p.x - x0 }),
        out: (dx, dy) => ({ x: x0 + dy, y: y0 + H0 - dx })
      }
    default:
      return {
        W: W0, H: H0,
        toDisp: (p) => ({ x: p.x - x0, y: p.y - y0 }),
        out: (dx, dy) => ({ x: x0 + dx, y: y0 + dy })
      }
  }
}

// --- build a test page (with a shifted crop box to catch offset bugs) -------
async function makePdf(rotation) {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  page.setCropBox(10, 20, 592, 752)
  page.setRotation(degrees(rotation))
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText('x', { x: 300, y: 400, size: 8, font })
  return doc.save()
}

let failures = 0
const close = (a, b) => Math.abs(a - b) < 0.01

for (const R of [0, 90, 180, 270]) {
  const bytes = await makePdf(R)
  const doc = await getDocument({ data: bytes.slice(0), isEvalSupported: false }).promise
  const page = await doc.getPage(1)
  const vp = page.getViewport({ scale: 1, rotation: R }) // R here = total display rotation
  const fr = frameFor(R, 10, 20, 592, 752)
  if (!close(vp.width, fr.W) || !close(vp.height, fr.H)) {
    failures++
    console.error(`R=${R} dims mismatch: pdfjs ${vp.width}x${vp.height} vs frame ${fr.W}x${fr.H}`)
  }
  for (const p of [{ x: 10, y: 20 }, { x: 602, y: 772 }, { x: 300, y: 400 }, { x: 100, y: 700 }]) {
    const [vx, vy] = vp.convertToViewportPoint(p.x, p.y)
    const dispPdfjs = { x: vx, y: vp.height - vy } // y-up display space
    const dispMine = fr.toDisp(p)
    if (!close(dispPdfjs.x, dispMine.x) || !close(dispPdfjs.y, dispMine.y)) {
      failures++
      console.error(`R=${R} toDisp mismatch at (${p.x},${p.y}): pdfjs (${dispPdfjs.x.toFixed(2)},${dispPdfjs.y.toFixed(2)}) mine (${dispMine.x.toFixed(2)},${dispMine.y.toFixed(2)})`)
    }
    const back = fr.out(dispMine.x, dispMine.y)
    if (!close(back.x, p.x) || !close(back.y, p.y)) {
      failures++
      console.error(`R=${R} out() is not the inverse at (${p.x},${p.y}) -> (${back.x},${back.y})`)
    }
  }
  await doc.destroy()
}

// --- text orientation: draw with rotate=R at out(display pt), then check ----
// the text-item direction in user space equals R (CCW) and its display pos.
for (const R of [0, 90, 180, 270]) {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  page.setRotation(degrees(R))
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const fr = frameFor(R, 0, 0, 612, 792)
  const dispPt = { x: 111, y: 222 }
  const at = fr.out(dispPt.x, dispPt.y)
  page.drawText('MARKER', { x: at.x, y: at.y, size: 12, font, rotate: degrees(R) })
  const bytes = await doc.save()

  const pdoc = await getDocument({ data: bytes.slice(0), isEvalSupported: false }).promise
  const ppage = await pdoc.getPage(1)
  const vp = ppage.getViewport({ scale: 1, rotation: R })
  const tc = await ppage.getTextContent()
  const item = tc.items.find((i) => i.str === 'MARKER')
  if (!item) {
    failures++
    console.error(`R=${R}: MARKER not found`)
    continue
  }
  const tr = item.transform
  const [vx, vy] = vp.convertToViewportPoint(tr[4], tr[5])
  const disp = { x: vx, y: vp.height - vy }
  if (!close(disp.x, dispPt.x) || !close(disp.y, dispPt.y)) {
    failures++
    console.error(`R=${R} baked text display pos (${disp.x.toFixed(2)},${disp.y.toFixed(2)}) != expected (111,222)`)
  }
  // direction of the baseline in user space
  const ang = ((Math.atan2(tr[1], tr[0]) * 180) / Math.PI + 360) % 360
  if (!close(ang, R)) {
    failures++
    console.error(`R=${R} baked text user-space angle ${ang} != ${R}`)
  }
  await pdoc.destroy()
}

console.log(failures === 0 ? 'FRAME-CHECK-OK' : `FRAME-CHECK-FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
