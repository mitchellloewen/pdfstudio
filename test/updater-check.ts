/**
 * Updater plumbing that doesn't need Electron: latest.yml parsing and version
 * ordering. Pass a real dist/latest.yml path to parse that instead.
 *   npx tsx test/updater-check.ts [dist/latest.yml]
 */
import { readFileSync } from 'fs'
import { compareVersions, parseLatestYml } from '../src/main/updater'

const sample = `version: 2.1.0
files:
  - url: PDF-Studio-Setup-2.1.0.exe
    sha512: abc123==
    size: 130797504
path: PDF-Studio-Setup-2.1.0.exe
sha512: abc123==
releaseDate: '2026-09-04T19:41:18.000Z'
`

const text = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : sample
const m = parseLatestYml(text)
console.log('manifest:', m)
if (!m.version || !m.file.endsWith('.exe') || !m.sha512) throw new Error('bad parse')
if (!process.argv[2] && (m.version !== '2.1.0' || m.file !== 'PDF-Studio-Setup-2.1.0.exe' || m.sha512 !== 'abc123==')) throw new Error('sample parse mismatch')

const cases: [string, string, number][] = [
  ['2.1.0', '2.0.0', 1],
  ['2.0.0', '2.1.0', -1],
  ['2.1.0', '2.1.0', 0],
  ['v2.10.0', '2.9.3', 1],
  ['2.1.0', '2.1', 0],
  ['3.0.0', '2.99.99', 1]
]
for (const [a, b, want] of cases) {
  const got = Math.sign(compareVersions(a, b))
  console.log(`compare ${a} vs ${b} → ${got} (want ${want})`)
  if (got !== want) throw new Error('compare mismatch')
}
console.log('OK')
