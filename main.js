const { app, BrowserWindow, ipcMain, dialog, Menu, shell, clipboard, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

// ----- config + store roots -------------------------------------------------

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf-8')); } catch { return {}; }
}
function saveConfig(obj) {
  fs.writeFileSync(configPath(), JSON.stringify(obj, null, 2), 'utf-8');
}

// Default backing store: iCloud Drive › Documents › Athenaeum.
// Fall back to ~/Documents/Athenaeum if iCloud Drive is not present.
function defaultLibraryPath() {
  const iCloud = path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  const base = fs.existsSync(iCloud) ? iCloud : path.join(os.homedir(), 'Documents');
  return path.join(base, 'Athenaeum');
}

function libraryRoot() {
  const cfg = loadConfig();
  return cfg.libraryPath || defaultLibraryPath();
}
function articlesDir() { return path.join(libraryRoot(), 'library'); }
function quotesDir()   { return path.join(libraryRoot(), 'quotes'); }
function quotesFile()  { return path.join(quotesDir(), 'quotes.json'); }

function ensureStore() {
  fs.mkdirSync(articlesDir(), { recursive: true });
  fs.mkdirSync(quotesDir(), { recursive: true });
  if (!fs.existsSync(quotesFile())) {
    fs.writeFileSync(quotesFile(), JSON.stringify({ version: 1, quotes: [] }, null, 2), 'utf-8');
  }
}

// ----- small utilities ------------------------------------------------------

const TAG_RE = /#([a-zA-Z][a-zA-Z0-9_-]*)/g;
function parseTags(s) {
  const out = []; let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(s || '')) !== null) out.push(m[1]);
  return [...new Set(out)];
}

function slugify(s) {
  return (s || 'untitled')
    .replace(TAG_RE, '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

function datePrefix() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function uniqueId(title) {
  const base = `${datePrefix()}-${slugify(title)}`;
  let id = base, n = 2;
  while (fs.existsSync(path.join(articlesDir(), id))) id = `${base}-${n++}`;
  return id;
}

function rid(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

// ----- conversion: shared normalizer ---------------------------------------
// Every format funnels through this: strict allowlist -> minimal semantic
// fragment with images wrapped in <figure>, all styling left to app CSS.

function normalizeFragment(rawHtml) {
  const sanitizeHtml = require('sanitize-html');
  const clean = sanitizeHtml(rawHtml, {
    allowedTags: [
      'h1', 'h2', 'h3', 'p', 'blockquote', 'ul', 'ol', 'li',
      'figure', 'img', 'figcaption', 'table', 'thead', 'tbody',
      'tr', 'th', 'td', 'em', 'strong', 'a', 'code', 'pre', 'br', 'hr'
    ],
    allowedAttributes: { a: ['href'], img: ['src', 'alt'] },
    allowedSchemes: ['http', 'https', 'mailto', 'file'],
    transformTags: {
      h4: 'h3', h5: 'h3', h6: 'h3',
      b: 'strong', i: 'em',
      div: 'p', span: 'p'
    }
    // Empty-element cleanup happens in the jsdom pass below, which correctly
    // preserves paragraphs that wrap an image.
  });

  // jsdom pass: collapse empties, wrap bare images in <figure>+<figcaption>.
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(`<body>${clean}</body>`);
  const doc = dom.window.document;

  doc.querySelectorAll('img').forEach((img) => {
    if (img.closest('figure')) return;
    const fig = doc.createElement('figure');
    img.replaceWith(fig);
    fig.appendChild(img);
    const alt = (img.getAttribute('alt') || '').trim();
    if (alt) {
      const cap = doc.createElement('figcaption');
      cap.textContent = alt;
      fig.appendChild(cap);
    }
  });

  // tables from PDF extraction are often padded with empty columns/rows; compact them
  pruneTables(doc);

  // drop empty paragraphs left behind
  doc.querySelectorAll('p').forEach((p) => {
    if (!p.textContent.trim() && !p.querySelector('img')) p.remove();
  });

  // tag footnotes / citations (a small number then a quote or capital) so they
  // render smaller and lighter, distinct from body text; ensure a space after
  // the leading number ("7Hannah" -> "7 Hannah")
  doc.querySelectorAll('blockquote, p').forEach((el) => {
    const t = el.textContent.trim();
    if (/^\d{1,2} ?(["“''’]|[A-Z])/.test(t) && (el.tagName === 'BLOCKQUOTE' || t.length < 400)) {
      el.classList.add('cite');
      const first = el.firstChild;
      if (first && first.nodeType === 3) {
        first.nodeValue = first.nodeValue.replace(/^(\s*)(\d{1,2})(?=["“''’A-Za-z])/, '$1$2 ');
      }
    }
  });

  return doc.body.innerHTML.trim();
}

// Remove entirely-empty columns and rows from tables. PDF table extraction
// (pymupdf4llm) reconstructs visually-laid-out exhibits as a sparse grid with
// many blank padding cells; this collapses them back to the real data.
function pruneTables(doc) {
  doc.querySelectorAll('table').forEach((table) => {
    let rows = [...table.querySelectorAll('tr')];
    if (!rows.length) { table.remove(); return; }
    const ncol = Math.max(...rows.map((r) => r.children.length));

    // remove columns that are empty in every row (right-to-left to keep indices)
    for (let c = ncol - 1; c >= 0; c--) {
      const colEmpty = rows.every((r) => !r.children[c] || !r.children[c].textContent.trim());
      if (colEmpty) rows.forEach((r) => { if (r.children[c]) r.children[c].remove(); });
    }
    // remove rows with no content
    rows.forEach((r) => { if (![...r.children].some((c) => c.textContent.trim())) r.remove(); });

    rows = [...table.querySelectorAll('tr')];
    if (!rows.length || !rows.some((r) => r.textContent.trim())) { table.remove(); return; }
    // a single remaining column is not a table; flatten to paragraphs
    if (Math.max(...rows.map((r) => r.children.length)) <= 1) {
      rows.forEach((r) => {
        const txt = r.textContent.trim();
        if (txt) { const p = doc.createElement('p'); p.textContent = txt; table.parentNode.insertBefore(p, table); }
      });
      table.remove();
    }
  });
}

function countWords(html) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ');
  return text.split(/\s+/).filter(Boolean).length;
}
function firstHeading(html) {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
}

// ----- conversion: per-format ----------------------------------------------

async function convertDocx(srcPath, imagesDir) {
  const mammoth = require('mammoth');
  let n = 0;
  const result = await mammoth.convertToHtml(
    { path: srcPath },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const buf = await image.read();
        let ext = (image.contentType || 'image/png').split('/')[1] || 'png';
        if (ext === 'jpeg') ext = 'jpg';
        const name = `img-${String(++n).padStart(2, '0')}.${ext}`;
        fs.writeFileSync(path.join(imagesDir, name), buf);
        return { src: `images/${name}`, alt: image.altText || '' };
      })
    }
  );
  return { html: result.value, title: '', warnings: result.messages.map((m) => m.message).slice(0, 5) };
}

async function convertHtml(srcPath, imagesDir) {
  const raw = fs.readFileSync(srcPath, 'utf-8');
  const { JSDOM } = require('jsdom');
  const { Readability } = require('@mozilla/readability');
  const dom = new JSDOM(raw, { url: 'file://' + srcPath });
  const reader = new Readability(dom.window.document);
  const parsed = reader.parse();
  let bodyHtml = parsed ? parsed.content : dom.window.document.body.innerHTML;
  const title = parsed ? (parsed.title || '') : '';

  // localize images
  bodyHtml = await localizeImages(bodyHtml, imagesDir, path.dirname(srcPath));
  return { html: bodyHtml, title, warnings: [] };
}

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Fetch a web page as text, with a browser-like UA so sites don't serve a
// bot/blocked page. Rejects non-HTML responses (PDFs, images, etc.).
async function fetchPage(url) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 30000);
  let res;
  try {
    res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'The page took too long to load.' : 'Could not reach that URL.');
  } finally { clearTimeout(to); }
  if (!res.ok) throw new Error(`Could not fetch the page (HTTP ${res.status}).`);
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct && !/text\/html|application\/xhtml|text\/plain|\+xml/.test(ct)) {
    throw new Error(`That link is not a web page (${ct.split(';')[0]}). Download it and use Add document instead.`);
  }
  return await res.text();
}

// Convert a live URL the same way an .html file is imported: Readability strips
// nav/ads/boilerplate, then images are localized into the article folder.
async function convertUrl(url, imagesDir) {
  const rawPage = await fetchPage(url);
  const { JSDOM } = require('jsdom');
  const { Readability } = require('@mozilla/readability');
  // Passing `url` lets Readability resolve relative <img>/<a> to absolute URLs.
  const dom = new JSDOM(rawPage, { url });
  const doc = dom.window.document;
  // Read the site's name + logo BEFORE Readability runs — it mutates the
  // document and strips the <head> links we need.
  const site = siteMeta(doc, url);
  const parsed = new Readability(doc).parse();
  if (!parsed || !parsed.content || !parsed.content.trim()) {
    throw new Error('Could not find readable article content on that page.');
  }
  const bodyHtml = await localizeImages(parsed.content, imagesDir, url);
  return {
    html: bodyHtml,
    title: parsed.title || '',
    author: (parsed.byline || '').trim(),
    excerpt: (parsed.excerpt || '').trim(),
    siteName: site.siteName,
    logoCandidates: site.logoCandidates,
    rawPage,
    warnings: []
  };
}

// A link's declared icon size ("180x180" -> 18), used to prefer larger logos.
function iconSize(linkEl) {
  const m = (linkEl.getAttribute('sizes') || '').match(/(\d+)x\d+/i);
  return m ? Math.min(parseInt(m[1], 10), 512) / 10 : 0;
}

// Pull the publishing site's display name and an ordered list of logo URLs
// (best first), falling back to the domain favicon and Google's favicon service
// so there is almost always something to show.
function siteMeta(doc, pageUrl) {
  const abs = (href) => { try { return new URL(href, pageUrl).href; } catch { return null; } };

  let siteName = '';
  const og = doc.querySelector('meta[property="og:site_name"]');
  if (og && og.getAttribute('content')) siteName = og.getAttribute('content').trim();
  let host = '';
  try { host = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch {}
  if (!siteName) siteName = host;

  const cands = [];
  const add = (href, score) => { const u = href && abs(href); if (u) cands.push({ u, score }); };
  // apple-touch-icon is usually a clean, square brand logo
  doc.querySelectorAll('link[rel~="apple-touch-icon"], link[rel~="apple-touch-icon-precomposed"]')
    .forEach((l) => add(l.getAttribute('href'), 100 + iconSize(l)));
  // declared favicons (prefer larger / svg)
  doc.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"], link[rel~="mask-icon"]')
    .forEach((l) => {
      const href = l.getAttribute('href') || '';
      const isSvg = /\.svg(\?|#|$)/i.test(href) || (l.getAttribute('type') || '').includes('svg');
      add(href, 50 + iconSize(l) + (isSvg ? 15 : 0));
    });

  cands.sort((a, b) => b.score - a.score);
  const ordered = cands.map((c) => c.u);
  try {
    const origin = new URL(pageUrl).origin;
    ordered.push(origin + '/favicon.ico');
    if (host) ordered.push('https://www.google.com/s2/favicons?domain=' + host + '&sz=128');
  } catch {}
  return { siteName, logoCandidates: [...new Set(ordered)] };
}

// Download a candidate logo into the article's images/ folder. Returns the
// relative path on success, or null so the caller can try the next candidate.
async function saveLogo(url, imagesDir) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': BROWSER_UA } }).catch(() => null);
    clearTimeout(to);
    if (!res || !res.ok) return null;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!/image\//.test(ct)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 2_000_000) return null;
    let ext = (ct.split('/')[1] || 'png').split('+')[0].replace(/[^a-z0-9]/gi, '') || 'png';
    if (ext === 'jpeg') ext = 'jpg';
    if (ext === 'xicon' || ext === 'vndmicrosofticon') ext = 'ico';
    if (ext === 'svgxml') ext = 'svg';
    const name = 'site-logo.' + ext;
    fs.writeFileSync(path.join(imagesDir, name), buf);
    return 'images/' + name;
  } catch { return null; }
}

async function localizeImages(html, imagesDir, baseDir) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(`<body>${html}</body>`);
  const doc = dom.window.document;
  const imgs = [...doc.querySelectorAll('img')];
  let n = 0;
  for (const img of imgs) {
    const src = img.getAttribute('src') || '';
    try {
      let buf = null, ext = 'png';
      if (src.startsWith('data:')) {
        const m = src.match(/^data:image\/([a-z0-9+]+);base64,(.*)$/i);
        if (m) { ext = m[1] === 'jpeg' ? 'jpg' : m[1]; buf = Buffer.from(m[2], 'base64'); }
      } else if (/^https?:\/\//i.test(src)) {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 15000);
        const res = await fetch(src, { signal: ctrl.signal }).catch(() => null);
        clearTimeout(to);
        if (res && res.ok) {
          buf = Buffer.from(await res.arrayBuffer());
          ext = (res.headers.get('content-type') || 'image/png').split('/')[1] || 'png';
          if (ext === 'jpeg') ext = 'jpg';
        }
      } else {
        const local = src.startsWith('file://') ? src.slice(7) : path.resolve(baseDir, src);
        if (fs.existsSync(local)) { buf = fs.readFileSync(local); ext = path.extname(local).slice(1) || 'png'; }
      }
      if (buf) {
        const name = `img-${String(++n).padStart(2, '0')}.${ext.replace(/[^a-z0-9]/gi, '') || 'png'}`;
        fs.writeFileSync(path.join(imagesDir, name), buf);
        img.setAttribute('src', `images/${name}`);
      } else {
        img.remove();
      }
    } catch { img.remove(); }
  }
  return doc.body.innerHTML;
}

function pythonBin() {
  const base = app.isPackaged ? process.resourcesPath : path.join(__dirname, 'resources');
  return path.join(base, 'pyenv', 'bin', 'python3');
}
function pdfScript() {
  const base = app.isPackaged ? process.resourcesPath : path.join(__dirname, 'resources');
  return path.join(base, 'py', 'pdf_to_html.py');
}

function runPdfScript(srcPath, outDir, extraArgs, timeoutMs) {
  const py = pythonBin();
  return new Promise((resolve, reject) => {
    const child = spawn(py, [pdfScript(), srcPath, outDir, ...extraArgs], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('PDF conversion timed out')); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('PDF conversion failed: ' + err.slice(0, 400)));
      try { resolve(JSON.parse(out)); } catch (e) { reject(new Error('Bad converter output: ' + e.message)); }
    });
  });
}

async function convertPdf(srcPath, imagesDir) {
  const py = pythonBin();
  if (!fs.existsSync(py)) {
    throw new Error('PDF support is not installed. Run `npm run setup` to build the Python environment.');
  }
  // When an Anthropic key is configured, use the higher-fidelity LLM-vision
  // pipeline; fall back to the heuristic extractor if it fails or has no key.
  if (apiKey()) {
    try { return await convertPdfLlm(srcPath, imagesDir); }
    catch (e) { console.error('[athenaeum] LLM PDF conversion failed, using heuristic:', e.message); }
  }

  const outDir = path.dirname(imagesDir); // article folder; script writes into images/
  const result = await runPdfScript(srcPath, outDir, [], 120000);

  if (result.mode === 'pages') {
    // scanned / text-empty PDF: page images already written to images/
    const figs = result.images.map((src) => `<figure><img src="${src}" alt=""></figure>`).join('\n');
    return { html: figs, title: result.title || '', warnings: ['Image-only PDF: text was not extracted.'], pages: result.pageCount, cover: result.cover || null, author: result.author || '' };
  }

  const { marked } = await import('marked');
  const html = marked.parse(result.markdown || '', { mangle: false, headerIds: false });
  return { html, title: result.title || '', warnings: result.warnings || [], pages: result.pageCount, cover: result.cover || null, author: result.author || '' };
}

// ----- LLM-vision PDF conversion (hybrid) -----------------------------------
// Render each page to an image, have Claude transcribe it into clean reading-order
// Markdown (data exhibits -> tables, prose -> prose), and inline the real chart
// figures rasterized by the Python prep step. Reading-fidelity far exceeds the
// heuristic extractor on design-heavy reports.
const LLM_PDF_MODEL = 'claude-haiku-4-5';
// [input, output] USD per 1M tokens, for the running cost meter
const MODEL_PRICE = {
  'claude-haiku-4-5': [1, 5], 'claude-haiku-4-5-20251001': [1, 5],
  'claude-sonnet-4-6': [3, 15], 'claude-opus-4-8': [5, 25]
};
function recordLlmUsage(model, inTok, outTok) {
  if (!inTok && !outTok) return;
  const cfg = loadConfig();
  const u = cfg.llmUsage || { inputTokens: 0, outputTokens: 0, cost: 0, calls: 0 };
  const [pin, pout] = MODEL_PRICE[model] || [1, 5];
  u.inputTokens += inTok || 0;
  u.outputTokens += outTok || 0;
  u.cost += (inTok || 0) / 1e6 * pin + (outTok || 0) / 1e6 * pout;
  u.calls += 1;
  cfg.llmUsage = u;
  saveConfig(cfg);
}
const LLM_PDF_PROMPT = `You are transcribing one page of a PDF into clean, readable Markdown for a reading app. The real chart/figure images from this page are added separately, so your job is the TEXT. Rules:
- Output ONLY Markdown for this page — no preamble, no commentary, no code fences.
- Reproduce the page's text in natural reading order.
- Use ## for section headings (reserve a single # for the document's main title on the very first page only). Body text as normal paragraphs. Lists as - or 1.. Block quotes with >.
- Render genuine data tables, and any "Exhibit/Figure" that is fundamentally a data matrix or list, as a GitHub Markdown table or list. Keep the exhibit's title/caption as a heading above it.
- For a purely visual chart, diagram, photo, or decorative graphic: do NOT describe it and do NOT emit a placeholder — omit it entirely. The actual image will be inlined separately.
- Render footnote/citation definitions as plain paragraphs that begin with the number then a space then the source, e.g. "7 Hannah Mayer, "Superagency in the workplace," McKinsey, 2025." Keep inline citation markers as plain numbers.
- Omit running headers, footers, page numbers, and standalone copyright / source-watermark lines that repeat across pages.
- Do not invent or summarize — transcribe what is actually on the page. If the page has no real text (cover art, full-bleed graphic), output nothing.`;

async function transcribePdfPage(key, pngPath) {
  const data = fs.readFileSync(pngPath).toString('base64');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: LLM_PDF_MODEL,
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
          { type: 'text', text: LLM_PDF_PROMPT }
        ]
      }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const text = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return { text, usage: json.usage || {} };
}

// keep the first <h1> (document title); demote later page-level h1s to h2
function relevelLlmHeadings(md) {
  let seen = false;
  return md.replace(/^(#{1,6})\s+(.*)$/gm, (m, hashes, text) => {
    if (hashes !== '#') return m;
    if (!seen) { seen = true; return m; }
    return '## ' + text;
  });
}

async function convertPdfLlm(srcPath, imagesDir) {
  const key = apiKey();
  if (!key) throw new Error('no API key');
  const outDir = path.dirname(imagesDir);
  const prep = await runPdfScript(srcPath, outDir, ['--prep-llm'], 180000);
  if (prep.mode !== 'llm-prep') throw new Error('prep returned ' + prep.mode);

  const n = prep.pageCount;
  const figs = prep.figures || {};
  const pageMd = new Array(n).fill('');
  let inTok = 0, outTok = 0;

  // transcribe pages with bounded concurrency to keep import latency reasonable
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= n) break;
      const ref = prep.pageImages[i];
      if (!ref) continue;
      try {
        const r = await transcribePdfPage(key, path.join(outDir, ref));
        pageMd[i] = r.text;
        inTok += r.usage.input_tokens || 0;
        outTok += r.usage.output_tokens || 0;
      } catch (e) { console.error(`[athenaeum] page ${i + 1} transcription failed:`, e.message); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, n) }, worker));
  recordLlmUsage(LLM_PDF_MODEL, inTok, outTok);

  // assemble: page text + inlined figures (charts always; designed exhibits only
  // when the model did not already transcribe that exhibit as a table)
  const parts = [];
  for (let i = 0; i < n; i++) {
    const md = pageMd[i] || '';
    const pf = figs[String(i)] || [];
    const hasTable = /(^|\n)\s*\|.*\|/.test(md);
    const keep = pf.filter((f) => f.type === 'chart' || f.type === 'image' || !hasTable);
    const block = [md, keep.map((f) => `![](${f.img})`).join('\n\n')].filter(Boolean).join('\n\n');
    if (block.trim()) parts.push(block);
  }

  // the full-page render images were only needed for transcription
  try {
    for (const f of fs.readdirSync(imagesDir)) {
      if (/^page-\d+\.png$/.test(f)) fs.rmSync(path.join(imagesDir, f), { force: true });
    }
  } catch {}

  if (!parts.length) throw new Error('no pages transcribed');
  const markdown = relevelLlmHeadings(parts.join('\n\n'));
  const title = (markdown.match(/^#\s+(.+)$/m) || [])[1] || prep.title || '';
  const { marked } = await import('marked');
  const html = marked.parse(markdown, { mangle: false, headerIds: false });
  return { html, title: title.trim(), warnings: prep.warnings || [], pages: n, cover: prep.cover || null, author: prep.author || '' };
}

// ----- AI summary (Anthropic API, user-provided key) ------------------------

function apiKey() {
  return process.env.ANTHROPIC_API_KEY || loadConfig().anthropicApiKey || '';
}

async function generateSummary(text) {
  const key = apiKey();
  if (!key || !text || text.length < 200) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: 'Summarize this document in 2 to 3 sentences for a reading-app cover card. Also identify: ' +
            '"author" (the writer(s), if named), and "source" (the publishing organization, company, or website it came from, as a SHORT clean name — e.g. "McKinsey & Company", "PitchBook", "The New York Times" — not a sentence). ' +
            'Respond with ONLY a JSON object: {"summary": "...", "author": "...", "source": "..."}. No preamble.\n\nDOCUMENT:\n' + text.slice(0, 12000)
        }]
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.usage) recordLlmUsage('claude-haiku-4-5-20251001', data.usage.input_tokens, data.usage.output_tokens);
    const txt = (data.content && data.content[0] && data.content[0].text) || '';
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    return { summary: txt.trim().slice(0, 600), author: '' };
  } catch { return null; }
}

// ----- ingest orchestration -------------------------------------------------

const EXT_TYPE = { '.pdf': 'pdf', '.docx': 'docx', '.htm': 'html', '.html': 'html' };

async function ingestFile(srcPath) {
  ensureStore();
  const ext = path.extname(srcPath).toLowerCase();
  const sourceType = EXT_TYPE[ext];
  if (!sourceType) throw new Error('Unsupported file type: ' + ext);

  const fallbackTitle = path.basename(srcPath, ext);
  const id = uniqueId(fallbackTitle);
  const folder = path.join(articlesDir(), id);
  const imagesDir = path.join(folder, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });

  // preserve the original
  fs.copyFileSync(srcPath, path.join(folder, 'original' + ext));

  let conv;
  try {
    if (sourceType === 'docx') conv = await convertDocx(srcPath, imagesDir);
    else if (sourceType === 'html') conv = await convertHtml(srcPath, imagesDir);
    else conv = await convertPdf(srcPath, imagesDir);
  } catch (e) {
    // don't leave a half-written article folder behind
    fs.rmSync(folder, { recursive: true, force: true });
    throw e;
  }

  const fragment = normalizeFragment(conv.html);
  fs.writeFileSync(path.join(folder, 'article.html'), fragment, 'utf-8');

  const title = (conv.title || firstHeading(fragment) || fallbackTitle).trim();
  const words = countWords(fragment);
  const imageCount = (fragment.match(/<img/gi) || []).length;

  // cover (already written into the folder by the converter) + AI summary
  const plain = fragment.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const ai = await generateSummary(plain);

  const meta = {
    version: 1,
    id,
    title,
    tags: parseTags(title),
    sourceType,
    originalFile: 'original' + ext,
    cover: conv.cover || null,
    author: (ai && ai.author) || conv.author || '',
    source: (ai && ai.source) || '',
    summary: (ai && ai.summary) || null,
    wordCount: words,
    readMinutes: Math.max(1, Math.ceil(words / 225)),
    imageCount,
    pageCount: conv.pages || null,
    rating: null,
    read: false,
    readAt: null,
    ingestedAt: new Date().toISOString(),
    timeSpentSeconds: 0,
    lastReadAt: null,
    conversion: { tool: sourceType, ok: true, warnings: conv.warnings || [] }
  };
  fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
  fs.writeFileSync(
    path.join(folder, 'annotations.json'),
    JSON.stringify({ version: 1, articleId: id, textAnnotations: [], imageAnnotations: [] }, null, 2),
    'utf-8'
  );
  return meta;
}

// Ingest a web link. Mirrors ingestFile() but fetches/extracts from a URL and
// records the source URL so "open original" can return to the live page.
async function ingestUrl(rawUrl) {
  ensureStore();
  let url = (rawUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    if (/^[\w-]+(\.[\w-]+)+/.test(url)) url = 'https://' + url; // bare domain → https
    else throw new Error('Enter a valid web address (http:// or https://).');
  }
  try { new URL(url); } catch { throw new Error('That does not look like a valid URL.'); }

  let host = 'web-article';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch {}
  const id = uniqueId(host);
  const folder = path.join(articlesDir(), id);
  const imagesDir = path.join(folder, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });

  let conv;
  try {
    conv = await convertUrl(url, imagesDir);
    // preserve the original page exactly as fetched
    fs.writeFileSync(path.join(folder, 'original.html'), conv.rawPage, 'utf-8');
  } catch (e) {
    fs.rmSync(folder, { recursive: true, force: true });
    throw e;
  }

  // grab the publishing site's logo (best candidate that actually downloads)
  let siteLogo = null;
  for (const cand of conv.logoCandidates || []) {
    siteLogo = await saveLogo(cand, imagesDir);
    if (siteLogo) break;
  }

  const fragment = normalizeFragment(conv.html);
  fs.writeFileSync(path.join(folder, 'article.html'), fragment, 'utf-8');

  const title = (conv.title || firstHeading(fragment) || host).trim();
  const words = countWords(fragment);
  const imageCount = (fragment.match(/<img/gi) || []).length;

  const plain = fragment.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const ai = await generateSummary(plain);

  const meta = {
    version: 1,
    id,
    title,
    tags: parseTags(title),
    sourceType: 'url',
    originalFile: 'original.html',
    sourceUrl: url,
    siteName: conv.siteName || host,
    siteLogo,
    cover: null,
    author: (ai && ai.author) || conv.author || '',
    source: (ai && ai.source) || conv.siteName || host,
    summary: (ai && ai.summary) || conv.excerpt || null,
    wordCount: words,
    readMinutes: Math.max(1, Math.ceil(words / 225)),
    imageCount,
    pageCount: null,
    rating: null,
    ingestedAt: new Date().toISOString(),
    timeSpentSeconds: 0,
    lastReadAt: null,
    conversion: { tool: 'url', ok: true, warnings: conv.warnings || [] }
  };
  fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
  fs.writeFileSync(
    path.join(folder, 'annotations.json'),
    JSON.stringify({ version: 1, articleId: id, textAnnotations: [], imageAnnotations: [] }, null, 2),
    'utf-8'
  );
  return meta;
}

function fileUrl(p) { return 'file://' + encodeURI(p.replace(/\\/g, '/')); }

function listArticles() {
  ensureStore();
  const dir = articlesDir();
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const folder = path.join(dir, name);
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(folder, 'meta.json'), 'utf-8')); } catch { continue; }
    // library thumbnail: a web article's site logo/favicon, else a PDF's rendered
    // front page (cover). Resolved to an absolute file:// url the list can render.
    const icon = (meta.sourceType === 'url' && meta.siteLogo) ? meta.siteLogo : (meta.cover || null);
    meta.iconUrl = (icon && fs.existsSync(path.join(folder, icon))) ? fileUrl(path.join(folder, icon)) : null;
    out.push(meta);
  }
  out.sort((a, b) => (b.ingestedAt || '').localeCompare(a.ingestedAt || ''));
  return out;
}

// ----- IPC ------------------------------------------------------------------

ipcMain.handle('get-config', () => ({ libraryPath: libraryRoot() }));

ipcMain.handle('set-library-path', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  if (res.canceled || !res.filePaths[0]) return { libraryPath: libraryRoot() };
  const cfg = loadConfig(); cfg.libraryPath = path.join(res.filePaths[0], 'Athenaeum');
  saveConfig(cfg); ensureStore();
  return { libraryPath: libraryRoot() };
});

async function ingestPaths(filePaths) {
  const added = [], errors = [];
  for (const fp of filePaths) {
    if (!EXT_TYPE[path.extname(fp).toLowerCase()]) {
      errors.push({ file: path.basename(fp), message: 'Unsupported file type' });
      continue;
    }
    try { added.push(await ingestFile(fp)); }
    catch (e) { errors.push({ file: path.basename(fp), message: e.message }); }
  }
  return { added, errors };
}

ipcMain.handle('pick-and-ingest', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showOpenDialog(win, {
    title: 'Add to Athenaeum',
    buttonLabel: 'Add',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Documents', extensions: ['pdf', 'docx', 'html', 'htm'] }]
  });
  if (res.canceled || !res.filePaths.length) return { added: [], errors: [] };
  return ingestPaths(res.filePaths);
});

// drag-and-drop: the renderer resolves dropped File objects to absolute paths
ipcMain.handle('ingest-paths', (_, paths) => ingestPaths(Array.isArray(paths) ? paths : []));

ipcMain.handle('ingest-url', async (_, url) => {
  try { return { added: [await ingestUrl(url)], errors: [] }; }
  catch (e) { return { added: [], errors: [{ file: url, message: e.message }] }; }
});

ipcMain.handle('list-articles', () => listArticles());

// Full-text search across the library. Ranks matches in the reader's own
// annotations — comments first, then highlighted passages — above matches in the
// article body, so a search surfaces what the user marked up before raw content.
function snippetAround(text, q, pad = 90) {
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return text.slice(0, pad * 2);
  const s = Math.max(0, i - pad), e = Math.min(text.length, i + q.length + pad);
  return (s > 0 ? '…' : '') + text.slice(s, e).trim() + (e < text.length ? '…' : '');
}
ipcMain.handle('search-articles', (_, query) => {
  ensureStore();
  const raw = String(query || '').trim();
  const q = raw.toLowerCase();
  if (q.length < 2) return [];
  const dir = articlesDir();
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  for (const id of names) {
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, id, 'meta.json'), 'utf-8')); } catch { continue; }
    let ann = { textAnnotations: [], imageAnnotations: [] };
    try { ann = JSON.parse(fs.readFileSync(path.join(dir, id, 'annotations.json'), 'utf-8')); } catch {}
    let content = '';
    try {
      content = fs.readFileSync(path.join(dir, id, 'article.html'), 'utf-8')
        .replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
    } catch {}
    const title = meta.title || '';

    let commentHit = null, hlHit = null, commentCount = 0, hlCount = 0;
    for (const a of (ann.textAnnotations || [])) {
      const note = a.comment || '';
      const passage = (a.anchor && a.anchor.exact) || '';
      if (note && note.toLowerCase().includes(q)) {
        commentCount++;
        if (!commentHit) commentHit = { id: a.id, text: note };
      } else if (passage && passage.toLowerCase().includes(q)) {
        hlCount++;
        if (!hlHit) hlHit = { id: a.id, text: passage };
      }
    }
    for (const a of (ann.imageAnnotations || [])) {
      if (a.comment && a.comment.toLowerCase().includes(q)) {
        commentCount++;
        if (!commentHit) commentHit = { id: a.id, text: a.comment };
      }
    }
    const titleHit = title.toLowerCase().includes(q);
    const contentHit = content.toLowerCase().includes(q);
    if (!commentHit && !hlHit && !titleHit && !contentHit) continue;

    let matchType, snippet, target, base;
    if (commentHit) { matchType = 'comment'; base = 1000; snippet = snippetAround(commentHit.text, q); target = { annoId: commentHit.id }; }
    else if (hlHit) { matchType = 'highlight'; base = 600; snippet = snippetAround(hlHit.text, q); target = { annoId: hlHit.id }; }
    else if (titleHit) { matchType = 'title'; base = 400; snippet = ''; target = { text: raw }; }
    else { matchType = 'content'; base = 100; snippet = snippetAround(content, q); target = { text: raw }; }

    const icon = (meta.sourceType === 'url' && meta.siteLogo) ? meta.siteLogo : (meta.cover || null);
    const iconUrl = (icon && fs.existsSync(path.join(dir, id, icon))) ? fileUrl(path.join(dir, id, icon)) : null;
    out.push({
      id, title, tags: meta.tags || [], sourceType: meta.sourceType || 'doc',
      iconUrl, siteName: meta.siteName || '', source: meta.source || '', author: meta.author || '',
      matchType, snippet, target,
      counts: { comments: commentCount, highlights: hlCount },
      score: base + commentCount * 25 + hlCount * 12 + (contentHit ? 1 : 0)
    });
  }
  out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return out;
});

ipcMain.handle('get-stats', () => {
  ensureStore();
  const dir = articlesDir();
  let count = 0, readMinutes = 0, spentSeconds = 0, highlights = 0, comments = 0;
  for (const name of fs.readdirSync(dir)) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, name, 'meta.json'), 'utf-8'));
      count++;
      readMinutes += meta.readMinutes || 0;
      spentSeconds += meta.timeSpentSeconds || 0;
    } catch {}
    try {
      const ann = JSON.parse(fs.readFileSync(path.join(dir, name, 'annotations.json'), 'utf-8'));
      for (const a of ann.textAnnotations || []) {
        if (a.type === 'comment') comments++; else highlights++;
      }
      comments += (ann.imageAnnotations || []).length; // image notes are comments too
    } catch {}
  }
  const llm = loadConfig().llmUsage || {};
  return { count, readMinutes, spentSeconds, highlights, comments, llmCost: llm.cost || 0 };
});

ipcMain.handle('read-article-html', (_, id) => {
  const fp = path.join(articlesDir(), id, 'article.html');
  return fs.existsSync(fp) ? fs.readFileSync(fp, 'utf-8') : '';
});

ipcMain.handle('article-base', (_, id) => path.join(articlesDir(), id) + path.sep);

ipcMain.handle('read-meta', (_, id) => {
  try { return JSON.parse(fs.readFileSync(path.join(articlesDir(), id, 'meta.json'), 'utf-8')); }
  catch { return null; }
});

ipcMain.handle('update-meta', (_, id, patch) => {
  const fp = path.join(articlesDir(), id, 'meta.json');
  const meta = JSON.parse(fs.readFileSync(fp, 'utf-8'));
  Object.assign(meta, patch);
  if (Object.prototype.hasOwnProperty.call(patch, 'title')) meta.tags = parseTags(meta.title);
  fs.writeFileSync(fp, JSON.stringify(meta, null, 2), 'utf-8');
  return meta;
});

ipcMain.handle('add-read-time', (_, id, seconds) => {
  const fp = path.join(articlesDir(), id, 'meta.json');
  try {
    const meta = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    meta.timeSpentSeconds = (meta.timeSpentSeconds || 0) + Math.round(seconds);
    meta.lastReadAt = new Date().toISOString();
    fs.writeFileSync(fp, JSON.stringify(meta, null, 2), 'utf-8');
    return meta.timeSpentSeconds;
  } catch { return 0; }
});

ipcMain.handle('delete-article', (_, id) => {
  fs.rmSync(path.join(articlesDir(), id), { recursive: true, force: true });
  return true;
});

ipcMain.handle('read-annotations', (_, id) => {
  const fp = path.join(articlesDir(), id, 'annotations.json');
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); }
  catch { return { version: 1, articleId: id, textAnnotations: [], imageAnnotations: [] }; }
});

ipcMain.handle('write-annotations', (_, id, data) => {
  fs.writeFileSync(path.join(articlesDir(), id, 'annotations.json'), JSON.stringify(data, null, 2), 'utf-8');
  return true;
});

ipcMain.handle('get-annotations-mtime', (_, id) => {
  try { return fs.statSync(path.join(articlesDir(), id, 'annotations.json')).mtimeMs; } catch { return 0; }
});

ipcMain.handle('read-quotes', () => {
  ensureStore();
  try { return JSON.parse(fs.readFileSync(quotesFile(), 'utf-8')); }
  catch { return { version: 1, quotes: [] }; }
});

ipcMain.handle('write-quotes', (_, data) => {
  ensureStore();
  fs.writeFileSync(quotesFile(), JSON.stringify(data, null, 2), 'utf-8');
  return true;
});

ipcMain.handle('open-original', (_, id) => {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(articlesDir(), id, 'meta.json'), 'utf-8'));
    // web links reopen the live page; files open the preserved original
    if (meta.sourceType === 'url' && meta.sourceUrl) { shell.openExternal(meta.sourceUrl); return; }
    shell.openPath(path.join(articlesDir(), id, meta.originalFile));
  } catch {}
});

ipcMain.handle('open-external', (_, url) => shell.openExternal(url));

ipcMain.handle('has-api-key', () => !!apiKey());

ipcMain.handle('set-api-key', (_, key) => {
  const cfg = loadConfig();
  cfg.anthropicApiKey = (key || '').trim();
  saveConfig(cfg);
  return !!cfg.anthropicApiKey;
});

ipcMain.handle('regenerate-summary', async (_, id) => {
  const folder = path.join(articlesDir(), id);
  const metaPath = path.join(folder, 'meta.json');
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    const fragment = fs.readFileSync(path.join(folder, 'article.html'), 'utf-8');
    const plain = fragment.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const ai = await generateSummary(plain);
    if (ai) {
      if (ai.summary) meta.summary = ai.summary;
      if (ai.author) meta.author = ai.author;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
    }
    return meta;
  } catch { return null; }
});

ipcMain.handle('copy-image', (_, absPath) => {
  try {
    const img = nativeImage.createFromPath(absPath);
    if (img.isEmpty()) return false;
    clipboard.writeImage(img);
    return true;
  } catch { return false; }
});

// ----- window ---------------------------------------------------------------

function buildMenu(win) {
  const template = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { label: 'Add Document…', accelerator: 'CmdOrCtrl+O', click: () => win.webContents.send('menu', 'add') },
        { label: 'Add Link…', accelerator: 'CmdOrCtrl+L', click: () => win.webContents.send('menu', 'addurl') },
        { label: 'Change Library Folder…', click: () => win.webContents.send('menu', 'library') },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false // allow file:// images from the article folder
    }
  });
  ensureStore();
  buildMenu(win);

  // Links inside articles must never hijack the app window (which would strand
  // the reader with no way back). Keep file:// (the app shell) in-window and
  // send every web link to the user's default browser instead.
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file://')) return; // the app shell itself
    e.preventDefault();
    shell.openExternal(url); // http/https/mailto — sanitizer already blocks the rest
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(path.join(__dirname, 'reader.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
