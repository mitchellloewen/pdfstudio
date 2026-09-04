import { resolve } from 'path'
import { existsSync, readFileSync, statSync } from 'fs'
import { defineConfig, type Plugin } from 'vite'

/**
 * Bench server. Reads test/bench/pdfs.json — a list of
 * `{ key, label, path }` — and serves each file at /pdf/<key>, so the bench
 * page can load PDFs that live outside the vite root.
 */
const root = resolve(__dirname)
const manifestPath = resolve(root, 'pdfs.json')

interface Entry {
  key: string
  label: string
  path: string
}

function pdfServer(): Plugin {
  return {
    name: 'bench-pdf-server',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0]
        // The renderer dev server runs on its own port and fetches these.
        res.setHeader('access-control-allow-origin', '*')
        const entries: Entry[] = JSON.parse(readFileSync(manifestPath, 'utf8'))
        if (url === '/pdfs.json') {
          const withSize = entries
            .filter((e) => existsSync(e.path))
            .map((e) => ({ key: e.key, label: e.label, size: statSync(e.path).size }))
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(withSize))
          return
        }
        if (url.startsWith('/pdf/')) {
          const key = decodeURIComponent(url.slice(5))
          const e = entries.find((x) => x.key === key)
          if (!e || !existsSync(e.path)) {
            res.statusCode = 404
            res.end('no such pdf')
            return
          }
          res.setHeader('content-type', 'application/pdf')
          res.end(readFileSync(e.path))
          return
        }
        next()
      })
    }
  }
}

export default defineConfig({
  root,
  plugins: [pdfServer()],
  worker: { format: 'es' },
  server: { port: 5200 }
})
