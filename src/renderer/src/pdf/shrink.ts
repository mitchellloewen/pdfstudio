/**
 * Document-level driver for the content-stream optimiser.
 *
 * Walks every page content stream and every Form XObject, rewrites each with
 * `optimizeContentStream`, and re-deflates the result. Nothing else about the
 * file is touched: fonts, images, annotations, form fields, layers, bookmarks
 * and metadata all pass through pdf-lib unchanged.
 *
 * This runs for tens of seconds on a heavy plan set, so it is meant to be
 * called from optimize.worker.ts rather than on the UI thread.
 */
import {
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFArray,
  PDFDict,
  decodePDFRawStream
} from 'pdf-lib'
import { optimizeContentStream, type OptimizeOptions, type OptimizeStats } from './optimize'

export interface ShrinkStats extends OptimizeStats {
  /** Content streams rewritten (pages + form XObjects). */
  streams: number
  pages: number
  fileBefore: number
  fileAfter: number
  /** Wall-clock milliseconds. */
  ms: number
}

export interface ShrinkResult {
  bytes: Uint8Array
  stats: ShrinkStats
}

/** Deflate with the platform compressor — available on the main thread and in workers. */
async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate')
  const writer = cs.writable.getWriter()
  void writer.write(data as unknown as BufferSource)
  void writer.close()
  const buf = await new Response(cs.readable).arrayBuffer()
  return new Uint8Array(buf)
}

type Mat = [number, number, number, number, number, number]

/**
 * Swap a stream's contents while keeping its dictionary — BBox, Resources,
 * Matrix, Group and anything else the original carried.
 *
 * This has to replace the object *in place*. Registering a new one and
 * repointing the reference leaves the original in the file as an orphan
 * (pdf-lib never garbage-collects), so the output would carry both the old and
 * the new copy and come out roughly twice the size.
 */
function replaceStream(dict: PDFDict, packed: Uint8Array): PDFRawStream {
  dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'))
  dict.set(PDFName.of('Length'), PDFNumber.of(packed.length))
  dict.delete(PDFName.of('DecodeParms'))
  return PDFRawStream.of(dict, packed)
}

/** Read a Form XObject's /Matrix, defaulting to identity. */
function formMatrix(dict: PDFDict): Mat {
  const m = dict.get(PDFName.of('Matrix'))
  if (m instanceof PDFArray && m.size() === 6) {
    const v = m.asArray().map((x) => Number((x as { asNumber?: () => number }).asNumber?.() ?? NaN))
    if (v.every((n) => Number.isFinite(n))) return v as Mat
  }
  return [1, 0, 0, 1, 0, 0]
}

export async function optimizePdf(
  src: ArrayBuffer | Uint8Array,
  opts: OptimizeOptions & { onProgress?: (done: number, total: number, label: string) => void } = {}
): Promise<ShrinkResult> {
  const t0 = Date.now()
  const srcBytes = src instanceof Uint8Array ? src : new Uint8Array(src)
  const doc = await PDFDocument.load(srcBytes, { updateMetadata: false })
  const ctx = doc.context

  const stats: ShrinkStats = {
    segmentsBefore: 0,
    segmentsAfter: 0,
    wrappersFlattened: 0,
    strokesMerged: 0,
    degenerateDropped: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    streams: 0,
    pages: doc.getPageCount(),
    fileBefore: srcBytes.length,
    fileAfter: 0,
    ms: 0
  }
  const add = (s: OptimizeStats): void => {
    stats.segmentsBefore += s.segmentsBefore
    stats.segmentsAfter += s.segmentsAfter
    stats.wrappersFlattened += s.wrappersFlattened
    stats.strokesMerged += s.strokesMerged
    stats.degenerateDropped += s.degenerateDropped
    stats.bytesBefore += s.bytesBefore
    stats.bytesAfter += s.bytesAfter
    stats.streams++
  }

  // --- collect the work list ------------------------------------------------
  // Form XObjects first so the page pass sees a stable object graph.
  const forms: { ref: PDFRef; stream: PDFRawStream }[] = []
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue
    const sub = obj.dict.get(PDFName.of('Subtype'))
    if (sub instanceof PDFName && sub.asString() === '/Form') forms.push({ ref, stream: obj })
  }
  const pages = doc.getPages()
  const total = forms.length + pages.length
  let done = 0

  // --- form XObjects --------------------------------------------------------
  for (const f of forms) {
    let raw: Uint8Array
    try {
      raw = decodePDFRawStream(f.stream).decode()
    } catch {
      done++
      continue
    }
    const { out, stats: s } = optimizeContentStream(raw, {
      ...opts,
      initialCtm: formMatrix(f.stream.dict)
    })
    add(s)
    if (out.length < raw.length) {
      const packed = await deflate(out)
      ctx.assign(f.ref, replaceStream(f.stream.dict, packed))
    }
    done++
    opts.onProgress?.(done, total, `form ${done}/${forms.length}`)
  }

  // --- page content streams -------------------------------------------------
  // Content streams are not always private to one page. pdf-lib, for one,
  // wraps every page it touches in a *shared* `q` stream and a shared `Q`
  // stream, so several pages point at the same objects. Overwriting such an
  // object with one page's rewritten content — or deleting it — corrupts every
  // other page that shares it. Count the uses first, and only recycle an
  // object that belongs to exactly one page.
  const useCount = new Map<string, number>()
  for (const page of pages) {
    const c = page.node.get(PDFName.of('Contents'))
    const rs = c instanceof PDFArray ? c.asArray() : c ? [c] : []
    for (const r of rs) {
      if (r instanceof PDFRef) {
        const k = r.toString()
        useCount.set(k, (useCount.get(k) || 0) + 1)
      }
    }
  }
  const isExclusive = (r: PDFRef): boolean => (useCount.get(r.toString()) || 0) === 1

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]
    const contents = page.node.get(PDFName.of('Contents'))
    const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : []
    const chunks: Uint8Array[] = []
    const streamRefs: PDFRef[] = []
    let firstDict: PDFDict | null = null
    let decodable = true
    for (const r of refs) {
      const st = ctx.lookup(r)
      if (st instanceof PDFRawStream) {
        try {
          chunks.push(decodePDFRawStream(st).decode())
        } catch {
          // One unreadable stream makes the concatenation wrong, so leave the
          // whole page alone rather than dropping part of its drawing.
          decodable = false
          break
        }
        if (r instanceof PDFRef) streamRefs.push(r)
        if (!firstDict) firstDict = st.dict
      }
    }
    if (decodable && chunks.length && streamRefs.length === chunks.length && firstDict) {
      const size = chunks.reduce((n, c) => n + c.length + 1, 0)
      const joined = new Uint8Array(size)
      let o = 0
      for (const c of chunks) {
        joined.set(c, o)
        o += c.length
        joined[o++] = 0x0a
      }
      const { out, stats: s } = optimizeContentStream(joined, opts)
      add(s)
      const packed = await deflate(out)
      // Recycle the page's own first stream object where we can — registering
      // a fresh one instead leaves the original behind as an orphan, since
      // pdf-lib never garbage-collects, and the file would carry both copies.
      let target: PDFRef
      if (isExclusive(streamRefs[0])) {
        ctx.assign(streamRefs[0], replaceStream(firstDict, packed))
        target = streamRefs[0]
      } else {
        target = ctx.register(
          ctx.stream(packed, { Filter: PDFName.of('FlateDecode'), Length: packed.length })
        )
      }
      // Drop the page's other streams, but never one another page still uses.
      for (let k = 1; k < streamRefs.length; k++) {
        if (streamRefs[k] !== target && isExclusive(streamRefs[k])) ctx.delete(streamRefs[k])
      }
      page.node.set(PDFName.of('Contents'), target)
    }
    done++
    opts.onProgress?.(done, total, `page ${i + 1}/${pages.length}`)
  }

  const outBytes = await doc.save({ useObjectStreams: true })
  stats.fileAfter = outBytes.length
  stats.ms = Date.now() - t0
  return { bytes: outBytes, stats }
}
