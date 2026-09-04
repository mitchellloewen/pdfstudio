import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import { installDevApiShim } from './devApiShim'

installDevApiShim()

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[PDF Studio] renderer crash', error, info)
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="crash">
          <div className="crash-card">
            <h1>Something went wrong</h1>
            <p>PDF Studio hit an unexpected error. Your files on disk are untouched.</p>
            <pre>{String(this.state.error?.message || this.state.error)}</pre>
            <button className="primary" onClick={() => window.location.reload()}>
              Reload PDF Studio
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
