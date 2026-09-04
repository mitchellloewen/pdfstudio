/**
 * Combine several files into one PDF, and turn images into PDF pages.
 *
 * Images (PNG / JPEG) become a Letter-sized page in whichever orientation
 * matches the picture, scaled to fit inside a ½-inch margin and centred —
 * what you'd expect from "print this photo". A phone photo at its native
 * pixel size would otherwise be a 40-inch page.
 */
import { PDFDocument, type PDFPage } from 'pdf-lib'

export type CombineKind = 'pdf' | 'image'

export interface CombineItem {
  id: string
  name: string
  kind: CombineKind
  bytes: ArrayBuffer
  /** Page count for PDFs (filled in asynchronously); 1 for images. */
  pages: number | null
  /** Set when the file couldn't be read (encrypted, corrupt, unsupported). */
  error?: string
}

const LETTER: [number, number] = [612, 792]
const IMAGE_MARGIN = 36

export function kindForName(name: string): CombineKind | null {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (ext === 'pdf') return 'pdf'
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg') return 'image'
  return null
}

/** Sniff the container so a .jpg that is really a PNG still embeds. */
export function imageFormat(bytes: ArrayBuffer): 'png' | 'jpg' | null {
  const b = new Uint8Array(bytes.slice(0, 8))
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  return null
}

let seq = 0
export const combineId = (): string => `c${Date.now().toString(36)}${(seq++).toString(36)}`

/** Build a list entry, reading the page count for PDFs. */
export async function describeFile(name: string, bytes: ArrayBuffer): Promise<CombineItem> {
  const kind = kindForName(name)
  const item: CombineItem = { id: combineId(), name, kind: kind ?? 'pdf', bytes, pages: null }
  if (!kind) {
    item.error = 'Only PDF, PNG and JPEG files can be combined'
    return item
  }
  if (kind === 'image') {
    item.pages = 1
    if (!imageFormat(bytes)) item.error = 'Not a PNG or JPEG image'
    return item
  }
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
    item.pages = doc.getPageCount()
  } catch (err) {
    item.error = /encrypt/i.test(String(err)) ? 'Password-protected — unlock it first' : 'Could not read this PDF'
  }
  return item
}

/** Add one image as a new page at the end of `doc`. */
export async function addImagePage(doc: PDFDocument, bytes: ArrayBuffer): Promise<PDFPage> {
  const fmt = imageFormat(bytes)
  if (!fmt) throw new Error('Not a PNG or JPEG image')
  const img = fmt === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes)
  const landscape = img.width > img.height
  const [pw, ph] = landscape ? [LETTER[1], LETTER[0]] : LETTER
  const page = doc.addPage([pw, ph])
  const maxW = pw - 2 * IMAGE_MARGIN
  const maxH = ph - 2 * IMAGE_MARGIN
  const scale = Math.min(maxW / img.width, maxH / img.height, 1e9)
  const w = img.width * scale
  const h = img.height * scale
  page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h })
  return page
}

/** Append every page of `bytes` (a PDF) to `doc`. Returns pages added. */
export async function addPdfPages(doc: PDFDocument, bytes: ArrayBuffer): Promise<number> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const pages = await doc.copyPages(src, src.getPageIndices())
  for (const p of pages) doc.addPage(p)
  return pages.length
}

/** Merge the items, in order, into a brand-new PDF. */
export async function buildCombined(items: CombineItem[]): Promise<Uint8Array> {
  const out = await PDFDocument.create()
  out.setCreator('PDF Studio')
  out.setProducer('PDF Studio')
  for (const it of items) {
    if (it.error) continue
    if (it.kind === 'image') await addImagePage(out, it.bytes)
    else await addPdfPages(out, it.bytes)
  }
  if (out.getPageCount() === 0) throw new Error('Nothing to combine — every file was empty or unreadable')
  return out.save()
}
