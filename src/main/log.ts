/**
 * Local diagnostic log: one plain-text file per day in
 * %APPDATA%\pdf-studio\logs, kept 14 days. Nothing leaves the computer.
 *
 * Lines look like:
 *   2026-11-23 09:14:02.381 +1234ms [main] INFO  read: Plan set.pdf 48.2 MB in 3120 ms (15.4 MB/s) from Z:
 * where +ms is time since the process started — so a slow launch reads
 * straight off the left-hand column.
 *
 * Writes are synchronous appends: volume is a few hundred lines a session, and
 * a sync write means the last line before a crash is on disk.
 */
import { app } from 'electron'
import { join } from 'path'
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs'

export type Level = 'INFO' | 'WARN' | 'ERROR'

const KEEP_DAYS = 14
let dir: string | null = null

export function logDir(): string {
  if (!dir) dir = join(app.getPath('userData'), 'logs')
  return dir
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

function dayStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function timeStamp(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/** Write one line. `source` is main, renderer, updater, … */
export function writeLog(source: string, level: Level, msg: string): void {
  try {
    const d = new Date()
    const up = Math.round(process.uptime() * 1000)
    // one entry per line: fold stack traces onto continuation lines
    const body = String(msg).replace(/\r?\n/g, '\n    ')
    const line = `${dayStamp(d)} ${timeStamp(d)} +${up}ms [${source}] ${level.padEnd(5)} ${body}\r\n`
    mkdirSync(logDir(), { recursive: true })
    appendFileSync(join(logDir(), `pdfstudio-${dayStamp(d)}.log`), line, 'utf8')
  } catch {
    /* logging must never break the app */
  }
}

export const log = (msg: string): void => writeLog('main', 'INFO', msg)
export const logWarn = (msg: string): void => writeLog('main', 'WARN', msg)
export const logError = (msg: string): void => writeLog('main', 'ERROR', msg)

export function errText(e: unknown): string {
  if (e instanceof Error) return e.stack || e.message
  return String(e)
}

/** Delete day files older than KEEP_DAYS. */
export function pruneLogs(): void {
  try {
    const cutoff = Date.now() - KEEP_DAYS * 86_400_000
    for (const f of readdirSync(logDir())) {
      if (!/^pdfstudio-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue
      const p = join(logDir(), f)
      if (statSync(p).mtimeMs < cutoff) unlinkSync(p)
    }
  } catch {
    /* folder may not exist yet */
  }
}

/** "48.2 MB" */
export function mb(bytes: number): string {
  return bytes < 1048576 ? Math.max(1, Math.round(bytes / 1024)) + ' KB' : (bytes / 1048576).toFixed(1) + ' MB'
}

/** Where a file lives, without logging the folder path: drive, share host, OneDrive flag. */
export function whereIs(path: string): string {
  if (path.startsWith('\\\\')) return 'network share \\\\' + (path.split('\\')[2] || '?')
  const drive = /^[a-z]:/i.exec(path)?.[0]?.toUpperCase() ?? '?'
  return drive + (/onedrive/i.test(path) ? ' (OneDrive)' : '')
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}
