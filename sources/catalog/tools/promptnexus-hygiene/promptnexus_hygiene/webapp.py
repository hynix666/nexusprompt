"""A single-file, offline searchable app for the catalog.

Generated from the same in-memory model as every other export, so it cannot
drift from the data. No build step, no CDN, no server: one HTML file with the
records embedded, openable from ``file://``.

Design notes, since they were deliberate rather than defaults:

* **Light, not dark.** This is a reference document people consult while
  working, not a dashboard. A near-black surface with a bright accent is the
  house style of every AI-built developer tool; a paper ground reads as
  something you look things up in.
* **Monospace as the display face.** The artifact a user actually leaves with is
  a prompt template — monospaced text. Setting the headings in the same face as
  the templates makes the page look like the thing it is about, and it avoids
  depending on a web font that would break offline.
* **Colour encodes epistemic state, nothing else.** Green means checked against
  the source, amber means nobody checked. No decorative colour anywhere. After
  an audit that found five fabricated citations, what a reader most needs from
  this catalog is to know which claims it stands behind.
* **The signature is the template filler.** Placeholders are editable chips
  inside the template itself, so the form *is* the preview — the template
  visibly becomes the prompt as you type. Copy takes what you see.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Final

from . import labels
from .exports import technique_to_record
from .model import Catalog

__all__ = ["catalog_to_app", "write_app"]

_DATA_SENTINEL: Final[str] = "/*__CATALOG_DATA__*/null"
_META_SENTINEL: Final[str] = "/*__CATALOG_META__*/null"
_LABELS_SENTINEL: Final[str] = "/*__CATALOG_LABELS__*/null"

_APP_TEMPLATE: Final[str] = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Prompt-Technique Catalog</title>
<style>
:root{
  --paper:#eceae3;
  --card:#f7f6f2;
  --ink:#14181c;
  --ink-soft:#5b6570;
  --rule:#cdcabf;
  --checked:#1f5c46;
  --unchecked:#8a6414;
  --token:#2f45b4;
  --token-bg:#e5e7f7;
  --focus:#2f45b4;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
*{box-sizing:border-box}
html,body{height:100%}
body{
  margin:0;background:var(--paper);color:var(--ink);
  font-family:var(--sans);font-size:15px;line-height:1.5;
  -webkit-font-smoothing:antialiased;
}
button,input,select{font:inherit;color:inherit}
a{color:var(--token)}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}

/* ---------- shell ---------- */
.masthead{
  border-bottom:1px solid var(--rule);padding:14px 20px 12px;
  display:flex;gap:18px;align-items:baseline;flex-wrap:wrap;
}
.wordmark{
  font-family:var(--mono);font-size:15px;font-weight:700;
  letter-spacing:.16em;text-transform:uppercase;margin:0;
}
.masthead .stamp{font-family:var(--mono);font-size:11.5px;color:var(--ink-soft);letter-spacing:.04em}
.masthead .caveat{
  font-size:12.5px;color:var(--ink-soft);margin-left:auto;max-width:46ch;
  border-left:2px solid var(--unchecked);padding-left:10px;
}

.shell{display:grid;grid-template-columns:minmax(300px,380px) 1fr;height:calc(100% - 58px)}
@media (max-width:880px){.shell{grid-template-columns:1fr}}

/* ---------- browse pane ---------- */
.browse{border-right:1px solid var(--rule);display:flex;flex-direction:column;min-height:0}
.searchbar{padding:12px 16px 10px;border-bottom:1px solid var(--rule)}
.searchbar input{
  width:100%;padding:9px 11px;border:1px solid var(--rule);border-radius:2px;
  background:var(--card);font-family:var(--mono);font-size:13.5px;
}
.searchbar input::placeholder{color:var(--ink-soft)}
.facets{padding:10px 16px 12px;border-bottom:1px solid var(--rule);display:grid;gap:8px}
.facet{display:grid;grid-template-columns:88px 1fr;align-items:center;gap:8px}
.facet > span{
  font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;
  text-transform:uppercase;color:var(--ink-soft);
}
.facet select{
  width:100%;padding:5px 7px;border:1px solid var(--rule);border-radius:2px;
  background:var(--card);font-size:13px;
}
.tally{
  padding:8px 16px;font-family:var(--mono);font-size:11.5px;color:var(--ink-soft);
  display:flex;justify-content:space-between;align-items:center;gap:10px;
  border-bottom:1px solid var(--rule);
}
.tally button{background:none;border:none;padding:0;color:var(--token);cursor:pointer;font-size:11.5px;text-decoration:underline}
.results{overflow-y:auto;flex:1;min-height:0}
.row{
  display:block;width:100%;text-align:left;background:none;border:0;
  border-bottom:1px solid var(--rule);padding:10px 16px;cursor:pointer;
}
.row:hover{background:var(--card)}
.row[aria-current="true"]{background:var(--card);box-shadow:inset 3px 0 0 var(--ink)}
.row h3{margin:0 0 2px;font-size:14px;font-weight:600;line-height:1.3}
.row .rowmeta{
  font-family:var(--mono);font-size:10.5px;color:var(--ink-soft);
  display:flex;gap:8px;align-items:center;flex-wrap:wrap;
}
.row p{margin:4px 0 0;font-size:12.5px;color:var(--ink-soft);line-height:1.42}
mark{background:var(--token-bg);color:inherit;padding:0 1px;border-radius:2px}

/* provenance mark: two cells, filled = checked against the source */
.prov{display:inline-flex;gap:2px;vertical-align:-1px}
.prov i{width:7px;height:7px;border:1px solid var(--unchecked);display:block;border-radius:1px}
.prov i.on{background:var(--checked);border-color:var(--checked)}

.empty{padding:36px 20px;color:var(--ink-soft);font-size:13.5px}
.empty strong{display:block;color:var(--ink);font-size:14px;margin-bottom:4px}

/* ---------- detail pane ---------- */
.detail{overflow-y:auto;min-height:0;padding:26px 30px 80px}
@media (max-width:880px){
  .browse{border-right:0}
  /* Full-viewport overlay rather than an offset from the header: the header
     wraps at narrow widths, so any fixed top offset is wrong at some size. */
  .detail{
    position:fixed;inset:0;background:var(--paper);z-index:30;
    display:none;padding:16px 18px 60px;
  }
  .detail.open{display:block}
}
.backbtn{display:none}
@media (max-width:880px){
  .backbtn{
    display:inline-block;margin-bottom:14px;background:none;border:1px solid var(--rule);
    border-radius:2px;padding:5px 10px;font-family:var(--mono);font-size:12px;cursor:pointer;
  }
}
.detail h2{
  font-family:var(--mono);font-size:20px;font-weight:700;margin:0 0 4px;line-height:1.25;
  letter-spacing:-.01em;
}
.slug{font-family:var(--mono);font-size:12px;color:var(--ink-soft);margin:0 0 14px}
.summary{font-size:16px;line-height:1.5;margin:0 0 18px;max-width:70ch}
.spec{
  display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;
  background:var(--rule);border:1px solid var(--rule);margin:0 0 22px;
}
.spec div{background:var(--card);padding:8px 11px}
.spec dt{
  font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--ink-soft);margin:0 0 3px;
}
.spec dd{margin:0;font-size:13px;line-height:1.35}
.audit{border-left:3px solid var(--unchecked);padding:9px 12px;background:var(--card);margin:0 0 22px;font-size:13px}
.audit.full{border-left-color:var(--checked)}
.audit b{font-family:var(--mono);font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;display:block;color:var(--ink-soft);margin-bottom:3px}
.detail h4{
  font-family:var(--mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;
  color:var(--ink-soft);margin:22px 0 8px;padding-bottom:5px;border-bottom:1px solid var(--rule);
}
.detail p,.detail li{max-width:74ch}
.detail ul{margin:0;padding-left:18px}
.detail li{margin-bottom:5px;font-size:14px}
.chips{display:flex;flex-wrap:wrap;gap:5px}
.chip{
  font-family:var(--mono);font-size:11px;border:1px solid var(--rule);
  border-radius:2px;padding:2px 6px;background:var(--card);
}
.chip.link{cursor:pointer}
.chip.link:hover{border-color:var(--ink)}
.cite{font-size:13.5px;line-height:1.5}
.cite em{color:var(--ink)}

/* ---------- the template filler ---------- */
.tpl{border:1px solid var(--rule);background:var(--card);margin-bottom:18px}
.tplhead{
  display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;
  padding:9px 12px;border-bottom:1px solid var(--rule);
}
.tplhead .name{font-size:13.5px;font-weight:600}
.tplhead .tid{font-family:var(--mono);font-size:10.5px;color:var(--ink-soft)}
.copy{
  border:1px solid var(--ink);background:var(--ink);color:var(--card);
  border-radius:2px;padding:5px 12px;font-family:var(--mono);font-size:11.5px;
  cursor:pointer;letter-spacing:.04em;
}
.copy:hover{background:#000}
.copy.done{background:var(--checked);border-color:var(--checked)}
.body{
  font-family:var(--mono);font-size:12.5px;line-height:1.75;white-space:pre-wrap;
  word-break:break-word;padding:13px 12px;margin:0;
}
.slot{
  display:inline-block;font-family:var(--mono);font-size:12.5px;
  background:var(--token-bg);color:var(--token);border:1px solid #c3c8ee;
  border-radius:2px;padding:0 4px;min-width:8ch;
}
.slot:focus{outline:2px solid var(--focus);outline-offset:1px;background:#fff}
.slot.filled{background:#fff;color:var(--ink);border-color:var(--rule)}
.repro{
  font-size:12px;color:var(--ink-soft);padding:0 12px 11px;margin:0;line-height:1.45;
}
.vars{border-top:1px solid var(--rule);padding:10px 12px;font-size:12.5px}
.vars dt{font-family:var(--mono);font-size:12px;color:var(--token);margin-top:6px}
.vars dd{margin:1px 0 0;color:var(--ink-soft);line-height:1.4}
.toast{
  position:fixed;left:50%;bottom:26px;transform:translateX(-50%);
  background:var(--ink);color:var(--card);padding:8px 16px;border-radius:2px;
  font-family:var(--mono);font-size:12px;opacity:0;pointer-events:none;
  transition:opacity .18s ease;z-index:40;
}
.toast.show{opacity:1}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style>
</head>
<body>
<header class="masthead">
  <h1 class="wordmark">Prompt-Technique Catalog</h1>
  <span class="stamp" id="stamp"></span>
  <p class="caveat">Filled squares mark what has been checked against the cited
  source. No record&rsquo;s pitfalls have been traced to a paper &mdash; treat
  them as practitioner guidance.</p>
</header>

<div class="shell">
  <section class="browse" aria-label="Browse techniques">
    <div class="searchbar">
      <input id="q" type="search" autocomplete="off" spellcheck="false"
             placeholder="Search names, summaries, pitfalls&hellip;  (press /)"
             aria-label="Search techniques">
    </div>
    <div class="facets" id="facets"></div>
    <div class="tally">
      <span id="tally"></span>
      <button id="reset" type="button">Clear filters</button>
    </div>
    <div class="results" id="results" role="list"></div>
  </section>
  <main class="detail" id="detail" tabindex="-1" aria-live="polite"></main>
</div>
<div class="toast" id="toast" role="status"></div>

<script id="catalog-data" type="application/json">DATA_PLACEHOLDER</script>
<script>
const RAW = JSON.parse(document.getElementById('catalog-data').textContent);
const META = /*__CATALOG_META__*/null;
const LABELS = /*__CATALOG_LABELS__*/null;
const RECORDS = RAW.techniques;

const el = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

/* ---------- search index ---------- */
const NEEDLE_FIELDS = ['name','id','executive_summary','description'];
RECORDS.forEach(r => {
  r._hay = [
    r.name, r.id, (r.aliases||[]).join(' '), r.executive_summary, r.description,
    (r.when_to_use||[]).join(' '), (r.when_not_to_use||[]).join(' '),
    (r.known_pitfalls||[]).join(' '), (r.tags||[]).join(' '),
    r.primary_source ? [r.primary_source.authors, r.primary_source.title].join(' ') : ''
  ].join(' \u0001 ').toLowerCase();
  r._title = (r.name + ' ' + r.id + ' ' + (r.aliases||[]).join(' ')).toLowerCase();
});

const FACETS = [
  {key:'category', label:'Category', map:LABELS.category},
  {key:'cost_profile', label:'Cost', map:LABELS.cost_profile},
  {key:'verification_status', label:'Verifies', map:LABELS.verification_status},
  {key:'status', label:'Provenance', map:LABELS.status},
  {key:'_audit', label:'Checked', map:{
    'yes':'Description checked against source', 'no':'Description not checked'}}
];
RECORDS.forEach(r => { r._audit = r.source_audit.description === 'unverified' ? 'no' : 'yes'; });

const state = {q:'', facets:{}, selected:null};

function buildFacets(){
  el('facets').innerHTML = FACETS.map(f => {
    const counts = {};
    RECORDS.forEach(r => { const v = r[f.key]; counts[v] = (counts[v]||0)+1; });
    const opts = Object.keys(counts).sort((a,b) =>
      (f.map[a]||a).localeCompare(f.map[b]||b)).map(v =>
      `<option value="${esc(v)}">${esc(f.map[v]||v)} (${counts[v]})</option>`).join('');
    return `<label class="facet"><span>${esc(f.label)}</span>
      <select data-key="${esc(f.key)}"><option value="">All</option>${opts}</select></label>`;
  }).join('');
  el('facets').querySelectorAll('select').forEach(s => {
    s.addEventListener('change', () => {
      const k = s.dataset.key;
      if (s.value) state.facets[k] = s.value; else delete state.facets[k];
      if (window.innerWidth <= 880) el('detail').classList.remove('open');
      render();
    });
  });
}

function terms(){ return state.q.toLowerCase().split(/\s+/).filter(Boolean); }

function matches(){
  const t = terms();
  return RECORDS.filter(r => {
    for (const [k,v] of Object.entries(state.facets)) if (r[k] !== v) return false;
    return t.every(w => r._hay.includes(w));
  }).sort((a,b) => {
    const score = (r) => t.reduce((n,w) => n + (r._title.includes(w) ? 1 : 0), 0);
    const d = score(b) - score(a);
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });
}

function highlight(text, limit){
  let s = String(text || '');
  if (limit && s.length > limit) s = s.slice(0, limit).replace(/\s+\S*$/, '') + '\u2026';
  let out = esc(s);
  for (const w of terms()){
    if (w.length < 2) continue;
    const re = new RegExp('(' + w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + ')', 'ig');
    out = out.replace(re, '<mark>$1</mark>');
  }
  return out;
}

function provMark(r){
  const d = r.source_audit.description !== 'unverified';
  const p = r.source_audit.pitfalls !== 'unverified';
  return `<span class="prov" title="Description ${d?'checked':'not checked'}; pitfalls ${p?'traced':'not traced'} to the source">
    <i class="${d?'on':''}"></i><i class="${p?'on':''}"></i></span>`;
}

function render(){
  const rows = matches();
  el('tally').textContent = rows.length === RECORDS.length
    ? `${RECORDS.length} techniques`
    : `${rows.length} of ${RECORDS.length}`;
  const list = el('results');
  if (!rows.length){
    list.innerHTML = `<div class="empty"><strong>Nothing matches those filters.</strong>
      Try fewer words, or clear a filter to widen the search.</div>`;
    return;
  }
  list.innerHTML = rows.map(r => `
    <button class="row" role="listitem" data-id="${esc(r.id)}"
            aria-current="${state.selected === r.id}">
      <h3>${highlight(r.name)}</h3>
      <div class="rowmeta">${provMark(r)}<span>${esc(LABELS.category[r.category]||r.category)}</span>
        <span>&middot;</span><span>${esc(LABELS.cost_profile[r.cost_profile]||r.cost_profile)}</span></div>
      <p>${highlight(r.executive_summary, 150)}</p>
    </button>`).join('');
  list.querySelectorAll('.row').forEach(b =>
    b.addEventListener('click', () => select(b.dataset.id)));
}

/* Selecting a record marks the current row in place. Re-rendering the whole
   list on selection would destroy the element the reader just clicked, lose
   their scroll position, and re-run highlighting across every row. */
function markCurrent(){
  el('results').querySelectorAll('.row').forEach(b =>
    b.setAttribute('aria-current', String(b.dataset.id === state.selected)));
}

function select(id){
  state.selected = id;
  const r = RECORDS.find(x => x.id === id);
  if (!r) return;
  el('detail').innerHTML = detailHTML(r);
  el('detail').classList.add('open');
  el('detail').scrollTop = 0;
  wireDetail(r);
  markCurrent();
  if (window.innerWidth <= 880) el('detail').focus();
}

function citation(s){
  if (!s) return '';
  const bits = [`${esc(s.authors)} (${esc(s.year)}), <em>${esc(s.title)}</em>`];
  if (s.venue) bits.push(esc(s.venue));
  if (s.arxiv_id) bits.push(`<a href="https://arxiv.org/abs/${esc(s.arxiv_id)}" target="_blank" rel="noopener">arXiv:${esc(s.arxiv_id)}</a>`);
  else if (s.url) bits.push(`<a href="${esc(s.url)}" target="_blank" rel="noopener">source</a>`);
  return bits.join(', ');
}

function listBlock(title, items){
  if (!items || !items.length) return '';
  return `<h4>${esc(title)}</h4><ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`;
}

function detailHTML(r){
  const a = r.source_audit;
  const both = a.description !== 'unverified' && a.pitfalls !== 'unverified';
  const tpls = (r.usage_templates||[]).map((t, i) => {
    const vars = (t.variables||[]).map(v =>
      `<dt>{{${esc(v.name)}}}</dt><dd>${esc(v.description)}${v.example ? ' &mdash; e.g. ' + esc(v.example) : ''}</dd>`).join('');
    return `<div class="tpl" data-tpl="${i}">
      <div class="tplhead">
        <div><div class="name">${esc(t.template_name)}</div>
             <div class="tid">${esc(t.template_id)}</div></div>
        <button class="copy" type="button" data-copy="${i}">Copy prompt</button>
      </div>
      <p class="body" data-body="${i}">${slots(t.template)}</p>
      <p class="repro">${esc(t.reproducibility_note)}</p>
      ${vars ? `<dl class="vars">${vars}</dl>` : ''}
    </div>`;
  }).join('');

  return `
  <button class="backbtn" type="button" id="back">&larr; Results</button>
  <h2>${esc(r.name)}</h2>
  <p class="slug">${esc(r.id)}${(r.aliases||[]).length ? ' &middot; ' + esc(r.aliases.join(', ')) : ''}</p>
  <p class="summary">${esc(r.executive_summary)}</p>
  <dl class="spec">
    <div><dt>Category</dt><dd>${esc(LABELS.category[r.category]||r.category)}<br><span class="tid">${esc(r.subcategory)}</span></dd></div>
    <div><dt>Cost</dt><dd>${esc(LABELS.cost_profile[r.cost_profile]||r.cost_profile)}</dd></div>
    <div><dt>Verifying output</dt><dd>${esc(LABELS.verification_status[r.verification_status]||r.verification_status)}</dd></div>
    <div><dt>Provenance</dt><dd>${esc(LABELS.status[r.status]||r.status)}</dd></div>
  </dl>
  <div class="audit ${both ? 'full' : ''}">
    <b>What has been checked</b>
    Description: ${esc(LABELS.description_audit[a.description]||a.description)}.
    Pitfalls: ${esc(LABELS.pitfalls_audit[a.pitfalls]||a.pitfalls)}.
  </div>
  <p>${esc(r.description)}</p>
  ${listBlock('When to use', r.when_to_use)}
  ${listBlock('When not to use', r.when_not_to_use)}
  ${listBlock('Known pitfalls', r.known_pitfalls)}
  <h4>Usage templates</h4>
  ${tpls}
  ${r.primary_source ? `<h4>Primary source</h4><p class="cite">${citation(r.primary_source)}</p>` : ''}
  ${(r.secondary_sources||[]).map(s => `<p class="cite">${citation(s)}</p>`).join('')}
  ${(r.related_techniques||[]).length ? `<h4>Related</h4><div class="chips">${
    r.related_techniques.map(id => `<button class="chip link" data-goto="${esc(id)}">${esc(id)}</button>`).join('')}</div>` : ''}
  ${(r.tags||[]).length ? `<h4>Tags</h4><div class="chips">${
    r.tags.map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}`;
}

/* placeholders become editable chips inside the template itself */
function slots(body){
  return esc(body).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, name) =>
    `<span class="slot" contenteditable="true" spellcheck="false" role="textbox"
       aria-label="Fill in ${name}" data-slot="${name}">${name}</span>`);
}

function filledText(node){
  let out = '';
  node.childNodes.forEach(n => {
    if (n.nodeType === 3) out += n.nodeValue;
    else if (n.classList && n.classList.contains('slot')){
      const typed = n.textContent.trim();
      out += (typed && typed !== n.dataset.slot) ? typed : '{{' + n.dataset.slot + '}}';
    } else out += n.textContent;
  });
  return out;
}

function wireDetail(r){
  const back = el('back');
  if (back) back.addEventListener('click', () => el('detail').classList.remove('open'));

  el('detail').querySelectorAll('.slot').forEach(s => {
    const sync = () => {
      const typed = s.textContent.trim();
      s.classList.toggle('filled', typed !== '' && typed !== s.dataset.slot);
    };
    s.addEventListener('focus', () => {
      if (s.textContent.trim() === s.dataset.slot){
        s.textContent = '';
      }
    });
    s.addEventListener('blur', () => {
      if (s.textContent.trim() === '') s.textContent = s.dataset.slot;
      sync();
    });
    s.addEventListener('input', sync);
    s.addEventListener('keydown', e => {
      if (e.key === 'Enter'){ e.preventDefault(); s.blur(); }
    });
  });

  el('detail').querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const body = el('detail').querySelector(`[data-body="${btn.dataset.copy}"]`);
      const text = filledText(body);
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'Copied'; btn.classList.add('done');
        toast('Prompt copied to the clipboard');
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
        btn.textContent = 'Copied'; btn.classList.add('done');
        toast('Prompt copied to the clipboard');
      }
      setTimeout(() => { btn.textContent = 'Copy prompt'; btn.classList.remove('done'); }, 2200);
    });
  });

  el('detail').querySelectorAll('[data-goto]').forEach(c =>
    c.addEventListener('click', () => {
      const target = RECORDS.find(x => x.id === c.dataset.goto);
      if (target) select(target.id);
      else toast(`${c.dataset.goto} is not in this catalog`);
    }));
}

let toastTimer;
function toast(msg){
  const t = el('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
}

/* ---------- boot ---------- */
el('stamp').textContent =
  `v${META.catalog_version} \u00b7 schema ${META.schema_version} \u00b7 ${RECORDS.length} techniques \u00b7 ${META.generated_at}`;
buildFacets();
el('q').addEventListener('input', e => {
  state.q = e.target.value;
  // On a phone the detail is a full-screen overlay; typing means the reader has
  // gone back to browsing, so get it out of the way rather than updating a list
  // they cannot see.
  if (window.innerWidth <= 880) el('detail').classList.remove('open');
  render();
});
el('reset').addEventListener('click', () => {
  state.q = ''; state.facets = {}; el('q').value = '';
  el('facets').querySelectorAll('select').forEach(s => s.value = '');
  el('detail').classList.remove('open');
  render(); el('q').focus();
});
document.addEventListener('keydown', e => {
  if (e.key === '/' && document.activeElement !== el('q') &&
      !(document.activeElement && document.activeElement.isContentEditable)){
    e.preventDefault(); el('q').focus(); el('q').select();
  }
  if (e.key === 'Escape'){
    if (window.innerWidth <= 880) el('detail').classList.remove('open');
    else if (document.activeElement === el('q')) el('q').blur();
  }
});
render();
el('detail').innerHTML =
  `<div class="empty"><strong>Pick a technique to see it in full.</strong>
   Search across names, summaries and pitfalls, or narrow by category, cost and
   what it takes to verify the output. Every template can be filled in and
   copied from its detail view.</div>`;
</script>
</body>
</html>
"""


def catalog_to_app(catalog: Catalog) -> str:
    """Render the whole catalog as one self-contained HTML page."""
    payload: dict[str, Any] = {
        "techniques": [technique_to_record(t) for t in catalog.techniques]
    }
    meta = {
        "catalog_name": catalog.metadata.catalog_name,
        "catalog_version": catalog.metadata.catalog_version,
        "schema_version": catalog.metadata.schema_version,
        "generated_at": catalog.metadata.generated_at,
        "entry_count": len(catalog.techniques),
    }
    label_tables = {
        "category": labels.CATEGORY_LABELS,
        "cost_profile": labels.COST_PROFILE_LABELS,
        "verification_status": labels.VERIFICATION_STATUS_LABELS,
        "status": {
            key: value.replace(" (`{corpus_file}`)", "").replace("\U0001F4C4 ", "")
            .replace("\U0001F517 ", "").replace("\U0001F4D8 ", "")
            for key, value in labels.STATUS_LABELS.items()
        },
        "description_audit": labels.DESCRIPTION_AUDIT_LABELS,
        "pitfalls_audit": labels.PITFALLS_AUDIT_LABELS,
    }

    # The data goes in a JSON script block rather than a JS literal so that no
    # character in a prompt template can terminate the script early.
    data_json = json.dumps(payload, ensure_ascii=False).replace("</", "<\\/")
    html = _APP_TEMPLATE.replace("DATA_PLACEHOLDER", data_json)
    html = html.replace(_META_SENTINEL, json.dumps(meta, ensure_ascii=False))
    html = html.replace(_LABELS_SENTINEL, json.dumps(label_tables, ensure_ascii=False))
    return html


def write_app(catalog: Catalog, path: str | Path) -> int:
    text = catalog_to_app(catalog)
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
    return len(text.encode("utf-8"))
