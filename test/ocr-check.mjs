// Verify the bundled Tesseract engine works fully offline in Node:
// local language data, no CDN, word boxes returned.
import { createWorker } from 'tesseract.js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const worker = await createWorker('eng', 1, {
  langPath: join(root, 'resources', 'tessdata'),
  cacheMethod: 'none',
  gzip: true
})
const t0 = Date.now()
const { data } = await worker.recognize(readFileSync(join(root, 'test', 'ocr-sample.png')))
const ms = Date.now() - t0
await worker.terminate()

const words = (data.words || []).filter((w) => w.confidence >= 35).map((w) => w.text)
console.log('recognize ms:', ms)
console.log('words:', words.join(' '))
const need = ['INVOICE', '4715', 'Winnipeg']
const missing = need.filter((n) => !words.some((w) => w.includes(n)))
const first = data.words?.[0]
console.log('first word bbox:', first && JSON.stringify({ text: first.text, bbox: first.bbox }))
console.log(missing.length === 0 && first?.bbox ? 'OCR-CHECK-OK' : 'OCR-CHECK-FAILED missing=' + missing)
process.exit(missing.length === 0 ? 0 : 1)
