# Athenaeum

A personal knowledge container. Add PDF, Word, or HTML documents (or Google
Drive files exported to those formats); Athenaeum converts each into a clean,
native HTML article in a strict-monochrome reading style. Highlight text,
comment on passages, annotate images and charts, and keep a commonplace book of
quotes. Everything is stored as plain files in iCloud Drive.

## Backing store

By default the library lives in iCloud Drive:

```
~/Library/Mobile Documents/com~apple~CloudDocs/Athenaeum/
  library/<article-id>/   original.<ext>  article.html  images/  meta.json  annotations.json
  quotes/quotes.json
```

If iCloud Drive is not present it falls back to `~/Documents/Athenaeum`. Use the
`⇄` pill in the top bar (or File › Change Library Folder) to relocate it.

## Run

```bash
npm install
npm start
```

DOCX and HTML import work immediately. PDF import needs the bundled Python
converter (PyMuPDF), built once:

```bash
npm run setup        # creates resources/pyenv via python3.11/3.12
```

> PyMuPDF wheels lag the newest CPython, so `setup.sh` prefers Python 3.12 or
> 3.11. Install one with `brew install python@3.12` if needed.

## How conversion works

| Format | Engine | Notes |
|--------|--------|-------|
| DOCX   | `mammoth` (Node) | Semantic HTML, images extracted to `images/`. |
| HTML   | `@mozilla/readability` + `sanitize-html` | Boilerplate stripped, images localized. |
| PDF    | bundled Python + `pymupdf4llm` | Reading-order text + extracted charts/images. Scanned PDFs fall back to one image per page. |

All three converge on a single allowlist normalizer that emits a minimal
semantic fragment (no inline styles or classes); the app's CSS does all styling.

## Tags, metadata, reading time

Add `#tags` anywhere in an article's title (edit the title in the reader header).
Tags render as pills and filter the Library list. Each article tracks its
original format, date added, estimated read time (225 wpm), and the time you
have actually spent reading it (accrued while the article is open and focused).

## Annotations

- Select text → Highlight, Comment, or Save quote.
- Click an image → drop a pinned note (charts included).
- Comments appear in the right-hand rail; click a highlight or card to focus it.

Annotations are anchored by quoted text with positional fallback (W3C-style) and
stored in each article's `annotations.json`, so they survive restarts and
reconversion. Highlights can be promoted into the Quotes commonplace book.

## Build a distributable

```bash
npm run setup        # ensure resources/pyenv exists first
npm run build:mac
```

The Python environment is bundled via electron-builder `extraResources`. For a
signed/notarized build, the native dylibs inside `resources/pyenv` must be
signed.
