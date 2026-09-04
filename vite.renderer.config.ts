import { resolve } from 'path'
import { existsSync, readFileSync } from 'fs'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Dev-server-only route for smoke-testing against a real file.
 *
 * `PDFSTUDIO_DEV_FILE=<path>` serves that PDF at `/devfile`, so opening
 * `http://localhost:5199/?file=/devfile` loads it on boot (see devApiShim).
 * Same origin, so the app's CSP is left alone.
 */
function devFile(): Plugin {
  return {
    name: 'pdfstudio-dev-file',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.url || '').split('?')[0] !== '/devfile') return next()
        const p = process.env.PDFSTUDIO_DEV_FILE
        if (!p || !existsSync(p)) {
          res.statusCode = 404
          res.end('set PDFSTUDIO_DEV_FILE to an existing path')
          return
        }
        res.setHeader('content-type', 'application/pdf')
        res.end(readFileSync(p))
      })
    }
  }
}

// Standalone renderer server for smoke-testing the web layer in a browser.
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  resolve: { alias: { '@': resolve(__dirname, 'src/renderer/src') } },
  plugins: [react(), devFile()],
  worker: { format: 'es' },
  server: { port: 5199 }
})
