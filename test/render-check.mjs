import { readFileSync } from 'fs'
import { AnnotationMode, getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

/** Bezier segments in a page's paths — an ellipse is drawn as 4 of them. */
function curveCount(opList) {
  let n = 0
  for (let i = 0; i < opList.fnArray.length; i++) {
    if (opList.fnArray[i] !== OPS.constructPath) continue
    const sub = opList.argsArray[i]?.[0]
    if (Array.isArray(sub)) n += sub.filter((op) => op === OPS.curveTo).length
  }
  return n
}

const open = (file) => getDocument({ data: new Uint8Array(readFileSync(file)), isEvalSupported: false }).promise

const data = new Uint8Array(readFileSync('test/out-baked.pdf'))
const doc = await getDocument({ data, isEvalSupported: false }).promise
console.log('numPages:', doc.numPages)
for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i)
  const vp = page.getViewport({ scale: 1 })
  const ops = await page.getOperatorList()
  const tc = await page.getTextContent()
  const text = tc.items.map((it) => it.str).join('').slice(0, 40)
  console.log(`page ${i}: ${Math.round(vp.width)}x${Math.round(vp.height)} rot=${vp.rotation} ops=${ops.fnArray.length} curves=${curveCount(ops)} text="${text}"`)
}
await doc.destroy()

// Editable marks must still *render* in a pdf.js viewer (Chrome, Edge, our own
// preview) — that only works if every annotation carries an appearance stream.
// With annotations switched off the same page has none of them, proving the
// marks live in the annotation layer rather than the page content.
{
  const ed = await open('test/out-editable.pdf')
  const page = await ed.getPage(1)
  const withAnnots = await page.getOperatorList({ annotationMode: AnnotationMode.ENABLE })
  const without = await page.getOperatorList({ annotationMode: AnnotationMode.DISABLE })
  const drawn = curveCount(withAnnots)
  if (drawn < 4) throw new Error('editable circle did not render through its appearance stream: ' + drawn)
  if (curveCount(without) !== 0) throw new Error('editable marks leaked into the page content')
  if (withAnnots.fnArray.length <= without.fnArray.length) {
    throw new Error('annotation appearances contributed no drawing operations')
  }
  const pageText = (await page.getTextContent()).items.map((it) => it.str).join(' ')
  if (pageText.includes('Stays editable')) throw new Error('editable text box was also burned into the page')
  await ed.destroy()
  console.log(`Editable annots: pdf.js renders them from /AP (${without.fnArray.length} page ops -> ${withAnnots.fnArray.length} with annotations)`)
}

// Flattened: the very same marks, now part of the page — visible and
// searchable with annotations switched off entirely.
{
  const fl = await open('test/out-flat.pdf')
  const page = await fl.getPage(1)
  const without = await page.getOperatorList({ annotationMode: AnnotationMode.DISABLE })
  if (curveCount(without) < 4) throw new Error('flattened circle missing from page content')
  const pageText = (await page.getTextContent()).items.map((it) => it.str).join(' ')
  if (!pageText.includes('Stays editable')) throw new Error('flattened text not extractable: ' + pageText.slice(0, 120))
  await fl.destroy()
  console.log('Flattened annots: drawn and searchable in the page content itself')
}

// Draw-tab shapes: same contract as the other editable marks — nothing in the
// page content, everything drawn from the annotations' appearance streams (and
// flattening moves it the other way).
{
  const dr = await open('test/out-draw.pdf')
  const page = await dr.getPage(1)
  const withAnnots = await page.getOperatorList({ annotationMode: AnnotationMode.ENABLE })
  const without = await page.getOperatorList({ annotationMode: AnnotationMode.DISABLE })
  // the ellipse alone contributes 4 bezier segments
  if (curveCount(withAnnots) < 4) throw new Error('drawn ellipse did not render from its appearance stream')
  if (withAnnots.fnArray.length - without.fnArray.length < 8) {
    throw new Error('drawings contributed almost no drawing operations: ' + withAnnots.fnArray.length)
  }
  await dr.destroy()

  const fl = await open('test/out-draw-flat.pdf')
  const flatOps = await (await fl.getPage(1)).getOperatorList({ annotationMode: AnnotationMode.DISABLE })
  if (curveCount(flatOps) < 4) throw new Error('flattened drawings missing from the page content')
  await fl.destroy()
  console.log(
    `Drawings: rendered from /AP (${without.fnArray.length} page ops -> ${withAnnots.fnArray.length}), and burned in when flattened`
  )
}

// Pre-filled form: the canvas render mode the viewer uses (ENABLE_FORMS) must
// drop the fillable widget's baked appearance — our field overlay draws that
// value — while still painting the read-only one, which the overlay skips.
// Getting this wrong shows every value already filled in elsewhere twice.
{
  const pf = await open('test/out-prefilled-src.pdf')
  const page = await pf.getPage(1)
  const all = await page.getOperatorList({ annotationMode: AnnotationMode.ENABLE })
  const forms = await page.getOperatorList({ annotationMode: AnnotationMode.ENABLE_FORMS })
  const none = await page.getOperatorList({ annotationMode: AnnotationMode.DISABLE })
  if (forms.fnArray.length >= all.fnArray.length) {
    throw new Error('ENABLE_FORMS still paints the fillable widget — values would render twice')
  }
  if (forms.fnArray.length <= none.fnArray.length) {
    throw new Error('ENABLE_FORMS dropped the read-only widget too — its value would vanish')
  }
  await pf.destroy()

  // ...and after a flatten the fillable value is page content, drawn once.
  const ff = await open('test/out-prefilled-flat.pdf')
  const flatPage = await ff.getPage(1)
  const text = (await flatPage.getTextContent()).items.map((it) => it.str).join(' ')
  const hits = text.split('TYPEDINNITRO').length - 1
  if (hits !== 1) throw new Error(`flattened field value appears ${hits}x in the page text, expected 1`)
  await ff.destroy()
  console.log(
    `Pre-filled form: ${none.fnArray.length} page ops -> ${forms.fnArray.length} with forms mode -> ${all.fnArray.length} with all annotations; flattened value appears once`
  )
}

// OCR bake: invisible text must be extractable; redacted words must NOT be.
const ocrDoc = await getDocument({
  data: new Uint8Array(readFileSync('test/out-ocr.pdf')),
  isEvalSupported: false
}).promise
const ocrText = (await (await ocrDoc.getPage(1)).getTextContent()).items.map((it) => it.str).join(' ')
await ocrDoc.destroy()
if (!ocrText.includes('SEARCHABLE')) throw new Error('OCR text layer missing: ' + ocrText)
if (ocrText.includes('SECRET')) throw new Error('REDACTION LEAK: whiteouted OCR word was baked!')
console.log('OCR layer: searchable word present, whiteouted word excluded')

// Layers: pdf.js must see the saved OFF state, and its group-id format must
// match the "<num>R" pattern the save pipeline parses.
const layDoc = await getDocument({
  data: new Uint8Array(readFileSync('test/out-layered.pdf')),
  isEvalSupported: false
}).promise
const occ = await layDoc.getOptionalContentConfig()
const groups = occ.getGroups()
const ids = Object.keys(groups || {})
if (ids.length !== 2) throw new Error('expected 2 OCGs, got ' + ids.length)
if (!ids.every((id) => /^\d+R\d*$/.test(id))) throw new Error('unexpected OCG id format: ' + ids.join(','))
const states = ids.map((id) => `${groups[id].name}=${occ.isVisible ? '?' : ''}${groups[id].visible}`)
const markups = ids.find((id) => String(groups[id].name) === 'Markups')
if (!markups || groups[markups].visible !== false) throw new Error('hidden layer not honoured by pdf.js: ' + states.join(' '))
await layDoc.destroy()
console.log('Layers: ids ' + ids.join(',') + ' — hidden layer honoured by pdf.js (' + states.join(', ') + ')')
console.log('RENDER-PIPELINE-OK')
