import { useMemo, useState, type ReactNode } from 'react'

/**
 * Parse a page spec like "1-3, 5, 8-" into sorted, deduped 1-based page numbers.
 * Anything out of range is clamped; junk tokens are ignored rather than fatal —
 * the dialog shows a live count so a typo is visible before you commit.
 */
export function parsePageSpec(spec: string, total: number): number[] {
  const hits = new Set<number>()
  const add = (a: number, b: number): void => {
    const lo = Math.max(1, Math.min(a, b))
    const hi = Math.min(total, Math.max(a, b))
    for (let n = lo; n <= hi; n++) hits.add(n)
  }
  for (const raw of spec.split(/[,;\s]+/)) {
    const tok = raw.trim()
    if (!tok) continue
    const single = /^(\d+)$/.exec(tok)
    if (single) {
      add(Number(single[1]), Number(single[1]))
      continue
    }
    const range = /^(\d*)[-–—:](\d*)$/.exec(tok)
    if (range && (range[1] || range[2])) {
      add(range[1] ? Number(range[1]) : 1, range[2] ? Number(range[2]) : total)
    }
  }
  return [...hits].sort((a, b) => a - b)
}

/** "1, 2, 3, 7" — truncated so a 400-page pick doesn't blow out the dialog. */
function summarize(pages: number[]): string {
  if (pages.length <= 12) return pages.join(', ')
  return pages.slice(0, 10).join(', ') + `, … , ${pages[pages.length - 1]}`
}

type Mode = 'current' | 'selected' | 'all' | 'custom'

interface Props {
  title: string
  intro: string
  confirmLabel: string
  /** Red confirm button, for destructive picks (delete). */
  danger?: boolean
  totalPages: number
  currentPage: number
  /** Pages ticked in the thumbnail sidebar, 1-based. */
  selectedPages: number[]
  /** Extra controls (e.g. rotate direction) shown under the page options. */
  extra?: ReactNode
  onConfirm: (pages: number[]) => void
  onCancel: () => void
}

/**
 * One page picker for extract / rotate / delete: current page, the sidebar
 * selection, everything, or a typed range. Deliberately defaults to the page
 * you're looking at — the sidebar selection is the fallback, not the driver.
 */
export default function PagePickDialog({
  title,
  intro,
  confirmLabel,
  danger,
  totalPages,
  currentPage,
  selectedPages,
  extra,
  onConfirm,
  onCancel
}: Props): JSX.Element {
  const [mode, setMode] = useState<Mode>('current')
  const [spec, setSpec] = useState('')

  const custom = useMemo(() => parsePageSpec(spec, totalPages), [spec, totalPages])

  const pages =
    mode === 'current'
      ? [currentPage]
      : mode === 'selected'
        ? selectedPages
        : mode === 'all'
          ? Array.from({ length: totalPages }, (_, i) => i + 1)
          : custom

  const submit = (): void => {
    if (pages.length > 0) onConfirm(pages)
  }

  const radio = (m: Mode, label: string, hint?: string): JSX.Element => (
    <label className={`ex-opt ${mode === m ? 'sel' : ''}`}>
      <input type="radio" name="page-pick-mode" checked={mode === m} onChange={() => setMode(m)} />
      <span className="ex-opt-label">{label}</span>
      {hint && <span className="ex-opt-hint">{hint}</span>}
    </label>
  )

  return (
    <div className="modal-back" onClick={onCancel}>
      <div className="modal ex-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <p>{intro}</p>

        <div className="ex-opts">
          {radio('current', `Current page (${currentPage})`)}
          {selectedPages.length > 0 &&
            radio(
              'selected',
              `Pages selected in the sidebar (${selectedPages.length})`,
              summarize(selectedPages)
            )}
          {radio('all', `All pages (1–${totalPages})`)}
          <label className={`ex-opt ${mode === 'custom' ? 'sel' : ''}`}>
            <input
              type="radio"
              name="page-pick-mode"
              checked={mode === 'custom'}
              onChange={() => setMode('custom')}
            />
            <span className="ex-opt-label">Pages</span>
            <input
              className="ex-spec"
              value={spec}
              placeholder="e.g. 1-3, 5, 8-12"
              onChange={(e) => {
                setSpec(e.target.value)
                setMode('custom')
              }}
              onFocus={() => setMode('custom')}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </label>
        </div>

        {extra}

        <div className="ex-preview">
          {pages.length === 0
            ? mode === 'custom' && spec.trim()
              ? 'No pages match — use numbers like 2, 5-9.'
              : 'No pages chosen.'
            : `${pages.length} page${pages.length === 1 ? '' : 's'}: ${summarize(pages)}`}
        </div>

        <div className="modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button
            className={danger ? 'primary danger' : 'primary'}
            onClick={submit}
            disabled={pages.length === 0}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
