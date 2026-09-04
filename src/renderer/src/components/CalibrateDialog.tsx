import { useState } from 'react'
import type { Calibration } from '../pdf/types'

interface Props {
  /** Length of the drawn reference line in PDF points, or null when entering a plain 1:n ratio. */
  pxDistance: number | null
  /** e.g. "page 3" — the page the scale will apply to. */
  pageLabel: string
  onApply: (cal: Calibration, applyAll: boolean) => void
  onCancel: () => void
}

const UNITS = ['ft', 'm', 'yd', 'in', 'cm', 'mm', 'km', 'mi']

// Real-world units per real-world inch — turns a 1:n paper ratio into
// units-per-PDF-point (1 pt = 1/72" on paper).
const UNIT_PER_INCH: Record<string, number> = {
  ft: 1 / 12,
  m: 0.0254,
  yd: 1 / 36,
  in: 1,
  cm: 2.54,
  mm: 25.4,
  km: 0.0000254,
  mi: 1 / 63360
}

export default function CalibrateDialog({ pxDistance, pageLabel, onApply, onCancel }: Props): JSX.Element {
  const ratioMode = pxDistance == null
  const [value, setValue] = useState('')
  const [unit, setUnit] = useState(ratioMode ? 'm' : 'ft')
  const [applyAll, setApplyAll] = useState(false)

  const submit = (): void => {
    const n = parseFloat(value)
    if (!isFinite(n) || n <= 0) return
    if (ratioMode) {
      onApply({ unitsPerPoint: (n * UNIT_PER_INCH[unit]) / 72, unit, ratio: n }, applyAll)
    } else {
      onApply({ unitsPerPoint: n / pxDistance, unit }, applyAll)
    }
  }

  return (
    <div className="modal-back" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{ratioMode ? 'Set scale by ratio' : 'Set the scale'}</h2>
        {ratioMode ? (
          <p>
            Enter the drawing’s scale ratio (e.g. 1:2000 — one unit on paper is 2000 in the real world) and the unit
            measurements should be shown in. Applies to {pageLabel}.
          </p>
        ) : (
          <p>You drew a reference line on {pageLabel}. Enter its real-world length so measurements convert correctly.</p>
        )}
        <div className="row">
          {ratioMode && <span className="ratio-prefix">1 :</span>}
          <input
            type="number"
            autoFocus
            placeholder={ratioMode ? 'e.g. 2000' : 'e.g. 100'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          {ratioMode && <span className="ratio-prefix">in</span>}
          <select value={unit} onChange={(e) => setUnit(e.target.value)}>
            {UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </div>
        <label className="row check" style={{ marginTop: 10, gap: 6, alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={applyAll} onChange={(e) => setApplyAll(e.target.checked)} />
          <span>Apply to all pages (otherwise only {pageLabel})</span>
        </label>
        <div className="modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={submit}>
            Set scale
          </button>
        </div>
      </div>
    </div>
  )
}
