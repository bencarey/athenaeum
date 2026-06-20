#!/usr/bin/env node
/* Reprocess already-imported PDFs through the LLM-vision hybrid pipeline, IN PLACE.
 * Rebuilds article.html + figures and refreshes derived meta, while preserving id,
 * tags, rating, read-state, annotations, and ingest date. Stale heuristic images
 * (chart-*, original.pdf-*) no longer referenced by the new article are removed.
 *
 * Usage: node scripts/reprocess_llm.js [slug-substring]
 * Reads the Anthropic key from the app's config.json (or ANTHROPIC_API_KEY) and
 * records spend into config.llmUsage so the home-page cost meter stays accurate.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PYBIN = path.join(ROOT, 'resources', 'pyenv', 'bin', 'python3');
const PYSCRIPT = path.join(ROOT, 'resources', 'py', 'pdf_to_html.py');
const LIBRARY = path.join(os.homedir(),
  'Library/Mobile Documents/com~apple~CloudDocs/Athenaeum/library');
const CONFIG = path.join(os.homedir(), 'Library/Application Support/athenaeum/config.json');
const MODEL = 'claude-haiku-4-5';
const PRICE = { 'claude-haiku-4-5': [1, 5], 'claude-sonnet-4-6': [3, 15], 'claude-opus-4-8': [5, 25] };

function loadConfig() { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf-8')); } catch { return {}; } }
function apiKey() { return process.env.ANTHROPIC_API_KEY || loadConfig().anthropicApiKey || ''; }
function recordUsage(inTok, outTok) {
  const cfg = loadConfig();
  const u = cfg.llmUsage || { inputTokens: 0, outputTokens: 0, cost: 0, calls: 0 };
  const [pin, pout] = PRICE[MODEL] || [1, 5];
  u.inputTokens += inTok; u.outputTokens += outTok;
  u.cost += inTok / 1e6 * pin + outTok / 1e6 * pout; u.calls += 1;
  cfg.llmUsage = u;
  try { fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), 'utf-8'); } catch {}
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

const PROMPT = `You are transcribing one page of a PDF into clean, readable Markdown for a reading app. The real chart/figure images from this page are added separately, so your job is the TEXT. Rules:
- Output ONLY Markdown for this page — no preamble, no commentary, no code fences.
- Reproduce the page's text in natural reading order.
- Reserve a single # for the document's main title (first page only). Use ## ONLY for the document's genuine section titles — the handful you would list in a table of contents — and ### for real subsections. Do NOT make headings out of figure/exhibit captions, statistics, pull quotes, or short callout phrases; render those as normal text. Body text as normal paragraphs. Lists as - or 1.. Block quotes with >.
- If a page is a stand-alone table of contents / index (section titles with page numbers), skip it entirely — output nothing for it; the app builds its own contents.
- Render genuine data tables, and any "Exhibit/Figure" that is fundamentally a data matrix or list, as a GitHub Markdown table or list, with its title/caption in **bold** above it (not as a heading).
- For a purely visual chart, diagram, photo, or decorative graphic: do NOT describe it and do NOT emit a placeholder — omit it entirely. The actual image will be inlined separately.
- Render footnote/citation definitions as plain paragraphs that begin with the number then a space then the source, e.g. "7 Hannah Mayer, "Superagency in the workplace," McKinsey, 2025." Keep inline citation markers as plain numbers.
- Omit running headers, footers, page numbers, and standalone copyright / source-watermark lines that repeat across pages.
- Do not invent or summarize — transcribe what is actually on the page. If the page has no real text (cover art, full-bleed graphic), output nothing.`;

function relevelHeadings(md) {
  let seen = false;
  return md.replace(/^(#{1,6})\s+(.*)$/gm, (m, hashes, text) => {
    if (hashes !== '#') return m;
    if (!seen) { seen = true; return m; }
    return '## ' + text;
  });
}

function prep(src, outDir) {
  return new Promise((resolve, reject) => {
    const c = spawn(PYBIN, [PYSCRIPT, src, outDir, '--prep-llm'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', d => out += d); c.stderr.on('data', d => err += d);
    c.on('close', code => code === 0 ? (() => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } })() : reject(new Error('prep: ' + err.slice(0, 200))));
  });
}

async function transcribe(key, png) {
  const data = fs.readFileSync(png).toString('base64');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 8000,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
        { type: 'text', text: PROMPT }] }]
    })
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const j = await res.json();
  return { text: (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim(), usage: j.usage || {} };
}

async function reprocess(folder, key) {
  const id = path.basename(folder);
  const src = path.join(folder, 'original.pdf');
  if (!fs.existsSync(src)) { console.log(`  skip ${id} (no original.pdf)`); return; }
  const imagesDir = path.join(folder, 'images');

  const prepRes = await prep(src, folder);   // writes images/page-*.png + images/fig-*.png
  const n = prepRes.pageCount, figs = prepRes.figures || {};
  const pageMd = new Array(n).fill('');
  let inTok = 0, outTok = 0, nextI = 0;
  const worker = async () => {
    while (true) {
      const i = nextI++; if (i >= n) break;
      const ref = prepRes.pageImages[i]; if (!ref) continue;
      try { const r = await transcribe(key, path.join(folder, ref)); pageMd[i] = r.text; inTok += r.usage.input_tokens || 0; outTok += r.usage.output_tokens || 0; }
      catch (e) { console.error(`    page ${i + 1}: ${e.message}`); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, n) }, worker));
  recordUsage(inTok, outTok);

  const parts = [];
  for (let i = 0; i < n; i++) {
    const md = pageMd[i] || '';
    const pf = figs[String(i)] || [];
    const hasTable = /(^|\n)\s*\|.*\|/.test(md);
    const keep = pf.filter(f => f.type === 'chart' || f.type === 'image' || !hasTable);
    const block = [md, keep.map(f => `![](${f.img})`).join('\n\n')].filter(Boolean).join('\n\n');
    if (block.trim()) parts.push(block);
  }
  const markdown = relevelHeadings(parts.join('\n\n'));
  const { marked } = await import('marked');
  const fragment = normalizeFragment(marked.parse(markdown, { mangle: false, headerIds: false }));
  fs.writeFileSync(path.join(folder, 'article.html'), fragment, 'utf-8');

  // clean images: keep cover.png + only figures referenced by the new article
  const referenced = new Set([...fragment.matchAll(/images\/([^\s")']+)/g)].map(m => m[1]));
  for (const f of fs.readdirSync(imagesDir)) {
    if (f === 'cover.png' || referenced.has(f)) continue;
    fs.rmSync(path.join(imagesDir, f), { force: true });
  }

  // refresh derived metadata, preserve everything else
  const metaPath = path.join(folder, 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  meta.wordCount = countWords(fragment);
  meta.readMinutes = Math.max(1, Math.ceil(meta.wordCount / 225));
  meta.imageCount = (fragment.match(/<img/gi) || []).length;
  meta.pageCount = n;
  if (prepRes.author && !meta.author) meta.author = prepRes.author;
  meta.conversion = { tool: 'llm-vision', model: MODEL, ok: true, warnings: prepRes.warnings || [] };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

  const tbl = (fragment.match(/<table/gi) || []).length;
  console.log(`  rebuilt ${id}: ${meta.wordCount} words, ${meta.imageCount} figs, ${tbl} tables  (in ${inTok}/${outTok} tok)`);
}

(async () => {
  const key = apiKey();
  if (!key) { console.error('No Anthropic API key. Add it in the app or set ANTHROPIC_API_KEY.'); process.exit(1); }
  const filter = process.argv[2] || '';
  const folders = fs.readdirSync(LIBRARY).map(d => path.join(LIBRARY, d))
    .filter(d => fs.statSync(d).isDirectory() && d.includes(filter) && fs.existsSync(path.join(d, 'original.pdf')));
  console.log(`Reprocessing ${folders.length} PDF(s) via ${MODEL}…`);
  for (const f of folders) {
    try { await reprocess(f, key); }
    catch (e) { console.error(`  FAILED ${path.basename(f)}: ${e.message}`); }
  }
  const u = loadConfig().llmUsage || {};
  console.log(`Done. Aggregate LLM cost now: $${(u.cost || 0).toFixed(2)}`);
})();
