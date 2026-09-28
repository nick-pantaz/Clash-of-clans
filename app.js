'use strict';

const STORE_KEY = 'coc-rush-tracker-v1';
const START_TH = 10;
const MAX_TH = 18;
const MAX_BUILDERS = 6;
const DAY_MS = 86400000;

let DATA = [];
const BY_ID = new Map();
const TAIL = new Map();          // longest chain of work (days) starting at an item
let state = loadState();
const ui = {
  tab: 'next',
  prevTab: 'next',
  spareLimit: 8,
  showBlocked: false,
  filters: { stage: 'all', cat: 'all', q: '', hideDone: false },
};

/* ---------------- State ---------------- */

function defaultState() {
  return { v: 1, done: {}, include: {}, running: {}, builders: 3, theme: 'system' };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return sanitizeState(JSON.parse(raw));
  } catch (e) { /* storage unavailable */ }
  return defaultState();
}

function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

// Accepts saved or imported state and keeps only well-formed fields.
// Upgrade ids are checked against the data later, in init().
function sanitizeState(data) {
  const next = defaultState();
  if (!isObj(data)) return next;
  for (const key of ['done', 'include']) {
    for (const [k, v] of Object.entries(isObj(data[key]) ? data[key] : {})) {
      if (typeof v === 'boolean') next[key][k] = v;
    }
  }
  const taken = new Set();
  for (const [k, v] of Object.entries(isObj(data.running) ? data.running : {})) {
    if (!isObj(v) || !Number.isFinite(v.endsAt) || !Number.isInteger(v.builder)) continue;
    if (v.builder < 0 || v.builder >= MAX_BUILDERS || taken.has(v.builder)) continue;
    taken.add(v.builder);
    next.running[k] = { builder: v.builder, endsAt: v.endsAt, startedAt: Number.isFinite(v.startedAt) ? v.startedAt : Date.now() };
  }
  const b = parseInt(data.builders, 10);
  next.builders = b >= 1 && b <= MAX_BUILDERS ? b : 3;
  next.theme = ['system', 'dark', 'light'].includes(data.theme) ? data.theme : 'system';
  return next;
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
}

/* ---------------- Derived data ---------------- */

const isIncluded = it => (it.id in state.include ? state.include[it.id] : it.include);
const isDone = it => !!state.done[it.id];
const isRunning = it => !!state.running[it.id];

function currentTH() {
  let th = START_TH;
  for (const it of DATA) {
    if (it.category === 'Town Hall' && isDone(it)) th = Math.max(th, it.beforeTH);
  }
  return th;
}

function unmetDeps(it) {
  return it.requires.map(id => BY_ID.get(id)).filter(d => isIncluded(d) && !isDone(d));
}

function isStartable(it, th = currentTH()) {
  return isIncluded(it) && !isDone(it) && !isRunning(it) && it.availTH <= th && unmetDeps(it).length === 0;
}

function blockReason(it, th) {
  if (it.availTH > th) return `Unlocks at TH${it.availTH}`;
  const deps = unmetDeps(it);
  if (!deps.length) return '';
  if (it.category === 'Town Hall') return `${deps.length} upgrade${deps.length === 1 ? '' : 's'} still needed`;
  const names = deps.slice(0, 2).map(d => d.name + (isRunning(d) ? ' (in progress)' : ''));
  return 'Waiting on ' + names.join(', ') + (deps.length > 2 ? ` +${deps.length - 2} more` : '');
}

function builderSlots() {
  const used = Object.values(state.running).map(r => r.builder);
  const count = Math.max(state.builders, used.length ? Math.max(...used) + 1 : 0);
  return { count, used: new Set(used) };
}

function freeBuilders() {
  const out = [];
  const used = new Set(Object.values(state.running).map(r => r.builder));
  const spare = Math.max(0, state.builders - used.size);
  for (let i = 0; out.length < spare; i++) if (!used.has(i)) out.push(i);
  return out;
}

function priorityCompare(a, b) {
  const ta = a.category === 'Town Hall' ? 1 : 0;
  const tb = b.category === 'Town Hall' ? 1 : 0;
  if (a.beforeTH !== b.beforeTH) return a.beforeTH - b.beforeTH;
  if (ta !== tb) return tb - ta;
  return (TAIL.get(b.id) - TAIL.get(a.id)) || (a.id - b.id);
}

function suggestions() {
  const th = currentTH();
  const nextTH = th + 1;
  const ready = DATA.filter(it => isStartable(it, th)).sort(priorityCompare);
  return {
    th, nextTH,
    now: ready.filter(it => it.beforeTH <= nextTH),
    spare: ready.filter(it => it.beforeTH > nextTH),
  };
}

function computeTails() {
  const dependents = new Map(DATA.map(it => [it.id, []]));
  for (const it of DATA) {
    if (it.category === 'Town Hall') continue; // TH depends on everything; skip so chains stay meaningful
    for (const id of it.requires) dependents.get(id).push(it.id);
  }
  const visit = id => {
    if (TAIL.has(id)) return TAIL.get(id);
    const kids = dependents.get(id).map(visit);
    const t = BY_ID.get(id).days + (kids.length ? Math.max(...kids) : 0);
    TAIL.set(id, t);
    return t;
  };
  DATA.forEach(it => visit(it.id));
}

/* ---------------- Actions ---------------- */

function markDone(id) {
  // Marking something done implies everything it needs is done too.
  let extra = 0;
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    if (state.done[cur]) continue;
    state.done[cur] = true;
    delete state.running[cur];
    if (cur !== id) extra++;
    stack.push(...BY_ID.get(cur).requires);
  }
  return extra;
}

function startUpgrade(id) {
  const it = BY_ID.get(id);
  if (!it.days) {
    markDone(id);
    toast(`${it.name} placed (instant build)`);
    return;
  }
  const free = freeBuilders();
  if (!free.length) { toast('All builders are busy'); return; }
  const now = Date.now();
  state.running[id] = { builder: free[0], startedAt: now, endsAt: now + it.days * DAY_MS };
  toast(`Builder ${free[0] + 1} started ${it.name}`);
}

function finishUpgrade(id) {
  const it = BY_ID.get(id);
  delete state.running[id];
  const before = currentTH();
  markDone(id);
  const after = currentTH();
  toast(after > before ? `Town Hall ${after} reached!` : `${it.name} done`);
}

async function setTimeLeft(id) {
  const r = state.running[id];
  const current = fmtCountdown(Math.max(0, r.endsAt - Date.now()), true);
  const input = await ask({
    title: 'Time left',
    body: `How long is left on ${BY_ID.get(id).name}? Copy it from the game, e.g. 2d 5h 30m.`,
    input: { value: current },
    okText: 'Save',
  });
  if (input == null) return false;
  const ms = parseDuration(input);
  if (ms == null) { toast("Couldn't read that time. Try 2d 5h 30m"); return false; }
  r.endsAt = Date.now() + ms;
  return true;
}

function parseDuration(s) {
  const text = s.trim().toLowerCase();
  if (!/^(\d+(\.\d+)?\s*[dhms]\s*)+$/.test(text)) return null;
  let total = 0;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/g)) {
    total += parseFloat(m[1]) * { d: DAY_MS, h: 3600000, m: 60000, s: 1000 }[m[2]];
  }
  return total;
}

function setStartingPoint(th) {
  for (const it of DATA) {
    if (it.beforeTH <= th) { state.done[it.id] = true; delete state.running[it.id]; }
    else delete state.done[it.id];
  }
}

/* ---------------- Formatting ---------------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtNum(n) {
  const trim = x => String(+x.toFixed(2));
  if (n >= 1e6) return trim(n / 1e6) + 'M';
  if (n >= 1e3) return trim(n / 1e3) + 'K';
  return String(Math.round(n));
}

function fmtDays(d) {
  const mins = Math.round(d * 1440);
  if (!mins) return 'instant';
  const D = Math.floor(mins / 1440), H = Math.floor((mins % 1440) / 60), M = mins % 60;
  if (D) return H ? `${D}d ${H}h` : `${D}d`;
  if (H) return M ? `${H}h ${M}m` : `${H}h`;
  return `${M}m`;
}

function fmtCountdown(ms, loose = false) {
  const s = Math.ceil(ms / 1000);
  const D = Math.floor(s / 86400), H = Math.floor((s % 86400) / 3600), M = Math.floor((s % 3600) / 60), S = s % 60;
  if (loose) return [D && `${D}d`, H && `${H}h`, M && `${M}m`].filter(Boolean).join(' ') || `${S}s`;
  const p = n => String(n).padStart(2, '0');
  return D ? `${D}d ${p(H)}h ${p(M)}m` : `${p(H)}:${p(M)}:${p(S)}`;
}

function fmtDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

const resClass = r => (r === 'Dark Elixir' ? 'Dark' : r);
const resShort = r => (r === 'Dark Elixir' ? 'DE' : r);

/* ---------------- Rendering helpers ---------------- */

const CHECK_SVG = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="m9.5 16.2-4.2-4.2-1.4 1.4 5.6 5.6 11-11-1.4-1.4z"/></svg>';

function itemRow(it, { action = 'start', th, top = false, showStage = false, free = 1 } = {}) {
  const done = isDone(it), running = isRunning(it), included = isIncluded(it);
  const reason = !done && !running && included && th != null ? blockReason(it, th) : '';
  const cls = ['item', top && 'top', done && 'done', reason && 'blocked', !included && 'excluded'].filter(Boolean).join(' ');

  let meta = '';
  if (showStage) meta += `<span class="tag th">TH${it.beforeTH}</span>`;
  meta += `<span class="res ${resClass(it.resource)}">${fmtNum(it.cost)} ${resShort(it.resource)}</span>`;
  meta += `<span>${fmtDays(it.days)}</span>`;
  meta += `<span>${esc(it.category)}</span>`;
  const tail = TAIL.get(it.id);
  if (tail - it.days > 0.5 && !done) meta += `<span title="Work left in this chain">chain ${fmtDays(tail)}</span>`;

  let lead = '', trail = '';
  if (action === 'check') {
    lead = `<button class="check ${done ? 'on' : ''}" data-action="toggle-done" data-id="${it.id}" aria-label="${esc(it.name)} done" aria-pressed="${done}">${done ? CHECK_SVG : ''}</button>`;
    trail = `<button class="inc-btn" data-action="toggle-include" data-id="${it.id}">${included ? 'Skip' : 'Skipped'}</button>`;
  } else if (running) {
    trail = `<span class="tag">Builder ${state.running[it.id].builder + 1}</span>`;
  } else if (!reason && included && !done) {
    trail = `<button class="btn" data-action="start" data-id="${it.id}" ${free ? '' : 'disabled'}>Start</button>`;
  }

  return `<div class="${cls}">${lead}<div class="body">
      <div class="name">${esc(it.name)}</div>
      <div class="meta">${meta}</div>
      ${reason ? `<div class="why">${esc(reason)}</div>` : ''}
      ${running ? `<div class="meta">In progress · <span data-ends="${state.running[it.id].endsAt}"></span></div>` : ''}
    </div>${trail}</div>`;
}

function stageStats(th) {
  const items = DATA.filter(it => it.beforeTH === th && isIncluded(it));
  const done = items.filter(isDone);
  const totalDays = items.reduce((s, it) => s + it.days, 0);
  const doneDays = done.reduce((s, it) => s + it.days, 0);
  return { items, total: items.length, done: done.length, totalDays, daysLeft: totalDays - doneDays };
}

/* ---------------- Views ---------------- */

function renderNext() {
  const el = document.getElementById('view-next');
  const { th, nextTH, now, spare } = suggestions();
  const free = freeBuilders();

  if (th >= MAX_TH) {
    el.innerHTML = `<div class="card hero-card"><div class="big">Town Hall ${MAX_TH} reached 🎉</div>
      <div class="muted">The rush list is complete. Time to go back and max things out.</div></div>`;
    return;
  }

  const st = stageStats(nextTH);
  const pct = st.totalDays ? (1 - st.daysLeft / st.totalDays) * 100 : 100;
  let html = `<div class="card hero-card">
    <div class="big">TH${th} → TH${nextTH}</div>
    <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>
    <div class="row"><span>${st.done} of ${st.total} upgrades done</span><span>${fmtDays(st.daysLeft)} of builder time left</span></div>
    <div class="row"><span>${free.length} of ${state.builders} builders free</span>${nextBuilderFreeText(free)}</div>
  </div>`;

  // Picks for free builders: stage work first, then spare work.
  const picks = [...now, ...spare].slice(0, free.length);
  const pickIds = new Set(picks.map(p => p.id));
  if (picks.length) {
    html += `<h2>Start now <span class="count">${picks.length}</span></h2>
      <p class="muted small" style="margin:-4px 0 8px">Best jobs for your free builders right now.</p>
      <div class="list">${picks.map(it => itemRow(it, { th, top: true, showStage: it.beforeTH > nextTH, free: free.length })).join('')}</div>`;
  }

  // Everything left before the next Town Hall.
  const remaining = st.items.filter(it => !isDone(it) && !pickIds.has(it.id));
  const running = remaining.filter(isRunning);
  const ready = now.filter(it => !pickIds.has(it.id));
  const blocked = remaining.filter(it => !isRunning(it) && !isStartable(it, th)).sort(priorityCompare);
  html += `<h2>Needed for TH${nextTH} <span class="count">${remaining.length}</span></h2>`;
  if (!remaining.length) {
    html += `<div class="card empty">Nothing else — ${picks.length ? 'start the picks above' : 'wait for your builders to finish'}.</div>`;
  } else {
    html += `<div class="list">${[...running, ...ready].map(it => itemRow(it, { th, free: free.length })).join('')}</div>`;
    if (blocked.length) {
      html += `<button class="btn ghost more" data-action="toggle-blocked">${ui.showBlocked ? 'Hide' : 'Show'} ${blocked.length} waiting on something else</button>`;
      if (ui.showBlocked) html += `<div class="list" style="margin-top:8px">${blocked.map(it => itemRow(it, { th })).join('')}</div>`;
    }
  }

  // Spare builder ideas: later-stage work that's already unlocked.
  const spareRest = spare.filter(it => !pickIds.has(it.id));
  html += `<h2>Spare builder upgrades <span class="count">${spareRest.length}</span></h2>
    <p class="muted small" style="margin:-4px 0 8px">Unlocked now, needed for later Town Halls. Soonest Town Hall first, then the longest chains, so they don't hold you up later.</p>`;
  if (!spareRest.length) {
    html += `<div class="card empty">No later-stage upgrades unlocked yet.</div>`;
  } else {
    html += `<div class="list">${spareRest.slice(0, ui.spareLimit).map(it => itemRow(it, { th, showStage: true, free: free.length })).join('')}</div>`;
    if (spareRest.length > ui.spareLimit) html += `<button class="btn ghost more" data-action="more-spare">Show more</button>`;
  }
  el.innerHTML = html;
}

function nextBuilderFreeText(free) {
  if (free.length) return '';
  const soonest = Math.min(...Object.values(state.running).map(r => r.endsAt));
  if (soonest <= Date.now()) return '<span>A builder is ready to collect</span>';
  return `<span>Next free in <b data-ends="${soonest}"></b></span>`;
}

function renderBuilders() {
  const el = document.getElementById('view-builders');
  const { count } = builderSlots();
  const byBuilder = new Map(Object.entries(state.running).map(([id, r]) => [r.builder, { id: +id, ...r }]));
  const { th, nextTH, now, spare } = suggestions();
  const queue = [...now, ...spare];
  let q = 0;
  const nowMs = Date.now();

  let html = '<div class="builders">';
  for (let b = 0; b < count; b++) {
    const job = byBuilder.get(b);
    if (job) {
      const it = BY_ID.get(job.id);
      const ready = job.endsAt <= nowMs;
      const pct = Math.min(100, ((nowMs - job.startedAt) / (job.endsAt - job.startedAt)) * 100);
      html += `<div class="card builder ${ready ? 'ready' : ''}">
        <div class="head"><span class="label">Builder ${b + 1}</span><span class="tag th">TH${it.beforeTH}</span></div>
        <div class="name" style="font-weight:600">${esc(it.name)}</div>
        <div class="timer" data-ends="${job.endsAt}" data-ready-text="Ready to collect"></div>
        <div class="bar good"><i style="width:${pct.toFixed(1)}%"></i></div>
        <div class="btn-row">
          <button class="btn good" data-action="finish" data-id="${job.id}">${ready ? 'Collect' : 'Done'}</button>
          <button class="btn ghost" data-action="set-time" data-id="${job.id}">Set time left</button>
          <button class="btn danger" data-action="cancel" data-id="${job.id}">Cancel</button>
        </div>
      </div>`;
    } else {
      const sug = b < state.builders ? queue[q++] : null;
      html += `<div class="card builder">
        <div class="head"><span class="label">Builder ${b + 1}</span><span class="free">Free</span></div>
        ${sug ? `<div class="muted small">Suggested:</div>${itemRow(sug, { th, showStage: sug.beforeTH > nextTH, top: true })}`
              : '<div class="muted small">Nothing unlocked to start right now.</div>'}
      </div>`;
    }
  }
  html += '</div>';
  html += `<p class="muted small">Tip: when you start an upgrade in the game, tap Start here too. If you boost or the game timer differs, use “Set time left”.</p>`;
  el.innerHTML = html;
}

function renderProgress() {
  const el = document.getElementById('view-progress');
  const th = currentTH();
  const inc = DATA.filter(isIncluded);
  const nowMs = Date.now();
  const totalDays = inc.reduce((s, it) => s + it.days, 0);

  let daysLeft = 0;
  const left = { Gold: 0, Elixir: 0, 'Dark Elixir': 0 };
  for (const it of inc) {
    if (isDone(it)) continue;
    const r = state.running[it.id];
    if (r) daysLeft += Math.max(0, r.endsAt - nowMs) / DAY_MS;
    else { daysLeft += it.days; left[it.resource] += it.cost; }
  }
  const thChain = DATA.filter(it => it.category === 'Town Hall' && !isDone(it))
    .reduce((s, it) => s + (state.running[it.id] ? Math.max(0, state.running[it.id].endsAt - nowMs) / DAY_MS : it.days), 0);
  const estDays = Math.max(daysLeft / state.builders, thChain);
  const pct = totalDays ? (1 - daysLeft / totalDays) * 100 : 100;

  let html = `<div class="card hero-card">
    <div class="big">${pct.toFixed(1)}% of the rush done</div>
    <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>
    <div class="row"><span>Town Hall ${th} of ${MAX_TH}</span><span>${daysLeft > 0 ? fmtDays(daysLeft) + ' builder time left' : 'No builder time left'}</span></div>
  </div>
  <div class="stats">
    <div class="stat"><div class="k">Gold left</div><div class="v res Gold">${fmtNum(left.Gold)}</div></div>
    <div class="stat"><div class="k">Elixir left</div><div class="v res Elixir">${fmtNum(left.Elixir)}</div></div>
    <div class="stat"><div class="k">Dark Elixir left</div><div class="v res Dark">${fmtNum(left['Dark Elixir'])}</div></div>
    <div class="stat"><div class="k">Est. days to TH${MAX_TH}</div><div class="v">${Math.ceil(estDays)}</div></div>
  </div>
  <p class="muted small">Estimate: builder time ÷ ${state.builders} builders, or the Town Hall upgrades back to back, whichever is longer. Earliest finish ≈ ${fmtDate(nowMs + estDays * DAY_MS)}. It's optimistic: it ignores farming time.</p>
  <h2>Stages</h2><div class="card">`;
  for (let t = START_TH + 1; t <= MAX_TH; t++) {
    const st = stageStats(t);
    const p = st.totalDays ? (1 - st.daysLeft / st.totalDays) * 100 : 100;
    const cur = t === th + 1;
    html += `<div class="stage">
      <div class="head"><b class="${cur ? 'cur' : ''}">TH${t - 1} → TH${t}${cur ? ' · now' : ''}</b><span class="muted">${st.done}/${st.total} · ${st.done === st.total ? 'done' : fmtDays(st.daysLeft) + ' left'}</span></div>
      <div class="bar ${p >= 100 ? 'good' : ''}"><i style="width:${p.toFixed(1)}%"></i></div>
    </div>`;
  }
  html += '</div>';
  el.innerHTML = html;
}

function renderAll() {
  const el = document.getElementById('view-all');
  const f = ui.filters;
  const cats = [...new Set(DATA.map(it => it.category))];
  const th = currentTH();

  if (!el.querySelector('.filters')) {
    el.innerHTML = `<div class="filters">
        <input type="search" id="fq" placeholder="Search upgrades (e.g. Cannon #3)">
        <select id="fstage"><option value="all">All stages</option>
          ${Array.from({ length: MAX_TH - START_TH }, (_, i) => START_TH + 1 + i).map(t => `<option value="${t}">Before TH${t}</option>`).join('')}
        </select>
        <select id="fcat"><option value="all">All categories</option>${cats.map(c => `<option>${esc(c)}</option>`).join('')}</select>
      </div>
      <label class="toggle"><input type="checkbox" id="fhide"> Hide done</label>
      <div id="allList"></div>`;
    el.querySelector('#fq').addEventListener('input', e => { f.q = e.target.value; renderAll(); });
    el.querySelector('#fstage').addEventListener('change', e => { f.stage = e.target.value; renderAll(); });
    el.querySelector('#fcat').addEventListener('change', e => { f.cat = e.target.value; renderAll(); });
    el.querySelector('#fhide').addEventListener('change', e => { f.hideDone = e.target.checked; renderAll(); });
  }

  const q = f.q.trim().toLowerCase();
  const rows = DATA.filter(it =>
    (f.stage === 'all' || it.beforeTH === +f.stage) &&
    (f.cat === 'all' || it.category === f.cat) &&
    (!f.hideDone || !isDone(it)) &&
    (!q || it.name.toLowerCase().includes(q)));

  const list = el.querySelector('#allList');
  list.innerHTML = rows.length
    ? `<p class="muted small">${rows.length} upgrades · ticking one also ticks the levels before it.</p>
       <div class="list">${rows.map(it => itemRow(it, { action: 'check', th, showStage: true })).join('')}</div>`
    : '<div class="card empty">No upgrades match.</div>';
}

function renderSettings() {
  const el = document.getElementById('view-settings');
  const th = currentTH();
  el.innerHTML = `<div class="card">
    <div class="field"><label>Builders</label>
      <div class="stepper">
        <button class="btn ghost" data-action="builders" data-delta="-1" aria-label="Fewer builders">−</button>
        <output>${state.builders}</output>
        <button class="btn ghost" data-action="builders" data-delta="1" aria-label="More builders">+</button>
        <span class="muted small">6 = with B.O.B.</span>
      </div>
    </div>
    <div class="field"><label for="startTH">Set my starting point</label>
      <div class="muted small">Marks every upgrade needed up to that Town Hall as done and clears done marks for later stages. Fine-tune individual items in the All tab.</div>
      <div class="btn-row">
        <select id="startTH" style="flex:1">${Array.from({ length: MAX_TH - START_TH + 1 }, (_, i) => START_TH + i)
          .map(t => `<option value="${t}" ${t === th ? 'selected' : ''}>I'm at Town Hall ${t}</option>`).join('')}</select>
        <button class="btn" data-action="set-start">Apply</button>
      </div>
    </div>
    <div class="field"><label>Theme</label>
      <div class="btn-row">
        ${['system', 'dark', 'light'].map(t => `<button class="btn ${state.theme === t ? '' : 'ghost'}" data-action="theme" data-theme="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
      </div>
    </div>
  </div>
  <h2>Backup</h2>
  <div class="card">
    <div class="muted small" style="margin-bottom:10px">Progress is saved on this device only. Copy a backup and paste it on another device to move it.</div>
    <div class="btn-row">
      <button class="btn ghost" data-action="copy-backup">Copy backup</button>
      <button class="btn ghost" data-action="paste-backup">Paste backup</button>
      <button class="btn ghost" data-action="export">Save file</button>
      <label class="btn ghost file-btn">Open file<input type="file" id="importFile" accept="application/json,.json" hidden></label>
    </div>
    <button class="btn danger block" style="margin-top:12px" data-action="reset">Reset everything</button>
  </div>
  <h2>About the data</h2>
  <div class="card small muted">
    Minimum upgrades to rush TH10 → TH18, from the rush spreadsheet (wiki data checked 2026-09-28).
    Walls, heroes, lab, pets and farming time aren't included. Hero Hall 10 and 11 are kept in to be safe; tap “Skip” on them in the All tab if the game doesn't require them.
    Level-1 build times for small buildings are estimates. Check in-game costs before relying on a figure.
  </div>
  <button class="btn ghost block" style="margin-top:16px" data-action="close-settings">Done</button>`;
  el.querySelector('#importFile').addEventListener('change', importState);
}

/* ---------------- Shell ---------------- */

function renderHeader() {
  const th = currentTH();
  const free = freeBuilders().length;
  document.getElementById('thBadge').textContent = `TH${th}`;
  document.getElementById('topSub').textContent = th >= MAX_TH
    ? 'Rush complete'
    : `Next: TH${th + 1} · ${free} of ${state.builders} builder${state.builders === 1 ? '' : 's'} free`;
  const anyReady = Object.values(state.running).some(r => r.endsAt <= Date.now());
  document.getElementById('readyDot').hidden = !anyReady;
}

let themeSetByApp = false;
function applyTheme() {
  const root = document.documentElement;
  if (state.theme === 'dark' || state.theme === 'light') {
    root.dataset.theme = state.theme;
    themeSetByApp = true;
  } else if (themeSetByApp) {
    delete root.dataset.theme;
    themeSetByApp = false;
  }
}

function render() {
  applyTheme();
  renderHeader();
  document.querySelectorAll('.view').forEach(v => { v.hidden = v.dataset.view !== ui.tab; });
  document.querySelectorAll('.tabbar button').forEach(b => {
    const on = b.dataset.tab === ui.tab;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  ({ next: renderNext, builders: renderBuilders, progress: renderProgress, all: renderAll, settings: renderSettings })[ui.tab]();
  tick();
}

function commit() { save(); render(); }

let lastReady = -1;
function tick() {
  const now = Date.now();
  document.querySelectorAll('[data-ends]').forEach(el => {
    const left = +el.dataset.ends - now;
    el.textContent = left > 0 ? fmtCountdown(left) : (el.dataset.readyText || 'ready');
  });
  const ready = Object.values(state.running).filter(r => r.endsAt <= now).length;
  const prev = lastReady;
  lastReady = ready;
  if (prev !== -1 && ready !== prev) render();
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

function exportState() {
  const blob = new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `rush-tracker-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function applyBackup(txt) {
  let data;
  try { data = JSON.parse(txt); } catch (e) { data = null; }
  if (!isObj(data) || !isObj(data.done)) { toast("That isn't a Rush Tracker backup"); return; }
  state = pruneUnknownIds(sanitizeState(data));
  commit();
  toast('Backup restored');
}

function pruneUnknownIds(st) {
  for (const key of ['done', 'include', 'running']) {
    for (const k of Object.keys(st[key])) if (!BY_ID.has(+k)) delete st[key][k];
  }
  return st;
}

function importState(e) {
  const file = e.target.files[0];
  if (!file) return;
  file.text().then(applyBackup, () => toast("Couldn't read that file"));
  e.target.value = '';
}

function copyBackup() {
  const txt = JSON.stringify(state);
  const fallback = () => ask({ title: 'Your backup', body: 'Select all of this text and copy it.', input: { value: txt, multiline: true }, okText: 'Close', cancelText: null });
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(() => toast('Backup copied'), fallback);
  } else fallback();
}

// In-page replacement for confirm()/prompt(), which some hosts block.
function ask({ title, body = '', input = null, okText = 'OK', cancelText = 'Cancel', danger = false }) {
  const wrap = document.getElementById('dialog');
  if (!wrap.hidden) return Promise.resolve(null);
  const opener = document.activeElement;
  return new Promise(resolve => {
    const field = input == null ? ''
      : input.multiline
        ? `<textarea id="dlgInput" rows="6" spellcheck="false">${esc(input.value || '')}</textarea>`
        : `<input type="text" id="dlgInput" value="${esc(input.value || '')}" autocomplete="off">`;
    wrap.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlgTitle">
        <div class="dlg-title" id="dlgTitle">${esc(title)}</div>
        ${body ? `<div class="muted small">${esc(body)}</div>` : ''}
        ${field}
        <div class="btn-row dlg-actions">
          ${cancelText ? `<button class="btn ghost" data-dlg="cancel">${esc(cancelText)}</button>` : ''}
          <button class="btn ${danger ? 'danger-fill' : ''}" data-dlg="ok">${esc(okText)}</button>
        </div>
      </div>`;
    wrap.hidden = false;
    const inp = wrap.querySelector('#dlgInput');
    (inp || wrap.querySelector('[data-dlg=ok]')).focus();
    if (inp && !input.multiline) inp.select();
    const close = val => {
      wrap.hidden = true;
      wrap.innerHTML = '';
      wrap.onclick = null;
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected) opener.focus();
      resolve(val);
    };
    const onKey = e => {
      if (e.key === 'Escape') close(null);
      else if (e.key === 'Enter' && inp && !input.multiline) close(inp.value);
    };
    document.addEventListener('keydown', onKey);
    wrap.onclick = e => {
      if (e.target === wrap) return close(null);
      const b = e.target.closest('[data-dlg]');
      if (b) close(b.dataset.dlg === 'ok' ? (inp ? inp.value : true) : null);
    };
  });
}

async function onClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id = btn.dataset.id ? +btn.dataset.id : null;
  switch (btn.dataset.action) {
    case 'start': startUpgrade(id); break;
    case 'finish': finishUpgrade(id); break;
    case 'cancel':
      if (!await ask({ title: `Cancel ${BY_ID.get(id).name}?`, body: 'It goes back to the to-do list.', okText: 'Cancel upgrade', cancelText: 'Keep it', danger: true })) return;
      delete state.running[id];
      break;
    case 'set-time': if (!await setTimeLeft(id)) return; break;
    case 'toggle-done':
      if (state.done[id]) delete state.done[id];
      else {
        const extra = markDone(id);
        if (extra) toast(`Also marked ${extra} earlier upgrade${extra === 1 ? '' : 's'} done`);
      }
      break;
    case 'toggle-include': {
      const it = BY_ID.get(id);
      state.include[id] = !isIncluded(it);
      if (state.include[id] === it.include) delete state.include[id];
      break;
    }
    case 'toggle-blocked': ui.showBlocked = !ui.showBlocked; render(); return;
    case 'more-spare': ui.spareLimit += 10; render(); return;
    case 'builders': {
      const n = state.builders + +btn.dataset.delta;
      state.builders = Math.min(MAX_BUILDERS, Math.max(1, n));
      break;
    }
    case 'set-start': {
      const t = +document.getElementById('startTH').value;
      if (!await ask({ title: `Set starting point to TH${t}?`, body: `Every upgrade needed up to Town Hall ${t} will be marked done, and later stages will be cleared.`, okText: 'Set TH${t}' })) return;
      setStartingPoint(t);
      toast(`Starting point set to TH${t}`);
      break;
    }
    case 'theme': state.theme = btn.dataset.theme; break;
    case 'export': exportState(); return;
    case 'copy-backup': copyBackup(); return;
    case 'paste-backup': {
      const txt = await ask({ title: 'Paste backup', body: 'Paste the backup text you copied from Rush Tracker.', input: { value: '', multiline: true }, okText: 'Restore' });
      if (txt) applyBackup(txt);
      return;
    }
    case 'reset':
      if (!await ask({ title: 'Erase all progress?', body: 'This clears every done mark, skipped item and builder timer.', okText: 'Erase', danger: true })) return;
      state = defaultState();
      break;
    case 'close-settings': ui.tab = ui.prevTab; break;
    default: return;
  }
  commit();
}

async function init() {
  applyTheme();
  try {
    const res = await fetch('data/upgrades.json');
    DATA = await res.json();
  } catch (e) {
    document.getElementById('view-next').innerHTML = '<div class="card empty">Could not load upgrade data. Check your connection and reload.</div>';
    return;
  }
  DATA.forEach(it => BY_ID.set(it.id, it));
  // Drop timers/marks for ids that no longer exist after a data update.
  pruneUnknownIds(state);
  computeTails();

  document.getElementById('main').addEventListener('click', onClick);
  document.getElementById('tabbar').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    ui.tab = b.dataset.tab;
    render();
    window.scrollTo(0, 0);
  });
  document.getElementById('settingsBtn').addEventListener('click', () => {
    if (ui.tab === 'settings') ui.tab = ui.prevTab;
    else { ui.prevTab = ui.tab; ui.tab = 'settings'; }
    render();
    window.scrollTo(0, 0);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
  setInterval(tick, 1000);
  render();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
