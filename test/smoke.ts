import { PDFDocument, PDFDict, PDFHexString, PDFName, PDFRef, PDFString, PDFArray, StandardFonts, rgb } from 'pdf-lib'
import { writeFileSync } from 'fs'
import { bakeAndSave, extractPages } from '../src/renderer/src/pdf/save'
import { EDITABLE_KEYWORD, importStudioAnnots } from '../src/renderer/src/pdf/annots'
import { detectFields } from '../src/renderer/src/pdf/forms'
import type { DocModel, PageLeaf, RectAnnot, ShapeAnnot } from '../src/renderer/src/pdf/types'

// A tiny 2x2 red PNG (base64) to exercise the image/signature path.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8Dwn4EIwDiqEAAQoQMOFCJ0oQAAAABJRU5ErkJggg=='
const pngBytes = Uint8Array.from(Buffer.from(PNG_B64, 'base64'))

async function makeBasePdf(): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create()
  const form = doc.getForm()
  for (let i = 0; i < 3; i++) {
    const page = doc.addPage([612, 792])
    page.drawText(`Original page ${i + 1}`, { x: 50, y: 740, size: 20, color: rgb(0, 0, 0.6) })
    page.drawRectangle({ x: 50, y: 400, width: 200, height: 100, borderColor: rgb(0, 0, 0), borderWidth: 1 })
  }
  // Add a real AcroForm text field + checkbox on page 1 to exercise widget stripping.
  const tf = form.createTextField('applicant.name')
  tf.addToPage(doc.getPage(0), { x: 60, y: 300, width: 220, height: 20 })
  const cb = form.createCheckBox('agree')
  cb.addToPage(doc.getPage(0), { x: 60, y: 260, width: 16, height: 16 })
  const bytes = await doc.save()
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

async function main(): Promise<void> {
  const src = await makeBasePdf()

  const leaves: PageLeaf[] = [
    { id: 'L1', srcPage: 1, rotation: 0 },
    { id: 'L2', srcPage: 2, rotation: 90 },
    { id: 'L3', srcPage: 3, rotation: 0 }
  ]

  const model: DocModel = {
    fileName: 'test.pdf',
    // reorder: put page 3 first, drop nothing
    leaves: [leaves[2], leaves[0], leaves[1]],
    images: {
      sig1: {
        id: 'sig1',
        kind: 'png',
        dataUrl: 'data:image/png;base64,' + PNG_B64,
        bytes: pngBytes.buffer.slice(pngBytes.byteOffset, pngBytes.byteOffset + pngBytes.byteLength) as ArrayBuffer,
        width: 2,
        height: 2
      }
    },
    calibrations: { L1: { unitsPerPoint: 0.5, unit: 'ft' } },
    annotations: [
      { id: 't1', leafId: 'L1', type: 'text', a: { x: 60, y: 600 }, b: { x: 300, y: 560 }, text: 'Filled-in text overlay for a scanned form field.', fontSize: 12, color: '#111111' },
      { id: 'w1', leafId: 'L1', type: 'whiteout', a: { x: 55, y: 735 }, b: { x: 250, y: 755 }, color: '#ffffff' },
      { id: 'c1', leafId: 'L1', type: 'check', a: { x: 320, y: 600 }, b: { x: 340, y: 620 }, color: '#0a7d29' },
      { id: 'x1', leafId: 'L1', type: 'cross', a: { x: 320, y: 560 }, b: { x: 340, y: 580 }, color: '#b91c1c' },
      { id: 'o1', leafId: 'L1', type: 'circle', a: { x: 60, y: 640 }, b: { x: 160, y: 690 }, color: '#111111' },
      // same on the 90°-rotated leaf, so the Frame math gets exercised too
      { id: 'o2', leafId: 'L2', type: 'circle', a: { x: 60, y: 640 }, b: { x: 160, y: 690 }, color: '#b91c1c' },
      { id: 'img1', leafId: 'L1', type: 'image', a: { x: 350, y: 500 }, b: { x: 500, y: 560 }, imageId: 'sig1' },
      { id: 'm1', leafId: 'L1', type: 'measure', kind: 'length', pts: [{ x: 50, y: 100 }, { x: 250, y: 100 }], color: '#2563eb', value: 100, label: '100 ft' },
      { id: 'm2', leafId: 'L2', type: 'measure', kind: 'area', pts: [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 300 }, { x: 100, y: 300 }], color: '#d97706', value: 10000, label: '10,000 ft²' },
      { id: 'f1', leafId: 'L1', type: 'field', fieldKind: 'text', fieldName: 'applicant.name', a: { x: 60, y: 300 }, b: { x: 280, y: 320 }, value: 'FIELDVALUEXYZ', order: 0 },
      { id: 'f2', leafId: 'L1', type: 'field', fieldKind: 'checkbox', fieldName: 'agree', a: { x: 60, y: 260 }, b: { x: 76, y: 276 }, value: 'On', exportValue: 'On', order: 1 },
      { id: 'hl1', leafId: 'L1', type: 'markup', kind: 'highlight', rects: [{ x: 50, y: 736, w: 160, h: 22 }], color: '#ffd400' },
      { id: 'ul1', leafId: 'L2', type: 'markup', kind: 'underline', rects: [{ x: 50, y: 736, w: 160, h: 22 }], color: '#b91c1c' }
    ]
  }

  const out = await bakeAndSave(src, model)
  writeFileSync('test/out-baked.pdf', out)
  console.log('baked bytes:', out.length)

  const extracted = await extractPages(src, model, ['L1'])
  writeFileSync('test/out-extract.pdf', extracted)
  console.log('extracted bytes:', extracted.length)

  // Basic structural assertions
  const reload = await PDFDocument.load(out)
  if (reload.getPageCount() !== 3) throw new Error('expected 3 pages, got ' + reload.getPageCount())
  const remainingFields = reload.getForm().getFields().length
  if (remainingFields !== 0) throw new Error('expected form fields flattened, got ' + remainingFields)
  const ex = await PDFDocument.load(extracted)
  if (ex.getPageCount() !== 1) throw new Error('expected 1 extracted page, got ' + ex.getPageCount())
  console.log('OK: 3 baked, 1 extracted, form widgets flattened (0 interactive fields remain)')
  // (the baked circle/oval outlines are asserted by render-check.mjs, which can
  // decode the flate-compressed content stream pdf-lib appends)

  // ---- duplicate leaf + reorder in-place --------------------------------
  const dupModel: DocModel = {
    ...model,
    leaves: [leaves[2], leaves[0], { id: 'L1b', srcPage: 1, rotation: 0 }, leaves[1]]
  }
  const dupOut = await bakeAndSave(src, dupModel)
  const dupReload = await PDFDocument.load(dupOut)
  if (dupReload.getPageCount() !== 4) throw new Error('expected 4 pages after duplicate, got ' + dupReload.getPageCount())
  console.log('OK: duplicated page baked (4 pages)')

  // ---- keep-forms mode: fields stay live with values filled -------------
  const keepOut = await bakeAndSave(src, model, { keepForms: true })
  writeFileSync('test/out-keepforms.pdf', keepOut)
  const keepReload = await PDFDocument.load(keepOut)
  const form = keepReload.getForm()
  const nameVal = form.getTextField('applicant.name').getText()
  if (nameVal !== 'FIELDVALUEXYZ') throw new Error('keep-forms text value lost: ' + nameVal)
  if (!form.getCheckBox('agree').isChecked()) throw new Error('keep-forms checkbox not checked')
  console.log('OK: keep-forms save preserved live fields with values')

  await prefilledFormChecks()

  // ---- OCR words bake as invisible text; whiteouted words never do -------
  const ocrModel: DocModel = {
    fileName: 'ocr.pdf',
    leaves: [{ id: 'L1', srcPage: 1, rotation: 0 }],
    images: {},
    calibrations: {},
    annotations: [
      // covers the area where the SECRET word sits
      { id: 'wR', leafId: 'L1', type: 'whiteout', a: { x: 100, y: 90 }, b: { x: 320, y: 140 }, color: '#ffffff' }
    ]
  }
  const ocrOut = await bakeAndSave(src, ocrModel, {
    ocrWords: (sp) =>
      sp === 1
        ? [
            { text: 'SEARCHABLE', rect: { x: 60, y: 500, w: 130, h: 14 } },
            { text: 'SECRET', rect: { x: 140, y: 100, w: 90, h: 14 } }
          ]
        : undefined
  })
  writeFileSync('test/out-ocr.pdf', ocrOut)
  console.log('OK: OCR bake written (verified by render-check)')

  // ---- cover (Edit Text) is a plain vector patch + custom font text ------
  const coverModel: DocModel = {
    fileName: 'cover.pdf',
    leaves: [{ id: 'L1', srcPage: 1, rotation: 0 }],
    images: {},
    calibrations: {},
    annotations: [
      { id: 'cv', leafId: 'L1', type: 'cover', a: { x: 48, y: 735 }, b: { x: 260, y: 760 }, color: '#ffffff' },
      { id: 'tx', leafId: 'L1', type: 'text', a: { x: 50, y: 737 }, b: { x: 300, y: 758 }, text: 'Replacement heading', fontSize: 16, color: '#111111', font: 'timesB' }
    ]
  }
  const coverOut = await bakeAndSave(src, coverModel, {
    // no rasterizeLeaf on purpose: covers must never require rasterisation
    ocrWords: () => undefined
  })
  const coverReload = await PDFDocument.load(coverOut)
  if (coverReload.getPageCount() !== 1) throw new Error('cover bake page count')
  writeFileSync('test/out-cover.pdf', coverOut)
  console.log('OK: cover + Times-Bold text baked (vector, no raster)')

  // ---- layers: OCG visibility persists into the saved default config -----
  const layeredSrc = await makeLayeredPdf()
  writeFileSync('test/out-layered-src.pdf', Buffer.from(layeredSrc.bytes))
  const layerModel: DocModel = {
    fileName: 'layers.pdf',
    leaves: [{ id: 'L1', srcPage: 1, rotation: 0 }],
    images: {},
    calibrations: {},
    annotations: []
  }
  const layeredOut = await bakeAndSave(layeredSrc.bytes, layerModel, {
    layers: [
      { id: `${layeredSrc.ocg1Num}R`, visible: true },
      { id: `${layeredSrc.ocg2Num}R`, visible: false }
    ]
  })
  writeFileSync('test/out-layered.pdf', layeredOut)
  const lr = await PDFDocument.load(layeredOut)
  const ocProps = lr.catalog.lookupMaybe(PDFName.of('OCProperties'), PDFDict)
  if (!ocProps) throw new Error('OCProperties lost on save')
  const dCfg = ocProps.lookupMaybe(PDFName.of('D'), PDFDict)
  const offArr = dCfg?.lookupMaybe(PDFName.of('OFF'), PDFArray)
  const offRefs: string[] = []
  if (offArr) for (let i = 0; i < offArr.size(); i++) offRefs.push(String(offArr.get(i)))
  if (!offRefs.some((r) => r.startsWith(`${layeredSrc.ocg2Num} `))) {
    throw new Error('hidden layer not in OFF array: ' + JSON.stringify(offRefs))
  }
  console.log('OK: layer visibility persisted (OFF contains hidden OCG)')

  await editableAnnotChecks(src, leaves)
  await drawShapeChecks(src, leaves)
}

/**
 * A form somebody else already filled in (Nitro/Acrobat/PDF-XChange): every
 * widget carries a baked /AP holding its value. One field is read-only.
 */
async function makePrefilledForm(): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const form = doc.getForm()
  const open = form.createTextField('visible.name')
  open.setText('TYPEDINNITRO')
  open.addToPage(page, { x: 60, y: 700, width: 220, height: 20 })
  const locked = form.createTextField('locked.ref')
  locked.setText('READONLYVALUE')
  locked.enableReadOnly()
  locked.addToPage(page, { x: 60, y: 660, width: 220, height: 20 })
  // pdf-lib writes the appearance streams on save, same as any other producer
  const bytes = await doc.save()
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** Widget annotations still on a page, by field name. */
function widgetNames(doc: PDFDocument, pageIndex = 0): string[] {
  const annots = doc.getPage(pageIndex).node.Annots()
  const names: string[] = []
  if (!annots) return names
  for (let i = 0; i < annots.size(); i++) {
    const dict = doc.context.lookupMaybe(annots.get(i), PDFDict)
    if (!dict || dict.get(PDFName.of('Subtype')) !== PDFName.of('Widget')) continue
    const title = (d?: PDFDict): string | undefined =>
      d?.lookupMaybe(PDFName.of('T'), PDFString, PDFHexString)?.decodeText()
    const t = title(dict) ?? title(dict.lookupMaybe(PDFName.of('Parent'), PDFDict))
    names.push(t ?? '?')
  }
  return names
}

/**
 * A pre-filled form must show each value exactly once. The overlay owns the
 * fillable fields (the canvas is rendered with ENABLE_FORMS, which drops their
 * baked appearances); everything the viewer keeps painting itself — read-only
 * fields, push buttons, signatures — must stay out of the overlay, and must
 * survive a flatten, because nothing in the model redraws it.
 */
async function prefilledFormChecks(): Promise<void> {
  const bytes = await makePrefilledForm()
  writeFileSync('test/out-prefilled-src.pdf', Buffer.from(bytes))

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), isEvalSupported: false }).promise
  const leaves: PageLeaf[] = [{ id: 'L1', srcPage: 1, rotation: 0 }]
  const detected = await detectFields(doc, leaves)
  const names = detected.map((f) => f.fieldName).sort()
  if (names.join(',') !== 'visible.name') {
    throw new Error('detectFields must claim only the fillable widget, got: ' + JSON.stringify(names))
  }
  if (detected[0].value !== 'TYPEDINNITRO') throw new Error('pre-filled value not read: ' + detected[0].value)
  await doc.destroy()

  const flat = await bakeAndSave(bytes, {
    fileName: 'prefilled.pdf',
    leaves,
    images: {},
    calibrations: {},
    annotations: detected
  })
  writeFileSync('test/out-prefilled-flat.pdf', flat)
  const reload = await PDFDocument.load(flat)
  // widgets carry the terminal field name; 'locked.ref' lives under a parent
  const left = widgetNames(reload)
  if (left.join(',') !== 'ref') {
    throw new Error('flatten must drop the filled widget and keep the read-only one, got: ' + JSON.stringify(left))
  }
  console.log('OK: pre-filled form — overlay owns the fillable field, read-only widget survives flatten')
}

/** The Draw tab's shapes, on a plain and on a rotated page. */
const DRAW_SHAPES: ShapeAnnot[] = [
  { id: 's-line', leafId: 'L1', type: 'shape', kind: 'line', pts: [{ x: 60, y: 300 }, { x: 240, y: 360 }], color: '#111111', width: 2 },
  { id: 's-arrow', leafId: 'L1', type: 'shape', kind: 'arrow', pts: [{ x: 60, y: 260 }, { x: 240, y: 260 }], color: '#b91c1c', width: 3, arrowEnd: true },
  { id: 's-rect', leafId: 'L1', type: 'shape', kind: 'rect', pts: [{ x: 300, y: 260 }, { x: 420, y: 340 }], color: '#1d4ed8', width: 2, fill: '#ffd400', fillAlpha: 0.25 },
  { id: 's-ellipse', leafId: 'L1', type: 'shape', kind: 'ellipse', pts: [{ x: 300, y: 380 }, { x: 430, y: 450 }], color: '#0a7d29', width: 1.5, dash: true },
  { id: 's-poly', leafId: 'L1', type: 'shape', kind: 'polyline', pts: [{ x: 60, y: 180 }, { x: 120, y: 220 }, { x: 190, y: 170 }, { x: 250, y: 215 }], color: '#7c3aed', width: 2 },
  { id: 's-gon', leafId: 'L1', type: 'shape', kind: 'polygon', pts: [{ x: 300, y: 150 }, { x: 400, y: 150 }, { x: 380, y: 230 }, { x: 310, y: 220 }], color: '#d97706', width: 2, fill: '#d97706', fillAlpha: 0.25 },
  { id: 's-ink', leafId: 'L1', type: 'shape', kind: 'ink', pts: [], strokes: [[{ x: 460, y: 160 }, { x: 480, y: 200 }, { x: 500, y: 150 }, { x: 520, y: 210 }]], color: '#111111', width: 1.5 },
  // same treatment on the 90°-rotated leaf, to exercise the appearance /Matrix
  { id: 's-rot', leafId: 'L2', type: 'shape', kind: 'arrow', pts: [{ x: 80, y: 300 }, { x: 260, y: 340 }], color: '#1d4ed8', width: 2.5, arrowStart: true, arrowEnd: true }
]

/**
 * Drawings are editable annotations like the rest, but they carry their own
 * geometry: exact points have to survive the round trip, and none of it may be
 * mistaken for a measurement (no scale, no label).
 */
async function drawShapeChecks(src: ArrayBuffer, leaves: PageLeaf[]): Promise<void> {
  const model: DocModel = {
    fileName: 'draw.pdf',
    leaves: [leaves[0], leaves[1]],
    images: {},
    calibrations: {},
    annotations: DRAW_SHAPES
  }

  const out = await bakeAndSave(src, model, {})
  writeFileSync('test/out-draw.pdf', out)
  const doc = await PDFDocument.load(out)
  const kinds = annotBreakdown(doc, 0).mine.map(subtypeOf).sort()
  const want = ['Circle', 'Ink', 'Line', 'Line', 'PolyLine', 'Polygon', 'Square']
  if (kinds.join(',') !== want.join(',')) {
    throw new Error(`draw save wrote ${kinds.join(',')} — expected ${want.join(',')}`)
  }
  for (const d of annotBreakdown(doc, 0).mine) {
    const ap = d.lookupMaybe(PDFName.of('AP'), PDFDict)
    if (!ap || !ap.get(PDFName.of('N'))) throw new Error(subtypeOf(d) + ' drawing has no appearance stream')
  }
  if (annotBreakdown(doc, 1).mine.length !== 1) throw new Error('drawing on the rotated page went missing')
  console.log(`OK: ${kinds.length + 1} drawings saved as standard annotations with appearances`)

  const imported = await importStudioAnnots(out)
  if (!imported) throw new Error('drawings did not come back on import')
  const back = imported.byPage.flat() as ShapeAnnot[]
  if (back.length !== DRAW_SHAPES.length) throw new Error(`expected ${DRAW_SHAPES.length} drawings back, got ${back.length}`)
  const byId = new Map(back.map((a) => [a.id, a]))
  for (const orig of DRAW_SHAPES) {
    const got = byId.get(orig.id)
    if (!got || got.type !== 'shape') throw new Error(orig.id + ' did not round-trip')
    if (got.kind !== orig.kind) throw new Error(`${orig.id} came back as ${got.kind}`)
    if (got.color !== orig.color || got.width !== orig.width) throw new Error(orig.id + ' lost its pen settings')
    const a = orig.kind === 'ink' ? orig.strokes!.flat() : orig.pts
    const b = got.kind === 'ink' ? (got.strokes || []).flat() : got.pts
    if (a.length !== b.length) throw new Error(`${orig.id} point count drifted: ${a.length} -> ${b.length}`)
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i].x - b[i].x) > 0.01 || Math.abs(a[i].y - b[i].y) > 0.01) {
        throw new Error(`${orig.id} point ${i} drifted: ${JSON.stringify([a[i], b[i]])}`)
      }
    }
    if ((orig.fill ?? null) !== (got.fill ?? null)) throw new Error(orig.id + ' lost its fill')
    if (!!orig.dash !== !!got.dash) throw new Error(orig.id + ' lost its dashes')
    if (!!orig.arrowStart !== !!got.arrowStart || !!orig.arrowEnd !== !!got.arrowEnd) {
      throw new Error(orig.id + ' lost an arrow head')
    }
  }
  console.log('OK: every drawing round-trips with its exact points, pen, fill and arrow heads')

  const flat = await bakeAndSave(src, model, { flatten: true })
  writeFileSync('test/out-draw-flat.pdf', flat)
  const flatDoc = await PDFDocument.load(flat)
  if (annotBreakdown(flatDoc, 0).mine.length !== 0) throw new Error('flatten left drawings as annotations')
  console.log('OK: drawings flatten into the page like every other mark')
}

/** Count the annotations on a page, split into ours and everyone else's. */
function annotBreakdown(doc: PDFDocument, pageIndex: number): { mine: PDFDict[]; foreign: PDFDict[] } {
  const page = doc.getPages()[pageIndex]
  const arr = page.node.Annots()
  const mine: PDFDict[] = []
  const foreign: PDFDict[] = []
  if (arr) {
    for (let i = 0; i < arr.size(); i++) {
      const d = doc.context.lookupMaybe(arr.get(i), PDFDict)
      if (!d) continue
      ;(d.lookupMaybe(PDFName.of('PDFStudio'), PDFDict) ? mine : foreign).push(d)
    }
  }
  return { mine, foreign }
}

const subtypeOf = (d: PDFDict): string => String(d.lookup(PDFName.of('Subtype'))).replace('/', '')

/**
 * Editable-by-default: text / check / X / circle / markup save as real PDF
 * annotations, come back as model objects, and only turn into page content when
 * the save flattens.
 */
async function editableAnnotChecks(src: ArrayBuffer, leaves: PageLeaf[]): Promise<void> {
  const model: DocModel = {
    fileName: 'editable.pdf',
    leaves: [leaves[0], leaves[1]],
    images: {},
    calibrations: {},
    annotations: [
      { id: 'e-text', leafId: 'L1', type: 'text', a: { x: 60, y: 620 }, b: { x: 260, y: 600 }, text: 'Stays editable', fontSize: 12, color: '#111111', autoWidth: true },
      { id: 'e-check', leafId: 'L1', type: 'check', a: { x: 300, y: 600 }, b: { x: 320, y: 620 }, color: '#0a7d29' },
      { id: 'e-cross', leafId: 'L1', type: 'cross', a: { x: 330, y: 600 }, b: { x: 350, y: 620 }, color: '#b91c1c' },
      { id: 'e-circle', leafId: 'L1', type: 'circle', a: { x: 60, y: 500 }, b: { x: 160, y: 550 }, color: '#1d4ed8' },
      { id: 'e-hl', leafId: 'L1', type: 'markup', kind: 'highlight', rects: [{ x: 50, y: 736, w: 160, h: 22 }], color: '#ffd400' },
      { id: 'e-ul', leafId: 'L1', type: 'markup', kind: 'underline', rects: [{ x: 50, y: 700, w: 120, h: 20 }], color: '#b91c1c' },
      // on the 90°-rotated leaf, to exercise the appearance /Matrix
      { id: 'e-rot', leafId: 'L2', type: 'text', a: { x: 80, y: 400 }, b: { x: 280, y: 380 }, text: 'Rotated page', fontSize: 14, color: '#7c3aed' },
      // baked regardless: a measurement and an Edit-Text cover patch
      { id: 'e-m', leafId: 'L1', type: 'measure', kind: 'length', pts: [{ x: 50, y: 100 }, { x: 250, y: 100 }], color: '#2563eb', value: 100, label: '100 ft' }
    ]
  }

  const out = await bakeAndSave(src, model, {})
  writeFileSync('test/out-editable.pdf', out)
  const doc = await PDFDocument.load(out)
  const p1 = annotBreakdown(doc, 0)
  const kinds = p1.mine.map(subtypeOf).sort()
  const want = ['Circle', 'FreeText', 'Highlight', 'Stamp', 'Stamp', 'Underline']
  if (kinds.join(',') !== want.join(',')) {
    throw new Error(`editable save wrote ${kinds.join(',')} — expected ${want.join(',')}`)
  }
  if (annotBreakdown(doc, 1).mine.length !== 1) throw new Error('rotated-page annotation missing')
  const kw = doc.getKeywords() ?? ''
  if (!kw.includes(EDITABLE_KEYWORD)) throw new Error('editable-annotations keyword not set: ' + JSON.stringify(kw))
  // every one of them must carry an appearance, or other viewers show nothing
  for (const d of p1.mine) {
    const ap = d.lookupMaybe(PDFName.of('AP'), PDFDict)
    if (!ap || !ap.get(PDFName.of('N'))) throw new Error(subtypeOf(d) + ' has no /AP /N appearance stream')
  }
  console.log(`OK: editable save wrote ${p1.mine.length + 1} real annotations, each with an appearance stream`)

  // ---- round trip: import puts them back as model objects ----------------
  const imported = await importStudioAnnots(out)
  if (!imported) throw new Error('import found none of our annotations')
  const back = imported.byPage.flat()
  if (back.length !== 7) throw new Error('expected 7 annotations back, got ' + back.length)
  const byId = new Map(back.map((a) => [a.id, a]))
  const t = byId.get('e-text') as RectAnnot | undefined
  if (!t || t.type !== 'text') throw new Error('text box did not round-trip')
  if (t.text !== 'Stays editable') throw new Error('text content lost: ' + JSON.stringify(t.text))
  if (t.fontSize !== 12 || t.color !== '#111111' || t.autoWidth !== true) {
    throw new Error('text box lost its formatting: ' + JSON.stringify(t))
  }
  // geometry: a is the top-left corner, b the bottom-right, as placed
  if (Math.abs(t.a.x - 60) > 0.01 || Math.abs(t.a.y - 620) > 0.01 || Math.abs(t.b.x - 260) > 0.01 || Math.abs(t.b.y - 600) > 0.01) {
    throw new Error('text box geometry drifted: ' + JSON.stringify({ a: t.a, b: t.b }))
  }
  const hl = byId.get('e-hl')
  if (!hl || hl.type !== 'markup' || hl.kind !== 'highlight') throw new Error('highlight did not round-trip')
  const r0 = hl.rects[0]
  if (Math.abs(r0.x - 50) > 0.01 || Math.abs(r0.y - 736) > 0.01 || Math.abs(r0.w - 160) > 0.01 || Math.abs(r0.h - 22) > 0.01) {
    throw new Error('highlight rect drifted: ' + JSON.stringify(r0))
  }
  if ((byId.get('e-circle') as RectAnnot | undefined)?.color !== '#1d4ed8') throw new Error('circle colour lost')
  if (byId.get('e-check')?.type !== 'check' || byId.get('e-cross')?.type !== 'cross') {
    throw new Error('check/X kinds not distinguished on import')
  }
  // and the file it hands back must be clean of them
  const stripped = await PDFDocument.load(imported.bytes)
  if (annotBreakdown(stripped, 0).mine.length !== 0) throw new Error('import left our annotations in the file')
  if ((stripped.getKeywords() ?? '').includes(EDITABLE_KEYWORD)) throw new Error('keyword survived the import')
  console.log('OK: annotations round-trip back into editable model objects (geometry, text, colour, flags)')

  // ---- foreign annotations are never touched ------------------------------
  const withForeign = await PDFDocument.load(out)
  const note = withForeign.context.register(
    withForeign.context.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: [500, 700, 520, 720],
      T: PDFString.of('Someone Else'),
      Contents: PDFString.of('please review')
    })
  )
  withForeign.getPages()[0].node.addAnnot(note)
  const foreignBytes = await withForeign.save()
  const afterImport = await importStudioAnnots(
    foreignBytes.buffer.slice(foreignBytes.byteOffset, foreignBytes.byteOffset + foreignBytes.byteLength) as ArrayBuffer
  )
  if (!afterImport) throw new Error('import bailed out when a foreign annotation was present')
  const cleaned = await PDFDocument.load(afterImport.bytes)
  const bd = annotBreakdown(cleaned, 0)
  if (bd.mine.length !== 0) throw new Error('our annotations survived the import')
  if (bd.foreign.length !== 1 || subtypeOf(bd.foreign[0]) !== 'Text') {
    throw new Error('foreign annotation was not left alone: ' + bd.foreign.map(subtypeOf).join(','))
  }
  console.log("OK: someone else's annotations are left untouched by the import")

  // ---- flatten: same marks, burned in, nothing editable left --------------
  const flat = await bakeAndSave(src, model, { flatten: true })
  writeFileSync('test/out-flat.pdf', flat)
  const flatDoc = await PDFDocument.load(flat)
  if (annotBreakdown(flatDoc, 0).mine.length !== 0) throw new Error('flatten still wrote annotations')
  if ((flatDoc.getKeywords() ?? '').includes(EDITABLE_KEYWORD)) throw new Error('flatten left the editable keyword set')
  if (await importStudioAnnots(flat)) throw new Error('flattened file still has importable annotations')
  if (flat.length <= 0) throw new Error('empty flatten output')
  console.log('OK: flatten burns the same marks in and leaves nothing importable')
}

/** Build a 1-page PDF with two real optional-content layers. */
async function makeLayeredPdf(): Promise<{ bytes: ArrayBuffer; ocg1Num: number; ocg2Num: number }> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const ctx = doc.context
  const ocg1 = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Base Layer') }))
  const ocg2 = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Markups') }))
  doc.catalog.set(
    PDFName.of('OCProperties'),
    ctx.obj({ OCGs: [ocg1, ocg2], D: ctx.obj({ Order: [ocg1, ocg2] }) })
  )
  // register the OCGs in the page resources and wrap two text runs in BDC/EMC
  const resources = page.node.lookupMaybe(PDFName.of('Resources'), PDFDict)!
  resources.set(PDFName.of('Properties'), ctx.obj({ L1: ocg1, L2: ocg2 }))
  const { PDFOperator, PDFOperatorNames } = await import('pdf-lib')
  const bdc = (tag: string): InstanceType<typeof PDFOperator> =>
    PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [PDFName.of('OC'), PDFName.of(tag)])
  const emc = (): InstanceType<typeof PDFOperator> => PDFOperator.of(PDFOperatorNames.EndMarkedContent)
  page.pushOperators(bdc('L1'))
  page.drawText('LAYER ONE TEXT', { x: 72, y: 700, size: 20, font })
  page.pushOperators(emc())
  page.pushOperators(bdc('L2'))
  page.drawText('LAYER TWO TEXT', { x: 72, y: 640, size: 20, font })
  page.pushOperators(emc())
  const bytes = await doc.save()
  return {
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    ocg1Num: (ocg1 as PDFRef).objectNumber,
    ocg2Num: (ocg2 as PDFRef).objectNumber
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
