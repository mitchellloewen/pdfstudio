/**
 * Content-stream image editing: move, resize, rotate, crop, copy and delete.
 *
 * Every assertion is checked against pdf.js's own operator list rather than the
 * parser under test, so a bug in our lexer can't quietly agree with itself. The
 * matrix pdf.js accumulates at each image draw is the placement the user sees.
 *
 *   npx tsx test/image-edit.ts
 */
import { PDFDocument, PDFName, PDFRef } from 'pdf-lib'
import { writeFileSync } from 'fs'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  applyImageEdits,
  boxM,
  composeM,
  decomposeM,
  invM,
  mulM,
  previewDrawIndex,
  scanPageImages,
  type ImageDrawEdit,
  type Matrix
} from '../src/renderer/src/pdf/images'
import { bakeAndSave } from '../src/renderer/src/pdf/save'
import { remapModel, resizePages } from '../src/renderer/src/pdf/pagesize'
import type { DocModel, ImageEditAnnot, PageLeaf } from '../src/renderer/src/pdf/types'

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8Dwn4EIwDiqEAAQoQMOFCJ0oQAAAABJRU5ErkJggg=='
const pngBytes = Uint8Array.from(Buffer.from(PNG_B64, 'base64'))

const toBuf = (u8: Uint8Array): ArrayBuffer =>
  u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ok   ${name}`)
  } else {
    failures++
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`)
  }
}

function near(a: number, b: number, tol = 0.01): boolean {
  return Math.abs(a - b) <= tol
}

function matNear(a: Matrix, b: Matrix, tol = 0.01): boolean {
  return a.every((v, i) => near(v, b[i], tol))
}

const fmt = (m: Matrix): string => '[' + m.map((v) => v.toFixed(2)).join(' ') + ']'

// ---------------------------------------------------------------------------
// what pdf.js sees
// ---------------------------------------------------------------------------

/** Placement matrices of every image pdf.js paints on a page, in draw order. */
async function renderedImageMatrices(bytes: Uint8Array, pageNo: number): Promise<Matrix[]> {
  const doc = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise
  const page = await doc.getPage(pageNo)
  const ops = await page.getOperatorList()
  const out: Matrix[] = []
  const stack: Matrix[] = []
  let ctm: Matrix = [1, 0, 0, 1, 0, 0]
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i]
    const args = ops.argsArray[i] as never[]
    if (fn === OPS.save) stack.push(ctm)
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm
    else if (fn === OPS.transform) ctm = mulM(args as unknown as Matrix, ctm)
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm)
      // pdf.js passes a null matrix for a form that declares none
      const fm = args[0] as unknown as Matrix | null
      if (fm) ctm = mulM(fm, ctm)
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm
    else if (
      fn === OPS.paintImageXObject ||
      fn === OPS.paintImageMaskXObject ||
      fn === OPS.paintInlineImageXObject
    ) {
      out.push(ctm)
    }
  }
  await doc.destroy()
  return out
}

/** The clip rectangles pdf.js constructs on a page (crop shows up as one). */
async function clipRectCount(bytes: Uint8Array, pageNo: number): Promise<number> {
  const doc = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise
  const page = await doc.getPage(pageNo)
  const ops = await page.getOperatorList()
  let n = 0
  for (const fn of ops.fnArray) if (fn === OPS.clip || fn === OPS.eoClip) n++
  await doc.destroy()
  return n
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/**
 * Page 1: two plainly-drawn images.
 * Pages 2 and 3: the same Form XObject, which draws one image — the case where
 * editing must copy the form so only the edited page moves.
 */
async function makeFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const img = await doc.embedPng(pngBytes)

  const p1 = doc.addPage([612, 792])
  p1.drawImage(img, { x: 100, y: 500, width: 200, height: 150 })
  p1.drawImage(img, { x: 350, y: 100, width: 80, height: 80 })

  // a form xobject that draws the image, shared by two pages
  const formContent = `q 120 0 0 90 10 10 cm /ImF Do Q`
  const formStream = doc.context.flateStream(formContent, {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: doc.context.obj([0, 0, 140, 110]),
    Resources: doc.context.obj({ XObject: doc.context.obj({ ImF: img.ref }) })
  })
  const formRef = doc.context.register(formStream)

  for (const y of [300, 60]) {
    const page = doc.addPage([612, 792])
    const content = doc.context.flateStream(`q 1 0 0 1 200 ${y} cm /Fm1 Do Q`)
    page.node.set(PDFName.of('Contents'), doc.context.register(content))
    page.node.set(
      PDFName.of('Resources'),
      doc.context.obj({ XObject: doc.context.obj({ Fm1: formRef }) })
    )
  }

  const out = await doc.save()
  return out
}

/** A page whose only image is an *inline* image (BI … ID … EI). */
async function makeInlineFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([300, 300])
  // 2x2 8-bit greyscale, uncompressed: the length is arithmetic, which is the
  // path skipInlineData takes when there is no filter
  const data = String.fromCharCode(0, 90, 180, 255)
  const content = `q 100 0 0 100 50 50 cm BI /W 2 /H 2 /CS /G /BPC 8 ID ${data} EI Q\n0 0 1 RG 1 w 10 10 m 290 290 l S\n`
  const stream = doc.context.flateStream(content)
  page.node.set(PDFName.of('Contents'), doc.context.register(stream))
  const out = await doc.save()
  return out
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n1. scanning')
  const srcBytes = await makeFixture()
  const src = await PDFDocument.load(srcBytes)
  const found = scanPageImages(src, 0)
  check('page 1 has two images', found.length === 2, `found ${found.length}`)
  check('first image placed 200x150 at (100,500)', matNear(found[0]?.ctm, [200, 0, 0, 150, 100, 500]), fmt(found[0]?.ctm))
  check('second image placed 80x80 at (350,100)', matNear(found[1]?.ctm, [80, 0, 0, 80, 350, 100]), fmt(found[1]?.ctm))
  check('pixel size read from the XObject', found[0]?.pxWidth === 2 && found[0]?.pxHeight === 2)

  const nested = scanPageImages(src, 1)
  check('image inside a form is found', nested.length === 1, `found ${nested.length}`)
  check('form image is flagged nested', nested[0]?.nested === true)
  check(
    'form image carries the composed matrix',
    matNear(nested[0]?.ctm, [120, 0, 0, 90, 210, 310]),
    fmt(nested[0]?.ctm)
  )

  const asRendered = await renderedImageMatrices(srcBytes, 1)
  check(
    'our scan agrees with pdf.js on the source file',
    asRendered.length === 2 && matNear(asRendered[0], found[0].ctm) && matNear(asRendered[1], found[1].ctm),
    asRendered.map(fmt).join(' ')
  )

  console.log('\n2. move, resize, rotate and duplicate on a plain page')
  {
    const doc = await PDFDocument.load(srcBytes)
    const moved: Matrix = [260, 0, 0, 195, 40, 200] // bigger, and moved
    const spun = composeM(400, 600, 100, 60, 30) // rotated 30 degrees
    const copy: Matrix = [50, 0, 0, 50, 500, 700]
    const edits = new Map<number, ImageDrawEdit>([
      [0, { place: { m: moved }, copies: [{ m: copy }] }],
      [1, { place: { m: spun } }]
    ])
    applyImageEdits(doc, doc.getPages()[0], edits)
    const out = await doc.save()
    writeFileSync('test/out-imgedit-move.pdf', out)

    const seen = await renderedImageMatrices(out, 1)
    check('three draws now (two originals + one copy)', seen.length === 3, `saw ${seen.length}`)
    check('image 1 lands on its new matrix', matNear(seen[0], moved), fmt(seen[0]))
    check('the copy lands on its own matrix', matNear(seen[1], copy), fmt(seen[1]))
    check('image 2 is rotated 30 degrees', matNear(seen[2], spun), fmt(seen[2]))
    const d = decomposeM(seen[2])
    check('rotation decomposes back to 30 degrees', near(d.rotation, 30, 0.01), String(d.rotation))
    check('rotated size decomposes back to 100x60', near(d.w, 100) && near(d.h, 60), `${d.w}x${d.h}`)

    // the untouched page 2 must be byte-for-byte unaffected
    const other = await renderedImageMatrices(out, 2)
    check('a page with no edits is untouched', other.length === 1 && matNear(other[0], nested[0].ctm), other.map(fmt).join(''))
  }

  console.log('\n3. delete')
  {
    const doc = await PDFDocument.load(srcBytes)
    applyImageEdits(doc, doc.getPages()[0], new Map([[0, { deleted: true }]]))
    const out = await doc.save()
    const seen = await renderedImageMatrices(out, 1)
    check('deleted image is gone', seen.length === 1, `saw ${seen.length}`)
    check('the other image is where it was', matNear(seen[0], found[1].ctm), fmt(seen[0]))
  }

  console.log('\n4. crop')
  {
    const doc = await PDFDocument.load(srcBytes)
    // keep the middle half of the image, in place: the visible quad is the
    // middle half of where it was
    const crop = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }
    const visible: Matrix = [100, 0, 0, 75, 150, 537.5]
    const before = await clipRectCount(srcBytes, 1)
    applyImageEdits(doc, doc.getPages()[0], new Map([[0, { place: { m: visible, crop } }]]))
    const out = await doc.save()
    writeFileSync('test/out-imgedit-crop.pdf', out)

    const seen = await renderedImageMatrices(out, 1)
    // the *full* image matrix is the visible quad backed out through the crop
    const full = mulM(invM(boxM(crop))!, visible)
    check('cropped image draws at the full-image matrix', matNear(seen[0], full), fmt(seen[0]))
    check(
      'the visible quad is the crop of it',
      matNear(mulM(boxM(crop), seen[0]), visible),
      fmt(mulM(boxM(crop), seen[0]))
    )
    check('a clip path was added', (await clipRectCount(out, 1)) > before)
  }

  console.log('\n5. an image inside a shared form')
  {
    const doc = await PDFDocument.load(srcBytes)
    const target: Matrix = [200, 0, 0, 150, 50, 50]
    applyImageEdits(doc, doc.getPages()[1], new Map([[0, { place: { m: target } }]]))
    const out = await doc.save()
    writeFileSync('test/out-imgedit-form.pdf', out)

    const edited = await renderedImageMatrices(out, 2)
    const sibling = await renderedImageMatrices(out, 3)
    check('the edited page moved', edited.length === 1 && matNear(edited[0], target), edited.map(fmt).join(''))
    check(
      'the page sharing the form did NOT move',
      sibling.length === 1 && matNear(sibling[0], [120, 0, 0, 90, 210, 70]),
      sibling.map(fmt).join('')
    )
  }

  console.log('\n6. inline images')
  {
    const inlineBytes = await makeInlineFixture()
    const doc0 = await PDFDocument.load(inlineBytes)
    const imgs = scanPageImages(doc0, 0)
    check('inline image is found', imgs.length === 1, `found ${imgs.length}`)
    check('inline image is flagged inline', imgs[0]?.inline === true)
    check('inline placement read correctly', matNear(imgs[0]?.ctm, [100, 0, 0, 100, 50, 50]), fmt(imgs[0]?.ctm))
    check('inline pixel size read from the abbreviated dict', imgs[0]?.pxWidth === 2 && imgs[0]?.pxHeight === 2)

    const doc = await PDFDocument.load(inlineBytes)
    const target: Matrix = [60, 0, 0, 60, 200, 200]
    applyImageEdits(doc, doc.getPages()[0], new Map([[0, { place: { m: target } }]]))
    const out = await doc.save()
    writeFileSync('test/out-imgedit-inline.pdf', out)
    const seen = await renderedImageMatrices(out, 1)
    check('inline image moved', seen.length === 1 && matNear(seen[0], target), seen.map(fmt).join(''))

    // the stroked line after the inline image proves EI was located correctly:
    // a mis-parse would swallow it
    const rd = await getDocument({ data: new Uint8Array(out), isEvalSupported: false }).promise
    const ops = await (await rd.getPage(1)).getOperatorList()
    check('content after the inline image survived', ops.fnArray.includes(OPS.stroke))
    await rd.destroy()
  }

  console.log('\n7. re-scanning an edited file gives the same indices back')
  {
    const doc = await PDFDocument.load(srcBytes)
    applyImageEdits(doc, doc.getPages()[0], new Map([[0, { place: { m: [150, 0, 0, 150, 10, 10] } }]]))
    const out = await doc.save()
    const again = await PDFDocument.load(out)
    const imgs = scanPageImages(again, 0)
    check('still two images, in the same order', imgs.length === 2)
    check('first is at its edited placement', matNear(imgs[0]?.ctm, [150, 0, 0, 150, 10, 10]), fmt(imgs[0]?.ctm))
    check('second is untouched', matNear(imgs[1]?.ctm, [80, 0, 0, 80, 350, 100]), fmt(imgs[1]?.ctm))
  }

  console.log('\n8. the save pipeline carries image edits through')
  {
    const leaves: PageLeaf[] = [
      { id: 'L1', srcPage: 1, rotation: 0 },
      { id: 'L2', srcPage: 2, rotation: 0 },
      { id: 'L3', srcPage: 3, rotation: 0 }
    ]
    const moved: Matrix = [180, 0, 0, 135, 60, 300]
    const copy: Matrix = [90, 0, 0, 68, 400, 620]
    const model: DocModel = {
      fileName: 'imgedit.pdf',
      leaves,
      images: {},
      calibrations: {},
      annotations: [
        { id: 'e1', leafId: 'L1', type: 'imgedit', drawIndex: 0, instance: 0, m: moved },
        { id: 'e2', leafId: 'L1', type: 'imgedit', drawIndex: 0, instance: 1, m: copy },
        { id: 'e3', leafId: 'L1', type: 'imgedit', drawIndex: 1, instance: 0, m: [1, 0, 0, 1, 0, 0], deleted: true },
        {
          id: 't1',
          leafId: 'L1',
          type: 'text',
          a: { x: 40, y: 700 },
          b: { x: 300, y: 720 },
          text: 'still here',
          fontSize: 12
        }
      ]
    }
    const out = await bakeAndSave(toBuf(srcBytes), model, { flatten: true })
    writeFileSync('test/out-imgedit-saved.pdf', out)
    const seen = await renderedImageMatrices(out, 1)
    check('saved file keeps the moved image and its copy, and drops the deleted one', seen.length === 2, `saw ${seen.length}`)
    check('moved image saved at its new placement', matNear(seen[0], moved), fmt(seen[0]))
    check('the copy saved at its own placement', matNear(seen[1], copy), fmt(seen[1]))

    const rd = await getDocument({ data: new Uint8Array(out), isEvalSupported: false }).promise
    const text = (await (await rd.getPage(1)).getTextContent()).items
      .map((i) => (i as { str: string }).str)
      .join('')
    check('other marks still bake alongside the image edits', text.includes('still here'), text.slice(0, 40))
    await rd.destroy()

    const again = scanPageImages(await PDFDocument.load(out), 0)
    check('the saved file re-scans to two images', again.length === 2, `found ${again.length}`)
  }

  console.log('\n9. standard page size')
  {
    // the page a scanner actually produces: nearly Letter, but not quite
    const odd = await PDFDocument.create()
    const img = await odd.embedPng(pngBytes)
    const page = odd.addPage([605, 785])
    page.drawImage(img, { x: 50, y: 50, width: 505, height: 685 })
    page.drawText('scan', { x: 20, y: 760, size: 10 })
    const oddBytes = await odd.save()

    const model: DocModel = {
      fileName: 'scan.pdf',
      leaves: [{ id: 'S1', srcPage: 1, rotation: 0 }],
      images: {},
      calibrations: { S1: { unitsPerPoint: 2, unit: 'ft' } },
      annotations: [
        {
          id: 'm1',
          leafId: 'S1',
          type: 'measure',
          kind: 'length',
          pts: [
            { x: 100, y: 100 },
            { x: 200, y: 100 }
          ],
          color: '#f00',
          value: 200,
          label: '200 ft'
        }
      ]
    }

    // keep: the content stays its own size, centred on the bigger sheet
    const keep = await resizePages(toBuf(oddBytes), {
      size: { w: 612, h: 792 },
      orientation: 'auto',
      fit: 'keep',
      pages: [0]
    })
    const kdoc = await getDocument({ data: new Uint8Array(keep.bytes), isEvalSupported: false }).promise
    const kvp = (await kdoc.getPage(1)).getViewport({ scale: 1 })
    check('keep: the page is exactly Letter', near(kvp.width, 612, 0.01) && near(kvp.height, 792, 0.01), `${kvp.width}x${kvp.height}`)
    await kdoc.destroy()
    const kimg = await renderedImageMatrices(keep.bytes, 1)
    check(
      'keep: the picture is the same size, shifted by the new margins',
      matNear(kimg[0], [505, 0, 0, 685, 53.5, 53.5]),
      fmt(kimg[0])
    )
    const kmodel = remapModel(model, keep.transforms)
    const km = kmodel.annotations[0] as unknown as { pts: { x: number; y: number }[] }
    check('keep: a measurement moves with the content', near(km.pts[0].x, 103.5) && near(km.pts[0].y, 103.5), JSON.stringify(km.pts[0]))
    check('keep: the drawing scale is unchanged', kmodel.calibrations.S1.unitsPerPoint === 2)

    // scale: the content grows to fill the sheet
    const scaled = await resizePages(toBuf(oddBytes), {
      size: { w: 612, h: 792 },
      orientation: 'auto',
      fit: 'scale',
      pages: [0]
    })
    const s = Math.min(612 / 605, 792 / 785)
    const simg = await renderedImageMatrices(scaled.bytes, 1)
    check('scale: the picture grew by the fit factor', near(simg[0][0], 505 * s, 0.05), fmt(simg[0]))
    const smodel = remapModel(model, scaled.transforms)
    check(
      'scale: the drawing scale is corrected so measurements still read the same',
      near(smodel.calibrations.S1.unitsPerPoint, 2 / s, 1e-6),
      String(smodel.calibrations.S1.unitsPerPoint)
    )

    const rdoc = await PDFDocument.load(scaled.bytes)
    const found2 = scanPageImages(rdoc, 0)
    check('images on a resized page are still editable', found2.length === 1, `found ${found2.length}`)
    check('and sit where pdf.js draws them', matNear(found2[0].ctm, simg[0]), fmt(found2[0]?.ctm))

    const noop = await resizePages(toBuf(keep.bytes), {
      size: { w: 612, h: 792 },
      orientation: 'auto',
      fit: 'keep',
      pages: [0]
    })
    check('a page already the right size is left alone', noop.changed === 0, `changed ${noop.changed}`)
  }

  console.log('\n10. draw indices in the previewed document')
  {
    const rec = (drawIndex: number, instance: number, deleted = false): ImageEditAnnot => ({
      id: `r${drawIndex}.${instance}`,
      leafId: 'L1',
      type: 'imgedit',
      drawIndex,
      instance,
      m: [1, 0, 0, 1, 0, 0],
      deleted: deleted || undefined
    })
    check('nothing edited: index is unchanged', previewDrawIndex([], 2) === 2)
    check('a delete before it shifts it down', previewDrawIndex([rec(0, 0, true)], 2) === 1)
    check('a copy before it pushes it up', previewDrawIndex([rec(0, 1)], 2) === 3)
    check('delete + copy cancel out', previewDrawIndex([rec(0, 0, true), rec(0, 1)], 2) === 2)
    check('a deleted draw with no copies has no index', previewDrawIndex([rec(1, 0, true)], 1) === -1)
    check('a deleted draw still resolves to its copy', previewDrawIndex([rec(1, 0, true), rec(1, 1)], 1) === 1)
  }

  console.log(failures === 0 ? '\nAll image-edit checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
