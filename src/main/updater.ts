/**
 * In-app updates from GitHub Releases, with no updater dependency.
 *
 * Every release on github.com/mitchellloewen/pdfstudio carries two assets that
 * `npm run build:win` produces (electron-builder writes latest.yml because the
 * yml has a github publish block):
 *
 *   latest.yml                       version / path / sha512 / size
 *   PDF-Studio-Setup-<ver>.exe       the NSIS installer
 *
 * GitHub's ".../releases/latest/download/<asset>" URL always points at the
 * newest release, so the app never touches the API and never needs a token.
 *
 * Flow: 8 s after launch (and every 4 h) fetch latest.yml → compare with our
 * version → download the installer to userData/updates → verify SHA-512 →
 * tell the renderer it is ready. "Restart to update" runs the installer
 * silently (/S) with --force-run so the app comes straight back on the new
 * version, then quits. Nothing is ever installed without that click.
 */
import { app, net, type BrowserWindow } from 'electron'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, promises as fs } from 'fs'
import { join } from 'path'

export const RELEASES_PAGE = 'https://github.com/mitchellloewen/pdfstudio/releases'
const FEED = RELEASES_PAGE + '/latest/download/'

export interface Manifest {
  version: string
  file: string
  size: number
  sha512: string
}

export type UpdateState =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'none'; version: string }
  | { state: 'available'; version: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; error: string; manual: boolean }

let current: UpdateState = { state: 'idle' }
let readyInstaller: { path: string; version: string } | null = null
let inFlight: Promise<void> | null = null
let getWindow: () => BrowserWindow | null = () => null
let onStateChange: ((s: UpdateState) => void) | null = null

const updatesDir = (): string => join(app.getPath('userData'), 'updates')

function setState(s: UpdateState): void {
  current = s
  const w = getWindow()
  if (w && !w.isDestroyed()) w.webContents.send('update', s)
  onStateChange?.(s)
}

export const getUpdateState = (): UpdateState => current

/** Numeric dotted-version compare: > 0 when a is newer than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  const pb = b.replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

/** electron-builder's latest.yml is flat enough to read without a YAML parser. */
export function parseLatestYml(text: string): Manifest {
  const grab = (key: string): string | null => {
    const m = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, 'm').exec(text)
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null
  }
  const version = grab('version')
  const file = grab('path')
  const sha512 = grab('sha512')
  const size = Number(grab('size') || 0)
  if (!version || !file || !sha512) throw new Error('latest.yml is missing version, path or sha512')
  return { version, file, sha512, size }
}

async function fetchManifest(): Promise<Manifest> {
  const res = await net.fetch(FEED + 'latest.yml?t=' + Date.now())
  if (!res.ok) throw new Error(`update feed returned HTTP ${res.status}`)
  return parseLatestYml(await res.text())
}

async function sha512Of(path: string): Promise<string> {
  const h = createHash('sha512')
  const fh = await fs.open(path, 'r')
  try {
    const buf = Buffer.alloc(4 * 1024 * 1024)
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null)
      if (!bytesRead) break
      h.update(buf.subarray(0, bytesRead))
    }
  } finally {
    await fh.close()
  }
  return h.digest('base64')
}

async function download(m: Manifest): Promise<string> {
  await fs.mkdir(updatesDir(), { recursive: true })
  const safeName = m.file.replace(/[\\/:*?"<>|]/g, '_')
  const dest = join(updatesDir(), safeName)

  // Already fetched on an earlier run (e.g. the user didn't restart yet)?
  if (existsSync(dest) && (await sha512Of(dest)) === m.sha512) return dest

  const tmp = dest + '.part'
  // GitHub stores asset names with spaces as dots; the yml keeps the original.
  const res = await net.fetch(FEED + encodeURIComponent(m.file.replace(/ /g, '.')))
  if (!res.ok || !res.body) throw new Error(`installer download returned HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || m.size || 0
  const fh = await fs.open(tmp, 'w')
  const hash = createHash('sha512')
  let got = 0
  let lastPct = -1
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      await fh.write(value)
      hash.update(value)
      got += value.length
      const pct = total ? Math.floor((got / total) * 100) : 0
      if (pct !== lastPct) {
        lastPct = pct
        setState({ state: 'downloading', version: m.version, percent: pct })
      }
    }
  } finally {
    await fh.close()
  }
  if (hash.digest('base64') !== m.sha512) {
    await fs.rm(tmp, { force: true })
    throw new Error('the downloaded installer failed its checksum — try again later')
  }
  await fs.rename(tmp, dest)
  for (const f of await fs.readdir(updatesDir()).catch(() => [] as string[])) {
    if (f !== safeName) fs.rm(join(updatesDir(), f), { force: true }).catch(() => {})
  }
  return dest
}

/**
 * Check the feed and download a newer version if there is one. `manual` is a
 * Help-menu click: it also reports "up to date" and errors. The automatic
 * check stays quiet unless an update is actually ready to install.
 */
export function checkForUpdates(manual: boolean): Promise<void> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      if (!app.isPackaged) {
        if (manual) setState({ state: 'error', error: 'Updates only run in the installed app, not in dev mode.', manual })
        return
      }
      if (readyInstaller) {
        setState({ state: 'ready', version: readyInstaller.version })
        return
      }
      setState({ state: 'checking' })
      const m = await fetchManifest()
      if (compareVersions(m.version, app.getVersion()) <= 0) {
        setState({ state: 'none', version: app.getVersion() })
        return
      }
      setState({ state: 'available', version: m.version })
      const path = await download(m)
      readyInstaller = { path, version: m.version }
      setState({ state: 'ready', version: m.version })
    } catch (err) {
      setState({ state: 'error', error: String((err as Error)?.message || err), manual })
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

/** Run the verified installer silently and quit; it relaunches the app. */
export function installUpdate(): boolean {
  if (!readyInstaller || !existsSync(readyInstaller.path)) return false
  // Same flags electron-updater passes to an NSIS installer.
  const child = spawn(readyInstaller.path, ['--updated', '/S', '--force-run'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.unref()
  setTimeout(() => app.quit(), 300)
  return true
}

export function initUpdater(opts: { window: () => BrowserWindow | null; onState?: (s: UpdateState) => void }): void {
  getWindow = opts.window
  onStateChange = opts.onState ?? null
  if (!app.isPackaged) return
  setTimeout(() => void checkForUpdates(false), 8000)
  setInterval(() => void checkForUpdates(false), 4 * 60 * 60 * 1000)
}
