import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, PDFPageProxy } from '../pdf/pdfjs'
import type { PageLeaf } from '../pdf/types'

interface Props {
  pdfDoc: PDFDocumentProxy
  leaves: PageLeaf[]
  selected: string[]
  currentPage: number
  setSelected: (ids: string[]) => void
  onRotate: (leafIds: string[], dir: 1 | -1) => void
  onDelete: (leafIds: string[]) => void
  onDuplicate: (leafIds: string[]) => void
  onExtract: () => void
  onReorder: (fromId: string, toId: string) => void
  onJump: (leafId: string) => void
  onCollapse: () => void
  layerConfig?: unknown
  layerVersion: number
}

function Thumb({
  pdfDoc,
  leaf,
  n,
  layerConfig,
  layerVersion
}: {
  pdfDoc: PDFDocumentProxy
  leaf: PageLeaf
  n: number
  layerConfig?: unknown
  layerVersion: number
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const holderRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(n <= 12)

  // Lazy-render thumbnails so opening a 300-page set doesn't rasterise all of
  // them up front.
  useEffect(() => {
    const el = holderRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setVisible(true)
      },
      { rootMargin: '600px 0px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let task: ReturnType<PDFPageProxy['render']> | null = null
    pdfDoc.getPage(leaf.srcPage).then((page) => {
      if (cancelled) return
      const rot = (page.rotate + leaf.rotation) % 360
      const base = page.getViewport({ scale: 1, rotation: rot })
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const scale = (150 * dpr) / base.width
      const vp = page.getViewport({ scale, rotation: rot })
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width = Math.floor(vp.width)
      canvas.height = Math.floor(vp.height)
      canvas.style.width = `${Math.floor(vp.width / dpr)}px`
      const ctx = canvas.getContext('2d')!
      task = page.render({
        canvasContext: ctx,
        viewport: vp,
        optionalContentConfigPromise: layerConfig ? Promise.resolve(layerConfig as never) : undefined
      })
      task.promise.catch(() => {})
    })
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [pdfDoc, leaf.srcPage, leaf.rotation, visible, layerConfig, layerVersion])
  return (
    <div ref={holderRef} className="thumb-holder">
      <canvas ref={canvasRef} className="thumb-canvas" title={`Page ${n}`} />
    </div>
  )
}

export default function ThumbnailSidebar(props: Props): JSX.Element {
  const { pdfDoc, leaves, selected, currentPage, setSelected, onJump } = props
  const [dragId, setDragId] = useState<string | null>(null)
  const lastClickRef = useRef<number>(-1)

  const clickThumb = (id: string, i: number, e: React.MouseEvent): void => {
    if (e.shiftKey && lastClickRef.current >= 0) {
      const a = Math.min(lastClickRef.current, i)
      const b = Math.max(lastClickRef.current, i)
      setSelected(leaves.slice(a, b + 1).map((l) => l.id))
    } else if (e.ctrlKey || e.metaKey) {
      setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
      lastClickRef.current = i
    } else {
      setSelected([id])
      lastClickRef.current = i
      onJump(id) // single click navigates to the page
    }
  }

  const multi = selected.length > 0

  return (
    <div className="thumbs">
      <div className="thumbs-head">
        <div className="thumbs-title">
          <span>Pages</span>
          <button className="collapse-btn" title="Hide pages panel" onClick={props.onCollapse}>
            «
          </button>
        </div>
        <span className="hint">Click to go · Ctrl / Shift-click to multi-select · drag to reorder</span>
        {multi && (
          <div className="thumbs-ops">
            <span className="sel-count">{selected.length} selected</span>
            <button title="Rotate selected left" onClick={() => props.onRotate(selected, -1)}>↺</button>
            <button title="Rotate selected right" onClick={() => props.onRotate(selected, 1)}>↻</button>
            <button title="Duplicate selected pages" onClick={() => props.onDuplicate(selected)}>⧉</button>
            <button title="Extract selected pages to a new PDF" onClick={props.onExtract}>⎘</button>
            <button className="del" title="Delete selected pages" onClick={() => props.onDelete(selected)}>🗑</button>
          </div>
        )}
      </div>
      <div className="thumbs-list">
        {leaves.map((leaf, i) => (
          <div
            key={leaf.id}
            className={`thumb ${selected.includes(leaf.id) ? 'sel' : ''} ${currentPage === i + 1 ? 'current' : ''} ${dragId === leaf.id ? 'dragging' : ''}`}
            draggable
            onDragStart={() => setDragId(leaf.id)}
            onDragEnd={() => setDragId(null)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              if (dragId && dragId !== leaf.id) props.onReorder(dragId, leaf.id)
              setDragId(null)
            }}
            onClick={(e) => clickThumb(leaf.id, i, e)}
            onDoubleClick={() => props.onJump(leaf.id)}
          >
            <div className="thumb-inner">
              <Thumb pdfDoc={pdfDoc} leaf={leaf} n={i + 1} layerConfig={props.layerConfig} layerVersion={props.layerVersion} />
            </div>
            <div className="thumb-bar">
              <span className="pn">{i + 1}</span>
              <div className="thumb-actions">
                <button title="Rotate left" onClick={(e) => { e.stopPropagation(); props.onRotate([leaf.id], -1) }}>↺</button>
                <button title="Rotate right" onClick={(e) => { e.stopPropagation(); props.onRotate([leaf.id], 1) }}>↻</button>
                <button title="Delete page" className="del" onClick={(e) => { e.stopPropagation(); props.onDelete([leaf.id]) }}>🗑</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
