import { initChrome, toast } from './common.js';
import { api, getMe, logout } from './api.js';
import { mountAuth } from './authui.js';
import { mountSecurity } from './security.js';
import { b64e } from './store.js';

const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const fmtDate = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const toLocalInput = (ms) => { if (!ms) return ''; const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };

let links = [];
let selectedId = null;

/* ------------------------------ boot & auth ------------------------------ */
async function boot() {
  initChrome();
  $('logout').addEventListener('click', async () => { await logout(); location.reload(); });
  $('dtabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showView(b.dataset.v); });
  $('nudgeBtn').addEventListener('click', () => showView('security'));
  document.addEventListener('securitychange', async () => { $('nudge').hidden = !!(await getMe(true))?.twoFactor; });
  $('keyNew').addEventListener('click', newKey);
  $('keyRevoke').addEventListener('click', revokeKey);

  let me;
  try { await api('/api/health'); me = await getMe(true); } catch { $('loading').hidden = true; $('offline').hidden = false; return; }
  $('loading').hidden = true;
  if (me) { await showApp(); return; }

  $('authView').hidden = false;
  mountAuth($('authView'), {
    startSignup: new URLSearchParams(location.search).get('signup') === '1',
    onSuccess: async (user, extra) => {
      await showApp();
      if (extra?.justCreated) showView('security');                       // nudge new accounts toward two-step verification
      else if (typeof extra?.recoveryLeft === 'number') {
        toast(`You used a recovery code. ${extra.recoveryLeft} left. Create new ones in Security.`);
      }
    },
  });
}

async function showApp() {
  const me = await getMe();
  $('authView').hidden = true; $('appView').hidden = false;
  $('whoami').textContent = me.name ? `${me.name} · ${me.email}` : me.email;
  $('nudge').hidden = !!me.twoFactor;
  $('keyHint').textContent = me.apiKeyHint ? `A key ending in …${me.apiKeyHint} is active.` : 'No API key yet.';
  buildForm($('newForm'), { kind: 'link' });
  buildPageForm($('pageForm'));
  await loadLinks();
}

function showView(v) {
  for (const b of $('dtabs').children) b.classList.toggle('active', b.dataset.v === v);
  for (const id of ['links', 'new', 'page', 'security', 'settings']) $(`v-${id}`).hidden = id !== v;
  if (v === 'security') mountSecurity($('securityRoot')).then(async () => { $('nudge').hidden = !!(await getMe(true))?.twoFactor; });
}

/* ------------------------------ links table ------------------------------ */
async function loadLinks() {
  links = (await api('/api/links')).links;
  renderTable();
  if (selectedId && links.some((l) => l.id === selectedId)) openDetail(selectedId); else { selectedId = null; $('detail').hidden = true; }
}

function statusOf(l) {
  if (!l.active) return ['Paused', 'off'];
  if (l.expiresAt && l.expiresAt < Date.now()) return ['Expired', 'off'];
  if (l.maxScans && l.scans >= l.maxScans) return ['Limit reached', 'off'];
  return ['Active', 'ok'];
}

function renderTable() {
  const box = $('linkTable'); box.textContent = '';
  if (!links.length) {
    const e = el('div', 'empty');
    e.append(el('p', '', 'No dynamic links yet.'));
    const b = el('button', 'btn small', 'Create your first link'); b.type = 'button';
    b.addEventListener('click', () => showView('new'));
    e.append(b); box.append(e); return;
  }
  const table = el('table', 'links');
  const head = el('tr');
  for (const h of ['Name', 'Short link', 'Type', 'Scans', 'Status', 'Created']) head.append(el('th', '', h));
  const thead = el('thead'); thead.append(head); table.append(thead);
  const body = el('tbody');
  for (const l of links) {
    const tr = el('tr', 'row-link'); tr.tabIndex = 0;
    const [label, cls] = statusOf(l);
    const status = el('td'); status.append(el('span', `pill-s ${cls}`, label));
    const short = el('td', 'mono', l.shortUrl.replace(/^https?:\/\//, ''));
    tr.append(el('td', '', l.name), short, el('td', '', l.kind === 'page' ? 'Landing page' : 'Redirect'), el('td', '', String(l.scans)), status, el('td', '', fmtDate(l.createdAt)));
    const open = () => { selectedId = l.id; openDetail(l.id); };
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    body.append(tr);
  }
  table.append(body); box.append(table);
}

/* ------------------------------ link form (create + edit) ------------------------------ */
function field(labelText, input, hint) {
  const w = el('div'); const l = el('label', '', labelText);
  input.id ||= `x${Math.random().toString(36).slice(2, 8)}`; l.htmlFor = input.id;
  w.append(l, input);
  if (hint) w.append(el('div', 'hint', hint));
  return w;
}
const input = (type, value = '', attrs = {}) => { const i = el('input'); i.type = type; i.value = value; Object.assign(i, attrs); return i; };

function buildForm(box, link) {
  box.textContent = '';
  const editing = !!link.id;
  const name = input('text', link.name || '', { maxLength: 100, placeholder: 'e.g. Spring menu' });
  const dest = input('url', link.destUrl || '', { placeholder: 'https://example.com', required: true });
  const expires = input('datetime-local', toLocalInput(link.expiresAt));
  const max = input('number', link.maxScans || '', { min: 1, step: 1, placeholder: 'Unlimited' });
  const pass = input('password', '', { placeholder: link.hasPassword ? 'Leave blank to keep, or type a new one' : 'Optional', autocomplete: 'new-password' });
  const hook = input('url', link.webhookUrl || '', { placeholder: 'https://hooks.example.com/…' });
  const err = el('div', 'err'); err.setAttribute('role', 'alert');
  const clearPass = el('label', 'check');
  const clearBox = input('checkbox'); clearPass.append(clearBox, el('span', '', 'Remove password'));
  clearPass.hidden = !link.hasPassword;

  box.append(el('h3', '', editing ? 'Edit link' : 'New dynamic link'));
  box.style.marginTop = editing ? '' : '0';
  box.append(field('Name', name), field('Destination URL', dest, 'Where scanners are sent. You can change it later without reprinting.'),
    el('div', 'row'), field('Password', pass), clearPass, field('Webhook URL (https)', hook, 'Receives a POST for each scan. Works with Zapier, Make or n8n.'));
  const row = box.querySelector('.row');
  row.append(field('Expires', expires), field('Scan limit', max));

  const save = el('button', 'btn', editing ? 'Save changes' : 'Create link'); save.type = 'button';
  save.addEventListener('click', async () => {
    err.textContent = '';
    const body = { name: name.value.trim(), destUrl: dest.value.trim(), expiresAt: expires.value ? new Date(expires.value).getTime() : null,
      maxScans: max.value ? Number(max.value) : null, webhookUrl: hook.value.trim() || null };
    if (pass.value) body.password = pass.value; else if (clearBox.checked) body.password = null;
    try {
      if (editing) { await api(`/api/links/${link.id}`, { method: 'PATCH', body }); toast('Saved'); await loadLinks(); }
      else { const { link: made } = await api('/api/links', { method: 'POST', body }); selectedId = made.id; toast('Link created'); await loadLinks(); showView('links'); }
    } catch (e) { err.textContent = e.message; }
  });
  save.style.marginTop = '18px';
  box.append(err, save);
}

/* ------------------------------ landing page builder ------------------------------ */
function buildPageForm(box, link = null) {
  box.textContent = '';
  const editing = !!link;
  const p = link?.page || { title: '', bio: '', accent: '#5258e4', avatar: '', links: [{ label: '', url: '' }] };
  const title = input('text', p.title, { maxLength: 80, placeholder: 'Your name or business' });
  const bio = input('text', p.bio, { maxLength: 300, placeholder: 'A short line about you' });
  const avatar = input('url', p.avatar || '', { placeholder: 'https://… (optional image address)' });
  const accent = input('color', p.accent || '#5258e4');
  const rows = el('div', 'link-rows');
  const err = el('div', 'err'); err.setAttribute('role', 'alert');

  const addRow = (l = { label: '', url: '' }) => {
    const r = el('div', 'row');
    const a = input('text', l.label, { maxLength: 60, placeholder: 'Button label', 'aria-label': 'Button label' });
    const u = input('url', l.url, { placeholder: 'https://…', 'aria-label': 'Button URL' });
    const rm = el('button', 'btn small danger', 'Remove'); rm.type = 'button';
    rm.addEventListener('click', () => r.remove());
    r.append(a, u, rm); rows.append(r);
  };
  p.links.forEach(addRow);
  const add = el('button', 'btn small alt', 'Add button'); add.type = 'button';
  add.addEventListener('click', () => { if (rows.children.length < 20) addRow(); });

  box.append(el('h3', '', editing ? 'Edit landing page' : 'New landing page'));
  if (!editing) box.firstChild.style.marginTop = '0';
  box.append(el('p', 'hint', 'A simple mobile page with buttons: menu, WhatsApp, social profiles, anything. Point a QR code at it and edit it whenever you like.'),
    field('Title', title), field('Bio', bio), field('Profile image URL', avatar),
    field('Accent color', accent), el('label', '', 'Buttons'), rows, add, err);
  const save = el('button', 'btn', editing ? 'Save page' : 'Create page'); save.type = 'button'; save.style.marginTop = '18px';
  save.addEventListener('click', async () => {
    err.textContent = '';
    const buttons = [...rows.children].map((r) => { const [a, u] = r.querySelectorAll('input'); return { label: a.value.trim(), url: u.value.trim() }; })
      .filter((b) => b.label || b.url);
    const page = { title: title.value.trim(), bio: bio.value.trim(), accent: accent.value, avatar: avatar.value.trim() || null, links: buttons };
    try {
      if (editing) { await api(`/api/links/${link.id}`, { method: 'PATCH', body: { page } }); toast('Saved'); await loadLinks(); }
      else { const { link: made } = await api('/api/links', { method: 'POST', body: { kind: 'page', name: page.title, page } }); selectedId = made.id; toast('Page created'); await loadLinks(); showView('links'); }
    } catch (e) { err.textContent = e.message; }
  });
  box.append(save);
}

/* ------------------------------ detail & analytics ------------------------------ */
let pollTimer = null;
async function openDetail(id) {
  const link = links.find((l) => l.id === id);
  if (!link) return;
  const box = $('detail'); box.hidden = false; box.textContent = '';
  box.append(el('div', 'empty', 'Loading analytics…'));
  let stats;
  try { stats = await api(`/api/links/${id}/stats?days=30`); } catch (e) { box.textContent = e.message; return; }
  if (selectedId !== id) return;
  box.textContent = '';

  const [label, cls] = statusOf(link);
  const head = el('div', 'dash-head');
  const left = el('div');
  const h = el('h2', '', link.name); h.style.cssText = 'margin:0;font-size:1.4rem';
  const sub = el('div', 'mono', link.shortUrl); sub.style.marginTop = '4px';
  left.append(h, sub, el('span', `pill-s ${cls}`, label));
  const actions = el('div', 'tools-row');
  const copy = el('button', 'btn small alt', 'Copy link'); copy.type = 'button';
  copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(link.shortUrl); toast('Copied'); } catch { toast(link.shortUrl); } });
  const pause = el('button', 'btn small alt', link.active ? 'Pause' : 'Resume'); pause.type = 'button';
  pause.addEventListener('click', async () => { await api(`/api/links/${id}`, { method: 'PATCH', body: { active: !link.active } }); await loadLinks(); });
  const csv = el('a', 'btn small alt', 'Export CSV'); csv.href = `/api/links/${id}/export.csv`;
  const del = el('button', 'btn small danger', 'Delete'); del.type = 'button';
  del.addEventListener('click', async () => {
    if (!confirm(`Delete "${link.name}"? Printed codes pointing to it will stop working and its scan history will be removed.`)) return;
    await api(`/api/links/${id}`, { method: 'DELETE' }); selectedId = null; toast('Deleted'); await loadLinks();
  });
  actions.append(copy, pause, csv, del);
  head.append(left, actions);
  box.append(head);

  const live = el('div');
  const liveTag = el('div', 'hint', 'Live: updates automatically'); liveTag.style.cssText = 'margin-bottom:8px';
  box.append(liveTag, live);
  const paint = (s) => {
    live.textContent = '';
    const tiles = el('div', 'tiles');
    for (const [v, l] of [[s.total, 'Total scans'], [s.inRange, 'Last 30 days'], [s.uniqueVisitors, 'Unique visitors (30 days)']]) {
      const t = el('div', 'tile'); t.append(el('b', '', String(v)), el('span', '', l)); tiles.append(t);
    }
    live.append(tiles, lineChart(s.series));
    const grid = el('div', 'cols2'); grid.style.marginTop = '20px';
    for (const [t, data] of [['Devices', s.devices], ['Browsers', s.browsers], ['Operating systems', s.os], ['Countries', s.countries], ['Referrers', s.referrers]]) {
      grid.append(bars(t, data));
    }
    live.append(grid);
  };
  paint(stats);
  // Poll for new scans while this link is open and the tab is visible; the edit form and QR below stay untouched.
  clearInterval(pollTimer);
  let last = JSON.stringify(stats);
  pollTimer = setInterval(async () => {
    if (selectedId !== id || document.hidden || !live.isConnected) { if (selectedId !== id || !live.isConnected) clearInterval(pollTimer); return; }
    try {
      const s = await api(`/api/links/${id}/stats?days=30`);
      const j = JSON.stringify(s);
      if (j !== last && selectedId === id) { last = j; paint(s); }
    } catch { /* transient network error: try again next tick */ }
  }, 5000);

  const split = el('div', 'detail-grid'); split.style.marginTop = '28px';
  const form = el('div');
  if (link.kind === 'page') buildPageForm(form, link); else buildForm(form, link);
  const qrBox = el('div'); qrBox.append(qrPanel(link));
  split.append(form, qrBox);
  box.append(split);
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function lineChart(series) {
  const W = 700; const H = 160; const pad = 6;
  const max = Math.max(1, ...series.map((s) => s.count));
  const step = (W - pad * 2) / Math.max(1, series.length - 1);
  const pts = series.map((s, i) => [pad + i * step, H - pad - (s.count / max) * (H - pad * 2 - 10)]);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'chart'); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Scans per day for the last ${series.length} days. Peak ${max}.`);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = document.createElementNS(ns, 'path');
  area.setAttribute('d', `${line} L${pts.at(-1)[0]},${H - pad} L${pts[0][0]},${H - pad} Z`); area.setAttribute('fill', 'var(--brand-soft)');
  const stroke = document.createElementNS(ns, 'path');
  stroke.setAttribute('d', line); stroke.setAttribute('fill', 'none'); stroke.setAttribute('stroke', 'var(--brand)'); stroke.setAttribute('stroke-width', '2.5'); stroke.setAttribute('stroke-linejoin', 'round');
  svg.append(area, stroke);
  series.forEach((s, i) => {
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', pts[i][0]); c.setAttribute('cy', pts[i][1]); c.setAttribute('r', s.count ? 3.5 : 0); c.setAttribute('fill', 'var(--brand)');
    const t = document.createElementNS(ns, 'title'); t.textContent = `${s.day}: ${s.count} scan${s.count === 1 ? '' : 's'}`; c.append(t);
    svg.append(c);
  });
  const wrap = el('div'); wrap.append(svg);
  const axis = el('div', 'hint'); axis.style.cssText = 'display:flex;justify-content:space-between';
  axis.append(el('span', '', series[0].day), el('span', '', `Peak: ${max}/day`), el('span', '', series.at(-1).day));
  wrap.append(axis);
  return wrap;
}

function bars(title, data) {
  const w = el('div'); w.append(el('h4', '', title));
  if (!data.length) { w.append(el('div', 'hint', 'No data yet')); return w; }
  const top = Math.max(...data.map((d) => d.count));
  const box = el('div', 'bars');
  for (const d of data) {
    const r = el('div', 'bar');
    const track = el('div', 't'); const fill = el('i'); fill.style.width = `${Math.max(4, (d.count / top) * 100)}%`; track.append(fill);
    r.append(el('span', '', d.label), track, el('span', '', String(d.count)));
    box.append(r);
  }
  w.append(box); return w;
}

function qrPanel(link) {
  const w = el('div'); w.append(el('h3', '', 'QR code'));
  w.firstChild.style.marginTop = '0';
  const host = el('div'); host.style.cssText = 'background:#fff;padding:12px;border-radius:14px;border:1px solid var(--line);display:inline-block;line-height:0';
  w.append(host);
  if (window.QRCodeStyling) {
    const qr = new window.QRCodeStyling({
      width: 220, height: 220, type: 'canvas', data: link.shortUrl, margin: 8, qrOptions: { errorCorrectionLevel: 'H' },
      dotsOptions: { color: '#1d1d1f', type: 'square' }, backgroundOptions: { color: '#ffffff' },
    });
    qr.append(host);
    const row = el('div', 'tools-row'); row.style.cssText = 'justify-content:flex-start;margin-top:12px';
    for (const ext of ['png', 'svg']) {
      const b = el('button', 'btn small alt', ext.toUpperCase()); b.type = 'button';
      b.addEventListener('click', () => qr.download({ name: `qr-${link.code}`, extension: ext }));
      row.append(b);
    }
    w.append(row);
  }
  const state = { type: 'url', values: { url: { url: link.shortUrl } }, v: 1 };
  const style = el('a', 'btn small', 'Style it in the generator'); style.href = `/#d=${b64e(state)}`; style.style.marginTop = '12px';
  w.append(style);
  w.append(el('p', 'hint', 'The code contains the short link above, so editing the destination never changes the printed code.'));
  return w;
}

/* ------------------------------ API key ------------------------------ */
async function newKey() {
  if (!confirm('Generate a new key? Any existing key stops working immediately.')) return;
  try {
    const { apiKey, hint } = await api('/api/me/apikey', { method: 'POST' });
    $('keyShown').textContent = apiKey;
    $('keyHint').textContent = `Copy this key now. It is shown once. (…${hint})`;
    try { await navigator.clipboard.writeText(apiKey); toast('Key copied'); } catch { /* user can copy manually */ }
  } catch (e) { toast(e.message); }
}
async function revokeKey() {
  if (!confirm('Revoke the API key? Apps using it will stop working.')) return;
  await api('/api/me/apikey', { method: 'DELETE' });
  $('keyShown').textContent = ''; $('keyHint').textContent = 'No API key.';
}

boot();
