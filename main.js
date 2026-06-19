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
    if (/^\d{1,2}(["“'']|[A-Z])/.test(t) && (el.tagName === 'BLOCKQUOTE' || t.length < 400)) {
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

async function convertPdf(srcPath, imagesDir) {
  const py = pythonBin();
  if (!fs.existsSync(py)) {
    throw new Error('PDF support is not installed. Run `npm run setup` to build the Python environment.');
  }
  const outDir = path.dirname(imagesDir); // article folder; script writes into images/
  const result = await new Promise((resolve, reject) => {
    const child = spawn(py, [pdfScript(), srcPath, outDir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('PDF conversion timed out')); }, 120000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('PDF conversion failed: ' + err.slice(0, 400)));
      try { resolve(JSON.parse(out)); } catch (e) { reject(new Error('Bad converter output: ' + e.message)); }
    });
  });

  if (result.mode === 'pages') {
    // scanned / text-empty PDF: page images already written to images/
    const figs = result.images.map((src) => `<figure><img src="${src}" alt=""></figure>`).join('\n');
    return { html: figs, title: result.title || '', warnings: ['Image-only PDF: text was not extracted.'], pages: result.pageCount, cover: result.cover || null, author: result.author || '' };
  }

  const { marked } = await import('marked');
  const html = marked.parse(result.markdown || '', { mangle: false, headerIds: false });
  return { html, title: result.title || '', warnings: result.warnings || [], pages: result.pageCount, cover: result.cover || null, author: result.author || '' };
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
          content: 'Summarize this document in 2 to 3 sentences for a reading-app cover card, and identify the author or publishing source. ' +
            'Respond with ONLY a JSON object: {"summary": "...", "author": "..."}. No preamble.\n\nDOCUMENT:\n' + text.slice(0, 12000)
        }]
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
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
    summary: (ai && ai.summary) || null,
    wordCount: words,
    readMinutes: Math.max(1, Math.ceil(words / 225)),
    imageCount,
    pageCount: conv.pages || null,
    rating: null,
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

function listArticles() {
  ensureStore();
  const dir = articlesDir();
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const mp = path.join(dir, name, 'meta.json');
    try { out.push(JSON.parse(fs.readFileSync(mp, 'utf-8'))); } catch {}
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

ipcMain.handle('pick-and-ingest', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showOpenDialog(win, {
    title: 'Add to Athenaeum',
    buttonLabel: 'Add',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Documents', extensions: ['pdf', 'docx', 'html', 'htm'] }]
  });
  if (res.canceled || !res.filePaths.length) return { added: [], errors: [] };
  const added = [], errors = [];
  for (const fp of res.filePaths) {
    try { added.push(await ingestFile(fp)); }
    catch (e) { errors.push({ file: path.basename(fp), message: e.message }); }
  }
  return { added, errors };
});

ipcMain.handle('ingest-url', async (_, url) => {
  try { return { added: [await ingestUrl(url)], errors: [] }; }
  catch (e) { return { added: [], errors: [{ file: url, message: e.message }] }; }
});

ipcMain.handle('list-articles', () => listArticles());

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
  return { count, readMinutes, spentSeconds, highlights, comments };
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
