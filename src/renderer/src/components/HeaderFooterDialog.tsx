import { useState } from 'react'
import type { FontKey } from '../pdf/types'

export type SlotKey = 'tl' | 'tc' | 'tr' | 'bl' | 'bc' | 'br'
export type DateFormat = 'long' | 'medium' | 'iso'

export interface HeaderFooterConfig {
  /** Text for each of the six positions; empty = nothing there. */
  slots: Record<SlotKey, string>
  font: FontKey
  size: number
  color: string
  margin: number
  from: number
  to: number
  startAt: number
  dateFormat: DateFormat
}

export const SLOT_POS: Record<SlotKey, { vpos: 'top' | 'bottom'; hpos: 'left' | 'center' | 'right' }> = {
  tl: { vpos: 'top', hpos: 'left' },
  tc: { vpos: 'top', hpos: 'center' },
  tr: { vpos: 'top', hpos: 'right' },
  bl: { vpos: 'bottom', hpos: 'left' },
  bc: { vpos: 'bottom', hpos: 'center' },
  br: { vpos: 'bottom', hpos: 'right' }
}

export function formatDate(fmt: DateFormat, d = new Date()): string {
  if (fmt === 'iso') {
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
  return d.toLocaleDateString('en-CA', { year: 'numeric', month: fmt === 'long' ? 'long' : 'short', day: 'numeric' })
}

/** Fill {n} {N} {date} {file} into a slot template. */
export function expandTemplate(tpl: string, v: { n: number; N: number; date: string; file: string }): string {
  return tpl
    .split('{n}').join(String(v.n))
    .split('{N}').join(String(v.N))
    .split('{date}').join(v.date)
    .split('{file}').join(v.file)
}

interface Props {
  totalPages: number
  fileName: string
  colors: string[]
  onApply: (cfg: HeaderFooterConfig) => void
  onCancel: () => void
}

const FONT_OPTIONS: { base: 'helv' | 'times' | 'cour'; label: string }[] = [
  { base: 'helv', label: 'Helvetica / Arial' },
  { base: 'times', label: 'Times Roman' },
  { base: 'cour', label: 'Courier' }
]

const EMPTY_SLOTS: Record<SlotKey, string> = { tl: '', tc: '', tr: '', bl: '', bc: 'Page {n} of {N}', br: '' }

/**
 * Header & footer — Nitro-style: six text positions (three across the top,
 * three across the bottom) sharing one font / size / colour, with tokens for
 * the page number, page count, today's date and the file name. The default is
 * plain "Page {n} of {N}" bottom-centre, so it is still the page-numbers
 * dialog it used to be.
 */
export default function HeaderFooterDialog({ totalPages, fileName, colors, onApply, onCancel }: Props): JSX.Element {
  const [slots, setSlots] = useState<Record<SlotKey, string>>(EMPTY_SLOTS)
  const [fontBase, setFontBase] = useState<'helv' | 'times' | 'cour'>('helv')
  const [bold, setBold] = useState(false)
  const [size, setSize] = useState('10')
  const [color, setColor] = useState('#111111')
  const [margin, setMargin] = useState('24')
  const [from, setFrom] = useState('1')
  const [to, setTo] = useState(String(totalPages))
  const [startAt, setStartAt] = useState('1')
  const [dateFormat, setDateFormat] = useState<DateFormat>('long')
  const [focused, setFocused] = useState<SlotKey>('bc')

  const setSlot = (k: SlotKey, v: string): void => setSlots((s) => ({ ...s, [k]: v }))
  const insertToken = (tok: string): void => {
    setSlots((s) => ({ ...s, [focused]: (s[focused] + (s[focused] && !s[focused].endsWith(' ') ? ' ' : '') + tok).trimStart() }))
  }

  const anyText = Object.values(slots).some((v) => v.trim())
  const submit = (): void => {
    if (!anyText) return
    const f = Math.max(1, Math.min(totalPages, parseInt(from, 10) || 1))
    const t = Math.max(f, Math.min(totalPages, parseInt(to, 10) || totalPages))
    onApply({
      slots: Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, v.trim()])) as Record<SlotKey, string>,
      font: (bold ? fontBase + 'B' : fontBase) as FontKey,
      size: Math.max(5, Math.min(72, parseFloat(size) || 10)),
      color,
      margin: Math.max(4, Math.min(200, parseFloat(margin) || 24)),
      from: f,
      to: t,
      startAt: Math.max(0, parseInt(startAt, 10) || 1),
      dateFormat
    })
  }

  const stem = fileName.replace(/\.pdf$/i, '')
  const preview = (k: SlotKey): string =>
    expandTemplate(slots[k], { n: parseInt(startAt, 10) || 1, N: (parseInt(startAt, 10) || 1) + totalPages - 1, date: formatDate(dateFormat), file: stem })

  const slotInput = (k: SlotKey, placeholder: string): JSX.Element => (
    <input
      key={k}
      className={`hf-slot ${slots[k] ? 'filled' : ''}`}
      value={slots[k]}
      placeholder={placeholder}
      title={slots[k] ? `Shows as: ${preview(k)}` : placeholder}
      onFocus={() => setFocused(k)}
      onChange={(e) => setSlot(k, e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && submit()}
    />
  )

  return (
    <div className="modal-back" onClick={onCancel}>
      <div className="modal pn-modal hf-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Header &amp; footer</h2>
        <p>
          Type into any of the six positions. Everything is added as regular text boxes — move, restyle or delete them
          afterwards, or Ctrl+Z to remove them all at once.
        </p>

        <div className="hf-page">
          <div className="hf-band">
            {slotInput('tl', 'Top left')}
            {slotInput('tc', 'Top centre')}
            {slotInput('tr', 'Top right')}
          </div>
          <div className="hf-body">page</div>
          <div className="hf-band">
            {slotInput('bl', 'Bottom left')}
            {slotInput('bc', 'Bottom centre')}
            {slotInput('br', 'Bottom right')}
          </div>
        </div>

        <div className="hf-tokens">
          <span>Insert:</span>
          <button type="button" onClick={() => insertToken('{n}')} title="Page number">
            {'{n}'} page
          </button>
          <button type="button" onClick={() => insertToken('{N}')} title="Last page number">
            {'{N}'} of
          </button>
          <button type="button" onClick={() => insertToken('{date}')} title={`Today: ${formatDate(dateFormat)}`}>
            {'{date}'}
          </button>
          <button type="button" onClick={() => insertToken('{file}')} title={`File name: ${stem}`}>
            {'{file}'}
          </button>
          <select value={dateFormat} onChange={(e) => setDateFormat(e.target.value as DateFormat)} title="Date style">
            <option value="long">{formatDate('long')}</option>
            <option value="medium">{formatDate('medium')}</option>
            <option value="iso">{formatDate('iso')}</option>
          </select>
        </div>

        <div className="pn-grid">
          <label className="pn-label">
            Font
            <select value={fontBase} onChange={(e) => setFontBase(e.target.value as 'helv' | 'times' | 'cour')}>
              {FONT_OPTIONS.map((f) => (
                <option key={f.base} value={f.base}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label className="pn-label">
            Size (pt)
            <input type="number" min={5} max={72} value={size} onChange={(e) => setSize(e.target.value)} />
          </label>
          <label className="pn-label pn-bold">
            <input type="checkbox" checked={bold} onChange={(e) => setBold(e.target.checked)} /> Bold
          </label>
          <label className="pn-label">
            Margin (pt)
            <input type="number" min={4} max={200} value={margin} onChange={(e) => setMargin(e.target.value)} />
          </label>
          <label className="pn-label">
            From page
            <input type="number" min={1} max={totalPages} value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="pn-label">
            To page
            <input type="number" min={1} max={totalPages} value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label className="pn-label">
            Start counting at
            <input type="number" min={0} value={startAt} onChange={(e) => setStartAt(e.target.value)} />
          </label>
        </div>

        <div className="pn-label" style={{ marginTop: 10 }}>
          Colour
          <div className="swatches" style={{ marginTop: 4 }}>
            {colors.map((c) => (
              <button
                key={c}
                className={`swatch ${color === c ? 'sel' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
                title={c}
              />
            ))}
          </div>
        </div>

        <div className="modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={submit} disabled={!anyText} title={anyText ? '' : 'Type something into at least one position'}>
            Add to pages
          </button>
        </div>
      </div>
    </div>
  )
}
