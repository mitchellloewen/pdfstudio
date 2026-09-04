// Browser fallback for the Electron preload API. Only installs itself when
// window.api is missing (i.e. when the renderer is served in a plain browser
// for testing). In the packaged Electron app the real preload API is present
// and this shim does nothing.
type Api = Window['api']

function pickFile(accept: string): Promise<{ name: string; ext: string; bytes: ArrayBuffer } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.onchange = async () => {
      const f = input.files?.[0]
      if (!f) return resolve(null)
      const bytes = await f.arrayBuffer()
      const ext = (f.name.split('.').pop() || '').toLowerCase()
      resolve({ name: f.name, ext, bytes })
    }
    input.click()
  })
}

function pickFiles(accept: string): Promise<{ path: string; name: string; bytes: ArrayBuffer }[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = true
    input.onchange = async () => {
      const out: { path: string; name: string; bytes: ArrayBuffer }[] = []
      for (const f of Array.from(input.files ?? [])) out.push({ path: '', name: f.name, bytes: await f.arrayBuffer() })
      resolve(out)
    }
    input.click()
  })
}

function download(bytes: ArrayBuffer, name: string): string {
  const blob = new Blob([bytes], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
  return name
}

export function installDevApiShim(): void {
  if ((window as unknown as { api?: Api }).api) return
  // `?file=<url>` opens a PDF straight from a URL on boot, so the renderer can
  // be driven in a plain browser without clicking through a file picker.
  const startupUrl = new URLSearchParams(location.search).get('file')

  const shim: Api = {
    getStartupFile: async () => {
      if (!startupUrl) return null
      try {
        const res = await fetch(startupUrl)
        if (!res.ok) return null
        const bytes = await res.arrayBuffer()
        const name = decodeURIComponent(startupUrl.split('/').pop() || 'document.pdf')
        return { path: startupUrl, name, bytes }
      } catch {
        return null
      }
    },
    onOpenFile: () => () => {},
    onMenu: () => () => {},
    openPdf: async () => {
      const f = await pickFile('application/pdf')
      return f ? { path: '', name: f.name, bytes: f.bytes } : null
    },
    openPdfs: async () => pickFiles('application/pdf'),
    openFiles: async () => pickFiles('application/pdf,image/png,image/jpeg'),
    openImages: async () => pickFiles('image/png,image/jpeg'),
    openImage: async () => {
      const f = await pickFile('image/png,image/jpeg')
      return f ? { path: f.name, ext: f.ext === 'jpeg' ? 'jpg' : f.ext, bytes: f.bytes } : null
    },
    readFile: async () => new ArrayBuffer(0),
    openPath: async () => null,
    getRecents: async () => [],
    addRecent: () => {},
    setDirty: () => {},
    appCommand: (cmd: string) => console.log('[shim] appCommand:', cmd),
    onUpdate: () => () => {},
    getUpdateState: async () => ({ state: 'idle' as const }),
    checkForUpdates: () => console.log('[shim] checkForUpdates'),
    installUpdate: async () => false,
    getVersion: async () => 'dev',
    pathForFile: () => '',
    savePdf: async (bytes: ArrayBuffer, suggestedName?: string) =>
      download(bytes, suggestedName || 'document.pdf'),
    savePdfToPath: async () => ({ ok: false as const, error: 'Not available in browser mode' }),
    printHtml: async (html: string) => {
      // best-effort browser print via a hidden iframe
      const frame = document.createElement('iframe')
      frame.style.position = 'fixed'
      frame.style.right = '110%'
      document.body.appendChild(frame)
      frame.srcdoc = html
      await new Promise((r) => (frame.onload = r))
      frame.contentWindow?.print()
      setTimeout(() => frame.remove(), 60000)
      return { ok: true }
    },
    openExternal: async () => {},
    unlockPdf: async () => ({ ok: false as const, error: 'QPDF_MISSING' }),
    hasQpdf: async () => false,
    // FAKE OCR for browser-mode UI testing only — the real engine lives in the
    // Electron main process. Returns a deterministic row of words.
    ocrPage: async (bytes: ArrayBuffer) => {
      let W = 1000
      let H = 1400
      try {
        const bmp = await createImageBitmap(new Blob([bytes]))
        W = bmp.width
        H = bmp.height
        bmp.close()
      } catch {
        /* keep defaults */
      }
      const words = ['SCANNED', 'SAMPLE', 'TEXT', 'ROW'].map((text, i) => ({
        text,
        x0: W * 0.08 + i * W * 0.2,
        y0: H * 0.1,
        x1: W * 0.08 + i * W * 0.2 + W * 0.16,
        y1: H * 0.1 + H * 0.03
      }))
      return { ok: true as const, words }
    },
    ocrCacheGet: async () => null,
    ocrCacheSet: async () => {},
    // no persistent cache in browser mode — the optimiser just re-runs
    optCacheGet: async () => null,
    optCacheSet: async () => {},
    listSignatures: async () => [],
    addSignature: async () => ({ id: 'dev', ext: 'png' }),
    removeSignature: async () => {}
  }
  ;(window as unknown as { api: Api }).api = shim
  console.info('[PDF Studio] running in browser mode (dev shim active)')
}
