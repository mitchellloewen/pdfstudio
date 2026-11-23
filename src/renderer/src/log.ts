// Renderer side of the local diagnostic log. Lines go to the main process,
// which writes them to %APPDATA%\pdf-studio\logs\pdfstudio-<date>.log.

type Level = 'INFO' | 'WARN' | 'ERROR'

function send(level: Level, msg: string): void {
  try {
    window.api?.log?.(level, msg)
  } catch {
    /* logging must never break the app */
  }
}

export const log = (msg: string): void => send('INFO', msg)
export const logWarn = (msg: string): void => send('WARN', msg)
export const logError = (msg: string): void => send('ERROR', msg)

export function errText(e: unknown): string {
  if (e instanceof Error) return e.stack || `${e.name}: ${e.message}`
  if (typeof e === 'object' && e) {
    try {
      return JSON.stringify(e)
    } catch {
      /* fall through */
    }
  }
  return String(e)
}

export const mb = (bytes: number): string =>
  bytes < 1048576 ? Math.max(1, Math.round(bytes / 1024)) + ' KB' : (bytes / 1048576).toFixed(1) + ' MB'

/** Thumbnails queue behind the main page, so their times include waiting; only flag the really slow. */
export const SLOW_THUMB_MS = 1500

/** A page draw slower than this gets a log line. */
export const SLOW_DRAW_MS = 300

/**
 * Step timer for a multi-stage job:
 *   const t = stepTimer('open Plan.pdf'); …; t.step('parse'); …; t.done('12 pages')
 * logs "open Plan.pdf: 2140 ms total — parse 1800, unlock 0, … · 12 pages".
 */
export function stepTimer(label: string): {
  step: (name: string) => void
  done: (extra?: string) => number
  fail: (e: unknown) => void
} {
  const t0 = performance.now()
  let last = t0
  const steps: string[] = []
  return {
    step(name) {
      const now = performance.now()
      steps.push(`${name} ${Math.round(now - last)}`)
      last = now
    },
    done(extra) {
      const total = performance.now() - t0
      const line = `${label}: ${Math.round(total)} ms total — ${steps.join(', ') || 'no steps'} (ms)${extra ? ' · ' + extra : ''}`
      if (total > 3000) logWarn(line + ' — SLOW')
      else log(line)
      return total
    },
    fail(e) {
      logError(`${label}: failed after ${Math.round(performance.now() - t0)} ms (${steps.join(', ')}) — ${errText(e)}`)
    }
  }
}

/**
 * Forward console.warn / console.error and uncaught errors to the log, so the
 * failures the app currently swallows with a console.warn are on record too.
 */
export function installRendererLogging(): void {
  const origWarn = console.warn.bind(console)
  const origError = console.error.bind(console)
  const fmt = (args: unknown[]): string => args.map((a) => (typeof a === 'string' ? a : errText(a))).join(' ')
  console.warn = (...args: unknown[]) => {
    origWarn(...args)
    logWarn(fmt(args))
  }
  console.error = (...args: unknown[]) => {
    origError(...args)
    logError(fmt(args))
  }
  window.addEventListener('error', (e) => {
    logError(`uncaught error: ${e.message} at ${e.filename}:${e.lineno}` + (e.error ? '\n' + errText(e.error) : ''))
  })
  window.addEventListener('unhandledrejection', (e) => {
    logError('unhandled promise rejection: ' + errText(e.reason))
  })
  // How long the renderer took to get going, measured from its own navigation start.
  log(`renderer: script running ${Math.round(performance.now())} ms after page navigation started`)
}
