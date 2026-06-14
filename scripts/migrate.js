#!/usr/bin/env node
/* Dev-only: re-run the PDF converter over already-imported library articles and
 * rebuild article.html in place, without re-importing (preserves id, meta,
 * annotations). Chart/image filenames are deterministic, so existing image
 * references stay valid. Usage: node scripts/migrate.js [slug-substring] */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PYBIN = path.join(ROOT, 'resources', 'pyenv', 'bin', 'python3');
const PYSCRIPT = path.join(ROOT, 'resources', 'py', 'pdf_to_html.py');
const LIBRARY = path.join(
  os.homedir(),
  'Library/Mobile Documents/com~apple~CloudDocs/Athenaeum/library'
);

// ---- conversion helpers copied verbatim from main.js (must stay in sync) ----
function pruneTables(doc) {
  doc.querySelectorAll('table').forEach((table) => {
    let rows = [...table.querySelectorAll('tr')];
    if (!rows.length) { table.remove(); return; }
    const ncol = Math.max(...rows.map((r) => r.children.length));
    for (let c = ncol - 1; c >= 0; c--) {
      const colEmpty = rows.every((r) => !r.children[c] || !r.children[c].textContent.trim());
      if (colEmpty) rows.forEach((r) => { if (r.children[c]) r.children[c].remove(); });
    }
    rows.forEach((r) => { if (![...r.children].some((c) => c.textContent.trim())) r.remove(); });
    rows = [...table.querySelectorAll('tr')];
    if (!rows.length || !rows.some((r) => r.textContent.trim())) { table.remove(); return; }
    if (Math.max(...rows.map((r) => r.children.length)) <= 1) {
      rows.forEach((r) => {
        const txt = r.textContent.trim();
        if (txt) { const p = doc.createElement('p'); p.textContent = txt; table.parentNode.insertBefore(p, table); }
      });
      table.remove();
    }
  });
}

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
  });
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
  pruneTables(doc);
  doc.querySelectorAll('p').forEach((p) => {
    if (!p.textContent.trim() && !p.querySelector('img')) p.remove();
  });
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

function countWords(html) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ');
  return text.split(/\s+/).filter(Boolean).length;
}

function runPython(src, outDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYBIN, [PYSCRIPT, src, outDir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error('converter failed: ' + err.slice(0, 400)));
      try { resolve(JSON.parse(out)); } catch (e) { reject(new Error('bad output: ' + e.message)); }
    });
  });
}

async function migrate(folder) {
  const id = path.basename(folder);
  const src = path.join(folder, 'original.pdf');
  if (!fs.existsSync(src)) { console.log(`  skip ${id} (no original.pdf)`); return; }
  const imagesDir = path.join(folder, 'images');
  // clear generated images so stale charts don't linger; converter regenerates
  fs.rmSync(imagesDir, { recursive: true, force: true });
  fs.mkdirSync(imagesDir, { recursive: true });

  const result = await runPython(src, folder);
  const { marked } = await import('marked');
  const html = result.mode === 'pages'
    ? result.images.map((s) => `<figure><img src="${s}" alt=""></figure>`).join('\n')
    : marked.parse(result.markdown || '', { mangle: false, headerIds: false });
  const fragment = normalizeFragment(html);
  fs.writeFileSync(path.join(folder, 'article.html'), fragment, 'utf-8');

  // refresh derived metadata used by the stats dashboard
  const metaPath = path.join(folder, 'meta.json');
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    meta.wordCount = countWords(fragment);
    meta.imageCount = (fragment.match(/<img/gi) || []).length;
    meta.readMinutes = Math.max(1, Math.ceil(meta.wordCount / 225));
    if (result.cover) meta.cover = result.cover;
    if (result.author && !meta.author) meta.author = result.author;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
  }
  console.log(`  rebuilt ${id}: ${countWords(fragment)} words, ${(fragment.match(/<img/gi) || []).length} images, ${(fragment.match(/<table/gi) || []).length} tables`);
}

(async () => {
  const filter = process.argv[2] || '';
  const folders = fs.readdirSync(LIBRARY)
    .map((d) => path.join(LIBRARY, d))
    .filter((d) => fs.statSync(d).isDirectory() && d.includes(filter));
  console.log(`Re-migrating ${folders.length} article(s)...`);
  for (const f of folders) {
    try { await migrate(f); }
    catch (e) { console.error(`  FAILED ${path.basename(f)}: ${e.message}`); }
  }
  console.log('Done.');
})();
