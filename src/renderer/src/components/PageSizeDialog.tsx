import { useMemo, useState, type JSX } from 'react'
import PagePickDialog from './PagePickDialog'
import { SHEET_SIZES, sizeLabel, type FitMode, type Orientation, type PageSizeInfo } from '../pdf/pagesize'

interface Props {
  totalPages: number
  currentPage: number
  selectedPages: number[]
  /** Displayed size of every page, in points, indexed from page 1. */
  sizes: PageSizeInfo[]
  onConfirm: (pages: number[], opts: { sizeId: string; orientation: Orientation; fit: FitMode }) => void
  onCancel: () => void
}

/** "3 pages at 8.50 × 11.00 in · 1 page at 8.47 × 10.98 in" */
function describeSizes(sizes: PageSizeInfo[]): { label: string; count: number }[] {
  const groups = new Map<string, number>()
  for (const s of sizes) {
    const key = sizeLabel(s.w, s.h)
    groups.set(key, (groups.get(key) ?? 0) + 1)
  }
  return [...groups.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({ label, count }))
}

/**
 * Put pages on a standard sheet.
 *
 * The case this exists for: a scanner that produces "Letter" pages a hair off
 * 8.5 × 11, or a document assembled from several sources. Choosing *Keep the
 * content at its printed size* trims or pads the edges without touching the
 * scale — which is what you want when the content is already right and only
 * the sheet is wrong.
 */
export default function PageSizeDialog({
  totalPages,
  currentPage,
  selectedPages,
  sizes,
  onConfirm,
  onCancel
}: Props): JSX.Element {
  const [sizeId, setSizeId] = useState('letter')
  const [orientation, setOrientation] = useState<Orientation>('auto')
  const [fit, setFit] = useState<FitMode>('keep')

  const groups = useMemo(() => describeSizes(sizes), [sizes])

  return (
    <PagePickDialog
      title="Page size"
      intro="Put pages on a standard sheet. Pages that are already the chosen size are left alone."
      confirmLabel="Change size"
      defaultMode="all"
      totalPages={totalPages}
      currentPage={currentPage}
      selectedPages={selectedPages}
      onCancel={onCancel}
      onConfirm={(pages) => onConfirm(pages, { sizeId, orientation, fit })}
      extra={
        <div className="ps-extra">
          <div className="ps-current">
            {groups.length === 1 ? 'Every page is ' : 'This document has '}
            {groups.map((g, i) => (
              <span key={g.label}>
                {i > 0 && ' · '}
                <b>{g.label}</b>
                {groups.length > 1 && ` (${g.count} page${g.count === 1 ? '' : 's'})`}
              </span>
            ))}
            {groups.length === 1 && '.'}
          </div>

          <label className="ps-row">
            <span>Sheet</span>
            <select value={sizeId} onChange={(e) => setSizeId(e.target.value)}>
              {SHEET_SIZES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>

          <label className="ps-row">
            <span>Orientation</span>
            <select value={orientation} onChange={(e) => setOrientation(e.target.value as Orientation)}>
              <option value="auto">Keep each page&rsquo;s own</option>
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape</option>
            </select>
          </label>

          <div className="ps-fit">
            <label className={`ex-opt ${fit === 'keep' ? 'sel' : ''}`}>
              <input type="radio" name="ps-fit" checked={fit === 'keep'} onChange={() => setFit('keep')} />
              <span className="ex-opt-label">Keep the content at its printed size</span>
              <span className="ex-opt-hint">
                Centred on the new sheet; anything past the edge is trimmed, and a smaller page gains white margins.
              </span>
            </label>
            <label className={`ex-opt ${fit === 'scale' ? 'sel' : ''}`}>
              <input type="radio" name="ps-fit" checked={fit === 'scale'} onChange={() => setFit('scale')} />
              <span className="ex-opt-label">Scale the content to fit</span>
              <span className="ex-opt-hint">
                Grown or shrunk proportionally to fill the sheet. Text and images stay sharp — nothing is rasterised.
              </span>
            </label>
          </div>
        </div>
      }
    />
  )
}
