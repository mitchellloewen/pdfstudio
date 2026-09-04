import { contextBridge, ipcRenderer, webUtils } from 'electron'

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

export type UnlockResult =
  | { ok: true; bytes: ArrayBuffer }
  | { ok: false; error: string }

export type WriteResult = { ok: true } | { ok: false; error: string }

export interface PdfPayload {
  path: string
  name: string
  bytes: ArrayBuffer
}

export interface StoredSignature {
  id: string
  ext: string
  bytes: ArrayBuffer
}

export type OcrResult =
  | { ok: true; words: { text: string; x0: number; y0: number; x1: number; y1: number }[] }
  | { ok: false; error: string }

const api = {
  getStartupFile: (): Promise<PdfPayload | null> => ipcRenderer.invoke('app:getStartupFile'),
  onOpenFile: (cb: (payload: PdfPayload) => void): (() => void) => {
    const handler = (_e: unknown, payload: PdfPayload): void => cb(payload)
    ipcRenderer.on('open-file', handler)
    return () => ipcRenderer.removeListener('open-file', handler)
  },
  onMenu: (cb: (action: string) => void): (() => void) => {
    const handler = (_e: unknown, action: string): void => cb(action)
    ipcRenderer.on('menu', handler)
    return () => ipcRenderer.removeListener('menu', handler)
  },
  openPdf: (): Promise<OpenedPdf | null> => ipcRenderer.invoke('dialog:openPdf'),
  /** Multi-select PDF picker (Ctrl+O, Insert from PDF). Empty array when cancelled. */
  openPdfs: (title?: string): Promise<OpenedPdf[]> => ipcRenderer.invoke('dialog:openPdfs', title),
  /** Multi-select picker for PDFs + pictures (Combine files). */
  openFiles: (): Promise<OpenedFile[]> => ipcRenderer.invoke('dialog:openFiles'),
  /** Multi-select picture picker (Insert pictures as pages). */
  openImages: (): Promise<OpenedFile[]> => ipcRenderer.invoke('dialog:openImages'),
  openImage: (): Promise<OpenedImage | null> => ipcRenderer.invoke('dialog:openImage'),
  readFile: (path: string): Promise<ArrayBuffer> => ipcRenderer.invoke('file:read', path),
  openPath: (path: string): Promise<PdfPayload | null> => ipcRenderer.invoke('app:openPath', path),
  getRecents: (): Promise<{ path: string; name: string }[]> => ipcRenderer.invoke('recents:get'),
  addRecent: (path: string): void => ipcRenderer.send('recents:add', path),
  setDirty: (dirty: boolean): void => ipcRenderer.send('app:setDirty', dirty),
  /** Window/app commands driven by the ribbon's File / View / Help menus. */
  appCommand: (cmd: string): void => ipcRenderer.send('app:command', cmd),
  /** Resolve the on-disk path of a dropped File (empty string if unavailable). */
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  savePdf: (bytes: ArrayBuffer, suggestedName?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:savePdf', { bytes, suggestedName }),
  savePdfToPath: (path: string, bytes: ArrayBuffer): Promise<WriteResult> =>
    ipcRenderer.invoke('file:saveToPath', { path, bytes }),
  printHtml: (html: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('print:html', html),
  openExternal: (path: string): Promise<void> => ipcRenderer.invoke('file:openExternal', path),
  unlockPdf: (bytes: ArrayBuffer, password?: string): Promise<UnlockResult> =>
    ipcRenderer.invoke('pdf:unlock', { bytes, password }),
  hasQpdf: (): Promise<boolean> => ipcRenderer.invoke('app:hasQpdf'),
  ocrPage: (bytes: ArrayBuffer): Promise<OcrResult> => ipcRenderer.invoke('ocr:page', bytes),
  ocrCacheGet: (hash: string): Promise<unknown | null> => ipcRenderer.invoke('ocr:cache-get', hash),
  ocrCacheSet: (hash: string, data: unknown): Promise<void> => ipcRenderer.invoke('ocr:cache-set', hash, data),
  optCacheGet: (hash: string): Promise<ArrayBuffer | null> => ipcRenderer.invoke('opt:cache-get', hash),
  optCacheSet: (hash: string, bytes: ArrayBuffer): Promise<void> =>
    ipcRenderer.invoke('opt:cache-set', hash, bytes),
  listSignatures: (): Promise<StoredSignature[]> => ipcRenderer.invoke('sig:list'),
  addSignature: (bytes: ArrayBuffer, ext: string): Promise<{ id: string; ext: string }> =>
    ipcRenderer.invoke('sig:add', { bytes, ext }),
  removeSignature: (id: string): Promise<void> => ipcRenderer.invoke('sig:remove', id)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
