import { app, shell, BrowserWindow, ipcMain, dialog, Menu, type MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { existsSync, promises as fs } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import { createWorker, type Worker as TessWorker } from 'tesseract.js'

const execFileP = promisify(execFile)

let mainWindow: BrowserWindow | null = null
let startupFile: string | null = null
let hasDirty = false

interface PdfPayload {
  path: string
  name: string
  bytes: ArrayBuffer
}

/** Find a .pdf path in a launch argv (double-click / "Open with" / default app). */
function pdfFromArgv(argv: string[]): string | null {
  for (const a of argv.slice(1)) {
    if (a && !a.startsWith('-') && a.toLowerCase().endsWith('.pdf') && existsSync(a)) return a
  }
  return null
}

async function readPdfPayload(path: string): Promise<PdfPayload> {
  const data = await fs.readFile(path)
  return {
    path,
    name: path.split(/[\\/]/).pop() || 'document.pdf',
    bytes: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  }
}

// ---- OCR (bundled Tesseract, fully offline) --------------------------------

interface OcrWordOut {
  text: string
  x0: number
  y0: number
  x1: number
  y1: number
}

let tessP: Promise<TessWorker> | null = null
let tessIdleTimer: NodeJS.Timeout | null = null

function tessLangPath(): string {
  // __dirname-relative in dev (out/main → project root) so the path is right
  // no matter how Electron was launched; resourcesPath when packaged.
  return app.isPackaged
    ? join(process.resourcesPath, 'tessdata')
    : join(__dirname, '..', '..', 'resources', 'tessdata')
}

function getTess(): Promise<TessWorker> {
  if (!tessP) {
    const langPath = tessLangPath()
    if (!existsSync(join(langPath, 'eng.traineddata.gz'))) {
      return Promise.reject(new Error('OCR language data missing at ' + langPath))
    }
    tessP = createWorker('eng', 1, {
      langPath,
      cacheMethod: 'none',
      gzip: true
    })
  }
  return tessP
}

// tesseract.js worker-thread failures can surface as uncaught exceptions in
// the main process (outside our promise chain). Contain them — a background
// OCR hiccup must never take the app down with a crash dialog.
process.on('uncaughtException', (err) => {
  const s = String(err?.stack || err)
  console.error('[uncaughtException]', s)
  if (/tesseract/i.test(s)) {
    const p = tessP
    tessP = null
    p?.then((w) => w.terminate()).catch(() => {})
    return
  }
  dialog.showErrorBox('PDF Studio — unexpected error', s.slice(0, 2000))
})

/** Drop the worker (~150 MB) after a while with no recognition work. */
function scheduleTessIdle(): void {
  if (tessIdleTimer) clearTimeout(tessIdleTimer)
  tessIdleTimer = setTimeout(() => {
    const p = tessP
    tessP = null
    p?.then((w) => w.terminate()).catch(() => {})
  }, 90_000)
}

async function ocrRecognize(image: Buffer): Promise<OcrWordOut[]> {
  const worker = await getTess()
  const { data } = await worker.recognize(image)
  scheduleTessIdle()
  return (data.words || [])
    .filter((w) => w.text && w.text.trim() && w.confidence >= 35)
    .map((w) => ({ text: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 }))
}

const ocrCacheDir = (): string => join(app.getPath('userData'), 'ocr-cache')
/** Optimised render copies of heavy documents, keyed by hash of the original. */
const optCacheDir = (): string => join(app.getPath('userData'), 'opt-cache')
/** Keep the cache bounded — these are whole PDFs, ~10 MB each on plan sets. */
const OPT_CACHE_BUDGET = 600 * 1024 * 1024
const isSafeHash = (h: string): boolean => /^[a-f0-9]{16,128}$/i.test(h)

// ---- Recent files ---------------------------------------------------------

interface RecentEntry {
  path: string
  name: string
  time: number
}

let recents: RecentEntry[] = []
const recentsFile = (): string => join(app.getPath('userData'), 'recents.json')

async function loadRecents(): Promise<void> {
  try {
    const raw = JSON.parse(await fs.readFile(recentsFile(), 'utf8'))
    if (Array.isArray(raw)) recents = raw.filter((r) => r && typeof r.path === 'string')
  } catch {
    recents = []
  }
}

function addRecent(path: string): void {
  if (!path) return
  const name = path.split(/[\\/]/).pop() || path
  recents = [{ path, name, time: Date.now() }, ...recents.filter((r) => r.path !== path)].slice(0, 12)
  fs.writeFile(recentsFile(), JSON.stringify(recents)).catch(() => {})
  buildMenu()
}

function existingRecents(): RecentEntry[] {
  return recents.filter((r) => existsSync(r.path))
}

// ---- Signatures store -----------------------------------------------------

const sigDir = (): string => join(app.getPath('userData'), 'signatures')

async function listSignatures(): Promise<{ id: string; ext: string; bytes: ArrayBuffer }[]> {
  try {
    const files = await fs.readdir(sigDir())
    const out: { id: string; ext: string; bytes: ArrayBuffer }[] = []
    for (const f of files) {
      const m = /^(.+)\.(png|jpg)$/i.exec(f)
      if (!m) continue
      const data = await fs.readFile(join(sigDir(), f))
      out.push({
        id: m[1],
        ext: m[2].toLowerCase(),
        bytes: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      })
    }
    return out.sort((a, b) => a.id.localeCompare(b.id))
  } catch {
    return []
  }
}

// ---- Window / menu --------------------------------------------------------

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#1f2430',
    title: 'PDF Studio',
    // The ribbon renders its own File / View / Help menus on the tab row, so
    // the native bar would just cost a row of height. Alt still reveals it.
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Normally we wait for the first paint so there's no white flash. If the
  // renderer never gets there, show the window anyway rather than leaving an
  // invisible process sitting on the single-instance lock.
  const showFallback = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show()
  }, 12000)
  mainWindow.on('ready-to-show', () => {
    clearTimeout(showFallback)
    mainWindow?.show()
  })
  mainWindow.on('closed', () => clearTimeout(showFallback))

  // Unsaved-changes guard: renderer keeps us posted via app:setDirty.
  mainWindow.on('close', (e) => {
    if (!hasDirty || !mainWindow) return
    const r = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Close anyway', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Unsaved changes',
      message: 'You have unsaved changes.',
      detail: 'Close PDF Studio anyway? Unsaved edits will be lost.'
    })
    if (r !== 0) e.preventDefault()
  })

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[renderer did-fail-load]', code, desc, url)
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[render-process-gone]', details.reason, details.exitCode)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // electron-vite injects ELECTRON_RENDERER_URL in dev
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function showAbout(): void {
  if (!mainWindow) return
  dialog.showMessageBox(mainWindow, {
    title: 'About PDF Studio',
    message: 'PDF Studio',
    detail:
      'Local PDF reader, editor, form-filler, signer & takeoff tool.\nVersion ' +
      app.getVersion() +
      '\n\nRuns fully offline on your machine.'
  })
}

/** Window/app level commands the ribbon's own File / View / Help menus invoke. */
function runAppCommand(cmd: string): void {
  switch (cmd) {
    case 'default-apps':
      shell.openExternal('ms-settings:defaultapps?registeredAppUser=PDF%20Studio')
      break
    case 'devtools':
      mainWindow?.webContents.toggleDevTools()
      break
    case 'fullscreen':
      mainWindow?.setFullScreen(!mainWindow.isFullScreen())
      break
    case 'reload':
      mainWindow?.reload()
      break
    case 'about':
      showAbout()
      break
    case 'quit':
      app.quit()
      break
  }
}

function buildMenu(): void {
  const send = (action: string): void => mainWindow?.webContents.send('menu', action)
  const recentItems: MenuItemConstructorOptions[] = existingRecents().map((r) => ({
    label: r.name,
    sublabel: r.path,
    click: async () => {
      try {
        const payload = await readPdfPayload(r.path)
        addRecent(r.path)
        mainWindow?.webContents.send('open-file', payload)
      } catch {
        /* file vanished */
      }
    }
  }))
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        {
          label: 'Open Recent',
          submenu: recentItems.length ? recentItems : [{ label: 'No recent files', enabled: false }]
        },
        { label: 'Combine Files…', click: () => send('combine') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('save-as') },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: () => send('print') },
        { type: 'separator' },
        { label: 'Remove Restrictions (Unlock)', click: () => send('unlock') },
        { type: 'separator' },
        {
          label: 'Set PDF Studio as Default PDF App…',
          // deep-link straight to PDF Studio's own default-apps page; Windows
          // falls back to the general Default Apps screen if unsupported
          click: () => shell.openExternal('ms-settings:defaultapps?registeredAppUser=PDF%20Studio')
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [{ label: 'About PDF Studio', click: () => showAbout() }]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Locate the bundled qpdf executable in dev and packaged builds. */
function qpdfPath(): string | null {
  const candidates = [
    // Packaged: extraResources copies resources/bin -> <resources>/bin
    join(process.resourcesPath || '', 'bin', 'qpdf', 'bin', 'qpdf.exe'),
    join(process.resourcesPath || '', 'bin', 'qpdf.exe'),
    // Dev
    join(app.getAppPath(), 'resources', 'bin', 'qpdf', 'bin', 'qpdf.exe'),
    join(app.getAppPath(), 'resources', 'bin', 'qpdf.exe')
  ]
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return null
}

// Headless OCR self-test: verifies the packaged engine + language data work.
// Usage: PDFSTUDIO_OCR_SELFTEST_IN=<image> PDFSTUDIO_OCR_SELFTEST_OUT=<json> "PDF Studio.exe"
const selftestIn = process.env['PDFSTUDIO_OCR_SELFTEST_IN']
const selftestOut = process.env['PDFSTUDIO_OCR_SELFTEST_OUT']
const runningSelftest = !!(selftestIn && selftestOut)
if (runningSelftest) {
  app.whenReady().then(async () => {
    try {
      const img = await fs.readFile(selftestIn!)
      const words = await ocrRecognize(img)
      await fs.writeFile(selftestOut!, JSON.stringify({ ok: true, words: words.map((w) => w.text) }))
    } catch (err) {
      await fs.writeFile(selftestOut!, JSON.stringify({ ok: false, error: String(err) })).catch(() => {})
    }
    app.exit(0)
  })
}

// Single-instance: route a second launch (e.g. opening another PDF) into this window.
const gotLock = runningSelftest ? true : app.requestSingleInstanceLock()
if (runningSelftest) {
  // self-test mode: no window, no IPC — handled above
} else if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', async (_e, argv) => {
    const f = pdfFromArgv(argv)
    // The primary instance can be left with no usable window (a hung startup,
    // or a window that went away without quitting). Without this recovery it
    // keeps the single-instance lock forever and every later launch silently
    // does nothing — the app simply "won't open".
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (f) {
        addRecent(f)
        startupFile = f
      }
      if (app.isReady()) createWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
    if (f) {
      addRecent(f)
      mainWindow.webContents.send('open-file', await readPdfPayload(f))
    }
  })
  startupFile = pdfFromArgv(process.argv)
  bootstrap()
}

function bootstrap(): void {
  app.whenReady().then(async () => {
    app.setAppUserModelId('ca.dirtpro.pdfstudio')
    await loadRecents()
    buildMenu()

    ipcMain.handle('app:getStartupFile', async () => {
      if (!startupFile) return null
      const f = startupFile
      startupFile = null
      try {
        const payload = await readPdfPayload(f)
        addRecent(f)
        return payload
      } catch {
        return null
      }
    })

    ipcMain.handle('dialog:openPdf', async () => {
      const res = await dialog.showOpenDialog(mainWindow!, {
        title: 'Open PDF',
        filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
        properties: ['openFile']
      })
      if (res.canceled || res.filePaths.length === 0) return null
      const path = res.filePaths[0]
      addRecent(path)
      return readPdfPayload(path)
    })

    // Ctrl+O and "Insert from PDF" both take several files at once.
    ipcMain.handle('dialog:openPdfs', async (_e, title?: string) => {
      const res = await dialog.showOpenDialog(mainWindow!, {
        title: title || 'Open PDF',
        filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
        properties: ['openFile', 'multiSelections']
      })
      if (res.canceled || res.filePaths.length === 0) return []
      const out: PdfPayload[] = []
      for (const path of res.filePaths) {
        try {
          out.push(await readPdfPayload(path))
          addRecent(path)
        } catch {
          /* unreadable — skip it */
        }
      }
      return out
    })

    // Combine files: PDFs and pictures together, in one picker.
    ipcMain.handle('dialog:openFiles', async () => {
      const res = await dialog.showOpenDialog(mainWindow!, {
        title: 'Choose files to combine',
        filters: [
          { name: 'PDFs and pictures', extensions: ['pdf', 'png', 'jpg', 'jpeg'] },
          { name: 'PDF Documents', extensions: ['pdf'] },
          { name: 'Pictures', extensions: ['png', 'jpg', 'jpeg'] }
        ],
        properties: ['openFile', 'multiSelections']
      })
      if (res.canceled || res.filePaths.length === 0) return []
      const out: { path: string; name: string; bytes: ArrayBuffer }[] = []
      for (const path of res.filePaths) {
        try {
          const data = await fs.readFile(path)
          out.push({
            path,
            name: path.split(/[\\/]/).pop() || path,
            bytes: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
          })
        } catch {
          /* skip */
        }
      }
      return out
    })

    // Pictures to insert as pages.
    ipcMain.handle('dialog:openImages', async () => {
      const res = await dialog.showOpenDialog(mainWindow!, {
        title: 'Choose pictures to insert as pages',
        filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg'] }],
        properties: ['openFile', 'multiSelections']
      })
      if (res.canceled || res.filePaths.length === 0) return []
      const out: { path: string; name: string; bytes: ArrayBuffer }[] = []
      for (const path of res.filePaths) {
        try {
          const data = await fs.readFile(path)
          out.push({
            path,
            name: path.split(/[\\/]/).pop() || path,
            bytes: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
          })
        } catch {
          /* skip */
        }
      }
      return out
    })

    ipcMain.handle('dialog:openImage', async () => {
      const res = await dialog.showOpenDialog(mainWindow!, {
        title: 'Choose signature or stamp image',
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
        properties: ['openFile']
      })
      if (res.canceled || res.filePaths.length === 0) return null
      const path = res.filePaths[0]
      const data = await fs.readFile(path)
      const ext = (path.split('.').pop() || '').toLowerCase()
      return { path, ext, bytes: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) }
    })

    ipcMain.handle('file:read', async (_e, path: string) => {
      const data = await fs.readFile(path)
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    })

    ipcMain.handle('app:openPath', async (_e, path: string) => {
      try {
        const payload = await readPdfPayload(path)
        addRecent(path)
        return payload
      } catch {
        return null
      }
    })

    ipcMain.handle('recents:get', async () => existingRecents().map((r) => ({ path: r.path, name: r.name })))
    ipcMain.on('recents:add', (_e, path: string) => addRecent(path))

    ipcMain.on('app:setDirty', (_e, v: boolean) => {
      hasDirty = !!v
    })

    ipcMain.handle('dialog:savePdf', async (_e, args: { bytes: ArrayBuffer; suggestedName?: string }) => {
      const res = await dialog.showSaveDialog(mainWindow!, {
        title: 'Save PDF',
        defaultPath: args.suggestedName || 'document.pdf',
        filters: [{ name: 'PDF Documents', extensions: ['pdf'] }]
      })
      if (res.canceled || !res.filePath) return null
      await fs.writeFile(res.filePath, Buffer.from(args.bytes))
      addRecent(res.filePath)
      return res.filePath
    })

    // Overwrite an existing file safely (write temp, then atomic rename).
    ipcMain.handle('file:saveToPath', async (_e, args: { path: string; bytes: ArrayBuffer }) => {
      try {
        const tmp = args.path + '.pdfstudio-tmp'
        await fs.writeFile(tmp, Buffer.from(args.bytes))
        await fs.rename(tmp, args.path)
        addRecent(args.path)
        return { ok: true as const }
      } catch (err) {
        return { ok: false as const, error: String((err as Error)?.message || err) }
      }
    })

    ipcMain.handle('file:openExternal', async (_e, path: string) => {
      await shell.openPath(path)
    })

    // Print pre-rendered page images via a hidden window + system dialog.
    ipcMain.handle('print:html', async (_e, html: string) => {
      const tmpDir = await fs.mkdtemp(join(os.tmpdir(), 'pdfstudio-print-'))
      const file = join(tmpDir, 'print.html')
      const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
      try {
        await fs.writeFile(file, html, 'utf8')
        await win.loadFile(file)
        return await new Promise<{ ok: boolean; error?: string }>((resolve) => {
          win.webContents.print({}, (success, reason) => resolve({ ok: success, error: reason || undefined }))
        })
      } catch (err) {
        return { ok: false, error: String((err as Error)?.message || err) }
      } finally {
        win.destroy()
        fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      }
    })

    // ---- OCR ---------------------------------------------------------------
    ipcMain.handle('ocr:page', async (_e, bytes: ArrayBuffer) => {
      try {
        const words = await ocrRecognize(Buffer.from(bytes))
        return { ok: true as const, words }
      } catch (err) {
        return { ok: false as const, error: String((err as Error)?.message || err) }
      }
    })

    ipcMain.handle('ocr:cache-get', async (_e, hash: string) => {
      if (!isSafeHash(hash)) return null
      try {
        return JSON.parse(await fs.readFile(join(ocrCacheDir(), hash + '.json'), 'utf8'))
      } catch {
        return null
      }
    })

    // ---- optimised render copies -----------------------------------------
    // Whole PDFs, so they get an LRU budget rather than living forever.
    ipcMain.handle('opt:cache-get', async (_e, hash: string) => {
      if (!isSafeHash(hash)) return null
      try {
        const f = join(optCacheDir(), hash + '.pdf')
        const buf = await fs.readFile(f)
        // touch, so the eviction pass below sees it as recently used
        const now = new Date()
        fs.utimes(f, now, now).catch(() => {})
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      } catch {
        return null
      }
    })

    ipcMain.handle('opt:cache-set', async (_e, hash: string, bytes: ArrayBuffer) => {
      if (!isSafeHash(hash)) return
      try {
        const dir = optCacheDir()
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(join(dir, hash + '.pdf'), Buffer.from(bytes))
        // Evict oldest-touched entries until the whole cache fits the budget.
        const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.pdf'))
        const stats = await Promise.all(
          names.map(async (n) => {
            const st = await fs.stat(join(dir, n)).catch(() => null)
            return st ? { n, size: st.size, at: st.mtimeMs } : null
          })
        )
        const live = stats.filter((x): x is { n: string; size: number; at: number } => !!x)
        let totalBytes = live.reduce((t, x) => t + x.size, 0)
        live.sort((x, y) => x.at - y.at)
        for (const x of live) {
          if (totalBytes <= OPT_CACHE_BUDGET) break
          await fs.unlink(join(dir, x.n)).catch(() => {})
          totalBytes -= x.size
        }
      } catch {
        /* cache is best-effort */
      }
    })

    ipcMain.handle('ocr:cache-set', async (_e, hash: string, data: unknown) => {
      if (!isSafeHash(hash)) return
      try {
        await fs.mkdir(ocrCacheDir(), { recursive: true })
        await fs.writeFile(join(ocrCacheDir(), hash + '.json'), JSON.stringify(data))
      } catch {
        /* cache is best-effort */
      }
    })

    // ---- persistent signatures -------------------------------------------
    ipcMain.handle('sig:list', async () => listSignatures())
    ipcMain.handle('sig:add', async (_e, args: { bytes: ArrayBuffer; ext: string }) => {
      const ext = args.ext === 'png' ? 'png' : 'jpg'
      const id = 'sig-' + Date.now().toString(36)
      await fs.mkdir(sigDir(), { recursive: true })
      await fs.writeFile(join(sigDir(), `${id}.${ext}`), Buffer.from(args.bytes))
      return { id, ext }
    })
    ipcMain.handle('sig:remove', async (_e, id: string) => {
      for (const ext of ['png', 'jpg']) {
        await fs.rm(join(sigDir(), `${id}.${ext}`), { force: true }).catch(() => {})
      }
    })

    // Unlock / decrypt a PDF using bundled qpdf.
    // password is optional (for user-password protected docs).
    ipcMain.handle('pdf:unlock', async (_e, args: { bytes: ArrayBuffer; password?: string }) => {
      const qpdf = qpdfPath()
      if (!qpdf) {
        return { ok: false, error: 'QPDF_MISSING' }
      }
      const tmpDir = await fs.mkdtemp(join(os.tmpdir(), 'pdfstudio-'))
      const inPath = join(tmpDir, 'in.pdf')
      const outPath = join(tmpDir, 'out.pdf')
      try {
        await fs.writeFile(inPath, Buffer.from(args.bytes))
        const argv = ['--decrypt']
        if (args.password) argv.push(`--password=${args.password}`)
        argv.push(inPath, outPath)
        await execFileP(qpdf, argv, { windowsHide: true })
        const out = await fs.readFile(outPath)
        return { ok: true, bytes: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) }
      } catch (err: any) {
        // qpdf exit code 3 = warnings (still produced output); try to read it
        try {
          const out = await fs.readFile(outPath)
          return { ok: true, bytes: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) }
        } catch {
          const msg = String(err?.stderr || err?.message || err)
          const needsPw = /password|invalid|R = /i.test(msg)
          return { ok: false, error: needsPw ? 'PASSWORD_REQUIRED' : msg }
        }
      } finally {
        fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      }
    })

    ipcMain.handle('app:hasQpdf', () => qpdfPath() !== null)

    ipcMain.on('app:command', (_e, cmd: string) => runAppCommand(cmd))

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  const p = tessP
  tessP = null
  p?.then((w) => w.terminate()).catch(() => {})
})
