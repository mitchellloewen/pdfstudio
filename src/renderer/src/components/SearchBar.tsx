import { useEffect, useRef } from 'react'

interface Props {
  query: string
  fuzzy: boolean
  count: number
  current: number // 0-based index, -1 if none
  searching: boolean
  onQuery: (q: string) => void
  onFuzzy: (f: boolean) => void
  onNext: () => void
  onPrev: () => void
  onClose: () => void
}

export default function SearchBar(props: Props): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  return (
    <div className="searchbar">
      <input
        ref={inputRef}
        className="search-input"
        placeholder="Find in document…"
        value={props.query}
        onChange={(e) => props.onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (e.shiftKey) props.onPrev()
            else props.onNext()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            props.onClose()
          }
        }}
      />
      <span className="search-count">
        {props.searching ? 'Searching…' : props.count ? `${props.current + 1} / ${props.count}` : props.query ? 'No results' : ''}
      </span>
      <div className="search-mode">
        <button
          className={!props.fuzzy ? 'active' : ''}
          title="Exact match (case-insensitive)"
          onClick={() => props.onFuzzy(false)}
        >
          Exact
        </button>
        <button
          className={props.fuzzy ? 'active' : ''}
          title="Fuzzy — ignores spacing & punctuation"
          onClick={() => props.onFuzzy(true)}
        >
          Fuzzy
        </button>
      </div>
      <button className="search-nav" title="Previous (Shift+Enter)" onClick={props.onPrev} disabled={!props.count}>
        ‹
      </button>
      <button className="search-nav" title="Next (Enter)" onClick={props.onNext} disabled={!props.count}>
        ›
      </button>
      <button className="search-close" title="Close (Esc)" onClick={props.onClose}>
        ×
      </button>
    </div>
  )
}
