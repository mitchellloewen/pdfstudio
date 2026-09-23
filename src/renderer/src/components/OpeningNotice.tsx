/** Shape of the preload's opening-file events, without importing the preload. */
export type OpeningInfo = NonNullable<Awaited<ReturnType<Window['api']['peekStartupFile']>>>

interface Props {
  files: OpeningInfo[]
  /** Over an open document (small card at the top) instead of the start screen. */
  floating?: boolean
}

function fmtSize(bytes: number | null): string {
  if (bytes == null) return ''
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** "Opening <file>…" while a file is still being read and parsed. */
export default function OpeningNotice({ files, floating }: Props): JSX.Element | null {
  const first = files[0]
  if (!first) return null
  const size = fmtSize(first.size)
  const more = files.length - 1
  return (
    <div className={floating ? 'opening opening-float' : 'opening'} role="status" aria-live="polite">
      <div className="opening-spinner" />
      <div className="opening-text">
        <div className="opening-label">Opening</div>
        <div className="opening-name" title={first.path}>
          {first.name}
        </div>
        {(size || more > 0) && (
          <div className="opening-meta">
            {size}
            {size && more > 0 ? ' · ' : ''}
            {more > 0 ? `${more} more file${more === 1 ? '' : 's'} waiting` : ''}
          </div>
        )}
      </div>
    </div>
  )
}
