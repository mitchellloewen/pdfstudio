interface TabInfo {
  id: string
  name: string
  dirty: boolean
}

interface Props {
  tabs: TabInfo[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
}

export default function TabBar({ tabs, activeId, onSelect, onClose, onNew }: Props): JSX.Element {
  return (
    <div className="tabbar">
      <div className="tabbar-scroll">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`tab ${t.id === activeId ? 'active' : ''}`}
            onPointerDown={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                onClose(t.id)
              } else {
                onSelect(t.id)
              }
            }}
            title={t.name + (t.dirty ? ' — unsaved changes' : '')}
          >
            {t.dirty && <span className="tab-dirty" title="Unsaved changes">●</span>}
            <span className="tab-name">{t.name}</span>
            <button
              className="tab-close"
              title="Close (Ctrl+W)"
              onPointerDown={(e) => {
                e.stopPropagation()
                onClose(t.id)
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button className="tab-new" title="Open another PDF" onClick={onNew}>
        +
      </button>
    </div>
  )
}
