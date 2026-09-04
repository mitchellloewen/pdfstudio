import { useState } from 'react'

interface Props {
  wrong: boolean
  onSubmit: (pw: string) => void
  onCancel: () => void
}

export default function PasswordDialog({ wrong, onSubmit, onCancel }: Props): JSX.Element {
  const [pw, setPw] = useState('')
  return (
    <div className="modal-back" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Password required</h2>
        <p>This PDF is protected with an open password. Enter it to view and edit the document.</p>
        <input
          type="password"
          autoFocus
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onSubmit(pw)}
          placeholder="Password"
        />
        {wrong && <div className="err">Incorrect password — try again.</div>}
        <div className="modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={() => onSubmit(pw)}>
            Open
          </button>
        </div>
      </div>
    </div>
  )
}
