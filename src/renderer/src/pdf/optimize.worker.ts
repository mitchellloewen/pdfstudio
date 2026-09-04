/**
 * Runs the content-stream optimiser off the UI thread.
 *
 * A dense plan set takes tens of seconds to rewrite, which would freeze the
 * window if it ran inline. The worker posts progress as it goes and transfers
 * the finished bytes back.
 */
import { optimizePdf, type ShrinkStats } from './shrink'
import type { OptimizeOptions } from './optimize'

export interface OptimizeRequest {
  bytes: ArrayBuffer
  opts?: OptimizeOptions
}

export type OptimizeResponse =
  | { kind: 'progress'; done: number; total: number; label: string }
  | { kind: 'done'; bytes: ArrayBuffer; stats: ShrinkStats }
  | { kind: 'error'; message: string }

self.onmessage = async (e: MessageEvent<OptimizeRequest>): Promise<void> => {
  const post = (m: OptimizeResponse, transfer?: Transferable[]): void =>
    (self as unknown as Worker).postMessage(m, transfer ?? [])
  try {
    const { bytes, stats } = await optimizePdf(e.data.bytes, {
      ...e.data.opts,
      onProgress: (done, total, label) => post({ kind: 'progress', done, total, label })
    })
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    post({ kind: 'done', bytes: buf, stats }, [buf])
  } catch (err) {
    post({ kind: 'error', message: (err as Error)?.message || String(err) })
  }
}
