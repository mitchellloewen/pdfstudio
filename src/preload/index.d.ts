// Ambient declaration of the preload API for the renderer. Kept self-contained
// (no import from index.ts) so the renderer's tsconfig never pulls in the
// preload implementation. Keep this in sync with the `api` object in index.ts.

export interface PdfPayload {
  path: string
  name: string
  bytes: ArrayBuffer
}

export interface OpenedPdf {
  path: string
  name: string
  bytes: ArrayBuffer
}

export interface OpenedFile {
  path: string
  name: string
  bytes: ArrayBuffer
}

export interface OpenedImage {
  path: string
  ext: string
  bytes: ArrayBuffer
}

export type UnlockResult = { ok: true; bytes: ArrayBuffer } | { ok: false; error: string }
export type WriteResult = { ok: true } | { ok: false; error: string }

export interface StoredSignature {
  id: string
  ext: string
  bytes: ArrayBuffer
}

export type OcrResult =
  | { ok: true; words: { text: string; x0: number; y0: number; x1: number; y1: number }[] }
  | { ok: false; error: string }

export interface PreloadApi {
  getStartupFile: () => Promise<PdfPayload | null>
  onOpenFile: (cb: (payload: PdfPayload) => void) => () => void
  onMenu: (cb: (action: string) => void) => () => void
  openPdf: () => Promise<OpenedPdf | null>
  /** Multi-select PDF picker; empty array when cancelled. */
  openPdfs: (title?: string) => Promise<OpenedPdf[]>
  /** Multi-select PDFs + pictures (Combine files). */
  openFiles: () => Promise<OpenedFile[]>
  /** Multi-select pictures (Insert pictures as pages). */
  openImages: () => Promise<OpenedFile[]>
  openImage: () => Promise<OpenedImage | null>
  readFile: (path: string) => Promise<ArrayBuffer>
  openPath: (path: string) => Promise<PdfPayload | null>
  getRecents: () => Promise<{ path: string; name: string }[]>
  addRecent: (path: string) => void
  setDirty: (dirty: boolean) => void
  appCommand: (cmd: string) => void
  pathForFile: (file: File) => string
  savePdf: (bytes: ArrayBuffer, suggestedName?: string) => Promise<string | null>
  savePdfToPath: (path: string, bytes: ArrayBuffer) => Promise<WriteResult>
  printHtml: (html: string) => Promise<{ ok: boolean; error?: string }>
  openExternal: (path: string) => Promise<void>
  unlockPdf: (bytes: ArrayBuffer, password?: string) => Promise<UnlockResult>
  hasQpdf: () => Promise<boolean>
  ocrPage: (bytes: ArrayBuffer) => Promise<OcrResult>
  ocrCacheGet: (hash: string) => Promise<unknown | null>
  ocrCacheSet: (hash: string, data: unknown) => Promise<void>
  /** Cached optimised render copy of a heavy document, keyed by hash of the original. */
  optCacheGet: (hash: string) => Promise<ArrayBuffer | null>
  optCacheSet: (hash: string, bytes: ArrayBuffer) => Promise<void>
  listSignatures: () => Promise<StoredSignature[]>
  addSignature: (bytes: ArrayBuffer, ext: string) => Promise<{ id: string; ext: string }>
  removeSignature: (id: string) => Promise<void>
}

declare global {
  interface Window {
    api: PreloadApi
  }
}

export {}
