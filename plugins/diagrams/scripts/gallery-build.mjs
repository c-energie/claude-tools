#!/usr/bin/env node
// Build the diagram gallery: N stores in, ONE self-contained HTML file out.
//
//   node gallery-build.mjs                                   # this project's store
//   node gallery-build.mjs ~/c-energie/diagrams ~/net-flex/diagrams
//   node gallery-build.mjs --out ~/Desktop/diagrams.html
//
//   --out PATH     where to write (default: gallery.html beside the first store)
//   --today DATE   pin the build stamp so output can be compared
//
// Two properties this file exists to hold, both of which have a way of being optimised away:
//
// 1. SELF-CONTAINED, opened over file://. The index and every SVG are inlined, so there is no
//    server to run and nothing to fetch. That is not only convenience: a file:// page cannot
//    fetch() a sibling index.jsonl at all — the browser blocks it as a cross-origin request to
//    a null origin — so a "just load the JSON" gallery works from a dev server and silently
//    shows nothing when someone actually double-clicks it.
//
// 2. PNG rasters stay SEPARATE, lazily linked, never base64'd. A handful of screenshots inlined
//    as data: URIs takes the single file from tens of kilobytes to tens of megabytes, and the
//    browser parses every byte before it paints anything.
//
// MULTI-STORE IS A LOCAL CONVENIENCE, AND MUST STAY ONE. Passing two stores is for a person who
// holds read on both and wants one place to look. THERE IS NO DEPLOYED INSTANCE AND NO PLAN FOR
// ONE. If that ever changes, a deployed gallery is SINGLE-STORE with its own access policy in
// front of it — because the per-org stores are a permission boundary, and a page that merges two
// of them re-breaches in the viewing layer exactly what the split was drawn to hold. Anyone
// adding a `--serve` flag or a deploy step to this file is undoing that decision; do it
// deliberately or not at all.

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readIndex, readTaxonomy, resolveStore, rasterFor } from './diagram-store.mjs';

const argv = process.argv.slice(2);
const die = (m) => { console.error(m); process.exit(2); };

const VALUED = new Set(['out', 'today']);
const values = new Map();
const dirs = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (!a.startsWith('--')) { dirs.push(a); continue; }
  const name = a.slice(2);
  if (!VALUED.has(name)) die(`unknown option --${name} (use --out, --today)`);
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) die(`--${name} needs a value`);
  values.set(name, v);
  i += 1;
}

let stores = dirs.map((d) => resolve(d));
if (!stores.length) {
  try {
    stores = [resolveStore().dir];
  } catch (e) {
    die(`${e.message}\n\nOr name one or more store checkouts directly: gallery-build.mjs [dir] [dir]`);
  }
}
for (const d of stores) {
  if (!existsSync(join(d, 'index.jsonl'))) {
    die(`${d} has no index.jsonl — that is not a diagram store (or nothing has been saved to it yet)`);
  }
}

const stamp = values.get('today') ?? new Date().toISOString().slice(0, 10);
const out = resolve(values.get('out') ?? join(stores[0], 'gallery.html'));

// ---------------------------------------------------------------- gather
const rows = [];
const problems = [];
for (const dir of stores) {
  const { entries, bad } = readIndex(dir);
  for (const b of bad) problems.push(`${dir}/index.jsonl:${b.line} is not valid JSON — skipped`);
  const taxonomy = readTaxonomy(dir);
  if (!taxonomy.present) problems.push(`${dir} has no taxonomy.json — its tags are unvalidated`);

  for (const e of entries) {
    const abs = e.path ? join(dir, e.path) : null;
    if (!abs || !existsSync(abs)) {
      problems.push(`${e.id ?? e.path ?? '(no id)'} — source file missing at ${e.path}; listed without a preview`);
      rows.push({ ...e, svg: null, raster: null, missing: true });
      continue;
    }
    const body = readFileSync(abs, 'utf8');
    rows.push({
      ...e,
      // HTML diagrams are not inlined into the page body — an arbitrary HTML document dropped
      // inside another one brings its own <style> and rewrites the gallery around it. They are
      // listed and linked instead, which is honest about what the single file can hold.
      svg: e.format === 'svg' ? body : null,
      // Absolute file:// URLs, not paths relative to the gallery: some viewers (IDE HTML
      // previews in particular) load the built page without giving it the document's own
      // location as a base URL, so a relative href resolves against nothing and goes nowhere.
      href: pathToFileURL(abs).href,
      raster: (() => {
        const png = rasterFor(dir, e.path);
        return png ? pathToFileURL(join(dir, png)).href : null;
      })(),
      bytes: statSync(abs).size,
      missing: false,
    });
  }
}

rows.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? ''))
  || String(a.title ?? '').localeCompare(String(b.title ?? '')));

const facet = (key) => [...new Set(rows.flatMap((r) => [].concat(r[key] ?? []).filter(Boolean)))].sort();
const orgs = facet('org');

// ---------------------------------------------------------------- render
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// The SVG goes into the document, so it must not carry anything that runs. A gallery is opened
// from file://, where a script in an inlined artifact would run with local-file reach.
const sanitiseSvg = (svg) => String(svg)
  .replace(/<\?xml[^>]*\?>/g, '')
  .replace(/<!DOCTYPE[^>]*>/gi, '')
  .replace(/<script\b[\s\S]*?<\/script>/gi, '')
  .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
  .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
  .trim();

const card = (r, i) => `
<article class="card" data-i="${i}"
  data-org="${esc(r.org)}" data-type="${esc(r.type)}" data-status="${esc(r.status)}"
  data-tags="${esc([].concat(r.tags ?? []).join(' '))}"
  data-hay="${esc([r.title, r.project, r.type, r.source_conversation, [].concat(r.tags ?? []).join(' '), r.text].filter(Boolean).join(' ').toLowerCase())}">
  <div class="frame">${
    r.svg ? sanitiseSvg(r.svg)
      : r.raster ? `<img loading="lazy" src="${esc(r.raster)}" alt="${esc(r.title)}">`
        : `<div class="none">${r.missing ? 'source file missing' : `${esc(r.format ?? 'file')} — open it`}</div>`
  }</div>
  <h2>${r.missing || !r.href ? esc(r.title) : `<a href="${esc(r.href)}">${esc(r.title)}</a>`}</h2>
  <p class="meta">
    <span class="pill org">${esc(r.org)}</span>
    ${r.type ? `<span class="pill">${esc(r.type)}</span>` : ''}
    ${r.status && r.status !== 'current' ? `<span class="pill status">${esc(r.status)}</span>` : ''}
    <span class="dim">${esc(r.date)}${r.project ? ` · ${esc(r.project)}` : ''}</span>
  </p>
  ${[].concat(r.tags ?? []).length ? `<p class="tags">${[].concat(r.tags).map((t) => `<span>${esc(t)}</span>`).join('')}</p>` : ''}
  ${r.source_conversation ? `<p class="src" title="source_conversation">from: ${esc(r.source_conversation)}</p>` : ''}
</article>`;

const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Diagrams — ${esc(orgs.join(', ') || 'store')}</title>
<style>
  :root {
    --bg: #fbfbfa; --fg: #1a1a19; --dim: #6b6b68; --line: #e3e3e0;
    --card: #ffffff; --pill: #f0f0ee; --accent: #2f5d50;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#16171a; --fg:#e9e9e6; --dim:#96968f; --line:#2c2e33; --card:#1e2024; --pill:#2a2d32; --accent:#7fc3ae; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif; }
  header { position:sticky; top:0; z-index:5; background:var(--bg); border-bottom:1px solid var(--line); padding:14px 20px; }
  h1 { margin:0 0 10px; font-size:16px; font-weight:600; }
  h1 .dim { font-weight:400; }
  .controls { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  input[type=search] { flex:1 1 260px; min-width:200px; padding:7px 10px; border:1px solid var(--line); border-radius:7px; background:var(--card); color:var(--fg); font:inherit; }
  select { padding:7px 8px; border:1px solid var(--line); border-radius:7px; background:var(--card); color:var(--fg); font:inherit; }
  #count { color:var(--dim); font-size:13px; margin-left:auto; }
  main { display:grid; gap:16px; padding:20px; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:11px; padding:12px; overflow:hidden; }
  .card[hidden] { display:none; }
  .frame { background:#fff; border:1px solid var(--line); border-radius:7px; overflow:auto; max-height:300px; padding:8px; display:flex; align-items:center; justify-content:center; }
  .frame svg, .frame img { max-width:100%; height:auto; }
  .none { color:var(--dim); font-size:13px; padding:34px 8px; }
  h2 { font-size:14px; margin:10px 0 4px; font-weight:600; }
  h2 a { color:inherit; }
  .meta { margin:0 0 6px; display:flex; gap:6px; align-items:center; flex-wrap:wrap; font-size:12px; }
  .pill { background:var(--pill); border-radius:20px; padding:2px 9px; }
  .pill.org { background:var(--accent); color:var(--bg); }
  .pill.status { border:1px solid var(--accent); }
  .dim { color:var(--dim); }
  .tags { margin:0; font-size:12px; color:var(--dim); display:flex; gap:6px; flex-wrap:wrap; }
  .tags span::before { content:"#"; opacity:.55; }
  .src { margin:6px 0 0; font-size:12px; color:var(--dim); }
  .notes { margin:0; padding:12px 20px; border-top:1px solid var(--line); color:var(--dim); font-size:12px; }
  .notes li { margin:2px 0; }
  .empty { padding:40px 20px; color:var(--dim); }
</style>

<header>
  <h1>Diagrams <span class="dim">· ${rows.length} · ${esc(stores.length === 1 ? orgs[0] ?? '' : `${stores.length} stores`)} · built ${esc(stamp)}</span></h1>
  <div class="controls">
    <input type="search" id="q" placeholder="Search titles, tags, and the words drawn inside the diagrams…" autofocus>
    ${orgs.length > 1 ? `<select id="f-org"><option value="">all orgs</option>${orgs.map((o) => `<option>${esc(o)}</option>`).join('')}</select>` : ''}
    ${facet('type').length ? `<select id="f-type"><option value="">all types</option>${facet('type').map((t) => `<option>${esc(t)}</option>`).join('')}</select>` : ''}
    ${facet('tags').length ? `<select id="f-tags"><option value="">all tags</option>${facet('tags').map((t) => `<option>${esc(t)}</option>`).join('')}</select>` : ''}
    ${facet('status').length > 1 ? `<select id="f-status"><option value="">any status</option>${facet('status').map((t) => `<option>${esc(t)}</option>`).join('')}</select>` : ''}
    <span id="count"></span>
  </div>
</header>

<main id="grid">${rows.length ? rows.map(card).join('\n') : '<p class="empty">This store has no diagrams yet.</p>'}</main>

${problems.length ? `<ul class="notes">${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}

<script>
  const cards = [...document.querySelectorAll('.card')];
  const q = document.getElementById('q');
  const sels = ['org', 'type', 'tags', 'status']
    .map((k) => [k, document.getElementById('f-' + k)])
    .filter(([, el]) => el);
  const count = document.getElementById('count');

  function apply() {
    const term = q.value.trim().toLowerCase();
    let shown = 0;
    for (const c of cards) {
      let ok = !term || c.dataset.hay.includes(term);
      for (const [k, el] of sels) {
        if (!ok || !el.value) continue;
        // tags is a space-joined list; the rest are single values.
        ok = k === 'tags'
          ? c.dataset.tags.split(' ').includes(el.value)
          : c.dataset[k] === el.value;
      }
      c.hidden = !ok;
      if (ok) shown += 1;
    }
    count.textContent = shown === cards.length ? cards.length + ' diagrams' : shown + ' of ' + cards.length;
  }
  q.addEventListener('input', apply);
  for (const [, el] of sels) el.addEventListener('change', apply);
  apply();
</script>
`;

writeFileSync(out, html, 'utf8');
// A plain Windows path (C:\...) is not a URI and most terminals won't make it clickable;
// the file:// form is what actually opens when clicked.
console.log(`built ${pathToFileURL(out).href}`);
console.log(`  ${rows.length} diagram(s) from ${stores.length} store(s): ${stores.join(', ')}`);
console.log(`  ${Math.round(Buffer.byteLength(html) / 1024)} KB, self-contained — open it with file://, no server`);
for (const p of problems) console.log(`  note: ${p}`);
