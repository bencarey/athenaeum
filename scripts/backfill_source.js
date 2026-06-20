#!/usr/bin/env node
/* Backfill the `source` (publisher / site) field — and author/summary if blank —
 * for existing library articles, using a cheap Haiku call. URL articles already
 * carry siteName, so only documents are processed. Records spend into
 * config.llmUsage. Usage: node scripts/backfill_source.js [slug-substring] */
const path = require('path');
const fs = require('fs');
const os = require('os');

const LIBRARY = path.join(os.homedir(),
  'Library/Mobile Documents/com~apple~CloudDocs/Athenaeum/library');
const CONFIG = path.join(os.homedir(), 'Library/Application Support/athenaeum/config.json');
const MODEL = 'claude-haiku-4-5-20251001';

function loadConfig() { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf-8')); } catch { return {}; } }
function apiKey() { return process.env.ANTHROPIC_API_KEY || loadConfig().anthropicApiKey || ''; }
function recordUsage(inTok, outTok) {
  const cfg = loadConfig();
  const u = cfg.llmUsage || { inputTokens: 0, outputTokens: 0, cost: 0, calls: 0 };
  u.inputTokens += inTok; u.outputTokens += outTok;
  u.cost += inTok / 1e6 * 1 + outTok / 1e6 * 5; u.calls += 1;
  cfg.llmUsage = u;
  try { fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), 'utf-8'); } catch {}
}

async function extract(key, text) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 400,
      messages: [{
        role: 'user',
        content: 'Summarize this document in 2 to 3 sentences for a reading-app cover card. Also identify: ' +
          '"author" (the writer(s), if named), and "source" (the publishing organization, company, or website it came from, as a SHORT clean name — e.g. "McKinsey & Company", "PitchBook", "The New York Times" — not a sentence). ' +
          'Respond with ONLY a JSON object: {"summary": "...", "author": "...", "source": "..."}. No preamble.\n\nDOCUMENT:\n' + text.slice(0, 12000)
      }]
    })
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const j = await res.json();
  if (j.usage) recordUsage(j.usage.input_tokens || 0, j.usage.output_tokens || 0);
  const txt = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const m = txt.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
}

(async () => {
  const key = apiKey();
  if (!key) { console.error('No Anthropic API key.'); process.exit(1); }
  const filter = process.argv[2] || '';
  const folders = fs.readdirSync(LIBRARY).map(d => path.join(LIBRARY, d))
    .filter(d => { try { return fs.statSync(d).isDirectory() && d.includes(filter); } catch { return false; } });
  for (const folder of folders) {
    const mp = path.join(folder, 'meta.json');
    let meta; try { meta = JSON.parse(fs.readFileSync(mp, 'utf-8')); } catch { continue; }
    if (meta.sourceType === 'url') { console.log(`  skip ${meta.id} (url → uses siteName)`); continue; }
    if (meta.source) { console.log(`  skip ${meta.id} (already has source: ${meta.source})`); continue; }
    let content = '';
    try { content = fs.readFileSync(path.join(folder, 'article.html'), 'utf-8').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim(); } catch {}
    if (content.length < 200) { console.log(`  skip ${meta.id} (too short)`); continue; }
    try {
      const r = await extract(key, content);
      if (!r) { console.log(`  ${meta.id}: no result`); continue; }
      meta.source = r.source || '';
      if (!meta.author && r.author) meta.author = r.author;
      if (!meta.summary && r.summary) meta.summary = r.summary;
      fs.writeFileSync(mp, JSON.stringify(meta, null, 2), 'utf-8');
      console.log(`  ${meta.id}: source = "${meta.source}"`);
    } catch (e) { console.error(`  ${meta.id} FAILED: ${e.message}`); }
  }
  const u = loadConfig().llmUsage || {};
  console.log(`Done. Aggregate LLM cost: $${(u.cost || 0).toFixed(2)}`);
})();
