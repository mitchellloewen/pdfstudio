import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { PDFDocument, type PDFRef } from 'pdf-lib'
import { loadPdf, isPasswordException, type PDFDocumentProxy } from './pdf/pdfjs'
import {
  DEFAULT_DRAW_STYLE,
  MARKUP_TOOLS,
  type Annotation,
  type Box,
  type Calibration,
  type DocModel,
  type DrawStyle,
  type FieldAnnot,
  type ImageEditAnnot,
  type MarkupAnnot,
  type OcrWord,
  type PageLeaf,
  type StoredImage,
  type ToolId,
  uid
} from './pdf/types'
import { bakeAndSave, extractPages } from './pdf/save'
import { EDITABLE_KEYWORD, countEditable, importStudioAnnots } from './pdf/annots'
import { makeRasterizer } from './pdf/raster'
import { buildPrintHtml } from './pdf/print'
import { detectFields } from './pdf/forms'
import { ocrPageWords, pageHasText, parseOcrCache, sha256Hex } from './pdf/ocr'
import { CLOSED_KINDS } from './pdf/draw'
import { runSearch, type SearchMatch, type HRect } from './pdf/search'
import { optimizePdfInWorker } from './pdf/optimizeClient'
import type { EditableLine } from './pdf/edit'
import {
  applyImageEdits,
  buildDrawEdits,
  decomposeM,
  mulM,
  previewDrawIndex,
  scanPageImages,
  type Matrix,
  type PageImage
} from './pdf/images'
import { cropToStoredImage, decodeEmbeddedImage, previewImage } from './pdf/imagedecode'
import {
  SHEET_SIZES,
  remapModel,
  remapOcr,
  resizePages,
  type FitMode,
  type Orientation,
  type PageSizeInfo
} from './pdf/pagesize'
import type { ImageSel } from './components/ImageLayer'
import Toolbar, { type LayerInfo, type SigInfo } from './components/Toolbar'
import TabBar from './components/TabBar'
import ThumbnailSidebar from './components/ThumbnailSidebar'
import PageView, { FONT_CSS } from './components/PageView'
import SearchBar from './components/SearchBar'
import CalibrateDialog from './components/CalibrateDialog'
import PasswordDialog from './components/PasswordDialog'
import HeaderFooterDialog, {
  SLOT_POS,
  expandTemplate,
  formatDate,
  type HeaderFooterConfig,
  type SlotKey
} from './components/HeaderFooterDialog'
import CombineDialog from './components/CombineDialog'
import { addImagePage, buildCombined, describeFile, kindForName, type CombineItem } from './pdf/combine'
import PagePickDialog from './components/PagePickDialog'
import PageSizeDialog from './components/PageSizeDialog'

interface DocTab {
  id: string
  srcBytes: ArrayBuffer
  srcPath: string | null
  pdfDoc: PDFDocumentProxy
  model: DocModel
  zoom: number
  currentPage: number
  selectedLeaves: string[]
  selectedId: string | null
  editingId: string | null
  dirty: boolean
  keepForms: boolean
  /** OCR words per source page (scanned pages only), in PDF user space. */
  ocrPages: Record<number, OcrWord[]>
  ocrVersion: number
  ocrProgress: { done: number; total: number } | null
  /** Optional-content (layer) support: pdf.js config object + UI list. */
  layerConfig: unknown | null
  layers: LayerInfo[] | null
  layerVersion: number
  /** Set once a background speed-up has been started (or ruled out) for this
   *  tab, so a slow page can't kick off the work more than once. */
  speedUpTried?: boolean
  // ---- embedded-image editing ----
  /** pdf-lib copy of srcBytes, loaded on demand to scan pages for images. */
  imageDoc: PDFDocument | null
  /** Images found on each source page, filled in as pages are looked at. */
  pageImages: Record<number, PageImage[]>
  /** Decoded pixels per source page and draw index, for the drag preview. */
  imageBitmaps: Record<string, HTMLCanvasElement | null>
  /** The embedded image being edited, on the current page. */
  imageSel: ImageSel | null
  /** Handles adjust the crop rather than the frame. */
  imageCrop: boolean
  /** Signature of the image edits the rendered document was built from. */
  imagePreviewSig: string
  imagePreviewBusy: boolean
}

interface SigItem {
  id: string
  ext: string
  dataUrl: string
  bytes: ArrayBuffer
  width: number
  height: number
}

interface HistEntry {
  past: DocModel[]
  future: DocModel[]
  lastTag?: string
}

interface Toast {
  id: number
  msg: string
  kind: 'info' | 'ok' | 'err'
}

type MarkupKind = MarkupAnnot['kind']

const DEFAULT_COLORS = ['#111111', '#b91c1c', '#1d4ed8', '#0a7d29', '#d97706', '#7c3aed']
const EMPTY_ANNOTS: Annotation[] = []
const NO_BITMAPS: Record<number, HTMLCanvasElement | null> = {}

/** The decoded image previews for one source page, keyed by draw index. */
function bitmapsByDraw(tab: DocTab, srcPage: number): Record<number, HTMLCanvasElement | null> {
  const prefix = `${srcPage}:`
  const out: Record<number, HTMLCanvasElement | null> = {}
  let any = false
  for (const [key, canvas] of Object.entries(tab.imageBitmaps)) {
    if (!key.startsWith(prefix)) continue
    out[Number(key.slice(prefix.length))] = canvas
    any = true
  }
  return any ? out : NO_BITMAPS
}
const HISTORY_LIMIT = 100
const clampZoom = (z: number): number => Math.min(5, Math.max(0.2, +z.toFixed(3)))
const errMsg = (e: unknown): string => String((e as Error)?.message || e)

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
}

async function imageMeta(bytes: ArrayBuffer, ext: string): Promise<{ dataUrl: string; width: number; height: number }> {
  const blob = new Blob([bytes], { type: ext === 'png' ? 'image/png' : 'image/jpeg' })
  const dataUrl = await new Promise<string>((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.readAsDataURL(blob)
  })
  const dims = await new Promise<{ w: number; h: number }>((resolve) => {
    const im = new Image()
    im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight })
    im.onerror = () => resolve({ w: 300, h: 100 })
    im.src = dataUrl
  })
  return { dataUrl, width: dims.w, height: dims.h }
}

/**
 * Un-composite a signature image from its white background so it lays on any
 * page colour like real ink: each pixel's alpha comes from how dark it is
 * (a = 255 - min(r,g,b)) and the ink colour is recovered as if drawn on
 * transparency — exact over white, so antialiased stroke edges keep their
 * feather instead of a white halo. Images that already carry transparency are
 * left untouched (re-running the formula would turn their clear pixels black).
 * Returns null when nothing should change; otherwise always PNG (jpg can't
 * hold alpha).
 */
async function removeWhiteBackground(
  bytes: ArrayBuffer,
  ext: string
): Promise<{ bytes: ArrayBuffer; ext: 'png' } | null> {
  try {
    const meta = await imageMeta(bytes, ext)
    const im = new Image()
    await new Promise<void>((resolve, reject) => {
      im.onload = () => resolve()
      im.onerror = () => reject(new Error('image decode failed'))
      im.src = meta.dataUrl
    })
    const canvas = document.createElement('canvas')
    canvas.width = im.naturalWidth
    canvas.height = im.naturalHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(im, 0, 0)
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const px = img.data
    for (let i = 3; i < px.length; i += 4) {
      if (px[i] < 250) return null // already background-free
    }
    for (let i = 0; i < px.length; i += 4) {
      const a = 255 - Math.min(px[i], px[i + 1], px[i + 2])
      if (a <= 6) {
        px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 0
      } else {
        const inv = 255 - a
        for (let k = 0; k < 3; k++) {
          px[i + k] = Math.max(0, Math.min(255, Math.round(((px[i + k] - inv) * 255) / a)))
        }
        px[i + 3] = a
      }
    }
    ctx.putImageData(img, 0, 0)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) return null
    return { bytes: await blob.arrayBuffer(), ext: 'png' }
  } catch {
    return null
  }
}

const hasFieldAnnots = (m: DocModel): boolean => m.annotations.some((a) => a.type === 'field')

let toastSeq = 0

export default function App(): JSX.Element {
  const [tabs, setTabs] = useState<DocTab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [tool, setTool] = useState<ToolId>('select')
  const [color, setColor] = useState('#111111')
  const [fontSize, setFontSize] = useState(12)
  const [drawStyle, setDrawStyle] = useState<DrawStyle>(DEFAULT_DRAW_STYLE)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [status, setStatus] = useState('Open a PDF to begin.')
  const [busy, setBusy] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [confirmCloseId, setConfirmCloseId] = useState<string | null>(null)
  const [recents, setRecents] = useState<{ path: string; name: string }[]>([])
  const [dropping, setDropping] = useState(false)
  const [, setHistVer] = useState(0)

  // signatures (persisted on disk by the main process)
  const [sigs, setSigs] = useState<SigItem[]>([])
  const [activeSigId, setActiveSigId] = useState<string | null>(
    () => localStorage.getItem('pdfstudio.activeSig') || null
  )

  // search
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchFuzzy, setSearchFuzzy] = useState(false)
  const [matches, setMatches] = useState<SearchMatch[]>([])
  const [currentMatch, setCurrentMatch] = useState(-1)
  const [searching, setSearching] = useState(false)

  const pendingOpenRef = useRef<{ bytes: ArrayBuffer; name: string; path: string | null } | null>(null)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [passwordWrong, setPasswordWrong] = useState(false)
  const [calibrateData, setCalibrateData] = useState<{ pxDistance: number; leafId: string } | null>(null)
  const [ratioOpen, setRatioOpen] = useState(false)
  /** Flatten confirmation — 'signed' when it was prompted by placing a signature. */
  const [flattenAsk, setFlattenAsk] = useState<null | 'button' | 'signed'>(null)
  /** Tabs already offered the post-signature prompt, so it asks once, not every time. */
  const signAskedRef = useRef<Set<string>>(new Set())

  const viewerRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<DocTab[]>([])
  const activeIdRef = useRef<string | null>(null)
  const zoomRef = useRef(1.25)
  const zoomAnchorRef = useRef<{ left: number; top: number } | null>(null)
  const scrollPosRef = useRef<Record<string, number>>({})
  const scrollRaf = useRef(0)
  const histRef = useRef<Record<string, HistEntry>>({})
  /** Per tab, the pdf-lib copy of its source bytes used for image editing. */
  const imageDocRef = useRef<Record<string, Promise<PDFDocument | null>>>({})
  const ocrRunRef = useRef<((tabId: string) => void) | null>(null)
  const ocrTokenRef = useRef<Record<string, number>>({})
  const sigsRef = useRef<SigItem[]>([])
  const activeSigRef = useRef<SigItem | null>(null)
  const whiteoutNoticeRef = useRef(false)
  const annotCacheRef = useRef(new Map<string, Annotation[]>())

  const active = useMemo(() => tabs.find((t) => t.id === activeId) || null, [tabs, activeId])
  const model = active?.model ?? null
  tabsRef.current = tabs
  activeIdRef.current = activeId
  zoomRef.current = active?.zoom ?? 1.25
  sigsRef.current = sigs
  activeSigRef.current = sigs.find((s) => s.id === activeSigId) || null

  const toast = useCallback((msg: string, kind: Toast['kind'] = 'info'): void => {
    const id = ++toastSeq
    setToasts((t) => [...t, { id, msg, kind }])
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5500)
  }, [])

  // ---- tab helpers ------------------------------------------------------
  const patchActive = useCallback((patch: Partial<DocTab>) => {
    setTabs((prev) => prev.map((t) => (t.id === activeIdRef.current ? { ...t, ...patch } : t)))
  }, [])

  /**
   * The single write path for model changes: pushes undo history (coalescing
   * rapid same-tag edits like typing) and marks the tab dirty.
   */
  const commitModel = useCallback((fn: (m: DocModel) => DocModel, tag?: string) => {
    const id = activeIdRef.current
    if (!id) return
    const t = tabsRef.current.find((x) => x.id === id)
    if (!t) return
    const next = fn(t.model)
    if (next === t.model) return
    const h = histRef.current[id] || (histRef.current[id] = { past: [], future: [] })
    if (!(tag && h.lastTag === tag && h.past.length > 0)) {
      h.past.push(t.model)
      if (h.past.length > HISTORY_LIMIT) h.past.shift()
    }
    h.future = []
    h.lastTag = tag
    setTabs((prev) => prev.map((x) => (x.id === id ? { ...x, model: next, dirty: true } : x)))
    setHistVer((v) => v + 1)
  }, [])

  const undo = useCallback(() => {
    const id = activeIdRef.current
    if (!id) return
    const h = histRef.current[id]
    if (!h || h.past.length === 0) return
    const t = tabsRef.current.find((x) => x.id === id)
    if (!t) return
    const prev = h.past.pop()!
    h.future.push(t.model)
    h.lastTag = undefined
    setTabs((p) =>
      p.map((x) => (x.id === id ? { ...x, model: prev, dirty: true, selectedId: null, editingId: null } : x))
    )
    setHistVer((v) => v + 1)
  }, [])

  const redo = useCallback(() => {
    const id = activeIdRef.current
    if (!id) return
    const h = histRef.current[id]
    if (!h || h.future.length === 0) return
    const t = tabsRef.current.find((x) => x.id === id)
    if (!t) return
    const next = h.future.pop()!
    h.past.push(t.model)
    h.lastTag = undefined
    setTabs((p) =>
      p.map((x) => (x.id === id ? { ...x, model: next, dirty: true, selectedId: null, editingId: null } : x))
    )
    setHistVer((v) => v + 1)
  }, [])

  const canUndo = !!(activeId && histRef.current[activeId]?.past.length)
  const canRedo = !!(activeId && histRef.current[activeId]?.future.length)

  const setSelectedId = useCallback((id: string | null) => patchActive({ selectedId: id }), [patchActive])
  const setEditingId = useCallback((id: string | null) => patchActive({ editingId: id }), [patchActive])
  const setSelectedLeaves = useCallback((ids: string[]) => patchActive({ selectedLeaves: ids }), [patchActive])
  const setZoom = useCallback((z: number) => patchActive({ zoom: clampZoom(z) }), [patchActive])

  // keep the main process informed for the app-close guard
  useEffect(() => {
    window.api.setDirty(tabs.some((t) => t.dirty))
  }, [tabs])

  // ---- Open / load ------------------------------------------------------
  const buildTab = useCallback(
    async (
      bytes: ArrayBuffer,
      name: string,
      opts: {
        password?: string
        replaceId?: string
        srcPath?: string | null
        /** Carry per-page calibrations across a rebuild (flatten), by page index. */
        calibrationsByPage?: (Calibration | undefined)[]
        /** Open as unsaved (a freshly combined document has no file yet). */
        dirty?: boolean
        /**
         * Reuse this model instead of building a fresh one. Used by page
         * resizing, which rewrites the file and moves the existing marks onto
         * the new geometry itself — restoring them from the file as well would
         * draw everything twice.
         */
        model?: DocModel
        /** OCR words to carry across, by source page. */
        ocrPages?: Record<number, OcrWord[]>
      } = {}
    ) => {
      let srcBytes = bytes
      let doc = await loadPdf(srcBytes, opts.password)

      // Permission-locked files (owner password only, so they open without
      // asking) display fine — pdf.js decrypts transparently — but their
      // streams are still encrypted on disk and the pdf-lib save engine can't
      // parse them. Strip the encryption up front with qpdf so everything
      // downstream (save, extract, print, annotation import) gets clean bytes.
      let unlocked = false
      try {
        if ((await doc.getPermissions()) !== null) {
          const res = await window.api.unlockPdf(srcBytes, opts.password)
          if (res.ok && res.bytes) {
            srcBytes = res.bytes
            const stale = doc
            doc = await loadPdf(srcBytes)
            void stale.destroy().catch(() => {})
            unlocked = true
          }
        }
      } catch (e) {
        console.warn('could not pre-decrypt locked file', e)
      }

      // A file we saved with editable marks says so in its Keywords. Lift those
      // annotations back out into the model and strip them from the document,
      // so they're ours to move and retype again instead of being drawn twice.
      let restored: Annotation[][] | null = null
      try {
        const info = (await doc.getMetadata())?.info as { Keywords?: string } | undefined
        const kw = info?.Keywords
        if (!opts.model && typeof kw === 'string' && kw.includes(EDITABLE_KEYWORD)) {
          const res = await importStudioAnnots(srcBytes)
          if (res) {
            restored = res.byPage
            srcBytes = res.bytes
            const stale = doc
            doc = await loadPdf(srcBytes, opts.password)
            void stale.destroy().catch(() => {})
          }
        }
      } catch (e) {
        console.warn('could not restore editable annotations', e)
      }

      const leaves: PageLeaf[] = []
      for (let i = 1; i <= doc.numPages; i++) leaves.push({ id: uid(), srcPage: i, rotation: 0 })
      const restoredAnnots: Annotation[] = []
      restored?.forEach((arr, i) => {
        const leaf = leaves[i]
        if (leaf) for (const a of arr) restoredAnnots.push({ ...a, leafId: leaf.id })
      })
      const calibrations: Record<string, Calibration> = {}
      opts.calibrationsByPage?.forEach((c, i) => {
        const leaf = leaves[i]
        if (c && leaf) calibrations[leaf.id] = c
      })

      // optional-content groups (layers), if the document has any
      let layerConfig: unknown | null = null
      let layers: LayerInfo[] | null = null
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const occ: any = await doc.getOptionalContentConfig()
        const groups = occ?.getGroups?.()
        const ids = groups ? Object.keys(groups) : []
        if (ids.length) {
          layerConfig = occ
          layers = ids.map((id) => ({
            id,
            name: String(groups[id]?.name ?? `Layer ${id}`),
            visible: groups[id]?.visible !== false
          }))
        }
      } catch {
        /* no layer support in this file */
      }

      // open at fit-width
      let zoom = 1.25
      try {
        const p1 = await doc.getPage(1)
        const vp = p1.getViewport({ scale: 1 })
        const avail = (viewerRef.current?.clientWidth ?? window.innerWidth - 240) - 64
        zoom = clampZoom(avail / vp.width)
      } catch {
        /* keep default */
      }

      const newTab: DocTab = {
        id: opts.replaceId ?? uid(),
        srcBytes,
        srcPath: opts.srcPath ?? null,
        pdfDoc: doc,
        model: opts.model ?? { fileName: name, leaves, annotations: restoredAnnots, images: {}, calibrations },
        zoom,
        currentPage: 1,
        selectedLeaves: [],
        selectedId: null,
        editingId: null,
        dirty: opts.dirty ?? false,
        keepForms: true,
        ocrPages: opts.ocrPages ?? {},
        ocrVersion: 0,
        ocrProgress: null,
        layerConfig,
        layers,
        layerVersion: 0,
        imageDoc: null,
        pageImages: {},
        imageBitmaps: {},
        imageSel: null,
        imageCrop: false,
        imagePreviewSig: '',
        imagePreviewBusy: false
      }
      histRef.current[newTab.id] = { past: [], future: [] }
      delete imageDocRef.current[newTab.id]
      setTabs((prev) =>
        opts.replaceId ? prev.map((t) => (t.id === opts.replaceId ? newTab : t)) : [...prev, newTab]
      )
      setActiveId(newTab.id)
      setStatus(
        `${name} — ${doc.numPages} page${doc.numPages === 1 ? '' : 's'}` +
          (unlocked ? ' · restrictions removed' : '')
      )

      // form-field detection runs in the background so big docs open instantly
      detectFields(doc, leaves)
        .then((fields) => {
          if (!fields.length) return
          setTabs((prev) =>
            prev.map((t) =>
              t.id === newTab.id && t.pdfDoc === doc
                ? { ...t, model: { ...t.model, annotations: [...fields, ...t.model.annotations] } }
                : t
            )
          )
          setStatus(`${name} — ${doc.numPages} pages · ${fields.length} fillable field${fields.length === 1 ? '' : 's'}`)
        })
        .catch((e) => console.warn('field detection failed', e))

      // OCR any scanned (text-less) pages in the background. Deferred a tick:
      // the scheduler reads tabsRef, which only carries the new tab after the
      // state update above has rendered.
      setTimeout(() => ocrRunRef.current?.(newTab.id), 100)
    },
    []
  )

  const openBytes = useCallback(
    async (bytes: ArrayBuffer, name: string, srcPath: string | null = null) => {
      setBusy(true)
      try {
        await buildTab(bytes, name, { srcPath })
      } catch (err) {
        const pw = isPasswordException(err)
        if (pw.needsPassword) {
          pendingOpenRef.current = { bytes, name, path: srcPath }
          setPasswordWrong(pw.wrong)
          setPasswordOpen(true)
        } else {
          console.error(err)
          toast('Could not open this PDF: ' + errMsg(err), 'err')
        }
      } finally {
        setBusy(false)
      }
    },
    [buildTab, toast]
  )

  const handleOpen = useCallback(async () => {
    const files = await window.api.openPdfs()
    for (const f of files) await openBytes(f.bytes, f.name, f.path || null)
  }, [openBytes])

  const openRecent = useCallback(
    async (path: string) => {
      const payload = await window.api.openPath(path)
      if (!payload) {
        toast('That file could not be opened (moved or deleted?).', 'err')
        setRecents((r) => r.filter((x) => x.path !== path))
        return
      }
      await openBytes(payload.bytes, payload.name, payload.path)
    },
    [openBytes, toast]
  )

  const submitPassword = useCallback(
    async (pw: string) => {
      const pending = pendingOpenRef.current
      if (!pending) return
      setBusy(true)
      try {
        await buildTab(pending.bytes, pending.name, { password: pw, srcPath: pending.path })
        setPasswordOpen(false)
        pendingOpenRef.current = null
      } catch (err) {
        const info = isPasswordException(err)
        if (info.needsPassword) setPasswordWrong(true)
        else {
          toast('Could not open: ' + errMsg(err), 'err')
          setPasswordOpen(false)
        }
      } finally {
        setBusy(false)
      }
    },
    [buildTab, toast]
  )

  const reallyCloseTab = useCallback((id: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id)
      const doomed = prev[idx]
      const next = prev.filter((t) => t.id !== id)
      delete scrollPosRef.current[id]
      delete histRef.current[id]
      delete imageDocRef.current[id]
      ocrTokenRef.current[id] = (ocrTokenRef.current[id] || 0) + 1 // abort any in-flight OCR
      delete ocrTokenRef.current[id]
      if (doomed) setTimeout(() => doomed.pdfDoc.destroy().catch(() => {}), 1500)
      if (activeIdRef.current === id) {
        const fallback = next[idx] || next[idx - 1] || next[0] || null
        setActiveId(fallback ? fallback.id : null)
      }
      return next
    })
    setConfirmCloseId(null)
  }, [])

  const closeTab = useCallback(
    (id: string) => {
      const t = tabsRef.current.find((x) => x.id === id)
      if (t?.dirty) setConfirmCloseId(id)
      else reallyCloseTab(id)
    },
    [reallyCloseTab]
  )

  // ---- Unlock -----------------------------------------------------------
  const handleUnlock = useCallback(async () => {
    const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
    if (!tab) return
    setBusy(true)
    setStatus('Removing document restrictions…')
    try {
      const res = await window.api.unlockPdf(tab.srcBytes)
      if (res.ok) {
        const oldDoc = tab.pdfDoc
        await buildTab(res.bytes, tab.model.fileName, { replaceId: tab.id, srcPath: tab.srcPath })
        setTimeout(() => oldDoc.destroy().catch(() => {}), 1500)
        toast('Restrictions removed. Document is now fully editable.', 'ok')
      } else if (res.error === 'QPDF_MISSING') toast('Unlock engine (qpdf) not bundled in this build.', 'err')
      else if (res.error === 'PASSWORD_REQUIRED')
        toast('This file needs its open-password to unlock. Re-open it and enter the password first.', 'err')
      else toast('Unlock failed: ' + res.error, 'err')
    } finally {
      setBusy(false)
      setStatus('Ready.')
    }
  }, [buildTab, toast])

  // ---- Fast viewing -----------------------------------------------------
  /**
   * Swap in an optimised copy of the document *for rendering only*.
   *
   * `srcBytes` — what every save, extract and print is built from — keeps
   * pointing at the bytes that came off disk, so the user's file is never
   * altered. Only `pdfDoc`, the pdf.js document the canvas draws from, is
   * replaced. test/optimize-parity.ts asserts that pdf.js reports identical
   * structure for both (page sizes, rotation, widget rects, text positions and
   * — critically — the same optional-content ids, which the Layers panel maps
   * straight back onto the original on save).
   */
  const applyFastDoc = useCallback(
    async (tabId: string, bytes: ArrayBuffer): Promise<boolean> => {
      const tab = tabsRef.current.find((t) => t.id === tabId)
      if (!tab) return false
      // an optimised copy is built from the original bytes, so swapping it in
      // would throw away the image edits the viewer is currently showing
      if (tab.model.annotations.some((a) => a.type === 'imgedit')) return false
      const fast = await loadPdf(bytes)
      if (fast.numPages !== tab.pdfDoc.numPages) {
        // Should be impossible, but a mismatch would misalign every overlay.
        void fast.destroy().catch(() => {})
        return false
      }

      // Re-derive the layer config from the new document and carry the user's
      // current visibility choices across.
      let layerConfig: unknown | null = null
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const occ: any = await fast.getOptionalContentConfig()
        if (occ?.getGroups?.() && Object.keys(occ.getGroups()).length) {
          for (const l of tab.layers ?? []) occ.setVisibility(l.id, l.visible)
          layerConfig = occ
        }
      } catch {
        /* file has no layers */
      }

      const stale = tab.pdfDoc
      setTabs((ts) =>
        ts.map((t) =>
          t.id === tabId
            ? { ...t, pdfDoc: fast, layerConfig, layerVersion: t.layerVersion + 1 }
            : t
        )
      )
      // Give in-flight render tasks a moment to unwind before tearing down the
      // document they are drawing from.
      setTimeout(() => void stale.destroy().catch(() => {}), 2000)
      return true
    },
    []
  )

  /**
   * A page took too long to draw. Build (or fetch) an optimised render copy in
   * the background and swap it in when it is ready.
   *
   * Runs at most once per tab. The result is cached on disk against a hash of
   * the original bytes, so this is a one-time cost per document — the same
   * pattern the OCR cache uses.
   */
  const startSpeedUp = useCallback(
    async (tabId: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId)
      if (!tab || tab.speedUpTried) return
      setTabs((ts) => ts.map((t) => (t.id === tabId ? { ...t, speedUpTried: true } : t)))

      const hash = await sha256Hex(tab.srcBytes).catch(() => null)
      if (hash) {
        const cached = await window.api.optCacheGet(hash).catch(() => null)
        if (cached && cached.byteLength) {
          if (await applyFastDoc(tabId, cached)) {
            setStatus('Ready. (using cached fast copy)')
            window.setTimeout(() => setStatus('Ready.'), 4000)
          }
          return
        }
      }

      setStatus('Heavy drawing detected — speeding up in the background…')
      try {
        const { bytes, stats } = await optimizePdfInWorker(tab.srcBytes, {}, (p) => {
          setStatus(`Speeding up in the background… ${p.label}`)
        })
        const savedOps =
          stats.segmentsBefore - stats.segmentsAfter + stats.wrappersFlattened * 2 + stats.strokesMerged
        if (savedOps < 10000) {
          setStatus('Ready.')
          return
        }
        // Cache first: even if the tab has since closed, the next open wins.
        if (hash) void window.api.optCacheSet(hash, bytes.slice(0)).catch(() => {})
        if (await applyFastDoc(tabId, bytes)) {
          toast(
            `Speeded up for viewing: ${(savedOps / 1e6).toFixed(1)}M redundant drawing ` +
              `operations skipped. Your file on disk is unchanged.`,
            'ok'
          )
        }
      } catch (e) {
        // Never surface this as an error — the document still works, just slowly.
        console.warn('background speed-up failed', e)
      } finally {
        setStatus('Ready.')
      }
    },
    [applyFastDoc, toast]
  )

  /**
   * Threshold for "this document is painful". Well above a normal page (a text
   * page renders in tens of milliseconds) and below the seconds-per-page a
   * dense plan sheet costs, so ordinary files never trigger the work.
   */
  const SLOW_PAGE_MS = 1200
  const noteRenderTime = useCallback(
    (ms: number) => {
      if (ms < SLOW_PAGE_MS) return
      const id = activeIdRef.current
      if (!id) return
      const tab = tabsRef.current.find((t) => t.id === id)
      if (!tab || tab.speedUpTried || tab.dirty) return
      void startSpeedUp(id)
    },
    [startSpeedUp]
  )

  // ---- Optimise for fast viewing ----------------------------------------
  /**
   * Produce an optimised copy and adopt it as the document, so **Save As**
   * writes the faster file out.
   *
   * This is the deliberate, permanent version of what `startSpeedUp` does
   * silently in the background: same rewrite, but here the result becomes the
   * tab's source bytes rather than just its render document, because the point
   * is to hand someone a file that is fast everywhere — Bluebeam, a phone, a
   * browser — not only in PDF Studio.
   */
  const handleOptimize = useCallback(async () => {
    const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
    if (!tab) return
    if (tab.dirty) {
      toast('Save your changes first — this rebuilds the document.', 'err')
      return
    }
    setBusy(true)
    setStatus('Building a faster copy…')
    try {
      const hash = await sha256Hex(tab.srcBytes).catch(() => null)
      let bytes: ArrayBuffer | null = null
      let savedOps = -1

      // The background pass may already have produced exactly these bytes.
      if (hash) {
        const cached = await window.api.optCacheGet(hash).catch(() => null)
        if (cached && cached.byteLength) bytes = cached
      }
      if (!bytes) {
        const res = await optimizePdfInWorker(tab.srcBytes, {}, (p) => {
          setStatus(`Building a faster copy… ${p.label}`)
        })
        bytes = res.bytes
        const st = res.stats
        savedOps = st.segmentsBefore - st.segmentsAfter + st.wrappersFlattened * 2 + st.strokesMerged
        if (savedOps < 10000) {
          toast('This file is already lean — nothing worth rewriting.', 'ok')
          return
        }
        if (hash) void window.api.optCacheSet(hash, bytes.slice(0)).catch(() => {})
      }

      const before = tab.srcBytes.byteLength / 1e6
      const after = bytes.byteLength / 1e6
      const oldDoc = tab.pdfDoc
      await buildTab(bytes, tab.model.fileName, { replaceId: tab.id, srcPath: tab.srcPath })
      setTimeout(() => void oldDoc.destroy().catch(() => {}), 1500)
      toast(
        (savedOps > 0 ? `${(savedOps / 1e6).toFixed(1)}M redundant drawing operations removed. ` : '') +
          `${before.toFixed(1)} MB → ${after.toFixed(1)} MB. Save As to keep this copy.`,
        'ok'
      )
    } catch (e) {
      toast('Could not build a faster copy: ' + ((e as Error)?.message || 'unknown error'), 'err')
    } finally {
      setBusy(false)
      setStatus('Ready.')
    }
  }, [buildTab, toast])

  // ---- Save / Extract / Print ------------------------------------------
  const bakeTab = useCallback(async (tab: DocTab, flatten = false): Promise<Uint8Array> => {
    return bakeAndSave(tab.srcBytes, tab.model, {
      keepForms: tab.keepForms && hasFieldAnnots(tab.model),
      rasterizeLeaf: makeRasterizer(tab.pdfDoc, tab.layerConfig ?? undefined),
      // saved scans become searchable PDFs in any reader
      ocrWords: (srcPage) => tab.ocrPages[srcPage],
      // persist layer visibility toggles into the saved file
      layers: tab.layers ?? undefined,
      // a plain save keeps text/checks/X's/circles/markup editable
      flatten
    })
  }, [])

  /** Save a tab. Returns true on success. saveAs forces the file dialog. */
  const saveTab = useCallback(
    async (tabId: string, saveAs: boolean): Promise<boolean> => {
      const tab = tabsRef.current.find((t) => t.id === tabId)
      if (!tab) return false
      setBusy(true)
      setStatus('Saving…')
      try {
        const bytes = await bakeTab(tab)
        const buf = toArrayBuffer(bytes)
        if (!saveAs && tab.srcPath) {
          const res = await window.api.savePdfToPath(tab.srcPath, buf)
          if (!res.ok) {
            toast('Save failed: ' + res.error, 'err')
            return false
          }
          setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, dirty: false } : t)))
          setStatus('Saved to ' + tab.srcPath)
          toast('Saved.', 'ok')
          return true
        }
        const path = await window.api.savePdf(buf, tab.model.fileName)
        if (!path) {
          setStatus('Save cancelled.')
          return false
        }
        const newName = path.split(/[\\/]/).pop() || tab.model.fileName
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId ? { ...t, dirty: false, srcPath: path, model: { ...t.model, fileName: newName } } : t
          )
        )
        setStatus('Saved to ' + path)
        toast('Saved.', 'ok')
        return true
      } catch (err) {
        console.error(err)
        toast('Save failed: ' + errMsg(err), 'err')
        return false
      } finally {
        setBusy(false)
      }
    },
    [bakeTab, toast]
  )

  const handleSave = useCallback(() => {
    if (activeIdRef.current) void saveTab(activeIdRef.current, false)
  }, [saveTab])
  const handleSaveAs = useCallback(() => {
    if (activeIdRef.current) void saveTab(activeIdRef.current, true)
  }, [saveTab])

  /**
   * Flatten now: burn the editable marks into the pages and reopen the result,
   * so what you see is what every reader will see. Undo history goes with it —
   * the marks are page content afterwards, not objects we can put back.
   */
  const flattenNow = useCallback(async () => {
    const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
    if (!tab) return
    const n = countEditable(tab.model.annotations)
    setBusy(true)
    setStatus('Flattening…')
    try {
      const bytes = await bakeTab(tab, true)
      const buf = toArrayBuffer(bytes)
      const byPage = tab.model.leaves.map((l) => tab.model.calibrations[l.id])
      const oldDoc = tab.pdfDoc
      await buildTab(buf, tab.model.fileName, {
        replaceId: tab.id,
        srcPath: tab.srcPath,
        calibrationsByPage: byPage
      })
      // the rebuilt tab matches the flattened bytes, but the file on disk doesn't
      patchActive({ dirty: true })
      setTimeout(() => oldDoc.destroy().catch(() => {}), 1500)
      toast(
        n > 0
          ? `Flattened ${n} mark${n === 1 ? '' : 's'} into the page. Save to write it to the file.`
          : 'Nothing was editable — the document is already flat.',
        'ok'
      )
    } catch (err) {
      console.error(err)
      toast('Flatten failed: ' + errMsg(err), 'err')
    } finally {
      setBusy(false)
      setStatus('Ready.')
    }
  }, [bakeTab, buildTab, patchActive, toast])

  const handleExtract = useCallback(
    async (leafIds: string[]) => {
      const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
      if (!tab || leafIds.length === 0) return
      setBusy(true)
      try {
        const bytes = await extractPages(tab.srcBytes, tab.model, leafIds, {
          rasterizeLeaf: makeRasterizer(tab.pdfDoc, tab.layerConfig ?? undefined),
          ocrWords: (srcPage) => tab.ocrPages[srcPage]
        })
        const stem = tab.model.fileName.replace(/\.pdf$/i, '')
        const only = leafIds.length === 1 ? tab.model.leaves.findIndex((l) => l.id === leafIds[0]) + 1 : 0
        const name = only ? `${stem} (page ${only}).pdf` : `${stem} (${leafIds.length} pages).pdf`
        const path = await window.api.savePdf(toArrayBuffer(bytes), name)
        if (path) toast(`Extracted ${leafIds.length} page(s).`, 'ok')
      } catch (err) {
        toast('Extract failed: ' + errMsg(err), 'err')
      } finally {
        setBusy(false)
      }
    },
    [toast]
  )

  // The page dialogs talk 1-based page numbers; everything downstream is leaf ids.
  const pagesToIds = useCallback((pages: number[]): string[] => {
    const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
    if (!tab) return []
    return pages.map((n) => tab.model.leaves[n - 1]?.id).filter((id): id is string => !!id)
  }, [])

  const [extractOpen, setExtractOpen] = useState(false)
  const extractByPage = useCallback(
    (pages: number[]) => {
      setExtractOpen(false)
      void handleExtract(pagesToIds(pages))
    },
    [handleExtract, pagesToIds]
  )

  const handlePrint = useCallback(async () => {
    const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
    if (!tab) return
    setBusy(true)
    setStatus('Preparing to print…')
    try {
      const bytes = await bakeTab(tab)
      const html = await buildPrintHtml(bytes, (d, t) => setStatus(`Preparing page ${d} of ${t} for print…`))
      const res = await window.api.printHtml(html)
      if (!res.ok && res.error && !/cancel/i.test(res.error)) toast('Print failed: ' + res.error, 'err')
      setStatus('Ready.')
    } catch (err) {
      toast('Print failed: ' + errMsg(err), 'err')
      setStatus('Ready.')
    } finally {
      setBusy(false)
    }
  }, [bakeTab, toast])

  // ---- Page ops ---------------------------------------------------------
  const rotateLeaves = useCallback(
    (leafIds: string[], dir: 1 | -1) => {
      const ids = new Set(leafIds)
      commitModel((m) => ({
        ...m,
        leaves: m.leaves.map((l) =>
          ids.has(l.id) ? { ...l, rotation: (((l.rotation + dir * 90) % 360) + 360) % 360 } : l
        )
      }))
    },
    [commitModel]
  )

  const deleteLeaves = useCallback(
    (leafIds: string[]) => {
      const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
      if (!tab) return
      const ids = new Set(leafIds)
      if (ids.size >= tab.model.leaves.length) {
        toast('A document must keep at least one page.', 'err')
        return
      }
      commitModel((m) => ({
        ...m,
        leaves: m.leaves.filter((l) => !ids.has(l.id)),
        annotations: m.annotations.filter((a) => !ids.has(a.leafId))
      }))
      patchActive({ selectedLeaves: tab.selectedLeaves.filter((id) => !ids.has(id)) })
    },
    [commitModel, patchActive, toast]
  )

  const duplicateLeaves = useCallback(
    (leafIds: string[]) => {
      const ids = new Set(leafIds)
      commitModel((m) => {
        const leaves: PageLeaf[] = []
        const annotations = [...m.annotations]
        const calibrations = { ...m.calibrations }
        for (const l of m.leaves) {
          leaves.push(l)
          if (!ids.has(l.id)) continue
          const copy: PageLeaf = { id: uid(), srcPage: l.srcPage, rotation: l.rotation }
          leaves.push(copy)
          if (calibrations[l.id]) calibrations[copy.id] = calibrations[l.id]
          for (const a of m.annotations) {
            if (a.leafId !== l.id) continue
            annotations.push({ ...a, id: uid(), leafId: copy.id } as Annotation)
          }
        }
        return { ...m, leaves, annotations, calibrations }
      })
    },
    [commitModel]
  )

  const reorderLeaf = useCallback(
    (fromId: string, toId: string) => {
      commitModel((m) => {
        const arr = [...m.leaves]
        const from = arr.findIndex((l) => l.id === fromId)
        const to = arr.findIndex((l) => l.id === toId)
        if (from < 0 || to < 0) return m
        const [moved] = arr.splice(from, 1)
        arr.splice(to, 0, moved)
        return { ...m, leaves: arr }
      })
    },
    [commitModel]
  )

  /**
   * Structural inserts append pages to the underlying PDF bytes (via pdf-lib)
   * and reload pdf.js — existing leaves keep their srcPage refs because new
   * pages always go at the end of the file; display order lives in `leaves`.
   */
  const mutateSource = useCallback(
    async (mutate: (doc: PDFDocument) => Promise<void> | void, insertAt: number, label: string) => {
      const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
      if (!tab) return
      setBusy(true)
      setStatus(label)
      try {
        const src = await PDFDocument.load(tab.srcBytes, { ignoreEncryption: true })
        const before = src.getPageCount()
        await mutate(src)
        const added = src.getPageCount() - before
        if (added <= 0) return
        const saved = await src.save()
        const newBytes = toArrayBuffer(saved)
        const newDoc = await loadPdf(newBytes)
        const newLeaves: PageLeaf[] = Array.from({ length: added }, (_, k) => ({
          id: uid(),
          srcPage: before + k + 1,
          rotation: 0
        }))
        const oldDoc = tab.pdfDoc
        const h = histRef.current[tab.id] || (histRef.current[tab.id] = { past: [], future: [] })
        h.past.push(tab.model)
        if (h.past.length > HISTORY_LIMIT) h.past.shift()
        h.future = []
        h.lastTag = undefined
        setTabs((prev) =>
          prev.map((t) => {
            if (t.id !== tab.id) return t
            const leaves = [...t.model.leaves]
            const at = Math.min(Math.max(insertAt, 0), leaves.length)
            leaves.splice(at, 0, ...newLeaves)
            return { ...t, srcBytes: newBytes, pdfDoc: newDoc, dirty: true, model: { ...t.model, leaves } }
          })
        )
        setHistVer((v) => v + 1)
        setTimeout(() => oldDoc.destroy().catch(() => {}), 3000)
        // new bytes / new pdf.js doc — restart OCR (token guard kills the old
        // run; deferred so tabsRef reflects the swapped-in document first)
        setTimeout(() => ocrRunRef.current?.(tab.id), 100)
        detectFields(newDoc, newLeaves)
          .then((fields) => {
            if (!fields.length) return
            setTabs((prev) =>
              prev.map((t) =>
                t.id === tab.id && t.pdfDoc === newDoc
                  ? { ...t, model: { ...t.model, annotations: [...t.model.annotations, ...fields] } }
                  : t
              )
            )
          })
          .catch(() => {})
        setStatus(`Inserted ${added} page${added === 1 ? '' : 's'}.`)
      } catch (err) {
        toast(label.replace('…', '') + ' failed: ' + errMsg(err), 'err')
        setStatus('Ready.')
      } finally {
        setBusy(false)
      }
    },
    [toast]
  )

  const insertFromPdf = useCallback(async () => {
    const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
    if (!tab) return
    const others = await window.api.openPdfs('Insert pages from…')
    if (!others.length) return
    await mutateSource(
      async (doc) => {
        for (const other of others) {
          const otherDoc = await PDFDocument.load(other.bytes, { ignoreEncryption: true })
          const pages = await doc.copyPages(otherDoc, otherDoc.getPageIndices())
          for (const p of pages) doc.addPage(p)
        }
      },
      tab.currentPage, // display position: after the current page
      others.length === 1 ? `Inserting pages from ${others[0].name}…` : `Inserting pages from ${others.length} PDFs…`
    )
  }, [mutateSource])

  /** Pictures become full pages after the current one (Pages tab, or drag & drop). */
  const insertImageFiles = useCallback(
    async (files: { name: string; bytes: ArrayBuffer }[]) => {
      const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
      if (!tab || !files.length) return
      await mutateSource(
        async (doc) => {
          for (const f of files) await addImagePage(doc, f.bytes)
        },
        tab.currentPage,
        files.length === 1 ? `Inserting ${files[0].name} as a page…` : `Inserting ${files.length} pictures as pages…`
      )
    },
    [mutateSource]
  )

  const insertImages = useCallback(async () => {
    const files = await window.api.openImages()
    await insertImageFiles(files)
  }, [insertImageFiles])

  const insertBlank = useCallback(async () => {
    const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
    if (!tab) return
    const curLeaf = tab.model.leaves[Math.max(0, (tab.currentPage || 1) - 1)]
    await mutateSource(
      (doc) => {
        const refIdx = Math.min((curLeaf?.srcPage ?? 1) - 1, doc.getPageCount() - 1)
        const { width, height } = doc.getPage(Math.max(0, refIdx)).getSize()
        doc.addPage([width, height])
      },
      tab.currentPage,
      'Inserting blank page…'
    )
  }, [mutateSource])

  const duplicateCurrent = useCallback(() => {
    const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
    if (!tab) return
    const curLeaf = tab.model.leaves[Math.max(0, (tab.currentPage || 1) - 1)]
    if (curLeaf) duplicateLeaves([curLeaf.id])
  }, [duplicateLeaves])

  // Ribbon page actions work on the page you're looking at, not the sidebar
  // selection — the sidebar is only a shortcut for picking several at once.
  const rotateCurrent = useCallback(
    (dir: 1 | -1) => {
      const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
      if (!tab) return
      const curLeaf = tab.model.leaves[Math.max(0, (tab.currentPage || 1) - 1)]
      if (curLeaf) rotateLeaves([curLeaf.id], dir)
    },
    [rotateLeaves]
  )

  const [rotateOpen, setRotateOpen] = useState(false)
  const [rotateDir, setRotateDir] = useState<1 | -1>(1)
  const rotateByPage = useCallback(
    (pages: number[]) => {
      setRotateOpen(false)
      rotateLeaves(pagesToIds(pages), rotateDir)
    },
    [rotateLeaves, pagesToIds, rotateDir]
  )

  const [deleteOpen, setDeleteOpen] = useState(false)
  const deleteByPage = useCallback(
    (pages: number[]) => {
      setDeleteOpen(false)
      deleteLeaves(pagesToIds(pages))
    },
    [deleteLeaves, pagesToIds]
  )

  // ---- Annotation CRUD --------------------------------------------------
  const createAnnot = useCallback(
    (a: Annotation) => {
      // Placing something while an untouched text box is open (the text tool
      // stays armed, so clicking again starts another box) drops that box in
      // the *same* commit — commitModel reads the model as of the last render,
      // so a second commit in this tick would undo this one.
      const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
      const open = tab?.editingId ? tab.model.annotations.find((x) => x.id === tab.editingId) : undefined
      const drop = open && open.type === 'text' && !(open.text || '').trim() ? open.id : null
      commitModel((m) => ({
        ...m,
        annotations: [...(drop ? m.annotations.filter((x) => x.id !== drop) : m.annotations), a]
      }))
      patchActive({ selectedId: a.id })
      if (a.type === 'whiteout' && !whiteoutNoticeRef.current) {
        whiteoutNoticeRef.current = true
        toast('Whiteout permanently removes the content beneath it when you save — that page is rebuilt as a high-resolution image.', 'info')
      }
    },
    [commitModel, patchActive, toast]
  )

  const updateAnnot = useCallback(
    (a: Annotation, coalesceTag?: string) => {
      commitModel((m) => ({ ...m, annotations: m.annotations.map((x) => (x.id === a.id ? a : x)) }), coalesceTag)
    },
    [commitModel]
  )

  const deleteAnnot = useCallback(
    (id: string) => {
      commitModel((m) => ({ ...m, annotations: m.annotations.filter((x) => x.id !== id) }))
      const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
      if (tab && (tab.selectedId === id || tab.editingId === id)) {
        patchActive({
          selectedId: tab.selectedId === id ? null : tab.selectedId,
          editingId: tab.editingId === id ? null : tab.editingId
        })
      }
    },
    [commitModel, patchActive]
  )


  // ---- embedded images ---------------------------------------------------
  //
  // Editing an image means editing the page's content stream, which the
  // overlay model can't express — so the change lands in the model as an
  // `imgedit` record and the *rendered* document is rebuilt from it. srcBytes
  // is never touched; the save pipeline replays the same records.

  /** The pdf-lib copy of a tab's source, loaded once and kept for scanning. */
  const ensureImageDoc = useCallback(async (tabId: string): Promise<PDFDocument | null> => {
    const cached = imageDocRef.current[tabId]
    if (cached) return cached
    const tab = tabsRef.current.find((t) => t.id === tabId)
    if (!tab) return null
    const p = PDFDocument.load(tab.srcBytes, { ignoreEncryption: true }).catch((e) => {
      console.warn('could not open the file for image editing', e)
      return null
    })
    imageDocRef.current[tabId] = p
    return p
  }, [])

  /** Find the images one page draws, and remember them on the tab. */
  const scanImagesForPage = useCallback(
    async (srcPage: number) => {
      const tabId = activeIdRef.current
      if (!tabId) return
      if (tabsRef.current.find((t) => t.id === tabId)?.pageImages[srcPage]) return
      const doc = await ensureImageDoc(tabId)
      if (!doc) return
      const found = scanPageImages(doc, srcPage - 1)
      setTabs((ts) =>
        ts.map((t) => (t.id === tabId ? { ...t, pageImages: { ...t.pageImages, [srcPage]: found } } : t))
      )
    },
    [ensureImageDoc]
  )

  /** Create or update the record behind one edited image. */
  const handleImageChange = useCallback(
    (rec: ImageEditAnnot, tag?: string) => {
      commitModel(
        (m) => ({
          ...m,
          annotations: m.annotations.some((a) => a.id === rec.id)
            ? m.annotations.map((a) => (a.id === rec.id ? rec : a))
            : [...m.annotations, rec]
        }),
        tag
      )
    },
    [commitModel]
  )

  const selectImage = useCallback(
    (sel: ImageSel | null) => patchActive(sel ? { imageSel: sel } : { imageSel: null, imageCrop: false }),
    [patchActive]
  )

  /** Everything the image commands need about the current selection. */
  const imageContext = useCallback(() => {
    const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
    const sel = tab?.imageSel
    if (!tab || !sel) return null
    const leaf = tab.model.leaves[tab.currentPage - 1]
    if (!leaf) return null
    const base = (tab.pageImages[leaf.srcPage] ?? []).find((i) => i.index === sel.drawIndex)
    if (!base) return null
    const rec = tab.model.annotations.find(
      (a): a is ImageEditAnnot =>
        a.type === 'imgedit' && a.leafId === leaf.id && a.drawIndex === sel.drawIndex && a.instance === sel.instance
    )
    const m = rec?.m ?? (sel.instance === 0 ? base.ctm : null)
    if (!m) return null
    return { tab, leaf, base, rec, sel, m, crop: rec?.crop }
  }, [])

  /** Rewrite the selected image's placement through `fn`. */
  const editSelectedImage = useCallback(
    (fn: (m: Matrix, crop: Box | undefined) => { m: Matrix; crop?: Box }, tag?: string) => {
      const c = imageContext()
      if (!c) return
      const next = fn(c.m, c.crop)
      handleImageChange(
        {
          id: c.rec?.id ?? uid(),
          leafId: c.leaf.id,
          type: 'imgedit',
          drawIndex: c.sel.drawIndex,
          instance: c.sel.instance,
          imageId: c.rec?.imageId,
          ...next
        },
        tag
      )
    },
    [imageContext, handleImageChange]
  )

  /** Turn a placement by whole degrees about the middle of what is visible. */
  const rotateImage = useCallback(
    (deg: number) => {
      editSelectedImage((m, crop) => {
        const cx = m[0] * 0.5 + m[2] * 0.5 + m[4]
        const cy = m[1] * 0.5 + m[3] * 0.5 + m[5]
        const r = (deg * Math.PI) / 180
        const cos = Math.cos(r)
        const sin = Math.sin(r)
        const about = mulM(
          mulM([1, 0, 0, 1, -cx, -cy] as Matrix, [cos, sin, -sin, cos, 0, 0] as Matrix),
          [1, 0, 0, 1, cx, cy] as Matrix
        )
        return { m: mulM(m, about), crop }
      })
    },
    [editSelectedImage]
  )

  const flipImage = useCallback(
    (axis: 'h' | 'v') => {
      editSelectedImage((m, crop) => ({
        m: mulM(axis === 'h' ? ([-1, 0, 0, 1, 1, 0] as Matrix) : ([1, 0, 0, -1, 0, 1] as Matrix), m),
        crop
      }))
    },
    [editSelectedImage]
  )

  /** Another draw of the same image, offset so it reads as a second copy. */
  const duplicateImage = useCallback(() => {
    const c = imageContext()
    if (!c) return
    const used = c.tab.model.annotations.filter(
      (a): a is ImageEditAnnot => a.type === 'imgedit' && a.leafId === c.leaf.id && a.drawIndex === c.sel.drawIndex
    )
    const instance = Math.max(0, ...used.map((a) => a.instance)) + 1
    handleImageChange({
      id: uid(),
      leafId: c.leaf.id,
      type: 'imgedit',
      drawIndex: c.sel.drawIndex,
      instance,
      m: mulM(c.m, [1, 0, 0, 1, 12, -12] as Matrix),
      crop: c.crop,
      imageId: c.rec?.imageId
    })
    patchActive({ imageSel: { drawIndex: c.sel.drawIndex, instance } })
  }, [imageContext, handleImageChange, patchActive])

  /**
   * Remove the selected image. The one the file came with is suppressed with a
   * flag — its record still remembers where it was, so Reset can bring it
   * back; a copy simply stops existing.
   */
  const deleteImage = useCallback(() => {
    const c = imageContext()
    if (!c) return
    if (c.sel.instance === 0) {
      handleImageChange({
        id: c.rec?.id ?? uid(),
        leafId: c.leaf.id,
        type: 'imgedit',
        drawIndex: c.sel.drawIndex,
        instance: 0,
        m: c.m,
        crop: c.crop,
        imageId: c.rec?.imageId,
        deleted: true
      })
    } else if (c.rec) {
      const doomed = c.rec.id
      commitModel((m) => ({ ...m, annotations: m.annotations.filter((a) => a.id !== doomed) }))
    }
    patchActive({ imageSel: null, imageCrop: false })
  }, [imageContext, handleImageChange, commitModel, patchActive])

  /** Put the image back exactly as the file had it. */
  const resetImage = useCallback(() => {
    const c = imageContext()
    if (!c?.rec) return
    const doomed = c.rec.id
    if (c.sel.instance === 0) {
      commitModel((m) => ({ ...m, annotations: m.annotations.filter((a) => a.id !== doomed) }))
    }
    patchActive({ imageCrop: false })
  }, [imageContext, commitModel, patchActive])

  const toggleImageCrop = useCallback(() => {
    const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
    if (!tab?.imageSel) return
    patchActive({ imageCrop: !tab.imageCrop })
  }, [patchActive])

  /**
   * Trim the cropped-away pixels for real, instead of hiding them behind a
   * clip. The image is re-encoded at its own resolution and takes the place of
   * the original, so the hidden content is gone for good.
   */
  const applyImageCrop = useCallback(async () => {
    const c = imageContext()
    if (!c) return
    const crop = c.crop
    if (!crop || (crop.w >= 0.999 && crop.h >= 0.999)) {
      toast('Nothing is cropped off this image yet.', 'info')
      return
    }
    setStatus('Trimming image…')
    const shownAt = previewDrawIndex(
      c.tab.model.annotations.filter(
        (a): a is ImageEditAnnot => a.type === 'imgedit' && a.leafId === c.leaf.id
      ),
      c.sel.drawIndex
    )
    const source = shownAt < 0 ? null : await decodeEmbeddedImage(c.tab.pdfDoc, c.leaf.srcPage, shownAt)
    if (!source) {
      toast(
        'This image could not be decoded, so the crop stays as a clipping region — it still prints and exports correctly.',
        'info'
      )
      setStatus('')
      return
    }
    const stored = await cropToStoredImage(source, crop)
    if (!stored) {
      toast('Could not re-encode the cropped image.', 'err')
      setStatus('')
      return
    }
    const rec: ImageEditAnnot = {
      id: c.rec?.id ?? uid(),
      leafId: c.leaf.id,
      type: 'imgedit',
      drawIndex: c.sel.drawIndex,
      instance: c.sel.instance,
      m: c.m,
      imageId: stored.id
    }
    commitModel((m) => ({
      ...m,
      images: { ...m.images, [stored.id]: stored },
      annotations: m.annotations.some((a) => a.id === rec.id)
        ? m.annotations.map((a) => (a.id === rec.id ? rec : a))
        : [...m.annotations, rec]
    }))
    patchActive({ imageCrop: false })
    setStatus(`Image trimmed to ${stored.width} × ${stored.height} px`)
  }, [imageContext, commitModel, patchActive, toast])

  // Decode the selected image once, for the drag preview.
  useEffect(() => {
    const tab = active
    const sel = tab?.imageSel
    if (!tab || !sel) return
    const leaf = tab.model.leaves[tab.currentPage - 1]
    if (!leaf) return
    const key = `${leaf.srcPage}:${sel.drawIndex}`
    if (key in tab.imageBitmaps) return
    const shownAt = previewDrawIndex(
      tab.model.annotations.filter((a): a is ImageEditAnnot => a.type === 'imgedit' && a.leafId === leaf.id),
      sel.drawIndex
    )
    if (shownAt < 0) return
    let cancelled = false
    void previewImage(tab.pdfDoc, leaf.srcPage, shownAt).then((canvas) => {
      if (cancelled) return
      setTabs((ts) =>
        ts.map((t) => (t.id === tab.id ? { ...t, imageBitmaps: { ...t.imageBitmaps, [key]: canvas } } : t))
      )
    })
    return () => {
      cancelled = true
    }
  }, [active?.id, active?.imageSel, active?.currentPage, active?.pdfDoc])

  /**
   * Rebuild the document the viewer draws from, with the image edits applied.
   *
   * This is the only truthful way to show a content-stream edit — no overlay
   * can move an image that is already part of the page. `srcBytes` stays
   * untouched, so saving still starts from the file that came off disk.
   */
  const rebuildImagePreview = useCallback(
    async (tabId: string, sig: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId)
      if (!tab || tab.imagePreviewSig === sig) return
      setTabs((ts) => ts.map((t) => (t.id === tabId ? { ...t, imagePreviewBusy: true } : t)))
      try {
        const doc = await PDFDocument.load(tab.srcBytes, { ignoreEncryption: true })
        const recs = tab.model.annotations.filter((a): a is ImageEditAnnot => a.type === 'imgedit')
        const embedded: Record<string, PDFRef> = {}
        for (const id of new Set(recs.map((r) => r.imageId).filter((x): x is string => !!x))) {
          const img = tab.model.images[id]
          if (!img) continue
          const emb = img.kind === 'png' ? await doc.embedPng(img.bytes) : await doc.embedJpg(img.bytes)
          embedded[id] = emb.ref
        }
        // One page object serves every leaf that shows it, so the preview uses
        // the first such leaf's edits. Saving is exact — it gives each leaf a
        // page of its own.
        const bySrc = new Map<number, ImageEditAnnot[]>()
        const leafById = new Map(tab.model.leaves.map((l) => [l.id, l]))
        for (const r of recs) {
          const leaf = leafById.get(r.leafId)
          if (!leaf) continue
          const arr = bySrc.get(leaf.srcPage) ?? []
          if (arr.length === 0 || arr[0].leafId === r.leafId) {
            arr.push(r)
            bySrc.set(leaf.srcPage, arr)
          }
        }
        const pages = doc.getPages()
        for (const [srcPage, group] of bySrc) {
          const page = pages[srcPage - 1]
          if (page) applyImageEdits(doc, page, buildDrawEdits(group, (id) => embedded[id]))
        }
        const bytes = await doc.save({ updateFieldAppearances: false, useObjectStreams: false })
        const next = await loadPdf(toArrayBuffer(bytes))
        const still = tabsRef.current.find((t) => t.id === tabId)
        if (!still || next.numPages !== still.pdfDoc.numPages) {
          void next.destroy().catch(() => {})
          return
        }
        let layerConfig: unknown | null = null
        try {
          const occ = (await next.getOptionalContentConfig()) as {
            getGroups?: () => Record<string, unknown>
            setVisibility?: (id: string, v: boolean) => void
          } | null
          if (occ?.getGroups && Object.keys(occ.getGroups()).length) {
            for (const l of still.layers ?? []) occ.setVisibility?.(l.id, l.visible)
            layerConfig = occ
          }
        } catch {
          /* no layers in this file */
        }
        const stale = still.pdfDoc
        setTabs((ts) =>
          ts.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  pdfDoc: next,
                  layerConfig,
                  layerVersion: t.layerVersion + 1,
                  imagePreviewSig: sig,
                  imagePreviewBusy: false,
                  imageBitmaps: {}
                }
              : t
          )
        )
        setTimeout(() => void stale.destroy().catch(() => {}), 2000)
      } catch (e) {
        console.warn('could not preview the image edits', e)
        setTabs((ts) => ts.map((t) => (t.id === tabId ? { ...t, imagePreviewBusy: false } : t)))
        toast('Could not redraw the page with that change — it will still be applied when you save.', 'err')
      }
    },
    [toast]
  )

  // The image commands act on the current page, so a selection must not
  // outlive the page it was made on — otherwise scrolling away and pressing
  // Delete would remove a different page's picture with the same draw index.
  useEffect(() => {
    if (active?.imageSel) patchActive({ imageSel: null, imageCrop: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, active?.currentPage])

  /** Size and resolution of the selected image, for the properties bar. */
  const imageSelInfo = useMemo(() => {
    const tab = active
    const sel = tab?.imageSel
    if (!tab || !sel) return null
    const leaf = tab.model.leaves[tab.currentPage - 1]
    if (!leaf) return null
    const base = (tab.pageImages[leaf.srcPage] ?? []).find((i) => i.index === sel.drawIndex)
    if (!base) return null
    const rec = tab.model.annotations.find(
      (a): a is ImageEditAnnot =>
        a.type === 'imgedit' && a.leafId === leaf.id && a.drawIndex === sel.drawIndex && a.instance === sel.instance
    )
    const m = rec?.m ?? (sel.instance === 0 ? base.ctm : null)
    if (!m) return null
    const d = decomposeM(m)
    const crop = rec?.crop
    // the visible part carries only its share of the pixels
    const px = Math.round(base.pxWidth * (crop?.w ?? 1))
    const dpi = d.w > 0.01 ? Math.round((px / d.w) * 72) : 0
    const inches = (v: number): string => (v / 72).toFixed(2)
    return {
      label: `${inches(d.w)} × ${inches(d.h)} in${dpi >= 10 ? ` · ${dpi} dpi` : ''}`,
      rotation: Math.round(d.rotation),
      cropped: !!crop,
      copy: sel.instance > 0,
      edited: !!rec
    }
  }, [active?.imageSel, active?.currentPage, active?.pageImages, active?.model.annotations, active?.model.leaves])

  // ---- standard page size -------------------------------------------------

  const [pageSizeOpen, setPageSizeOpen] = useState(false)
  const [pageSizeList, setPageSizeList] = useState<PageSizeInfo[]>([])

  /** Measure every page as the viewer shows it, then offer the size dialog. */
  const openPageSize = useCallback(async () => {
    const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
    if (!tab) return
    const sizes: PageSizeInfo[] = []
    for (const leaf of tab.model.leaves) {
      try {
        const page = await tab.pdfDoc.getPage(leaf.srcPage)
        const rot = (((page.rotate + leaf.rotation) % 360) + 360) % 360
        const vp = page.getViewport({ scale: 1, rotation: rot })
        sizes.push({ w: vp.width, h: vp.height })
      } catch {
        sizes.push({ w: 612, h: 792 })
      }
    }
    setPageSizeList(sizes)
    setPageSizeOpen(true)
  }, [])

  /**
   * Rewrite the file onto a standard sheet and rebuild the tab around it.
   *
   * The marks in the model move with the content rather than being baked in
   * first, so a text box stays a text box and every image stays editable — the
   * page's own geometry is all that changes.
   */
  const applyPageSize = useCallback(
    async (pages: number[], opts: { sizeId: string; orientation: Orientation; fit: FitMode }) => {
      setPageSizeOpen(false)
      const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
      const sheet = SHEET_SIZES.find((s) => s.id === opts.sizeId)
      if (!tab || !sheet) return
      setBusy(true)
      setStatus('Changing page size…')
      try {
        // the viewer's own page rotations are not in the file yet, so tell the
        // resizer about them or a rotated page would be sized the wrong way up
        const extraRotation: Record<number, number> = {}
        for (const leaf of tab.model.leaves) {
          if (leaf.rotation) extraRotation[leaf.srcPage - 1] = leaf.rotation
        }
        const srcPages = [...new Set(pages.map((n) => tab.model.leaves[n - 1]?.srcPage).filter(Boolean))].map(
          (n) => (n as number) - 1
        )
        const res = await resizePages(tab.srcBytes, {
          size: { w: sheet.w, h: sheet.h },
          orientation: opts.orientation,
          fit: opts.fit,
          pages: srcPages,
          extraRotation
        })
        if (res.changed === 0) {
          setStatus('')
          toast('Those pages are already that size.', 'info')
          return
        }
        const model = remapModel(tab.model, res.transforms)
        const ocrPages: Record<number, OcrWord[]> = {}
        for (const [key, words] of Object.entries(tab.ocrPages)) {
          const m = res.transforms[Number(key) - 1]
          ocrPages[Number(key)] = m ? remapOcr(words, m) : words
        }
        await buildTab(toArrayBuffer(res.bytes), tab.model.fileName, {
          replaceId: tab.id,
          srcPath: tab.srcPath,
          model,
          ocrPages,
          dirty: true
        })
        setStatus(
          `${res.changed} page${res.changed === 1 ? '' : 's'} resized to ${sheet.label.split(' — ')[0]}`
        )
      } catch (e) {
        toast(`Could not change the page size: ${errMsg(e)}`, 'err')
        setStatus('')
      } finally {
        setBusy(false)
      }
    },
    [buildTab, toast]
  )

  /** What the rendered document has to match: every image edit, in order. */
  const imageEditSig = useMemo(() => {
    const recs = active?.model.annotations.filter((a): a is ImageEditAnnot => a.type === 'imgedit') ?? []
    if (!recs.length) return ''
    return JSON.stringify(
      recs
        .map((r) => JSON.stringify([r.leafId, r.drawIndex, r.instance, r.m, r.crop, r.deleted, r.imageId]))
        .sort()
    )
  }, [active?.model.annotations])

  useEffect(() => {
    if (!active || imageEditSig === active.imagePreviewSig) return
    const id = active.id
    const t = window.setTimeout(() => void rebuildImagePreview(id, imageEditSig), 250)
    return () => window.clearTimeout(t)
  }, [active?.id, imageEditSig, active?.imagePreviewSig, rebuildImagePreview])

  /**
   * A text editor blurred: stop editing and drop the box if nothing was typed.
   * Only the *current* editor may close the editing state — a blur can land
   * after focus already moved to a new box (the new editor focuses itself on
   * mount), and clearing it then would leave that new box uneditable.
   */
  const finishTextEdit = useCallback(
    (id: string, text: string) => {
      const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
      if (tab?.editingId === id) patchActive({ editingId: null })
      if (!text.trim() && tab?.model.annotations.some((x) => x.id === id)) deleteAnnot(id)
    },
    [patchActive, deleteAnnot]
  )

  /** The annotation currently selected in the active tab (if any). */
  const findSelectedAnnot = useCallback((): Annotation | null => {
    const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
    if (!tab?.selectedId) return null
    return tab.model.annotations.find((a) => a.id === tab.selectedId) || null
  }, [])

  // Toolbar colour applies to new annotations AND to the selected one.
  const handleSetColor = useCallback(
    (c: string) => {
      setColor(c)
      const an = findSelectedAnnot()
      if (!an) return
      if (
        an.type === 'text' ||
        an.type === 'check' ||
        an.type === 'cross' ||
        an.type === 'circle' ||
        an.type === 'markup' ||
        an.type === 'measure' ||
        an.type === 'shape'
      ) {
        updateAnnot({ ...an, color: c } as Annotation, `color:${an.id}`)
      }
    },
    [findSelectedAnnot, updateAnnot]
  )

  /**
   * Draw-tab pen settings: they arm the next drawing and, like the colour
   * swatches, restyle the drawing that is currently selected.
   */
  const handleSetDrawStyle = useCallback(
    (patch: Partial<DrawStyle>) => {
      setDrawStyle((s) => ({ ...s, ...patch }))
      const an = findSelectedAnnot()
      if (!an || an.type !== 'shape') return
      const next = { ...an }
      const closed = CLOSED_KINDS.includes(an.kind)
      if (patch.width !== undefined) next.width = patch.width
      if (patch.dash !== undefined) next.dash = patch.dash || undefined
      if (an.kind === 'arrow') {
        if (patch.arrowStart !== undefined) next.arrowStart = patch.arrowStart || undefined
        if (patch.arrowEnd !== undefined) next.arrowEnd = patch.arrowEnd || undefined
      }
      if (closed && patch.fill !== undefined) {
        next.fill = patch.fill ?? undefined
        next.fillAlpha = patch.fill ? (patch.fillAlpha ?? drawStyle.fillAlpha) : undefined
      }
      if (closed && patch.fillAlpha !== undefined && next.fill) next.fillAlpha = patch.fillAlpha
      updateAnnot(next, `draw:${an.id}`)
    },
    [findSelectedAnnot, updateAnnot, drawStyle.fillAlpha]
  )

  // Toolbar size applies to new text AND to the selected text box.
  const handleSetFontSize = useCallback(
    (n: number) => {
      const size = Math.min(72, Math.max(6, n))
      setFontSize(size)
      const an = findSelectedAnnot()
      if (an && an.type === 'text') {
        updateAnnot({ ...an, fontSize: size }, `fontsize:${an.id}`)
      }
    },
    [findSelectedAnnot, updateAnnot]
  )

  // When a text box (or other coloured annotation) is selected, reflect its
  // current size / colour in the toolbar so edits start from what you see.
  useEffect(() => {
    const an = findSelectedAnnot()
    if (!an) return
    if (an.type === 'text') {
      setFontSize(an.fontSize || 12)
      if (an.color) setColor(an.color)
    } else if (an.type === 'shape') {
      setColor(an.color)
      // Only take back the settings this shape can actually carry: a line has
      // no fill and a rectangle has no arrow heads, so reading those off them
      // would quietly throw away the preference set for the shapes that do.
      const closed = CLOSED_KINDS.includes(an.kind)
      const arrow = an.kind === 'arrow'
      setDrawStyle((s) => ({
        ...s,
        width: an.width,
        dash: !!an.dash,
        ...(closed ? { fill: an.fill ?? null, fillAlpha: an.fillAlpha ?? s.fillAlpha } : {}),
        ...(arrow ? { arrowStart: !!an.arrowStart, arrowEnd: !!an.arrowEnd } : {})
      }))
    } else if (
      an.type === 'check' ||
      an.type === 'cross' ||
      an.type === 'circle' ||
      an.type === 'markup' ||
      an.type === 'measure'
    ) {
      if (an.color) setColor(an.color)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.selectedId])

  const changeField = useCallback(
    (field: FieldAnnot, value: string) => {
      commitModel(
        (m) => ({
          ...m,
          annotations: m.annotations.map((a) => {
            if (a.type !== 'field') return a
            if (field.fieldKind === 'radio') return a.fieldName === field.fieldName ? { ...a, value } : a
            return a.id === field.id ? { ...a, value } : a
          })
        }),
        `field:${field.fieldKind === 'radio' ? field.fieldName : field.id}`
      )
    },
    [commitModel]
  )

  // ---- OCR of scanned pages ---------------------------------------------
  /**
   * Background pass: find pages with no text layer, OCR them (current page
   * first), cache per-document on disk. Guarded by a token so tab close,
   * unlock, or a structural insert cleanly aborts a stale run.
   */
  const runOcr = useCallback(
    async (tabId: string) => {
      const start = tabsRef.current.find((t) => t.id === tabId)
      if (!start) return
      const doc = start.pdfDoc
      const token = (ocrTokenRef.current[tabId] || 0) + 1
      ocrTokenRef.current[tabId] = token
      const guard = (): DocTab | null => {
        const t = tabsRef.current.find((x) => x.id === tabId)
        return t && t.pdfDoc === doc && ocrTokenRef.current[tabId] === token ? t : null
      }
      const patchWords = (store: Record<number, OcrWord[]>, progress: DocTab['ocrProgress']): void => {
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId && t.pdfDoc === doc
              ? { ...t, ocrPages: { ...store }, ocrProgress: progress, ocrVersion: t.ocrVersion + 1 }
              : t
          )
        )
      }
      const patchProgress = (progress: DocTab['ocrProgress']): void => {
        setTabs((prev) => prev.map((t) => (t.id === tabId && t.pdfDoc === doc ? { ...t, ocrProgress: progress } : t)))
      }

      let hash = ''
      try {
        hash = await sha256Hex(start.srcBytes)
      } catch {
        /* cache disabled for this doc */
      }
      const store: Record<number, OcrWord[]> = {}
      if (hash) {
        const cached = parseOcrCache(await window.api.ocrCacheGet(hash))
        if (cached) Object.assign(store, cached)
      }
      const t0 = guard()
      if (!t0) return
      if (Object.keys(store).length) patchWords(store, t0.ocrProgress)

      // unique source pages in display order, starting at the current page
      const srcPages: number[] = []
      const seen = new Set<number>()
      const leaves = t0.model.leaves
      const startIdx = Math.max(0, (t0.currentPage || 1) - 1)
      for (let k = 0; k < leaves.length; k++) {
        const sp = leaves[(startIdx + k) % leaves.length].srcPage
        if (!seen.has(sp)) {
          seen.add(sp)
          srcPages.push(sp)
        }
      }
      const todo: number[] = []
      for (const sp of srcPages) {
        if (!guard()) return
        if (store[sp]) continue
        try {
          if (!(await pageHasText(doc, sp))) todo.push(sp)
        } catch {
          /* unreadable page — skip */
        }
      }
      if (!todo.length) return

      let done = 0
      patchProgress({ done, total: todo.length })
      let recognized = 0
      for (const sp of todo) {
        if (!guard()) return
        const words = await ocrPageWords(doc, sp).catch(() => null)
        if (!guard()) return
        done++
        if (words) {
          store[sp] = words
          if (words.length) recognized++
          patchWords(store, { done, total: todo.length })
          if (hash) void window.api.ocrCacheSet(hash, { v: 1, pages: store })
        } else {
          patchProgress({ done, total: todo.length })
        }
      }
      patchProgress(null)
      if (recognized) {
        toast(
          `Recognized text on ${recognized} scanned page${recognized === 1 ? '' : 's'} — search, select, highlight and copy now work there.`,
          'ok'
        )
      }
    },
    [toast]
  )

  useEffect(() => {
    ocrRunRef.current = (id: string) => void runOcr(id)
  }, [runOcr])

  // ---- Signatures -------------------------------------------------------
  useEffect(() => {
    let alive = true
    window.api
      .listSignatures()
      .then(async (list) => {
        const items: SigItem[] = []
        for (const s of list) {
          const meta = await imageMeta(s.bytes, s.ext)
          items.push({ id: s.id, ext: s.ext, bytes: s.bytes, ...meta })
        }
        if (alive) setSigs(items)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (activeSigId) localStorage.setItem('pdfstudio.activeSig', activeSigId)
  }, [activeSigId])

  const addSignatureFlow = useCallback(async (): Promise<SigItem | null> => {
    const img = await window.api.openImage()
    if (!img) return null
    let ext = img.ext === 'png' ? 'png' : 'jpg'
    let bytes = img.bytes
    // scans and photos come in on solid white — lift the ink off it so the
    // signature lays cleanly on coloured pages too
    const cleared = await removeWhiteBackground(bytes, ext)
    if (cleared) {
      bytes = cleared.bytes
      ext = cleared.ext
    }
    let id = 'local-' + uid()
    try {
      const saved = await window.api.addSignature(bytes, ext)
      id = saved.id
    } catch {
      /* persistence failed — still usable this session */
    }
    const meta = await imageMeta(bytes, ext)
    const item: SigItem = { id, ext, bytes, ...meta }
    setSigs((s) => [...s, item])
    setActiveSigId(item.id)
    toast('Signature saved — it will be available every time you open PDF Studio.', 'ok')
    return item
  }, [toast])

  const removeSignature = useCallback((id: string) => {
    void window.api.removeSignature(id)
    setSigs((s) => s.filter((x) => x.id !== id))
    setActiveSigId((cur) => (cur === id ? null : cur))
  }, [])

  /** Called by a page when the Sign tool is used but no signature is active. */
  const needSignature = useCallback(async (): Promise<{ w: number; h: number } | null> => {
    let sig = activeSigRef.current
    if (!sig && sigsRef.current.length) {
      sig = sigsRef.current[0]
      setActiveSigId(sig.id)
    }
    if (!sig) sig = await addSignatureFlow()
    if (!sig) return null
    return { w: sig.width, h: sig.height }
  }, [addSignatureFlow])

  const placeSignature = useCallback(
    (leafId: string, a: { x: number; y: number }, b: { x: number; y: number }) => {
      const sig = activeSigRef.current || sigsRef.current[0]
      if (!sig) return
      commitModel((m) => {
        const images = m.images[sig.id]
          ? m.images
          : {
              ...m.images,
              [sig.id]: {
                id: sig.id,
                kind: sig.ext === 'png' ? 'png' : 'jpg',
                dataUrl: sig.dataUrl,
                bytes: sig.bytes,
                width: sig.width,
                height: sig.height
              } as StoredImage
            }
        return { ...m, images, annotations: [...m.annotations, { id: uid(), leafId, type: 'image', a, b, imageId: sig.id }] }
      })
      // Signing is usually the last thing you do, so offer to flatten — once per
      // document, and only when something is actually still editable.
      const tabId = activeIdRef.current
      if (tabId && !signAskedRef.current.has(tabId)) {
        signAskedRef.current.add(tabId)
        setTimeout(() => {
          const tab = tabsRef.current.find((t) => t.id === tabId)
          if (tab && countEditable(tab.model.annotations) > 0) setFlattenAsk('signed')
        }, 250)
      }
    },
    [commitModel]
  )

  const activeSig = sigs.find((s) => s.id === activeSigId) || null
  const sigInfos: SigInfo[] = useMemo(() => sigs.map((s) => ({ id: s.id, dataUrl: s.dataUrl })), [sigs])

  // ---- Markup (highlight / underline / strikeout) -----------------------
  const applyMarkupFromSelection = useCallback(
    async (kind: MarkupKind): Promise<boolean> => {
      const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
      if (!tab) return false
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false
      const wraps = Array.from(viewerRef.current?.querySelectorAll<HTMLElement>('[data-page-index]') ?? [])
      if (!wraps.length) return false

      const perPage = new Map<number, { wrap: HTMLElement; rects: DOMRect[] }>()
      for (let ri = 0; ri < sel.rangeCount; ri++) {
        for (const r of Array.from(sel.getRangeAt(ri).getClientRects())) {
          if (r.width < 1 || r.height < 1) continue
          const cx = r.left + r.width / 2
          const cy = r.top + r.height / 2
          const wrap = wraps.find((w) => {
            const b = w.getBoundingClientRect()
            return cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom
          })
          if (!wrap) continue
          const idx = Number(wrap.dataset.pageIndex)
          const entry = perPage.get(idx) || { wrap, rects: [] }
          entry.rects.push(r)
          perPage.set(idx, entry)
        }
      }
      if (!perPage.size) return false

      // pick a sensible color: user's swatch, except default-black highlights
      // become classic yellow
      const mkColor = kind === 'highlight' && color === '#111111' ? '#ffd400' : color

      const annots: MarkupAnnot[] = []
      for (const [idx, { wrap, rects }] of perPage) {
        const leaf = tab.model.leaves[idx]
        const stage = wrap.querySelector<HTMLElement>('.page-stage')
        if (!leaf || !stage) continue
        const page = await tab.pdfDoc.getPage(leaf.srcPage)
        const vp = page.getViewport({ scale: tab.zoom, rotation: (page.rotate + leaf.rotation) % 360 })
        const sb = stage.getBoundingClientRect()
        // drop container-artifact rects that span whole blocks
        const hs = rects.map((r) => r.height).sort((a, b) => a - b)
        const med = hs[Math.floor(hs.length / 2)] || 0
        const boxes: Box[] = []
        for (const r of rects) {
          if (med && r.height > med * 1.9) continue
          const [x1, y1] = vp.convertToPdfPoint(r.left - sb.left, r.top - sb.top)
          const [x2, y2] = vp.convertToPdfPoint(r.right - sb.left, r.bottom - sb.top)
          const box: Box = {
            x: Math.min(x1, x2),
            y: Math.min(y1, y2),
            w: Math.abs(x2 - x1),
            h: Math.abs(y2 - y1)
          }
          if (!boxes.some((b) => Math.abs(b.x - box.x) < 0.5 && Math.abs(b.y - box.y) < 0.5 && Math.abs(b.w - box.w) < 0.5)) {
            boxes.push(box)
          }
        }
        if (boxes.length) annots.push({ id: uid(), leafId: leaf.id, type: 'markup', kind, rects: boxes, color: mkColor })
      }
      if (!annots.length) return false
      commitModel((m) => ({ ...m, annotations: [...m.annotations, ...annots] }))
      sel.removeAllRanges()
      return true
    },
    [color, commitModel]
  )

  // markup tools apply on mouse-release while a tool is active
  useEffect(() => {
    if (!MARKUP_TOOLS.includes(tool)) return
    const onUp = (): void => {
      window.setTimeout(() => {
        void applyMarkupFromSelection(tool as MarkupKind)
      }, 10)
    }
    document.addEventListener('pointerup', onUp)
    return () => document.removeEventListener('pointerup', onUp)
  }, [tool, applyMarkupFromSelection])

  const onPickTool = useCallback(
    (t: ToolId) => {
      if (MARKUP_TOOLS.includes(t)) {
        // if text is already selected, apply immediately and stay put
        void applyMarkupFromSelection(t as MarkupKind).then((applied) => {
          if (!applied) setTool(t)
        })
        return
      }
      setTool(t)
    },
    [applyMarkupFromSelection]
  )

  // ---- Layers (optional content groups) ----------------------------------
  const toggleLayer = useCallback((id: string, visible: boolean) => {
    const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
    if (!tab?.layerConfig) return
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tab.layerConfig as any).setVisibility(id, visible)
    } catch {
      return
    }
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tab.id
          ? {
              ...t,
              dirty: true, // visibility persists into the saved file
              layers: (t.layers || []).map((l) => (l.id === id ? { ...l, visible } : l)),
              layerVersion: t.layerVersion + 1
            }
          : t
      )
    )
  }, [])

  // ---- Edit original text (Advanced) --------------------------------------
  const editNoticeRef = useRef(false)
  const handleEditLine = useCallback(
    (leafId: string, line: EditableLine) => {
      const pad = 1.5
      const coverAnnot: Annotation = {
        id: uid(),
        leafId,
        type: 'cover',
        a: { x: line.rect.x - pad, y: line.rect.y - pad },
        b: { x: line.rect.x + line.rect.w + pad, y: line.rect.y + line.rect.h + pad },
        color: '#ffffff'
      }
      const textId = uid()
      const textAnnot: Annotation = {
        id: textId,
        leafId,
        type: 'text',
        a: { x: line.rect.x, y: line.rect.y },
        // extra width so the retyped line has room to grow
        b: { x: line.rect.x + Math.max(line.rect.w + 40, line.rect.w * 1.25), y: line.rect.y + line.rect.h },
        text: line.text,
        fontSize: line.fontSize,
        color: '#111111'
      }
      commitModel((m) => ({ ...m, annotations: [...m.annotations, coverAnnot, textAnnot] }))
      patchActive({ selectedId: textId, editingId: textId })
      setTool('select')
      if (!editNoticeRef.current) {
        editNoticeRef.current = true
        toast('The original line is covered and replaced with an editable copy — one Ctrl+Z undoes the whole edit.', 'info')
      }
    },
    [commitModel, patchActive, toast]
  )

  // ---- Header & footer (page numbers, dates, file name, any text) ----------
  const [headerFooterOpen, setHeaderFooterOpen] = useState(false)
  const addHeaderFooter = useCallback(
    async (cfg: HeaderFooterConfig) => {
      const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
      if (!tab) return
      setHeaderFooterOpen(false)
      setBusy(true)
      try {
        const cssFont = FONT_CSS[cfg.font]
        const mctx = document.createElement('canvas').getContext('2d')!
        mctx.font = `${cssFont.weight >= 700 ? 'bold ' : ''}${cfg.size}px ${cssFont.family}`
        const lastNum = cfg.startAt + (cfg.to - cfg.from)
        const date = formatDate(cfg.dateFormat)
        const file = tab.model.fileName.replace(/\.pdf$/i, '')
        const slots = (Object.keys(cfg.slots) as SlotKey[]).filter((k) => cfg.slots[k])
        const annots: Annotation[] = []
        let pagesTouched = 0
        for (let i = cfg.from - 1; i <= cfg.to - 1; i++) {
          const leaf = tab.model.leaves[i]
          if (!leaf) continue
          const n = cfg.startAt + (i - (cfg.from - 1))
          const page = await tab.pdfDoc.getPage(leaf.srcPage)
          const vp = page.getViewport({ scale: 1, rotation: (page.rotate + leaf.rotation) % 360 })
          pagesTouched++
          for (const k of slots) {
            const { vpos, hpos } = SLOT_POS[k]
            const text = expandTemplate(cfg.slots[k], { n, N: lastNum, date, file })
            const wPt = mctx.measureText(text).width + 4
            const hPt = cfg.size * 1.35
            const dx = hpos === 'left' ? cfg.margin : hpos === 'center' ? (vp.width - wPt) / 2 : vp.width - cfg.margin - wPt
            const dyTop = vpos === 'top' ? cfg.margin : vp.height - cfg.margin - hPt
            const [ax, ay] = vp.convertToPdfPoint(dx, dyTop)
            const [bx, by] = vp.convertToPdfPoint(dx + wPt, dyTop + hPt)
            annots.push({
              id: uid(),
              leafId: leaf.id,
              type: 'text',
              a: { x: ax, y: ay },
              b: { x: bx, y: by },
              text,
              fontSize: cfg.size,
              color: cfg.color,
              font: cfg.font
            })
          }
        }
        if (annots.length) {
          commitModel((m) => ({ ...m, annotations: [...m.annotations, ...annots] }))
          toast(`Added header / footer text to ${pagesTouched} page${pagesTouched === 1 ? '' : 's'} — one Ctrl+Z removes it all.`, 'ok')
        }
      } catch (err) {
        toast('Adding the header / footer failed: ' + errMsg(err), 'err')
      } finally {
        setBusy(false)
      }
    },
    [commitModel, toast]
  )

  // ---- Combine files -------------------------------------------------------
  // null = dialog closed. The list holds the bytes, so a combine never re-reads
  // disk; App owns it because dropped files and the picker both feed it.
  const [combineItems, setCombineItems] = useState<CombineItem[] | null>(null)
  const [combining, setCombining] = useState(false)

  /** Read files into list rows (page counts arrive async) and append them. */
  const addCombineFiles = useCallback(async (files: { name: string; bytes: ArrayBuffer }[]) => {
    if (!files.length) return
    const rows = await Promise.all(files.map((f) => describeFile(f.name, f.bytes)))
    setCombineItems((cur) => [...(cur ?? []), ...rows])
  }, [])

  const openCombine = useCallback(
    async (initial: { name: string; bytes: ArrayBuffer }[] = []) => {
      setCombineItems((cur) => cur ?? [])
      if (initial.length) await addCombineFiles(initial)
      else {
        const picked = await window.api.openFiles()
        await addCombineFiles(picked)
      }
    },
    [addCombineFiles]
  )

  const pickMoreCombineFiles = useCallback(async () => {
    const picked = await window.api.openFiles()
    await addCombineFiles(picked)
  }, [addCombineFiles])

  const runCombine = useCallback(async () => {
    const items = (combineItems ?? []).filter((x) => !x.error)
    if (!items.length) return
    setCombining(true)
    setBusy(true)
    setStatus(`Combining ${items.length} file${items.length === 1 ? '' : 's'}…`)
    try {
      const bytes = toArrayBuffer(await buildCombined(items))
      const first = items[0].name.replace(/\.(pdf|png|jpe?g)$/i, '')
      const name = items.length === 1 ? `${first}.pdf` : `${first} + ${items.length - 1} more.pdf`
      await buildTab(bytes, name, { dirty: true })
      setCombineItems(null)
      toast(`Combined ${items.length} file${items.length === 1 ? '' : 's'} into a new document — Save it (Ctrl+S) to choose where it goes.`, 'ok')
    } catch (err) {
      toast('Combine failed: ' + errMsg(err), 'err')
      setStatus('Ready.')
    } finally {
      setCombining(false)
      setBusy(false)
    }
  }, [combineItems, buildTab, toast])

  // ---- Calibration (per page) -------------------------------------------
  const onCalibrateLine = useCallback((leafId: string, pxDistance: number) => setCalibrateData({ pxDistance, leafId }), [])

  const setPageScale = useCallback(
    (leafId: string, cal: Calibration, applyAll: boolean) => {
      commitModel((m) => ({
        ...m,
        calibrations: applyAll
          ? Object.fromEntries(m.leaves.map((l) => [l.id, cal]))
          : { ...m.calibrations, [leafId]: cal }
      }))
      setTool('measure-length')
      const what = cal.ratio ? `1:${cal.ratio} (${cal.unit})` : `1 pt = ${cal.unitsPerPoint.toPrecision(4)} ${cal.unit}`
      setStatus(`Scale ${what} set for ${applyAll ? 'all pages' : 'this page'}. Now measure lengths, areas or arcs.`)
    },
    [commitModel]
  )

  const applyCalibration = useCallback(
    (cal: Calibration, applyAll: boolean) => {
      if (!calibrateData) return
      setPageScale(calibrateData.leafId, cal, applyAll)
      setCalibrateData(null)
    },
    [calibrateData, setPageScale]
  )

  const applyRatioScale = useCallback(
    (cal: Calibration, applyAll: boolean) => {
      const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
      const leaf = tab?.model.leaves[Math.max(0, (tab.currentPage || 1) - 1)]
      if (leaf) setPageScale(leaf.id, cal, applyAll)
      setRatioOpen(false)
    },
    [setPageScale]
  )

  // ---- Navigation -------------------------------------------------------
  const scrollToPageIndex = useCallback((idx: number) => {
    const viewer = viewerRef.current
    if (!viewer) return
    const w = viewer.querySelector<HTMLElement>(`[data-page-index="${idx}"]`)
    // instant, not smooth — page nav should land on the page, not animate past
    // every page in between
    if (w) viewer.scrollTo({ top: Math.max(0, w.offsetTop - 8), behavior: 'auto' })
  }, [])

  const goToPage = useCallback(
    (n: number) => {
      if (!model) return
      const idx = Math.min(model.leaves.length, Math.max(1, Math.floor(n))) - 1
      scrollToPageIndex(idx)
    },
    [model, scrollToPageIndex]
  )

  const jumpToLeaf = useCallback(
    (leafId: string) => {
      if (!model) return
      const idx = model.leaves.findIndex((l) => l.id === leafId)
      if (idx >= 0) scrollToPageIndex(idx)
    },
    [model, scrollToPageIndex]
  )

  const fitZoom = useCallback(async (mode: 'width' | 'page') => {
    const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
    const viewer = viewerRef.current
    if (!tab || !viewer) return
    const leaf = tab.model.leaves[Math.max(0, (tab.currentPage || 1) - 1)]
    if (!leaf) return
    const page = await tab.pdfDoc.getPage(leaf.srcPage)
    const vp = page.getViewport({ scale: 1, rotation: (page.rotate + leaf.rotation) % 360 })
    const availW = viewer.clientWidth - 64
    const availH = viewer.clientHeight - 56
    const z = mode === 'width' ? availW / vp.width : Math.min(availW / vp.width, availH / vp.height)
    setTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, zoom: clampZoom(z) } : t)))
  }, [])

  // update current page as the viewer scrolls (offset-based; display-independent)
  const onViewerScroll = useCallback(() => {
    if (scrollRaf.current) return
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = 0
      const viewer = viewerRef.current
      if (!viewer || !activeIdRef.current) return
      scrollPosRef.current[activeIdRef.current] = viewer.scrollTop
      const probe = viewer.scrollTop + viewer.clientHeight * 0.3
      const wraps = viewer.querySelectorAll<HTMLElement>('[data-page-index]')
      let best = 1
      for (const w of wraps) {
        if (w.offsetTop <= probe) best = Number(w.dataset.pageIndex) + 1
        else break
      }
      patchActive({ currentPage: best })
    })
  }, [patchActive])

  // ---- Search -----------------------------------------------------------
  const nextMatch = useCallback(() => {
    setCurrentMatch((c) => (matches.length ? (c + 1) % matches.length : -1))
  }, [matches.length])
  const prevMatch = useCallback(() => {
    setCurrentMatch((c) => (matches.length ? (c - 1 + matches.length) % matches.length : -1))
  }, [matches.length])

  // run search (debounced) when the query / mode / active doc changes
  useEffect(() => {
    if (!searchOpen || !active || !searchQuery.trim()) {
      setMatches([])
      setCurrentMatch(-1)
      setSearching(false)
      return
    }
    const token = { cancelled: false }
    setSearching(true)
    const doc = active.pdfDoc
    const leaves = active.model.leaves
    const ocrPages = active.ocrPages
    const id = window.setTimeout(async () => {
      try {
        const res = await runSearch(doc, leaves, searchQuery, {
          fuzzy: searchFuzzy,
          isCancelled: () => token.cancelled,
          ocr: (srcPage) => ocrPages[srcPage]
        })
        if (token.cancelled) return
        setMatches(res)
        setCurrentMatch(res.length ? 0 : -1)
      } catch (e) {
        if (!token.cancelled) {
          console.warn('search failed', e)
          setMatches([])
          setCurrentMatch(-1)
        }
      } finally {
        if (!token.cancelled) setSearching(false)
      }
    }, 220)
    return () => {
      token.cancelled = true
      window.clearTimeout(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen, searchQuery, searchFuzzy, active?.id, active?.model.leaves, active?.ocrVersion])

  // scroll the current match into view
  useEffect(() => {
    if (currentMatch < 0 || currentMatch >= matches.length) return
    const m = matches[currentMatch]
    const viewer = viewerRef.current
    if (!viewer) return
    requestAnimationFrame(() => {
      const wrap = viewer.querySelector<HTMLElement>(`[data-page-index="${m.pageIndex}"]`)
      if (!wrap) return
      const target = wrap.offsetTop + m.yFrac * wrap.offsetHeight - viewer.clientHeight * 0.4
      viewer.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
    })
  }, [currentMatch, matches])

  const highlightsByLeaf = useMemo(() => {
    const map = new Map<string, { rects: HRect[]; current: boolean }[]>()
    matches.forEach((m, i) => {
      const arr = map.get(m.leafId) || []
      arr.push({ rects: m.rects, current: i === currentMatch })
      map.set(m.leafId, arr)
    })
    return map
  }, [matches, currentMatch])

  // restore per-tab scroll position when switching tabs
  useLayoutEffect(() => {
    const viewer = viewerRef.current
    if (viewer && activeId) viewer.scrollTop = scrollPosRef.current[activeId] ?? 0
  }, [activeId])

  // apply cursor-anchored scroll after a zoom change (viewport sizes are already updated)
  useLayoutEffect(() => {
    const viewer = viewerRef.current
    const a = zoomAnchorRef.current
    if (viewer && a) {
      viewer.scrollLeft = a.left
      viewer.scrollTop = a.top
      zoomAnchorRef.current = null
    }
  }, [active?.zoom])

  // Ctrl+wheel zoom + middle-click pan (native listeners for preventDefault / capture)
  const hasTabs = tabs.length > 0
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return

    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const oldZoom = zoomRef.current
      const newZoom = clampZoom(oldZoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12))
      if (newZoom === oldZoom) return
      const rect = viewer.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const factor = newZoom / oldZoom
      zoomAnchorRef.current = {
        left: (viewer.scrollLeft + cx) * factor - cx,
        top: (viewer.scrollTop + cy) * factor - cy
      }
      setZoom(newZoom)
    }

    let panning = false
    let lastX = 0
    let lastY = 0
    const onPointerDown = (e: PointerEvent): void => {
      if (e.button !== 1) return
      panning = true
      lastX = e.clientX
      lastY = e.clientY
      viewer.classList.add('panning')
      try {
        viewer.setPointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      e.preventDefault()
      e.stopPropagation()
    }
    const onPointerMove = (e: PointerEvent): void => {
      if (!panning) return
      viewer.scrollLeft -= e.clientX - lastX
      viewer.scrollTop -= e.clientY - lastY
      lastX = e.clientX
      lastY = e.clientY
      e.preventDefault()
    }
    const stopPan = (e: PointerEvent): void => {
      if (!panning) return
      panning = false
      viewer.classList.remove('panning')
      try {
        viewer.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
    }
    const onMouseDown = (e: MouseEvent): void => {
      if (e.button === 1) e.preventDefault() // suppress middle-click autoscroll
    }

    viewer.addEventListener('wheel', onWheel, { passive: false })
    viewer.addEventListener('pointerdown', onPointerDown, { capture: true })
    viewer.addEventListener('pointermove', onPointerMove, { capture: true })
    viewer.addEventListener('pointerup', stopPan, { capture: true })
    viewer.addEventListener('pointercancel', stopPan, { capture: true })
    viewer.addEventListener('mousedown', onMouseDown)
    return () => {
      viewer.removeEventListener('wheel', onWheel)
      viewer.removeEventListener('pointerdown', onPointerDown, { capture: true } as EventListenerOptions)
      viewer.removeEventListener('pointermove', onPointerMove, { capture: true } as EventListenerOptions)
      viewer.removeEventListener('pointerup', stopPan, { capture: true } as EventListenerOptions)
      viewer.removeEventListener('pointercancel', stopPan, { capture: true } as EventListenerOptions)
      viewer.removeEventListener('mousedown', onMouseDown)
    }
  }, [hasTabs, setZoom])

  // ---- keyboard shortcuts ----------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = document.activeElement
      const inField = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()

      if (mod && key === 'f') {
        e.preventDefault()
        if (active) setSearchOpen(true)
        return
      }
      if (mod && key === 'w') {
        e.preventDefault()
        if (active) closeTab(active.id)
        return
      }
      if (mod && e.key === 'Tab') {
        e.preventDefault()
        const list = tabsRef.current
        if (list.length > 1 && activeIdRef.current) {
          const i = list.findIndex((t) => t.id === activeIdRef.current)
          const next = list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length]
          setActiveId(next.id)
        }
        return
      }
      if (mod && (key === '=' || key === '+')) {
        e.preventDefault()
        setZoom(zoomRef.current * 1.15)
        return
      }
      if (mod && key === '-') {
        e.preventDefault()
        setZoom(zoomRef.current / 1.15)
        return
      }
      if (mod && key === '0') {
        e.preventDefault()
        void fitZoom('width')
        return
      }
      if (mod && key === 'z' && !inField) {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (mod && key === 'y' && !inField) {
        e.preventDefault()
        redo()
        return
      }
      if (mod && key === 's') {
        // the app menu also handles this; in browser mode we do it here
        e.preventDefault()
        if (e.shiftKey) handleSaveAs()
        else handleSave()
        return
      }
      if (mod && key === 'p') {
        e.preventDefault()
        void handlePrint()
        return
      }

      if (e.key === 'Escape') {
        if (searchOpen) setSearchOpen(false)
        // Escape backs out of a crop before it drops the selection, so it is
        // always one step "less committed" rather than starting over.
        if (active?.imageCrop) {
          patchActive({ imageCrop: false })
          return
        }
        if (active?.imageSel) {
          selectImage(null)
          return
        }
        // Escape puts the pointer back to plain select — that's how you stop a
        // sticky tool (text / check / X / circle) from placing another one.
        if (tool !== 'select') setTool('select')
        setEditingId(null)
        setSelectedId(null)
        return
      }

      // An embedded image is selected: it owns the editing keys.
      if (active?.imageSel && !inField) {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault()
          deleteImage()
          return
        }
        if (mod && key === 'd') {
          e.preventDefault()
          duplicateImage()
          return
        }
        if (e.key.startsWith('Arrow')) {
          const step = e.shiftKey ? 10 : 1
          const dx = e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0
          const dy = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0
          e.preventDefault()
          editSelectedImage((m, crop) => ({ m: mulM(m, [1, 0, 0, 1, dx, dy] as Matrix), crop }), 'img:nudge')
          return
        }
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && active?.selectedId && !active.editingId && !inField) {
        deleteAnnot(active.selectedId)
        return
      }

      if (inField || !active) return
      const viewer = viewerRef.current

      if (e.key === 'PageDown') {
        e.preventDefault()
        viewer?.scrollBy({ top: viewer.clientHeight * 0.9, behavior: 'smooth' })
      } else if (e.key === 'PageUp') {
        e.preventDefault()
        viewer?.scrollBy({ top: -viewer.clientHeight * 0.9, behavior: 'smooth' })
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        goToPage((active.currentPage || 1) + 1)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goToPage((active.currentPage || 1) - 1)
      } else if (e.key === 'Home') {
        e.preventDefault()
        goToPage(1)
      } else if (e.key === 'End') {
        e.preventDefault()
        goToPage(active.model.leaves.length)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    active,
    searchOpen,
    tool,
    deleteAnnot,
    setEditingId,
    setSelectedId,
    goToPage,
    closeTab,
    setZoom,
    fitZoom,
    undo,
    redo,
    handleSave,
    handleSaveAs,
    handlePrint,
    patchActive,
    selectImage,
    deleteImage,
    duplicateImage,
    editSelectedImage
  ])

  // One router for both menu sources: the native menu bar (Alt) and the
  // ribbon's own File menu.
  const runMenuAction = useCallback(
    (action: string) => {
      if (action === 'open') handleOpen()
      else if (action === 'combine') void openCombine()
      else if (action === 'save') handleSave()
      else if (action === 'save-as') handleSaveAs()
      else if (action === 'print') void handlePrint()
      else if (action === 'unlock') handleUnlock()
      else if (action === 'optimize') void handleOptimize()
    },
    [handleOpen, openCombine, handleSave, handleSaveAs, handlePrint, handleUnlock, handleOptimize]
  )

  // The app shell is meant to fill the window exactly and never scroll as a
  // whole. body{overflow:hidden} kills the scrollbar but not programmatic
  // scrolling, so any stray overflow plus a browser "scroll the focused element
  // into view" would push the ribbon up under the title bar with no way back.
  // Pin the document scroller so that can't happen again.
  useEffect(() => {
    const pin = (): void => {
      const de = document.documentElement
      if (de.scrollTop) de.scrollTop = 0
      if (de.scrollLeft) de.scrollLeft = 0
    }
    window.addEventListener('scroll', pin)
    return () => window.removeEventListener('scroll', pin)
  }, [])

  // ---- open files from Windows (double-click / menu) --------------------
  useEffect(() => {
    let alive = true
    window.api.getStartupFile().then((f) => {
      if (alive && f) openBytes(f.bytes, f.name, f.path || null)
    })
    const offOpen = window.api.onOpenFile((f) => openBytes(f.bytes, f.name, f.path || null))
    const offMenu = window.api.onMenu(runMenuAction)
    return () => {
      alive = false
      offOpen()
      offMenu()
    }
  }, [openBytes, runMenuAction])

  // ---- in-app updates -----------------------------------------------------
  // Main does the checking and downloading; we only show state. A manual
  // check (Help menu) reports every outcome; the automatic one only speaks up
  // once an installer is verified and waiting.
  type UpdateState = Awaited<ReturnType<Window['api']['getUpdateState']>>
  const [updateState, setUpdateState] = useState<UpdateState>({ state: 'idle' })
  const [appVersion, setAppVersion] = useState('')
  const manualCheckRef = useRef(false)
  useEffect(() => {
    window.api.getVersion().then(setAppVersion).catch(() => {})
    window.api.getUpdateState().then(setUpdateState).catch(() => {})
    return window.api.onUpdate((s) => {
      setUpdateState(s)
      if (s.state === 'ready') {
        toast(`PDF Studio ${s.version} is downloaded — Help → Restart to update when you're ready.`, 'ok')
        manualCheckRef.current = false
      } else if (s.state === 'none' && manualCheckRef.current) {
        toast(`You're up to date (${s.version}).`, 'info')
        manualCheckRef.current = false
      } else if (s.state === 'error' && (s.manual || manualCheckRef.current)) {
        toast('Update check failed: ' + s.error, 'err')
        manualCheckRef.current = false
      }
    })
  }, [toast])
  const checkForUpdates = useCallback(() => {
    manualCheckRef.current = true
    window.api.checkForUpdates()
  }, [])
  const installUpdate = useCallback(async () => {
    const ok = await window.api.installUpdate()
    if (!ok) toast('The update is not ready yet — try Help → Check for updates.', 'err')
  }, [toast])

  // recent files — shown on the empty state and in the ribbon's File menu
  useEffect(() => {
    window.api
      .getRecents()
      .then(setRecents)
      .catch(() => {})
  }, [tabs.length])

  // ---- drag & drop PDFs / pictures onto the window ------------------------
  // PDFs open as tabs. Pictures become pages of the open document (after the
  // current page); with nothing open, or while the Combine dialog is up, every
  // dropped file goes into the Combine list instead.
  const combineItemsRef = useRef<CombineItem[] | null>(null)
  combineItemsRef.current = combineItems
  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      setDropping(false)
      const dropped = Array.from(e.dataTransfer.files).filter((f) => kindForName(f.name))
      if (!dropped.length) return
      const read = async (f: File): Promise<{ name: string; bytes: ArrayBuffer; path: string }> => ({
        name: f.name,
        bytes: await f.arrayBuffer(),
        path: window.api.pathForFile(f)
      })
      const hasDoc = tabsRef.current.some((t) => t.id === activeIdRef.current)
      const images = dropped.filter((f) => kindForName(f.name) === 'image')
      if (combineItemsRef.current !== null || (!hasDoc && images.length)) {
        const files = await Promise.all(dropped.map(read))
        await openCombine(files)
        return
      }
      for (const f of dropped) {
        if (kindForName(f.name) !== 'pdf') continue
        const { bytes, path } = await read(f)
        if (path) window.api.addRecent(path)
        await openBytes(bytes, f.name, path || null)
      }
      if (images.length) await insertImageFiles(await Promise.all(images.map(read)))
    },
    [openBytes, openCombine, insertImageFiles]
  )

  // The drop overlay is driven by a heartbeat, not by dragleave: dragover repeats
  // every ~350ms while a drag is over the window, so when it stops we know the drag
  // is gone. dragleave can't tell us — it fires on whatever child is under the
  // cursor (viewer, canvas, thumbnail), and a drag cancelled with Esc or dropped on
  // another window never fires on us at all, which left the overlay stuck on.
  useEffect(() => {
    let timer: number | undefined
    const clear = (): void => {
      window.clearTimeout(timer)
      setDropping(false)
    }
    const ping = (e: DragEvent): void => {
      if (!e.dataTransfer?.types.includes('Files')) return
      setDropping(true)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setDropping(false), 700)
    }
    window.addEventListener('dragover', ping)
    window.addEventListener('drop', clear)
    window.addEventListener('dragend', clear)
    window.addEventListener('blur', clear)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('dragover', ping)
      window.removeEventListener('drop', clear)
      window.removeEventListener('dragend', clear)
      window.removeEventListener('blur', clear)
    }
  }, [])

  // stable per-leaf annotation arrays so memoised pages skip re-renders
  const annotsByLeaf = useMemo(() => {
    const next = new Map<string, Annotation[]>()
    if (model) {
      for (const a of model.annotations) {
        const arr = next.get(a.leafId)
        if (arr) arr.push(a)
        else next.set(a.leafId, [a])
      }
    }
    const prev = annotCacheRef.current
    const out = new Map<string, Annotation[]>()
    for (const [k, arr] of next) {
      const p = prev.get(k)
      out.set(k, p && p.length === arr.length && p.every((x, i) => x === arr[i]) ? p : arr)
    }
    annotCacheRef.current = out
    return out
  }, [model])

  // which leaf owns the selected / editing annotation (so only that page re-renders)
  const selectionLeaf = useMemo(() => {
    if (!model) return { sel: null as string | null, edit: null as string | null }
    let sel: string | null = null
    let edit: string | null = null
    for (const a of model.annotations) {
      if (a.id === active?.selectedId) sel = a.leafId
      if (a.id === active?.editingId) edit = a.leafId
    }
    return { sel, edit }
  }, [model, active?.selectedId, active?.editingId])

  const confirmTab = confirmCloseId ? tabs.find((t) => t.id === confirmCloseId) : null
  /** Marks that a save would leave editable — drives the Flatten button's dot. */
  const flattenCount = model ? countEditable(model.annotations) : 0

  // scale of the page currently in view (calibration is per page)
  const curLeaf = model && active ? model.leaves[Math.max(0, (active.currentPage || 1) - 1)] : null
  const curCal = curLeaf && model ? (model.calibrations[curLeaf.id] ?? null) : null
  const calibratePageNo = calibrateData && model ? model.leaves.findIndex((l) => l.id === calibrateData.leafId) + 1 : 0

  // shared inputs for the extract / rotate / delete page pickers
  const pickPages =
    model && active
      ? {
          totalPages: model.leaves.length,
          currentPage: Math.min(model.leaves.length, Math.max(1, active.currentPage || 1)),
          selectedPages: active.selectedLeaves
            .map((id) => model.leaves.findIndex((l) => l.id === id) + 1)
            .filter((n) => n > 0)
            .sort((a, b) => a - b)
        }
      : null

  return (
    <div
      className={`app ${dropping ? 'dropping' : ''}`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <Toolbar
        tool={tool}
        onPickTool={onPickTool}
        zoom={active?.zoom ?? 1.25}
        setZoom={setZoom}
        onFitWidth={() => void fitZoom('width')}
        onFitPage={() => void fitZoom('page')}
        color={color}
        setColor={handleSetColor}
        colors={DEFAULT_COLORS}
        fontSize={fontSize}
        setFontSize={handleSetFontSize}
        drawStyle={drawStyle}
        setDrawStyle={handleSetDrawStyle}
        hasDoc={!!active}
        calibrated={!!curCal}
        flattenCount={flattenCount}
        onFlatten={() => {
          if (flattenCount > 0) setFlattenAsk('button')
          else if (model?.annotations.some((a) => a.type === 'image'))
            toast('Nothing to flatten — signatures and images are stamped permanently into the page when you save.', 'info')
          else toast('Nothing to flatten — this document has no editable marks.', 'info')
        }}
        onScaleRatio={() => setRatioOpen(true)}
        currentPage={active?.currentPage ?? 1}
        totalPages={model?.leaves.length ?? 0}
        onGoToPage={goToPage}
        onMenuAction={runMenuAction}
        updateState={updateState}
        appVersion={appVersion}
        onCheckUpdates={checkForUpdates}
        onInstallUpdate={() => void installUpdate()}
        recents={recents}
        onOpenRecent={(p) => void openRecent(p)}
        onUnlock={handleUnlock}
        onExtract={() => setExtractOpen(true)}
        onRotateCurrent={rotateCurrent}
        onRotatePages={() => setRotateOpen(true)}
        onDeletePages={() => setDeleteOpen(true)}
        onFind={() => setSearchOpen(true)}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={undo}
        onRedo={redo}
        hasFields={!!model && hasFieldAnnots(model)}
        keepForms={active?.keepForms ?? true}
        onSetKeepForms={(v) => {
          patchActive({ keepForms: v })
          toast(
            v
              ? 'Saving will keep form fields fillable in other PDF readers.'
              : 'Saving will flatten form fields into permanent page content.',
            'info'
          )
        }}
        sigs={sigInfos}
        activeSigId={activeSigId}
        onPickSig={(id) => {
          setActiveSigId(id)
          setTool('signature')
        }}
        onAddSig={() => void addSignatureFlow()}
        onRemoveSig={removeSignature}
        onInsertFromPdf={() => void insertFromPdf()}
        onInsertImages={() => void insertImages()}
        onInsertBlank={() => void insertBlank()}
        onDuplicateCurrent={duplicateCurrent}
        onHeaderFooter={() => setHeaderFooterOpen(true)}
        layers={active?.layers ?? null}
        onToggleLayer={toggleLayer}
        busy={busy}
        onPageSize={() => void openPageSize()}
        imageInfo={imageSelInfo}
        imageCropMode={!!active?.imageCrop}
        imageBusy={!!active?.imagePreviewBusy}
        onImageRotate={rotateImage}
        onImageFlip={flipImage}
        onImageToggleCrop={toggleImageCrop}
        onImageApplyCrop={() => void applyImageCrop()}
        onImageDuplicate={duplicateImage}
        onImageDelete={deleteImage}
        onImageReset={resetImage}
      />
      {tabs.length > 0 && (
        <TabBar
          tabs={tabs.map((t) => ({ id: t.id, name: t.model.fileName, dirty: t.dirty }))}
          activeId={activeId}
          onSelect={setActiveId}
          onClose={closeTab}
          onNew={handleOpen}
        />
      )}
      <div className="body">
        {searchOpen && active && (
          <SearchBar
            query={searchQuery}
            fuzzy={searchFuzzy}
            count={matches.length}
            current={currentMatch}
            searching={searching}
            onQuery={setSearchQuery}
            onFuzzy={setSearchFuzzy}
            onNext={nextMatch}
            onPrev={prevMatch}
            onClose={() => setSearchOpen(false)}
          />
        )}
        {active && model ? (
          <>
            {sidebarCollapsed ? (
              <div className="thumbs-rail">
                <button className="rail-btn" title="Show pages" onClick={() => setSidebarCollapsed(false)}>
                  »
                </button>
              </div>
            ) : (
              <ThumbnailSidebar
                pdfDoc={active.pdfDoc}
                leaves={model.leaves}
                selected={active.selectedLeaves}
                currentPage={active.currentPage}
                setSelected={setSelectedLeaves}
                onRotate={rotateLeaves}
                onDelete={deleteLeaves}
                onDuplicate={duplicateLeaves}
                onExtract={() => void handleExtract(active.selectedLeaves)}
                onReorder={reorderLeaf}
                onJump={jumpToLeaf}
                onCollapse={() => setSidebarCollapsed(true)}
                layerConfig={active.layerConfig ?? undefined}
                layerVersion={active.layerVersion}
              />
            )}
            <div className="viewer" ref={viewerRef} onScroll={onViewerScroll}>
              {model.leaves.map((leaf, idx) => (
                <PageView
                  key={leaf.id}
                  pdfDoc={active.pdfDoc}
                  leaf={leaf}
                  index={idx}
                  zoom={active.zoom}
                  tool={tool}
                  color={color}
                  fontSize={fontSize}
                  drawStyle={drawStyle}
                  annotations={annotsByLeaf.get(leaf.id) || EMPTY_ANNOTS}
                  highlights={highlightsByLeaf.get(leaf.id)}
                  images={model.images}
                  calibration={model.calibrations[leaf.id] ?? null}
                  selectedId={selectionLeaf.sel === leaf.id ? active.selectedId : null}
                  editingId={selectionLeaf.edit === leaf.id ? active.editingId : null}
                  setTool={setTool}
                  onSelect={setSelectedId}
                  onEdit={setEditingId}
                  onFinishEdit={finishTextEdit}
                  onCreate={createAnnot}
                  onUpdate={updateAnnot}
                  onDelete={deleteAnnot}
                  onChangeField={changeField}
                  onCalibrateLine={onCalibrateLine}
                  onPlaceSignature={placeSignature}
                  onNeedSignature={needSignature}
                  signatureAspect={activeSig ? activeSig.height / activeSig.width : null}
                  ocrWords={active.ocrPages[leaf.srcPage]}
                  onEditLine={handleEditLine}
                  layerConfig={active.layerConfig ?? undefined}
                  layerVersion={active.layerVersion}
                  onRenderTime={noteRenderTime}
                  pageImages={active.pageImages[leaf.srcPage] ?? null}
                  imageSel={active.currentPage - 1 === idx ? active.imageSel : null}
                  imageCrop={active.imageCrop}
                  imageBitmaps={bitmapsByDraw(active, leaf.srcPage)}
                  onImageSelect={selectImage}
                  onImageChange={handleImageChange}
                  onNeedImages={scanImagesForPage}
                />
              ))}
            </div>
          </>
        ) : (
          <div className="empty">
            <div className="empty-card">
              <h1>PDF Studio</h1>
              <p>Read, edit, fill, sign, measure, and unlock PDFs — all offline on your machine.</p>
              <div className="empty-actions">
                <button className="primary big" onClick={handleOpen}>
                  Open a PDF
                </button>
                <button className="big secondary" onClick={() => void openCombine()} title="Join several PDFs and pictures into one new document">
                  Combine files…
                </button>
              </div>
              <p className="drop-hint">…or drag &amp; drop PDFs anywhere in this window (drop pictures to combine them)</p>
              {recents.length > 0 && (
                <div className="recents">
                  <div className="recents-title">Recent files</div>
                  {recents.slice(0, 8).map((r) => (
                    <button key={r.path} className="recent-item" title={r.path} onClick={() => void openRecent(r.path)}>
                      {r.name}
                    </button>
                  ))}
                </div>
              )}
              <ul className="feature-list">
                <li>Open several PDFs at once in tabs — print, search, select &amp; copy text</li>
                <li>Combine PDFs &amp; pictures into one file · rearrange, rotate, insert, delete &amp; extract pages</li>
                <li>Headers &amp; footers — page numbers, dates, file name, any text</li>
                <li>Draw lines, arrows, boxes, circles, polygons &amp; freehand — no scale needed</li>
                <li>Whiteout (true redaction), text, checkmarks, highlights and your signature</li>
                <li>Fill forms — save them fillable or flattened · full undo/redo</li>
                <li>Calibrate &amp; measure lengths, areas and arcs · strip owner-password locks</li>
              </ul>
            </div>
          </div>
        )}
      </div>
      <div className="statusbar">
        <span>{status}</span>
        {active?.ocrProgress && active.ocrProgress.done < active.ocrProgress.total && (
          <span className="ocr-badge">
            Recognizing scanned pages… {active.ocrProgress.done}/{active.ocrProgress.total}
          </span>
        )}
        {curCal && (
          <span className="cal-badge">
            {curCal.ratio
              ? `Scale (page ${active?.currentPage}): 1:${curCal.ratio} · ${curCal.unit}`
              : `Scale (page ${active?.currentPage}): 1 pt = ${curCal.unitsPerPoint.toPrecision(3)} ${curCal.unit}`}
          </span>
        )}
      </div>

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.msg}
          </div>
        ))}
      </div>

      {passwordOpen && (
        <PasswordDialog
          wrong={passwordWrong}
          onSubmit={submitPassword}
          onCancel={() => {
            setPasswordOpen(false)
            pendingOpenRef.current = null
          }}
        />
      )}
      {calibrateData && (
        <CalibrateDialog
          pxDistance={calibrateData.pxDistance}
          pageLabel={`page ${calibratePageNo || '?'}`}
          onApply={applyCalibration}
          onCancel={() => setCalibrateData(null)}
        />
      )}
      {ratioOpen && (
        <CalibrateDialog
          pxDistance={null}
          pageLabel={`page ${active?.currentPage ?? 1}`}
          onApply={applyRatioScale}
          onCancel={() => setRatioOpen(false)}
        />
      )}
      {headerFooterOpen && model && (
        <HeaderFooterDialog
          totalPages={model.leaves.length}
          fileName={model.fileName}
          colors={DEFAULT_COLORS}
          onApply={(cfg) => void addHeaderFooter(cfg)}
          onCancel={() => setHeaderFooterOpen(false)}
        />
      )}
      {combineItems !== null && (
        <CombineDialog
          items={combineItems}
          busy={combining}
          onChange={setCombineItems}
          onAddFiles={() => void pickMoreCombineFiles()}
          onCombine={() => void runCombine()}
          onCancel={() => setCombineItems(null)}
        />
      )}
      {extractOpen && pickPages && (
        <PagePickDialog
          {...pickPages}
          title="Extract pages"
          intro="Saves the chosen pages as a new PDF. This document is left untouched."
          confirmLabel="Extract…"
          onConfirm={extractByPage}
          onCancel={() => setExtractOpen(false)}
        />
      )}
      {rotateOpen && pickPages && (
        <PagePickDialog
          {...pickPages}
          title="Rotate pages"
          intro="Turns the chosen pages 90° at a time. Ctrl+Z undoes the whole rotation."
          confirmLabel="Rotate"
          extra={
            <div className="ex-extra">
              Direction
              <label className={`ex-opt ${rotateDir === 1 ? 'sel' : ''}`}>
                <input
                  type="radio"
                  name="rotate-dir"
                  checked={rotateDir === 1}
                  onChange={() => setRotateDir(1)}
                />
                <span className="ex-opt-label">↻ Right</span>
              </label>
              <label className={`ex-opt ${rotateDir === -1 ? 'sel' : ''}`}>
                <input
                  type="radio"
                  name="rotate-dir"
                  checked={rotateDir === -1}
                  onChange={() => setRotateDir(-1)}
                />
                <span className="ex-opt-label">↺ Left</span>
              </label>
            </div>
          }
          onConfirm={rotateByPage}
          onCancel={() => setRotateOpen(false)}
        />
      )}
      {deleteOpen && pickPages && (
        <PagePickDialog
          {...pickPages}
          title="Delete pages"
          intro="Removes the chosen pages from this document. Ctrl+Z puts them back; the file on disk only changes when you save."
          confirmLabel="Delete"
          danger
          onConfirm={deleteByPage}
          onCancel={() => setDeleteOpen(false)}
        />
      )}
      {pageSizeOpen && active && (
        <PageSizeDialog
          totalPages={active.model.leaves.length}
          currentPage={active.currentPage}
          selectedPages={active.selectedLeaves
            .map((id) => active.model.leaves.findIndex((l) => l.id === id) + 1)
            .filter((n) => n > 0)
            .sort((a, b) => a - b)}
          sizes={pageSizeList}
          onConfirm={(pages, opts) => void applyPageSize(pages, opts)}
          onCancel={() => setPageSizeOpen(false)}
        />
      )}
      {flattenAsk && (
        <div className="modal-back" onClick={() => setFlattenAsk(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{flattenAsk === 'signed' ? 'Signature placed' : 'Flatten document'}</h2>
            <p>
              {flattenAsk === 'signed'
                ? 'Flatten the document now? '
                : 'Flatten this document? '}
              {flattenCount} mark{flattenCount === 1 ? '' : 's'} — text, checks, X&rsquo;s, circles and
              markup — become part of the page. They stop being editable, here and in any other PDF
              editor. Measurements, whiteout and signatures are already part of the page.
            </p>
            <div className="modal-actions">
              <button onClick={() => setFlattenAsk(null)}>{flattenAsk === 'signed' ? 'Keep editable' : 'Cancel'}</button>
              <button
                className="primary"
                onClick={() => {
                  setFlattenAsk(null)
                  void flattenNow()
                }}
              >
                Flatten
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmTab && (
        <div className="modal-back" onClick={() => setConfirmCloseId(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Unsaved changes</h2>
            <p>
              “{confirmTab.model.fileName}” has unsaved changes. Save before closing?
            </p>
            <div className="modal-actions">
              <button onClick={() => setConfirmCloseId(null)}>Cancel</button>
              <button
                onClick={() => {
                  reallyCloseTab(confirmTab.id)
                }}
              >
                Close without saving
              </button>
              <button
                className="primary"
                onClick={async () => {
                  const ok = await saveTab(confirmTab.id, false)
                  if (ok) reallyCloseTab(confirmTab.id)
                }}
              >
                Save &amp; close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
