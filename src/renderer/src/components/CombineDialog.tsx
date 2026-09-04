import { useEffect, useState } from 'react'
import type { CombineItem } from '../pdf/combine'

interface Props {
  items: CombineItem[]
  busy: boolean
  onChange: (items: CombineItem[]) => void
  /** Opens the file picker; App appends whatever was chosen via onChange. */
  onAddFiles: () => void
  onCombine: () => void
  onCancel: () => void
}

function fmtSize(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Nitro-style "Combine files": pick PDFs and pictures, put them in order, get
 * one new document. The list is the whole UI — the order you see is the order
 * you get.
 */
export default function CombineDialog({ items, busy, onChange, onAddFiles, onCombine, onCancel }: Props): JSX.Element {
  const [dragId, setDragId] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  const move = (i: number, dir: -1 | 1): void => {
    const j = i + dir
    if (j < 0 || j >= items.length) return
    const next = [...items]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  const remove = (id: string): void => onChange(items.filter((x) => x.id !== id))
  const reorder = (fromId: string, toId: string): void => {
    const from = items.findIndex((x) => x.id === fromId)
    const to = items.findIndex((x) => x.id === toId)
    if (from < 0 || to < 0 || from === to) return
    const next = [...items]
    const [it] = next.splice(from, 1)
    next.splice(to, 0, it)
    onChange(next)
  }

  const usable = items.filter((x) => !x.error)
  const totalPages = usable.reduce((s, x) => s + (x.pages ?? 0), 0)
  const counting = usable.some((x) => x.pages === null)

  return (
    <div className="modal-back" onClick={() => !busy && onCancel()}>
      <div className="modal cb-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Combine files</h2>
        <p>
          Joins PDFs and pictures (PNG / JPEG) into one new document, top to bottom. Drag rows to reorder, or use the
          arrows. Pictures become a full page each.
        </p>

        {items.length === 0 ? (
          <div className="cb-empty">
            No files yet — click <b>Add files…</b> or drop PDFs and pictures onto this window.
          </div>
        ) : (
          <div className="cb-list">
            {items.map((it, i) => (
              <div
                key={it.id}
                className={`cb-row ${it.error ? 'bad' : ''} ${dragId === it.id ? 'dragging' : ''}`}
                draggable={!busy}
                onDragStart={(e) => {
                  setDragId(it.id)
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragEnd={() => setDragId(null)}
                onDragOver={(e) => {
                  if (dragId) e.preventDefault()
                }}
                onDrop={(e) => {
                  if (!dragId) return
                  e.preventDefault()
                  e.stopPropagation()
                  reorder(dragId, it.id)
                  setDragId(null)
                }}
              >
                <span className="cb-n">{i + 1}</span>
                <span className="cb-icon" aria-hidden>
                  {it.kind === 'image' ? '🖼' : '📄'}
                </span>
                <span className="cb-name" title={it.name}>
                  {it.name}
                </span>
                <span className="cb-meta">
                  {it.error
                    ? it.error
                    : `${it.pages === null ? '…' : it.pages} page${it.pages === 1 ? '' : 's'} · ${fmtSize(it.bytes.byteLength)}`}
                </span>
                <span className="cb-actions">
                  <button title="Move up" disabled={busy || i === 0} onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button title="Move down" disabled={busy || i === items.length - 1} onClick={() => move(i, 1)}>
                    ↓
                  </button>
                  <button className="del" title="Remove from the list" disabled={busy} onClick={() => remove(it.id)}>
                    ✕
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="cb-foot">
          <button className="cb-add" disabled={busy} onClick={onAddFiles}>
            ＋ Add files…
          </button>
          <span className="cb-total">
            {usable.length} file{usable.length === 1 ? '' : 's'}
            {usable.length > 0 && ` · ${counting ? '…' : totalPages} page${totalPages === 1 && !counting ? '' : 's'}`}
          </span>
        </div>

        <div className="modal-actions">
          <button disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button className="primary" disabled={busy || usable.length === 0 || counting} onClick={onCombine}>
            {busy ? 'Combining…' : 'Combine'}
          </button>
        </div>
      </div>
    </div>
  )
}
