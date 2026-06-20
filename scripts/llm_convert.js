#!/usr/bin/env node
/* Spike: LLM-powered PDF -> clean reading view, for quality comparison against the
 * heuristic pipeline. Renders each PDF page to an image, asks Claude (vision) to
 * transcribe it into clean reading-order Markdown, stitches the pages, runs the
 * SAME normalizeFragment pipeline as the app, and writes the result into the
 * library as a parallel entry ("… — LLM test") so it can be opened side-by-side
 * with the current conversion.
 *
 * Usage: node scripts/llm_convert.js <slug-substring>
 * Reads the Anthropic key from the app's config.json (the secure store the
 * in-app "Add Anthropic API key" flow writes to) or ANTHROPIC_API_KEY.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PYBIN = path.join(ROOT, 'resources', 'pyenv', 'bin', 'python3');
const LIBRARY = path.join(os.homedir(),
  'Library/Mobile Documents/com~apple~CloudDocs/Athenaeum/library');
const CONFIG = path.join(os.homedir(), 'Library/Application Support/athenaeum/config.json');
const MODEL = 'claude-haiku-4-5';
const PRICE = { 'claude-haiku-4-5': [1, 5], 'claude-sonnet-4-6': [3, 15], 'claude-opus-4-8': [5, 25] };
const DPI = 170;

function apiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf-8')).anthropicApiKey || ''; }
  catch { return ''; }
}

// ---- normalizeFragment, copied verbatim from main.js (keep in sync) ----------
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
    allowedTags: ['h1', 'h2', 'h3', 'p', 'blockquote', 'ul', 'ol', 'li', 'figure', 'img',
      'figcaption', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'em', 'strong', 'a', 'code', 'pre', 'br', 'hr'],
    allowedAttributes: { a: ['href'], img: ['src', 'alt'] },
    allowedSchemes: ['http', 'https', 'mailto', 'file'],
    transformTags: { h4: 'h3', h5: 'h3', h6: 'h3', b: 'strong', i: 'em', div: 'p', span: 'p' }
  });
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(`<body>${clean}</body>`);
  const doc = dom.window.document;
  doc.querySelectorAll('img').forEach((img) => {
    if (img.closest('figure')) return;
    const fig = doc.createElement('figure');
    img.replaceWith(fig); fig.appendChild(img);
    const alt = (img.getAttribute('alt') || '').trim();
    if (alt) { const cap = doc.createElement('figcaption'); cap.textContent = alt; fig.appendChild(cap); }
  });
  pruneTables(doc);
  doc.querySelectorAll('p').forEach((p) => { if (!p.textContent.trim() && !p.querySelector('img')) p.remove(); });
  doc.querySelectorAll('blockquote, p').forEach((el) => {
    const t = el.textContent.trim();
    if (/^\d{1,2} ?(["“''’]|[A-Z])/.test(t) && (el.tagName === 'BLOCKQUOTE' || t.length < 400)) {
      el.classList.add('cite');
      const first = el.firstChild;
      if (first && first.nodeType === 3) first.nodeValue = first.nodeValue.replace(/^(\s*)(\d{1,2})(?=["“''’A-Za-z])/, '$1$2 ');
    }
  });
  return doc.body.innerHTML.trim();
}
function countWords(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').split(/\s+/).filter(Boolean).length;
}

// ---- prep: render page images + figure rasters via bundled PyMuPDF -----------
function prep(src, outDir) {
  return new Promise((resolve, reject) => {
    const c = spawn(PYBIN, [path.join(ROOT, 'resources', 'py', 'pdf_to_html.py'), src, outDir, '--prep-llm'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', d => out += d); c.stderr.on('data', d => err += d);
    c.on('close', code => {
      if (code !== 0) return reject(new Error('prep failed: ' + err.slice(0, 300)));
      try { resolve(JSON.parse(out)); } catch (e) { reject(new Error('bad prep output: ' + e.message)); }
    });
  });
}

const PROMPT = `You are transcribing one page of a PDF into clean, readable Markdown for a reading app. The real chart/figure images from this page are added separately, so your job is the TEXT. Rules:
- Output ONLY Markdown for this page — no preamble, no commentary, no code fences.
- Reproduce the page's text in natural reading order.
- Reserve a single # for the document's main title (first page only). Use ## ONLY for the document's genuine section titles — the handful you would list in a table of contents — and ### for real subsections. Do NOT make headings out of figure/exhibit captions, statistics, pull quotes, or short callout phrases; render those as normal text. Body text as normal paragraphs. Lists as - or 1.. Block quotes with >.
- If a page is a stand-alone table of contents / index (section titles with page numbers), skip it entirely — output nothing for it; the app builds its own contents.
- Render genuine data tables, and any "Exhibit/Figure" that is fundamentally a data matrix or list, as a GitHub Markdown table or list. Keep the exhibit's title/caption as a heading above it.
- For a purely visual chart, diagram, photo, or decorative graphic: do NOT describe it and do NOT emit a placeholder — omit it entirely. The actual image will be inlined separately.
- Render footnote/citation definitions as plain paragraphs that begin with the number then a space then the source, e.g. "7 Hannah Mayer, "Superagency in the workplace," McKinsey, 2025." Keep inline citation markers as plain numbers.
- Omit running headers, footers, page numbers, and standalone copyright / source-watermark lines that repeat across pages.
- Do not invent or summarize — transcribe what is actually on the page. If the page has no real text (cover art, full-bleed graphic), output nothing.`;

// keep the first <h1> (document title); demote later page-level h1s to h2
function relevelHeadings(md) {
  let seen = false;
  return md.replace(/^(#{1,6})\s+(.*)$/gm, (m, hashes, text) => {
    if (hashes === '#') {
      if (!seen) { seen = true; return m; }
      return '## ' + text;
    }
    return m;
  });
}

async function transcribePage(key, pngPath) {
  const data = fs.readFileSync(pngPath).toString('base64');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
          { type: 'text', text: PROMPT }
        ]
      }]
    })
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const txt = (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return { md: txt.trim(), usage: json.usage || {} };
}

async function main() {
  const key = apiKey();
  if (!key) {
    console.error('No Anthropic API key found. Add it in the app (document opener → "Add Anthropic API key"),');
    console.error('or run with ANTHROPIC_API_KEY=... node scripts/llm_convert.js <slug>');
    process.exit(1);
  }
  const filter = process.argv[2] || 'seizing';
  const srcFolder = fs.readdirSync(LIBRARY).map(d => path.join(LIBRARY, d))
    .find(d => d.includes(filter) && !d.includes('zz-llm') && fs.existsSync(path.join(d, 'original.pdf')));
  if (!srcFolder) { console.error('No matching article with original.pdf for filter:', filter); process.exit(1); }

  const srcId = path.basename(srcFolder);
  const src = path.join(srcFolder, 'original.pdf');
  const destId = 'zz-llm-' + srcId.replace(/^\d{4}-\d{4}-/, '');
  const dest = path.join(LIBRARY, destId);
  const imagesDir = path.join(dest, 'images');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(imagesDir, { recursive: true });
  fs.copyFileSync(src, path.join(dest, 'original.pdf'));

  console.log(`Rendering pages + figures of ${srcId}…`);
  const prepRes = await prep(src, dest);   // writes images/page-*.png + images/fig-*.png into dest
  const n = prepRes.pageCount;
  const figs = prepRes.figures || {};
  if (fs.existsSync(path.join(imagesDir, 'page-001.png')))
    fs.copyFileSync(path.join(imagesDir, 'page-001.png'), path.join(imagesDir, 'cover.png'));

  console.log(`Transcribing ${n} pages with ${MODEL}…`);
  const parts = [];
  let inTok = 0, outTok = 0;
  for (let i = 0; i < n; i++) {
    const png = path.join(dest, prepRes.pageImages[i] || `images/page-${String(i + 1).padStart(3, '0')}.png`);
    let md = '';
    try {
      const r = await transcribePage(key, png);
      md = r.md; inTok += r.usage.input_tokens || 0; outTok += r.usage.output_tokens || 0;
    } catch (e) { console.error(`\n  page ${i + 1} failed: ${e.message}`); }

    // inline the real figure images: always for pure-visual 'chart's; for designed
    // 'exhibit's only when the model did NOT already transcribe it as a table.
    const pageFigs = figs[String(i)] || [];
    const hasTable = /(^|\n)\s*\|.*\|/.test(md);
    const keep = pageFigs.filter(f => f.type === 'chart' || !hasTable);
    const imgMd = keep.map(f => `![](${f.img})`).join('\n\n');
    const block = [md, imgMd].filter(Boolean).join('\n\n');
    if (block.trim()) parts.push(block);
    process.stdout.write(`  page ${i + 1}/${n} (${md.length} chars, ${keep.length} figs)   \r`);
  }
  console.log('');
  // page images were only needed for transcription; keep cover + figure rasters
  for (const f of fs.readdirSync(imagesDir)) {
    if (/^page-\d+\.png$/.test(f)) fs.rmSync(path.join(imagesDir, f), { force: true });
  }

  const markdown = relevelHeadings(parts.join('\n\n'));
  const { marked } = await import('marked');
  const html = marked.parse(markdown, { mangle: false, headerIds: false });
  const fragment = normalizeFragment(html);
  fs.writeFileSync(path.join(dest, 'article.html'), fragment, 'utf-8');

  // metadata + title
  let title = (markdown.match(/^#\s+(.+)$/m) || [])[1] || srcId;
  let srcMeta = {};
  try { srcMeta = JSON.parse(fs.readFileSync(path.join(srcFolder, 'meta.json'), 'utf-8')); } catch {}
  const words = countWords(fragment);
  const meta = {
    version: 1, id: destId, title: title.trim() + ' — LLM test',
    tags: ['llm-test'], sourceType: 'pdf', originalFile: 'original.pdf',
    cover: 'images/cover.png', author: srcMeta.author || '', summary: null,
    wordCount: words, readMinutes: Math.max(1, Math.ceil(words / 225)),
    imageCount: (fragment.match(/<img/gi) || []).length, pageCount: n,
    rating: null, read: false, readAt: null,
    ingestedAt: new Date().toISOString(), timeSpentSeconds: 0, lastReadAt: null,
    conversion: { tool: 'llm-vision', model: MODEL, ok: true, warnings: [] }
  };
  fs.writeFileSync(path.join(dest, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
  fs.writeFileSync(path.join(dest, 'annotations.json'),
    JSON.stringify({ version: 1, articleId: destId, textAnnotations: [], imageAnnotations: [] }, null, 2), 'utf-8');

  const [pin, pout] = PRICE[MODEL] || [5, 25];
  const cost = inTok / 1e6 * pin + outTok / 1e6 * pout;
  console.log(`\nDone → "${meta.title}"`);
  console.log(`  ${n} pages, ${words} words, ${meta.imageCount} figures, ${(fragment.match(/<table/gi) || []).length} tables`);
  console.log(`  tokens: ${inTok} in / ${outTok} out  (~$${cost.toFixed(2)} on ${MODEL})`);
  console.log(`  Open "${meta.title}" in the app to compare against the current "${srcMeta.title || srcId}".`);
}

main().catch(e => { console.error(e); process.exit(1); });
