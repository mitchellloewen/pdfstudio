# PDF Studio

A local, offline PDF reader + editor for Windows 10/11. Combines the everyday
essentials of Nitro and Adobe Acrobat Reader with DirtCAD-style takeoff
measurements — all running on your machine, no cloud, no account.

The toolbar is a compact ribbon. **File · View · Help** menus sit on the *same
line* as the **Home · Measure · Pages · Advanced** tabs (the native menu bar is
hidden — Alt still shows it), with find / undo / page nav / zoom on that row too.
Open, Save, Save As and Print live in the File menu and on their usual shortcuts.

**Collapse the ribbon** for a full-height page: the ⌃ chevron at the right of the
tab row, **Ctrl+F1**, double-clicking any tab, or View → Collapse the ribbon.
While collapsed, clicking a tab floats its tools over the page and they tuck away
again the moment you pick one. The state is remembered between sessions.

## Features

**Reading & navigation**
- **Open multiple PDFs at once in tabs** (＋ button, File → Open, drag & drop
  anywhere in the window, or double-click more files). Middle-click a tab or
  **Ctrl+W** to close it; **Ctrl+Tab** cycles tabs. Unsaved tabs show a blue dot.
- **Recent files** on the start screen and under File → Open Recent.
- **Select & copy text** right off the page (pdf.js text layer).
- **Find text** (Ctrl+F / 🔍) with **Exact** or **Fuzzy** matching (fuzzy ignores
  spacing & punctuation). Matches are highlighted; **Enter** / **Shift+Enter**
  jump to the next / previous hit.
- **Ctrl + mouse wheel** zooms toward the cursor; **middle-click + drag** pans.
- Zoom presets incl. **Fit width** / **Fit page** (documents open at fit-width);
  **Ctrl + = / − / 0** keyboard zoom.
- **Page X of Y** box — type a page number to jump; **← / →** step pages;
  **PgUp / PgDn** scroll; **Home / End** jump to first / last.
- Collapsible pages panel; click a thumbnail to jump to that page.
- **Print** (Ctrl+P / 🖨) — pages print exactly as they would save, including
  everything you've added.

**OCR — scanned documents just work**
- Pages with no text layer are **recognized automatically in the background**
  (bundled Tesseract engine, fully offline). A status-bar counter shows
  progress; results are **cached per document**, so it's a one-time cost.
- Once recognized, **search, select, copy, highlight, underline and strikeout
  all work on scanned pages** exactly like on regular PDFs.
- Saving embeds the recognized text as an **invisible text layer**, producing a
  standard searchable PDF that Acrobat, Nitro, browsers and phones can search
  and select. Text under a whiteout is never embedded (redaction stays real).
- Born-digital PDFs skip OCR entirely — zero overhead.

**Advanced tab** (deliberately tucked away so originals aren't changed by accident)
- **Edit original text** — click any existing line (born-digital *or* scanned,
  once OCR finishes) to replace it with an editable copy; the original is
  covered by a clean vector patch. One Ctrl+Z reverts the whole edit.
- **Layers** — show/hide the document's optional-content layers (CAD exports
  etc.). Hidden layers stay hidden in the saved file and in redacted rasters.
- Remove restrictions (unlock) also lives here.

**Heavy CAD plan sets open fast on their own**
- Some plan sets are painfully slow to pan and zoom even though the file isn't
  large. The cause is the *drawing data*, not the size: plotter exports emit
  every straight line as hundreds of collinear points, and wrap every single
  hatch tick in its own save / matrix / restore. One 12 MB sheet set in testing
  carried **11 million line segments and 1.7 million graphics-state wrappers** —
  260 MB of drawing commands once decompressed.
- **This is now automatic.** When a page takes more than ~1.2 s to draw, PDF
  Studio rewrites that redundancy away in a background worker and swaps the
  result in for rendering. **Your file on disk is never touched** — saving,
  extracting and printing all still work from the original bytes; only the
  document pdf.js draws from is replaced. The result is cached against a hash of
  the original, so it's a one-time cost per document (the same pattern the OCR
  cache uses; budget ~45 s for a ten-sheet set, capped at 600 MB on disk).
- Measured on the test sheet set: **6× faster rendering** — a heavy sheet goes
  from ~19 s to ~3 s per draw, and every zoom step pays that cost, not just the
  first view.
- **File → Build a faster copy…** does the same rewrite but adopts it as the
  document, so **Save As** writes the faster file out — for when you want to
  hand it to someone else, or open it fast in Bluebeam or on a phone. The
  optimised copy is also *smaller* (12.08 MB → 10.98 MB on the test set).
- None of this is image recompression — the online "compress PDF" services
  shrink images, which does nothing here (the whole image payload on that file
  was 0.56 MB of 12 MB). Nothing is rasterised and nothing is discarded: text,
  images, layers, annotations and form fields all pass through untouched.

**Combine files (File → Combine files…, or the start screen)**
- Pick any number of PDFs and pictures (PNG / JPEG) in one go, drag them into
  order, and get one new unsaved document. Pictures become a Letter page each,
  portrait or landscape to match, scaled to fit inside a ½" margin.
- Dropping pictures onto the window with nothing open, or dropping anything
  while the Combine list is up, adds them to the list.

**Pages tab**
- Insert from PDF (merge — pick several files at once), **Insert pictures…**
  (PNG / JPEG as full pages after the current page; dropping pictures onto an
  open document does the same), insert blank, duplicate, extract selected.
- **Header & footer…** — six positions (top / bottom × left / centre / right)
  with `{n}` page number, `{N}` last page, `{date}` (three styles) and `{file}`
  tokens; one font (Helvetica/Times/Courier ± bold), size, colour, margin,
  page range and start number for all of them. Default is plain
  `Page {n} of {N}` bottom-centre. Added as normal text boxes: move, restyle
  or delete individually, or undo all at once.

**Draw tab**
- Plain drawing with no scale and no measurements: **line**, **arrow**,
  **rectangle**, **ellipse**, **polyline**, **polygon** and **freehand**.
- Pen settings: colour, line width, dashes, **fill** (colour + opacity) for the
  closed shapes, and which end of an arrow gets a head. They arm the next
  drawing and restyle the selected one.
- Hold **Shift** while dragging to snap lines to 15° steps and to keep
  rectangles/ellipses square. Polylines and polygons are clicked corner by
  corner — **double-click** or **Enter** finishes.
- Drawings stay editable: drag one to move it, pull a handle to reshape it, and
  they save as standard PDF Line / Square / Circle / Polygon / PolyLine / Ink
  annotations until you Flatten.

**Editing**
- **Full undo / redo** (Ctrl+Z / Ctrl+Y) for every edit.
- **Highlight, underline and strikeout** text — select text and click the tool,
  or pick the tool and drag across text.
- Drop **text** anywhere (works on flat/scanned forms with no real fields),
  **checkmarks** and **X's**.
- **Whiteout with true redaction** — the covered content is *destroyed* on
  save (the page is rebuilt as a high-resolution image), not just hidden.

**Pages (Nitro-style)**
- Thumbnail sidebar — drag to reorder, rotate, delete; **Ctrl / Shift-click**
  multi-select with bulk rotate / duplicate / delete / extract.
- **Insert pages from another PDF** (merge / combine), **insert blank page**,
  **duplicate page** — Pages ▾ menu in the toolbar.
- Extract selected pages to a new PDF.
- Saving edits the document **in place**, so bookmarks, links and metadata in
  untouched parts of the file survive.

**Fill & Sign (Acrobat-style)**
- **Fillable form fields are auto-detected** (in the background — big documents
  open instantly). **Tab / Shift-Tab** moves between fields in reading order.
- On save, choose to **keep the form fillable** for other PDF readers (default)
  or **flatten** everything into permanent page content (Save ▾ menu).
- **Signatures are saved permanently** — load a signature image once (PNG with
  transparency works best) and it's one click on every future document. Keep
  several (full signature, initials) and manage them from the ✍▾ menu.

**Takeoff (DirtCAD-style)**
- **Scales are per page** — each sheet in a plan set can have its own.
- **Calibrate** a page by drawing a line of known real-world length, or type a
  **scale ratio** (e.g. 1:2000) directly — either can optionally apply to all pages.
- Measure **length** (multi-point polylines), **area**, and **arcs** (3-point).
- Live readout while drawing; labels are baked as real vector + text content,
  so the measurements are visible in *any* standard PDF reader.

**Saving**
- **Ctrl+S saves in place** (atomic write — temp file + rename), **Ctrl+Shift+S**
  is Save As. Closing a tab or the app with unsaved changes warns you first.

**Unlock**
- Remove owner-password restrictions (print/copy/edit locks) via bundled `qpdf`.
- Prompts for the open-password on password-protected files.

**Performance**
- Pages rasterise lazily and far-offscreen pages release their bitmaps, so
  large plan sets don't accumulate gigabytes of canvases.
- Rasterisation is capped per page (with CSS scaling beyond the cap), so deep
  zoom on 24×36 sheets can't blow past browser canvas limits.
- Zooming rescales instantly and re-sharpens after a short debounce.

## Install & set as default PDF viewer

Download the newest `PDF-Studio-Setup-<version>.exe` from
<https://github.com/mitchellloewen/pdfstudio/releases/latest> (or run the one
`npm run build:win` leaves in `dist/`). It installs per-user (no admin needed),
adds Start-menu and desktop shortcuts, and registers the app for `.pdf` files. A
portable build is also produced at `dist/win-unpacked/PDF Studio.exe`.

To make it your default PDF app: **File → Set PDF Studio as Default PDF App…**
(opens Windows Settings), or Settings → Apps → Default apps → `.pdf` → PDF Studio.
Once set, double-clicking any PDF opens it here. The app is single-instance, so
opening another PDF reuses the running window.

## Updates

Installed copies update themselves from GitHub Releases. About 8 s after
launch (and every 4 h while open) the app fetches `latest.yml` from the newest
release, and if it is newer than the running version, downloads the installer
in the background, checks its SHA-512, then shows **Help → Restart to update**
and a toast. Nothing installs until that is clicked; **Help → Check for
updates…** does it on demand. There is no token anywhere in the app — the
release assets are public. `src/main/updater.ts`, no updater dependency.

To ship a version:

```powershell
# bump "version" in package.json, commit, then
.\scripts\release.ps1 -Notes "What changed"
```

The script refuses to run on a dirty tree or an already-released version,
builds, tags `v<version>`, pushes, and creates the release with the installer,
its blockmap and `latest.yml`. Needs `gh` signed in (`gh auth login`).

## Develop

```bash
npm install
npm run dev        # launch in Electron with hot reload
npm run build      # production build to out/
npm run build:win  # build + package the NSIS installer to dist/
```

Renderer-only browser preview (for quick UI work): `npx vite --config vite.renderer.config.ts`

Tests (no framework — plain scripts):

```bash
npx tsx test/smoke.ts        # bake/extract/keep-forms/duplicate/OCR-layer pipeline
npx tsx test/combine-check.ts # combine PDFs + pictures, bad inputs rejected, Letter picture pages
node test/render-check.mjs   # re-render the baked output with pdf.js
node test/frame-check.mjs    # rotation/display-space math vs pdf.js viewports
node test/ocr-check.mjs      # bundled Tesseract engine, offline, with word boxes

# Optimise-for-fast-viewing. Run smoke.ts first — safety reuses its outputs.
npx tsx test/optimize-safety.ts             # structure-preserving? (pass a plan set as an extra arg)
npx tsx test/optimize-mem.ts <plan.pdf> 7   # heap ceiling — the tokeniser must stay streaming
npx tsx test/optimize-parity.ts <plan.pdf>  # pdf.js sees the same structure (render-doc swap)
npx tsx test/optimize-e2e.ts <plan.pdf>     # the shipping path, with before/after stats
npx tsx test/optimize-check.ts <plan.pdf>   # compare variants (geometry / flatten / merge)
npx tsx test/size-check.ts <plan.pdf>       # per-page decompressed vs stored size

# pdf.js render bench — copy test/bench/pdfs.example.json to pdfs.json, point it
# at an original and its optimised copy, then serve test/bench/vite.config.ts
# and open the page. Reports cold/warm rasterise time per page.
npx vite --config test/bench/vite.config.ts
```

Packaged OCR self-test (validates asar-unpack + bundled language data):

```bash
PDFSTUDIO_OCR_SELFTEST_IN=test/ocr-sample.png PDFSTUDIO_OCR_SELFTEST_OUT=out.json "dist/win-unpacked/PDF Studio.exe"
```

Typecheck with `npx tsc -p tsconfig.web.json --noEmit` and
`npx tsc -p tsconfig.node.json --noEmit`.

## Notes

- Whiteout pages are rebuilt as ~200 dpi JPEG images on save; that page's text
  is intentionally no longer searchable (that's the redaction). OCR words under
  a whiteout are likewise excluded from the saved text layer.
- `scripts/patch-tesseract.cjs` (run by `postinstall`) patches tesseract.js's
  environment detection: it classifies Electron's main process as 'electron'
  and then refuses to read a local `langPath` (tries to fetch it as a URL).
  Without the patch, OCR crashes with "Only absolute URLs are supported".
- OCR language data lives in `resources/tessdata/` (English, ~11 MB) and ships
  via extraResources; tesseract.js + tesseract.js-core are asar-unpacked.
