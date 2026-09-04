// tesseract.js@5 classifies Electron's main process (and its worker threads)
// as env 'electron', which makes loadLanguage treat a local langPath as a URL
// and crash with "Only absolute URLs are supported" (node-fetch can't read
// filesystem paths). There is no DOM in those contexts — plain 'node'
// behaviour (fs.readFile for langPath) is what we need, so this patch makes
// the detector fall back to 'node' whenever no DOM/WorkerGlobalScope exists.
// Runs from `postinstall`, so a fresh npm install stays patched.
const fs = require('fs')
const path = require('path')

const target = path.join(__dirname, '..', 'node_modules', 'tesseract.js', 'src', 'utils', 'getEnvironment.js')

const patched = `// PATCHED by PDF Studio (scripts/patch-tesseract.cjs):
// treat DOM-less Electron contexts as plain Node so local langPath reads work.
module.exports = (key) => {
  const env = {};

  if (typeof WorkerGlobalScope !== 'undefined') {
    env.type = 'webworker';
  } else if (typeof document === 'object') {
    env.type = 'browser';
  } else if (typeof process === 'object' && typeof require === 'function') {
    env.type = 'node';
  }

  if (typeof key === 'undefined') {
    return env;
  }

  return env[key];
};
`

try {
  const current = fs.readFileSync(target, 'utf8')
  if (current.includes('PATCHED by PDF Studio')) {
    console.log('[patch-tesseract] already patched')
  } else {
    fs.writeFileSync(target, patched)
    console.log('[patch-tesseract] applied to', target)
  }
} catch (err) {
  console.warn('[patch-tesseract] skipped:', String(err && err.message))
}
