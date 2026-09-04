import { useEffect, useRef, useState } from 'react'
import type { DrawStyle, ToolId } from '../pdf/types'

export interface SigInfo {
  id: string
  dataUrl: string
}

export interface LayerInfo {
  id: string
  name: string
  visible: boolean
}

interface Props {
  tool: ToolId
  onPickTool: (t: ToolId) => void
  zoom: number
  setZoom: (z: number) => void
  onFitWidth: () => void
  onFitPage: () => void
  color: string
  setColor: (c: string) => void
  colors: string[]
  fontSize: number
  setFontSize: (n: number) => void
  /** Draw tab pen settings — also applied to a selected drawing. */
  drawStyle: DrawStyle
  setDrawStyle: (patch: Partial<DrawStyle>) => void
  hasDoc: boolean
  calibrated: boolean
  /** Marks a save would leave editable; > 0 puts the "needs flattening" dot on. */
  flattenCount: number
  onFlatten: () => void
  onScaleRatio: () => void
  currentPage: number
  totalPages: number
  onGoToPage: (n: number) => void
  /** Routed through App's single menu-action handler (same one the native menu uses). */
  onMenuAction: (action: string) => void
  recents: { path: string; name: string }[]
  onOpenRecent: (path: string) => void
  onUnlock: () => void
  onExtract: () => void
  /** Rotates the page currently in the viewer, not the sidebar selection. */
  onRotateCurrent: (dir: 1 | -1) => void
  onRotatePages: () => void
  onDeletePages: () => void
  onFind: () => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  hasFields: boolean
  keepForms: boolean
  onSetKeepForms: (v: boolean) => void
  sigs: SigInfo[]
  activeSigId: string | null
  onPickSig: (id: string) => void
  onAddSig: () => void
  onRemoveSig: (id: string) => void
  onInsertFromPdf: () => void
  onInsertImages: () => void
  onInsertBlank: () => void
  onDuplicateCurrent: () => void
  onHeaderFooter: () => void
  layers: LayerInfo[] | null
  onToggleLayer: (id: string, visible: boolean) => void
  busy: boolean
}

function PageNav({
  currentPage,
  totalPages,
  onGoToPage
}: {
  currentPage: number
  totalPages: number
  onGoToPage: (n: number) => void
}): JSX.Element {
  const [text, setText] = useState(String(currentPage))
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setText(String(currentPage))
  }, [currentPage, editing])

  const commit = (): void => {
    const n = parseInt(text, 10)
    if (isFinite(n)) onGoToPage(n)
    setEditing(false)
  }

  return (
    <div className="pagenav">
      <button className="pg-btn" title="Previous page" onClick={() => onGoToPage(currentPage - 1)} disabled={currentPage <= 1}>
        ‹
      </button>
      <input
        className="pg-input"
        value={text}
        onFocus={(e) => {
          setEditing(true)
          e.currentTarget.select()
        }}
        onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
      <span className="pg-total">/ {totalPages}</span>
      <button className="pg-btn" title="Next page" onClick={() => onGoToPage(currentPage + 1)} disabled={currentPage >= totalPages}>
        ›
      </button>
    </div>
  )
}

/** Numeric box: replaces on first keystroke, applies only valid values. */
function SizeInput({
  value,
  onChange,
  min = 6,
  max = 72,
  step
}: {
  value: number
  onChange: (n: number) => void
  min?: number
  max?: number
  step?: number
}): JSX.Element {
  const [text, setText] = useState(String(value))
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setText(String(value))
  }, [value, editing])
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={text}
      onFocus={(e) => {
        setEditing(true)
        e.currentTarget.select()
      }}
      onChange={(e) => {
        setText(e.target.value)
        const n = Number(e.target.value)
        if (isFinite(n) && n >= min && n <= max) onChange(n)
      }}
      onBlur={() => {
        setEditing(false)
        const n = Number(text)
        if (!isFinite(n) || n < min || n > max) setText(String(value))
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
}

/** Small anchored dropdown that closes on any outside pointer-down. */
function DropMenu({
  button,
  title,
  disabled,
  className,
  children,
  keepSelection
}: {
  button: React.ReactNode
  title?: string
  disabled?: boolean
  className?: string
  children: (close: () => void) => React.ReactNode
  keepSelection?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open])
  return (
    <div className="dropmenu" ref={rootRef}>
      <button
        className={`tb-file dm-btn ${className || ''}`}
        title={title}
        disabled={disabled}
        onPointerDown={(e) => {
          if (keepSelection) e.preventDefault()
        }}
        onClick={() => setOpen((o) => !o)}
      >
        {button}
      </button>
      {open && <div className="dm-panel">{children(() => setOpen(false))}</div>}
    </div>
  )
}

interface ToolBtn {
  id: ToolId
  label: string
  icon: string
  title: string
  keepSelection?: boolean
}

const HOME_TOOLS: ToolBtn[] = [
  { id: 'select', label: 'Select', icon: '⭓', title: 'Select / move / resize' },
  { id: 'text', label: 'Text', icon: 'T', title: 'Add a text box (works on scanned forms too)' },
  { id: 'check', label: 'Check', icon: '✓', title: 'Drop a checkmark' },
  { id: 'cross', label: 'X', icon: '✗', title: 'Drop an X' },
  { id: 'circle', label: 'Circle', icon: '◯', title: 'Circle something — drag for an oval, or click for a default one' },
  { id: 'signature', label: 'Sign', icon: '✍', title: 'Place your saved signature' },
  { id: 'highlight', label: 'Highlight', icon: '▓', title: 'Highlight text — select text, or pick this tool and drag over text', keepSelection: true },
  { id: 'underline', label: 'Underline', icon: 'U̲', title: 'Underline text', keepSelection: true },
  { id: 'strikeout', label: 'Strike', icon: 'S̶', title: 'Strike through text', keepSelection: true },
  { id: 'whiteout', label: 'Whiteout', icon: '▭', title: 'Permanently remove the content under a box (page becomes an image on save)' }
]

const DRAW_TOOLS: ToolBtn[] = [
  { id: 'draw-line', label: 'Line', icon: '╱', title: 'Draw a straight line — hold Shift to snap to 15° steps' },
  { id: 'draw-arrow', label: 'Arrow', icon: '↗', title: 'Draw an arrow — hold Shift to snap to 15° steps' },
  { id: 'draw-rect', label: 'Rectangle', icon: '▭', title: 'Drag out a rectangle — hold Shift for a square' },
  { id: 'draw-ellipse', label: 'Ellipse', icon: '◯', title: 'Drag out an ellipse — hold Shift for a circle' },
  { id: 'draw-polyline', label: 'Polyline', icon: '∨', title: 'Click each corner; double-click (or Enter) to finish' },
  { id: 'draw-polygon', label: 'Polygon', icon: '◇', title: 'Click each corner; double-click (or Enter) to close the shape' },
  { id: 'draw-free', label: 'Freehand', icon: '✎', title: 'Draw freehand — hold the button down and sketch' }
]

const MEASURE_TOOLS: ToolBtn[] = [
  { id: 'calibrate', label: 'Calibrate', icon: '⟺', title: 'Set the drawing scale' },
  { id: 'measure-length', label: 'Length', icon: '╱', title: 'Measure a distance / polyline' },
  { id: 'measure-area', label: 'Area', icon: '◇', title: 'Measure an area' },
  { id: 'measure-arc', label: 'Arc', icon: '◜', title: 'Measure an arc (3 points)' }
]

const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]
type RibbonTab = 'home' | 'draw' | 'measure' | 'pages' | 'advanced'
const RIBBON_TABS: { id: RibbonTab; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'draw', label: 'Draw' },
  { id: 'measure', label: 'Measure' },
  { id: 'pages', label: 'Pages' },
  { id: 'advanced', label: 'Advanced' }
]

/** Fill opacity presets offered in the Draw tab's Fill menu. */
const FILL_ALPHAS = [0.25, 0.5, 1]

export default function Toolbar(props: Props): JSX.Element {
  const { tool, onPickTool, zoom, setZoom } = props
  const [tab, setTab] = useState<RibbonTab>(() => (localStorage.getItem('pdfstudio.ribbon') as RibbonTab) || 'home')
  useEffect(() => {
    localStorage.setItem('pdfstudio.ribbon', tab)
  }, [tab])

  // Collapsed ribbon: the tool row is hidden so the page gets the height. A
  // collapsed ribbon still "peeks" open when you click a tab, and closes again
  // as soon as you pick a tool (Office / Nitro behaviour).
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('pdfstudio.ribbonCollapsed') === '1')
  const [peek, setPeek] = useState(false)
  useEffect(() => {
    localStorage.setItem('pdfstudio.ribbonCollapsed', collapsed ? '1' : '0')
    if (!collapsed) setPeek(false)
  }, [collapsed])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'F1' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        setCollapsed((c) => !c)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!peek) return
    const onDown = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setPeek(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPeek(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [peek])

  const pickTab = (id: RibbonTab): void => {
    setTab(id)
    if (collapsed) setPeek(true)
  }

  // Office-style: the mouse wheel over the ribbon steps through the tabs
  const lastWheelRef = useRef(0)
  const onRibbonWheel = (e: React.WheelEvent): void => {
    const t = e.target as HTMLElement
    // leave dropdown panels, selects and inputs alone
    if (t.closest('.dm-panel, select, input, textarea')) return
    const now = Date.now()
    if (now - lastWheelRef.current < 120) return
    lastWheelRef.current = now
    const idx = RIBBON_TABS.findIndex((r) => r.id === tab)
    const next = Math.min(RIBBON_TABS.length - 1, Math.max(0, idx + (e.deltaY > 0 ? 1 : -1)))
    if (next !== idx) pickTab(RIBBON_TABS[next].id)
  }

  // While peeking, running a command closes the ribbon again — but not the
  // clicks that open a dropdown or adjust a setting (colour, size).
  const onRow2Click = (e: React.MouseEvent): void => {
    if (!peek) return
    const t = e.target as HTMLElement
    if (t.closest('.dm-panel, .dm-btn, .swatches, .fs')) return
    if (t.closest('.tb-tool, .tb-file')) setPeek(false)
  }

  const zoomPct = Math.round(zoom * 100)
  const matched = ZOOM_PRESETS.find((z) => Math.abs(z - zoom) < 0.005)

  const swatches = (
    <div className="swatches">
      {props.colors.map((c) => (
        <button
          key={c}
          className={`swatch ${props.color === c ? 'sel' : ''}`}
          style={{ background: c }}
          onPointerDown={(e) => e.preventDefault() /* keep focus in an open text editor */}
          onClick={() => props.setColor(c)}
          title={`${c} — applies to new and selected items`}
        />
      ))}
    </div>
  )

  const toolButtons = (tools: ToolBtn[]): JSX.Element[] =>
    tools.map((t) => (
      <button
        key={t.id}
        className={`tb-tool ${tool === t.id ? 'active' : ''} ${t.id === 'calibrate' && props.calibrated ? 'done' : ''}`}
        onPointerDown={(e) => {
          if (t.keepSelection) e.preventDefault()
        }}
        onClick={() => onPickTool(t.id)}
        disabled={!props.hasDoc}
        title={t.title}
      >
        <span className="ico">{t.icon}</span>
        <span className="lbl">{t.label}</span>
      </button>
    ))

  const menu = props.onMenuAction
  const cmd = (c: string): void => window.api.appCommand(c)

  return (
    <div className="toolbar ribbon" ref={rootRef} onWheel={onRibbonWheel}>
      {/* row 1 — app menus + ribbon tabs share one line (the native menu bar is
          hidden; Alt still shows it). Open / Save / Print live in File. */}
      <div className="tb-row">
        <div className="rb-tabs">
          <DropMenu button="File" className="app-menu" title="File">
            {(close) => (
              <>
                <button className="dm-item" onClick={() => { close(); menu('open') }}>
                  Open… <span className="dm-kbd">Ctrl+O</span>
                </button>
                <button
                  className="dm-item"
                  title="Join several PDFs and pictures into one new document"
                  onClick={() => { close(); menu('combine') }}
                >
                  Combine files…
                </button>
                {props.recents.length > 0 && (
                  <>
                    <div className="dm-sep" />
                    <div className="dm-note">Recent files</div>
                    {props.recents.slice(0, 8).map((r) => (
                      <button key={r.path} className="dm-item" title={r.path} onClick={() => { close(); props.onOpenRecent(r.path) }}>
                        {r.name}
                      </button>
                    ))}
                  </>
                )}
                <div className="dm-sep" />
                <button className="dm-item" disabled={!props.hasDoc} onClick={() => { close(); menu('save') }}>
                  Save <span className="dm-kbd">Ctrl+S</span>
                </button>
                <button className="dm-item" disabled={!props.hasDoc} onClick={() => { close(); menu('save-as') }}>
                  Save As… <span className="dm-kbd">Ctrl+Shift+S</span>
                </button>
                <button className="dm-item" disabled={!props.hasDoc} onClick={() => { close(); menu('print') }}>
                  Print… <span className="dm-kbd">Ctrl+P</span>
                </button>
                <div className="dm-sep" />
                <button className="dm-item" disabled={!props.hasDoc} onClick={() => { close(); menu('unlock') }}>
                  Remove restrictions (unlock)
                </button>
                <button
                  className="dm-item"
                  disabled={!props.hasDoc}
                  title="Rewrite bloated CAD drawing data into a smaller, faster file — heavy sheets already speed up on their own for viewing; use this to hand the faster file to someone else"
                  onClick={() => { close(); menu('optimize') }}
                >
                  Build a faster copy…
                </button>
                <button className="dm-item" onClick={() => { close(); cmd('default-apps') }}>
                  Set PDF Studio as default PDF app…
                </button>
                <div className="dm-sep" />
                <button className="dm-item" onClick={() => { close(); cmd('quit') }}>
                  Exit
                </button>
              </>
            )}
          </DropMenu>
          <DropMenu button="View" className="app-menu" title="View">
            {(close) => (
              <>
                <button className="dm-item" onClick={() => { close(); setCollapsed((c) => !c) }}>
                  {collapsed ? 'Show the ribbon' : 'Collapse the ribbon'} <span className="dm-kbd">Ctrl+F1</span>
                </button>
                <div className="dm-sep" />
                <button className="dm-item" onClick={() => { close(); cmd('fullscreen') }}>
                  Full screen
                </button>
                <button className="dm-item" onClick={() => { close(); cmd('reload') }}>
                  Reload
                </button>
                <button className="dm-item" onClick={() => { close(); cmd('devtools') }}>
                  Developer tools
                </button>
              </>
            )}
          </DropMenu>
          <DropMenu button="Help" className="app-menu" title="Help">
            {(close) => (
              <button className="dm-item" onClick={() => { close(); cmd('about') }}>
                About PDF Studio
              </button>
            )}
          </DropMenu>

          <div className="rb-tabs-sep" />

          {RIBBON_TABS.map((t) => (
            <button
              key={t.id}
              className={`rb-tab ${tab === t.id && (!collapsed || peek) ? 'active' : ''}`}
              onClick={() => pickTab(t.id)}
              onDoubleClick={() => setCollapsed((c) => !c)}
              title={`${t.label} — double-click to ${collapsed ? 'pin the ribbon open' : 'collapse the ribbon'}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="tb-group file">
          <button className="tb-file" onClick={props.onFind} disabled={!props.hasDoc} title="Find text (Ctrl+F)">
            🔍
          </button>
          <button className="tb-file" onClick={props.onUndo} disabled={!props.canUndo || props.busy} title="Undo (Ctrl+Z)">
            ↩
          </button>
          <button className="tb-file" onClick={props.onRedo} disabled={!props.canRedo || props.busy} title="Redo (Ctrl+Y)">
            ↪
          </button>
        </div>

        <div className="tb-spacer" />

        {props.hasDoc && <PageNav currentPage={props.currentPage} totalPages={props.totalPages} onGoToPage={props.onGoToPage} />}

        <div className="tb-group zoom">
          <button onClick={() => setZoom(zoom / 1.15)} disabled={!props.hasDoc} title="Zoom out (Ctrl+-)">
            −
          </button>
          <select
            className="zoom-select"
            disabled={!props.hasDoc}
            value={matched ? String(matched) : 'custom'}
            onChange={(e) => {
              const v = e.target.value
              if (v === 'fitw') props.onFitWidth()
              else if (v === 'fitp') props.onFitPage()
              else if (v !== 'custom') setZoom(Number(v))
            }}
            title="Zoom"
          >
            {!matched && <option value="custom">{zoomPct}%</option>}
            <option value="fitw">Fit width</option>
            <option value="fitp">Fit page</option>
            {ZOOM_PRESETS.map((z) => (
              <option key={z} value={String(z)}>
                {Math.round(z * 100)}%
              </option>
            ))}
          </select>
          <button onClick={() => setZoom(zoom * 1.15)} disabled={!props.hasDoc} title="Zoom in (Ctrl+=)">
            +
          </button>
        </div>

        <button
          className="rb-collapse"
          onClick={() => setCollapsed((c) => !c)}
          title={
            collapsed
              ? 'Show the ribbon (Ctrl+F1) — or double-click a tab'
              : 'Collapse the ribbon for a taller page (Ctrl+F1) — or double-click a tab'
          }
        >
          {collapsed ? '⌄' : '⌃'}
        </button>
      </div>

      {/* row 2 — the active ribbon tab's tools; floats over the page when the
          ribbon is collapsed and you peek at a tab */}
      {(!collapsed || peek) && (
      <div className={`tb-row tb-row2 ${peek ? 'peek' : ''}`} onClick={onRow2Click}>
        {tab === 'home' && (
          <>
            <div className="tb-group tools">
              {toolButtons(HOME_TOOLS)}
              <DropMenu button="✍▾" title="Signatures" disabled={!props.hasDoc} keepSelection>
                {(close) => (
                  <>
                    {props.sigs.map((s) => (
                      <div key={s.id} className={`dm-sig ${props.activeSigId === s.id ? 'active' : ''}`}>
                        <button
                          className="dm-sig-pick"
                          title="Use this signature"
                          onClick={() => {
                            close()
                            props.onPickSig(s.id)
                          }}
                        >
                          <img src={s.dataUrl} alt="signature" />
                        </button>
                        <button className="dm-sig-del" title="Delete this saved signature" onClick={() => props.onRemoveSig(s.id)}>
                          ×
                        </button>
                      </div>
                    ))}
                    {props.sigs.length === 0 && <div className="dm-note">No saved signatures yet.</div>}
                    <div className="dm-sep" />
                    <button
                      className="dm-item"
                      onClick={() => {
                        close()
                        props.onAddSig()
                      }}
                    >
                      ＋ Add signature image…
                    </button>
                  </>
                )}
              </DropMenu>
            </div>
            <div className="tb-sep" />
            <button
              className={`tb-tool ${props.flattenCount > 0 ? 'pending' : ''}`}
              onClick={props.onFlatten}
              disabled={!props.hasDoc || props.busy}
              title={
                props.flattenCount > 0
                  ? `Flatten ${props.flattenCount} editable mark${props.flattenCount === 1 ? '' : 's'} into the page — after this they can't be edited here or in any other PDF editor`
                  : 'Nothing to flatten — this document has no editable marks'
              }
            >
              <span className="ico">
                ⧉
                {props.flattenCount > 0 && <span className="dot" />}
              </span>
              <span className="lbl">Flatten</span>
            </button>
            <div className="tb-sep" />
            <div className="tb-group props">
              {swatches}
              <label className="fs" title="Text size — applies to new and selected text boxes">
                Size
                <SizeInput value={props.fontSize} onChange={props.setFontSize} />
              </label>
            </div>
            {props.hasFields && (
              <>
                <div className="tb-sep" />
                <DropMenu button="Forms ▾" title="How this document’s form fields are written when you save">
                  {(close) => (
                    <>
                      <button
                        className="dm-item"
                        onClick={() => {
                          close()
                          props.onSetKeepForms(true)
                        }}
                      >
                        {props.keepForms ? '● ' : '○ '} Keep form fields fillable
                      </button>
                      <button
                        className="dm-item"
                        onClick={() => {
                          close()
                          props.onSetKeepForms(false)
                        }}
                      >
                        {!props.keepForms ? '● ' : '○ '} Flatten form fields
                      </button>
                      <div className="dm-sep" />
                      <div className="dm-note">Applies when you save this document.</div>
                    </>
                  )}
                </DropMenu>
              </>
            )}
          </>
        )}

        {tab === 'draw' && (
          <>
            <div className="tb-group tools">{toolButtons(DRAW_TOOLS)}</div>
            <div className="tb-sep" />
            <div className="tb-group props" title="Line colour — or select a drawing first to recolour it">
              {swatches}
              <label className="fs" title="Line thickness in points">
                Width
                <SizeInput
                  value={props.drawStyle.width}
                  onChange={(n) => props.setDrawStyle({ width: n })}
                  min={0.5}
                  max={24}
                  step={0.5}
                />
              </label>
            </div>
            <div className="tb-sep" />
            <DropMenu
              button={
                <span className="fill-btn">
                  Fill
                  <span
                    className="fill-chip"
                    style={
                      props.drawStyle.fill
                        ? { background: props.drawStyle.fill, opacity: props.drawStyle.fillAlpha }
                        : undefined
                    }
                  >
                    {props.drawStyle.fill ? '' : '∅'}
                  </span>
                  ▾
                </span>
              }
              title="Fill for rectangles, ellipses and polygons"
              disabled={!props.hasDoc}
            >
              {(close) => (
                <>
                  <button
                    className="dm-item"
                    onClick={() => {
                      close()
                      props.setDrawStyle({ fill: null })
                    }}
                  >
                    {props.drawStyle.fill ? '○ ' : '● '} No fill
                  </button>
                  <div className="dm-sep" />
                  <div className="dm-swatches">
                    {[...props.colors, '#ffffff', '#ffd400'].map((c) => (
                      <button
                        key={c}
                        className={`swatch ${props.drawStyle.fill === c ? 'sel' : ''}`}
                        style={{ background: c }}
                        title={c}
                        onClick={() => props.setDrawStyle({ fill: c })}
                      />
                    ))}
                  </div>
                  <div className="dm-sep" />
                  <div className="dm-note">Fill opacity</div>
                  <div className="dm-swatches">
                    {FILL_ALPHAS.map((a) => (
                      <button
                        key={a}
                        className={`alpha-opt ${Math.abs(props.drawStyle.fillAlpha - a) < 0.01 ? 'sel' : ''}`}
                        onClick={() => props.setDrawStyle({ fillAlpha: a })}
                      >
                        {Math.round(a * 100)}%
                      </button>
                    ))}
                  </div>
                  <div className="dm-sep" />
                  <div className="dm-note">Applies to rectangles, ellipses and polygons.</div>
                </>
              )}
            </DropMenu>
            <label className="fs chk" title="Draw the outline as a dashed line">
              <input
                type="checkbox"
                checked={props.drawStyle.dash}
                onChange={(e) => props.setDrawStyle({ dash: e.target.checked })}
              />
              Dashed
            </label>
            <label className="fs" title="Which end of an arrow gets a head">
              Heads
              <select
                className="draw-select"
                value={`${props.drawStyle.arrowStart ? 's' : ''}${props.drawStyle.arrowEnd ? 'e' : ''}` || 'e'}
                onChange={(e) => {
                  const v = e.target.value
                  props.setDrawStyle({ arrowStart: v.includes('s'), arrowEnd: v.includes('e') })
                }}
              >
                <option value="e">End</option>
                <option value="s">Start</option>
                <option value="se">Both</option>
              </select>
            </label>
            <div className="tb-sep" />
            <span className="rb-hint">
              Plain drawing — no scale, no measurements. Drawings stay editable (drag to move, pull a handle to reshape)
              until you Flatten.
            </span>
          </>
        )}

        {tab === 'measure' && (
          <>
            <div className="tb-group tools">{toolButtons(MEASURE_TOOLS)}</div>
            <button
              className="tb-file"
              onClick={props.onScaleRatio}
              disabled={!props.hasDoc}
              title="Type the drawing's scale ratio (e.g. 1:2000) instead of drawing a reference line"
            >
              ⚖ Scale ratio…
            </button>
            <div className="tb-sep" />
            <div className="tb-group props" title="Colour for new measurements — or click a measurement first to recolour it">
              {swatches}
            </div>
            <div className="tb-sep" />
            <span className="rb-hint">
              {props.calibrated
                ? 'This page has a scale — draw lengths, areas and arcs. Labels bake into the PDF on save.'
                : 'Scale is per page: Calibrate (draw a known length) or enter a Scale ratio — either can apply to all pages.'}
            </span>
          </>
        )}

        {tab === 'pages' && (
          <div className="tb-group">
            <button
              className="tb-file"
              onClick={() => props.onRotateCurrent(-1)}
              disabled={!props.hasDoc || props.busy}
              title={`Rotate page ${props.currentPage} (the one in view) 90° left`}
            >
              ↺ Rotate left
            </button>
            <button
              className="tb-file"
              onClick={() => props.onRotateCurrent(1)}
              disabled={!props.hasDoc || props.busy}
              title={`Rotate page ${props.currentPage} (the one in view) 90° right`}
            >
              ↻ Rotate right
            </button>
            <button
              className="tb-file"
              onClick={props.onRotatePages}
              disabled={!props.hasDoc || props.busy}
              title="Rotate a page range, the sidebar selection or the whole document"
            >
              Rotate pages…
            </button>
            <div className="tb-sep" />
            <button
              className="tb-file"
              onClick={props.onDeletePages}
              disabled={!props.hasDoc || props.busy}
              title="Delete the current page or a page range (asks first)"
            >
              🗑 Delete pages…
            </button>
            <div className="tb-sep" />
            <button className="tb-file" onClick={props.onInsertFromPdf} disabled={!props.hasDoc || props.busy} title="Merge other PDFs' pages in after the current page — pick several at once">
              📄+ Insert from PDF…
            </button>
            <button className="tb-file" onClick={props.onInsertImages} disabled={!props.hasDoc || props.busy} title="Add PNG / JPEG pictures as full pages after the current page (or just drop them onto the window)">
              🖼 Insert pictures…
            </button>
            <button className="tb-file" onClick={props.onInsertBlank} disabled={!props.hasDoc || props.busy}>
              Insert blank page
            </button>
            <button className="tb-file" onClick={props.onDuplicateCurrent} disabled={!props.hasDoc || props.busy}>
              Duplicate page
            </button>
            <button className="tb-file" onClick={props.onHeaderFooter} disabled={!props.hasDoc || props.busy} title="Page numbers, dates, file name or any text — top or bottom, left / centre / right">
              #️⃣ Header &amp; footer…
            </button>
            <button
              className="tb-file"
              onClick={props.onExtract}
              disabled={!props.hasDoc || props.busy}
              title="Save the current page, a page range or the sidebar selection as a new PDF"
            >
              ⎘ Extract pages…
            </button>
            <span className="rb-hint">
              Rotate left/right and Duplicate act on page {props.currentPage} — the one in view. The “…” buttons let you
              pick a range instead.
            </span>
          </div>
        )}

        {tab === 'advanced' && (
          <div className="tb-group">
            <button
              className={`tb-tool warn ${tool === 'edit-text' ? 'active' : ''}`}
              onClick={() => onPickTool(tool === 'edit-text' ? 'select' : 'edit-text')}
              disabled={!props.hasDoc}
              title="Click any existing line of text to replace it with an editable copy (the original is covered). Works on scanned pages once OCR finishes."
            >
              <span className="ico">✎</span>
              <span className="lbl">Edit original text</span>
            </button>
            <DropMenu
              button={`Layers${props.layers ? ` (${props.layers.length}) ▾` : ' ▾'}`}
              title={props.layers ? 'Show / hide the document’s layers' : 'This document has no layers'}
              disabled={!props.hasDoc || !props.layers?.length}
            >
              {() => (
                <>
                  {(props.layers || []).map((l) => (
                    <label key={l.id} className="dm-item dm-check">
                      <input type="checkbox" checked={l.visible} onChange={(e) => props.onToggleLayer(l.id, e.target.checked)} />
                      <span>{l.name}</span>
                    </label>
                  ))}
                  <div className="dm-sep" />
                  <div className="dm-note">Hidden layers stay hidden in the saved file.</div>
                </>
              )}
            </DropMenu>
            <button className="tb-file" onClick={props.onUnlock} disabled={!props.hasDoc || props.busy} title="Remove owner-password restrictions (print/copy/edit locks)">
              🔓 Remove restrictions
            </button>
            <span className="rb-hint warn">⚠ These tools change the original document content — everything supports Undo.</span>
          </div>
        )}
      </div>
      )}
    </div>
  )
}
