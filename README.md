# Athenaeum

A minimal Mac app for keeping a personal library of things worth reading. Import a PDF, Word, or HTML document and Athenaeum converts it into a clean, monochrome reading view you can highlight, annotate, and rate. Everything is stored as plain files in iCloud Drive — no database, no account.

## Features

- Import **PDF, DOCX, and HTML** (or Google Drive files exported to those formats)
- Each document is converted to a clean reading view in a calm monochrome style
- **Charts and images preserved** in full color, including vector charts rasterized from PDFs
- Select text to **highlight** or attach a **comment**; pin notes onto images
- **Quotes** commonplace book — save passages with source and author
- **Tags** in the title (`#stoicism`) filter the library, just like the bullet journal
- **0–10 rating** per item
- Per-article metadata: original format, date added, estimated read time, and time actually spent reading
- A homepage **at-a-glance dashboard**: content saved, time read, highlights, comments
- **Wide / narrow** reading width toggle, light and dark themes

## Install

1. Download `Athenaeum.dmg` from the [latest release](../../releases/latest)
2. Open the DMG and drag **Athenaeum** to **Applications**
3. Open **Terminal** and run:
   ```bash
   xattr -dr com.apple.quarantine "/Applications/Athenaeum.app"
   ```
4. Double-click **Athenaeum** in Applications

> **Note:** The app is ad-hoc signed but not notarized (no Apple Developer account). Step 3 removes the macOS quarantine flag that blocks unsigned apps — it's a one-time step per machine. Without it, macOS 26 will silently refuse to launch the app.

## Where your library lives

By default Athenaeum stores everything in iCloud Drive:

```
~/Library/Mobile Documents/com~apple~CloudDocs/Athenaeum/
  library/<article-id>/   original.<ext>  article.html  images/  meta.json  annotations.json
  quotes/quotes.json
```

If iCloud Drive isn't present it falls back to `~/Documents/Athenaeum`. Use the `⇄` pill in the top bar to relocate it. Articles, highlights, and quotes are plain files, so they sync across your devices via iCloud.

## How conversion works

| Format | Engine | Notes |
|--------|--------|-------|
| DOCX   | `mammoth` | Semantic HTML, images extracted. |
| HTML   | `@mozilla/readability` + `sanitize-html` | Boilerplate stripped, images localized. |
| PDF    | bundled Python + `pymupdf4llm` | Reading-order text; vector charts detected and rasterized so they're kept as images. Scanned PDFs fall back to one image per page. |

DOCX and HTML import work with no extra setup. PDF import uses a bundled Python (PyMuPDF) environment.

## Development

```bash
npm install
npm run setup   # build the Python environment for PDF support (uses python3.11/3.12)
npm start
```

Requires Node.js and npm. `npm run setup` is only needed for PDF import; DOCX and HTML work without it.

## Build

```bash
npm run setup       # ensure resources/pyenv exists first
npm run build:mac   # electron-builder -> dist/Athenaeum-<version>.dmg
```

The DMG bundles the Python environment via electron-builder `extraResources`. PDF conversion relies on a Python install being present on the machine the environment was built from.
