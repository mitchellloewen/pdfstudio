/** Main-thread side of the content-stream optimiser worker. */
import OptimizeWorker from './optimize.worker?worker'
import type { OptimizeRequest, OptimizeResponse } from './optimize.worker'
import type { ShrinkStats } from './shrink'
import type { OptimizeOptions } from './optimize'

export type { ShrinkStats }

export interface OptimizeProgress {
  done: number
  total: number
  label: string
}

/**
 * Rewrite a PDF's content streams for fast rendering, off the UI thread.
 * Rejects if the worker reports an error; the caller keeps the original bytes.
 */
export function optimizePdfInWorker(
  bytes: ArrayBuffer,
  opts?: OptimizeOptions,
  onProgress?: (p: OptimizeProgress) => void
): Promise<{ bytes: ArrayBuffer; stats: ShrinkStats }> {
  return new Promise((resolve, reject) => {
    const worker = new OptimizeWorker()
    worker.onmessage = (e: MessageEvent<OptimizeResponse>): void => {
      const m = e.data
      if (m.kind === 'progress') {
        onProgress?.({ done: m.done, total: m.total, label: m.label })
        return
      }
      worker.terminate()
      if (m.kind === 'done') resolve({ bytes: m.bytes, stats: m.stats })
      else reject(new Error(m.message))
    }
    worker.onerror = (e): void => {
      worker.terminate()
      reject(new Error(e.message || 'optimiser worker failed'))
    }
    // The buffer is transferred, so hand the worker a copy — the caller still
    // needs its own bytes if the user cancels or the run fails.
    const copy = bytes.slice(0)
    const req: OptimizeRequest = { bytes: copy, opts }
    worker.postMessage(req, [copy])
  })
}
