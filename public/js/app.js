import { TYPES, typeById, printCheck, withScheme } from './content.js';
import { applyI18n, t } from './i18n.js';
import { initChrome, toast, refreshAuthLink } from './common.js';
import { api, getMe } from './api.js';
import { mountAuth } from './authui.js';
import { TEMPLATES, ICONS, extractPalette, deriveColors, designFromPalette, normalizeLogo } from './theme.js';
import { composeCanvas, composeSvg, FRAME_PRESETS } from './frame.js';
import { Store, b64e, b64d } from './store.js';
import { parseRows, uniqueNames, BULK_MAX } from './bulk.js';
import { canvasToPdf } from './pdf.js';

const $ = (id) => document.getElementById(id);
const SAMPLE = 'https://qrforge.app';
const STYLE_IDS = ['fg', 'bg', 'dots', 'corner', 'tstyle', 'c2', 'size', 'lsize', 'lpad'];

/* ------------------------------ state ------------------------------ */
let curType = document.body.dataset.type || 'url';
const values = {};                       // values[typeId][fieldId]
let logo = null, palette = [], mainIdx = 0, logoRound = false;
let templateId = null;
let autoMode = false, repairs = 0;       // auto-repair only runs for designs the app generated itself
let touched = false;
let dyn = { on: false, link: null };
let ptab = 'qr';
let lastBitmap = null;
let qr = null;
let restoring = false;

/* ------------------------------ small utils ------------------------------ */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const canvasBlob = (cv, type = 'image/png', q = 0.95) => new Promise((r) => cv.toBlob(r, type, q));
const setStatus = (msg) => { $('status').textContent = msg; };

/* ------------------------------ settings ------------------------------ */
function readStyle() {
  return {
    fg: $('fg').value, bg: $('bg').value, dots: $('dots').value, corner: $('corner').value,
    tstyle: $('tstyle').value, c2: $('c2').value, size: +$('size').value,
    lsize: +$('lsize').value, lpad: +$('lpad').value, lclear: $('lclear').checked,
    tauto: $('tauto').checked, btint: $('btint').checked, tpl: templateId,
  };
}
function frameOpts() {
  return {
    style: $('fstyle').value, text: $('ftext').value,
    color: $('fauto').checked ? $('fg').value : $('fcolor').value, bg: $('bg').value,
  };
}
function getSettings({ withLogo = true } = {}) {
  return {
    v: 1, type: curType, values: JSON.parse(JSON.stringify(values)), style: readStyle(),
    frame: { style: $('fstyle').value, text: $('ftext').value, color: $('fcolor').value, auto: $('fauto').checked },
    print: { w: +$('pw').value, d: +$('pd').value },
    logo: withLogo ? logo : null, palette, mainIdx, logoRound,
    dyn: dyn.on ? { on: true, link: dyn.link } : null,
  };
}
function applySettings(s) {
  restoring = true;
  for (const k of Object.keys(values)) delete values[k];
  Object.assign(values, s.values || {});
  const st = s.style || {};
  for (const id of STYLE_IDS) if (st[id] !== undefined) $(id).value = st[id];
  if (st.lclear !== undefined) $('lclear').checked = st.lclear;
  if (st.tauto !== undefined) $('tauto').checked = st.tauto;
  if (st.btint !== undefined) $('btint').checked = st.btint;
  templateId = st.tpl ?? null;
  const f = s.frame || {};
  if (f.style) $('fstyle').value = f.style;
  if (f.text !== undefined) $('ftext').value = f.text;
  if (f.color) $('fcolor').value = f.color;
  if (f.auto !== undefined) $('fauto').checked = f.auto;
  if (s.print) { $('pw').value = s.print.w; $('pd').value = s.print.d; }
  logo = s.logo || null; palette = s.palette || []; mainIdx = s.mainIdx || 0; logoRound = !!s.logoRound;
  dyn = s.dyn?.on ? { on: true, link: s.dyn.link || null } : { on: false, link: null };
  autoMode = false;
  setType(s.type || curType, { skipRender: true });
  syncLabels();
  renderSwatches();
  restoring = false;
  render();
  if (logo && !palette.length) themeFromLogo({ design: false });
}

/* ------------------------------ undo / redo ------------------------------ */
const undoStack = []; let undoIdx = -1; let lastPush = 0; let restoreSeq = -1;
function pushUndo(my) {
  if (restoring) return;
  const snap = JSON.stringify(getSettings());
  if (my === restoreSeq) {                    // this render came from undo/redo itself: just resync, never branch history
    undoStack[undoIdx] = snap; restoreSeq = -1; updateUndoButtons(); return;
  }
  if (undoStack[undoIdx] === snap) return;
  const now = Date.now();
  if (undoIdx > 0 && undoIdx === undoStack.length - 1 && now - lastPush < 700) {
    undoStack[undoIdx] = snap;                // fast successive edits (typing, dragging a slider) count as one step
  } else {
    undoStack.length = undoIdx + 1;
    undoStack.push(snap);
    if (undoStack.length > 50) undoStack.shift();
    undoIdx = undoStack.length - 1;
  }
  lastPush = now;
  updateUndoButtons();
}
function updateUndoButtons() {
  $('undo').disabled = undoIdx <= 0;
  $('redo').disabled = undoIdx >= undoStack.length - 1;
}
function stepUndo(dir) {
  const next = undoIdx + dir;
  if (next < 0 || next >= undoStack.length) return;
  undoIdx = next;
  applySettings(JSON.parse(undoStack[undoIdx]));
  restoreSeq = seq;                           // applySettings queued exactly one render; remember which
  updateUndoButtons();
}

/* ------------------------------ content types ------------------------------ */
function buildTabs() {
  const box = $('tabs');
  box.textContent = '';
  for (const ty of [...TYPES, { id: 'bulk', label: 'Bulk' }]) {
    const b = el('button', '', ty.label);
    b.type = 'button'; b.dataset.type = ty.id; b.setAttribute('role', 'tab');
    b.addEventListener('click', () => { setType(ty.id); });
    box.append(b);
  }
}

function renderFields() {
  const box = $('fields');
  box.textContent = '';
  if (curType === 'bulk') return;
  const def = typeById(curType);
  values[curType] ||= {};
  let pair = null;
  for (const f of def.fields) {
    const wrap = el('div');
    const label = el('label', '', f.label); label.htmlFor = `f_${f.id}`;
    let input;
    if (f.type === 'textarea') { input = el('textarea'); input.rows = 3; }
    else if (f.type === 'select') {
      input = el('select');
      for (const o of f.opts) { const op = el('option', '', o); op.value = o; input.append(op); }
    } else { input = el('input'); input.type = f.type; }
    input.id = `f_${f.id}`;
    if (f.ph) input.placeholder = f.ph;
    if (f.type === 'tel') input.setAttribute('inputmode', 'tel');
    if (values[curType][f.id] !== undefined) input.value = values[curType][f.id];
    else if (f.type === 'select') values[curType][f.id] = f.opts[0];
    const onEdit = () => { touched = true; values[curType][f.id] = input.value; render(); };
    input.addEventListener('input', onEdit);
    input.addEventListener('change', onEdit);
    wrap.append(label, input);
    if (f.half) {
      if (!pair) { pair = el('div', 'row'); box.append(pair); }
      pair.append(wrap);
      if (pair.children.length === 2) pair = null;
    } else { pair = null; box.append(wrap); }
  }
}

function setType(id, { skipRender = false } = {}) {
  curType = id === 'bulk' || TYPES.some((x) => x.id === id) ? id : 'url';
  for (const b of $('tabs').children) {
    const on = b.dataset.type === curType;
    b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on));
  }
  $('typePanel').hidden = curType === 'bulk';
  $('bulkPanel').hidden = curType !== 'bulk';
  if (curType !== 'url' && dyn.on) dyn = { on: false, link: null };
  renderFields();
  updateDynUI();
  $('err').textContent = '';
  if (!skipRender) render();
}

function currentData() {
  if (curType === 'bulk') return SAMPLE;
  if (dyn.on && dyn.link?.shortUrl) return dyn.link.shortUrl;
  return typeById(curType).build(values[curType] || {});
}

/* ------------------------------ QR rendering ------------------------------ */
function qrOptions(data) {
  const s = readStyle();
  const grad = s.tstyle === 'gradient'
    ? { type: 'linear', rotation: Math.PI / 4, colorStops: [{ offset: 0, color: s.fg }, { offset: 1, color: s.c2 }] } : null;
  const corner = s.tstyle === 'twotone' ? s.c2 : s.fg;
  return {
    width: s.size, height: s.size, type: 'canvas', data, margin: Math.round(s.size * 0.06),
    qrOptions: { errorCorrectionLevel: 'H' },
    dotsOptions: { color: s.fg, type: s.dots, gradient: grad },
    cornersSquareOptions: { color: corner, type: s.corner },
    cornersDotOptions: { color: corner },
    backgroundOptions: { color: s.bg },
    image: logo || undefined,
    imageOptions: { crossOrigin: 'anonymous', margin: s.lpad, imageSize: s.lsize / 100, hideBackgroundDots: s.lclear },
  };
}

let timer = 0; let seq = 0; let inflight = Promise.resolve();
function render() {
  syncLabels();
  seq++;
  clearTimeout(timer);
  timer = setTimeout(() => { timer = 0; inflight = doRender(seq); }, 90);
}
async function flush() {
  if (timer) { clearTimeout(timer); timer = 0; inflight = doRender(seq); }
  await inflight;
}

function syncLabels() {
  $('fgv').textContent = $('fg').value; $('bgv').textContent = $('bg').value; $('c2v').textContent = $('c2').value;
  $('sizev').textContent = $('size').value; $('lsizev').textContent = $('lsize').value; $('lpadv').textContent = $('lpad').value;
  $('logoOpts').hidden = !logo;
  $('c2').disabled = $('tstyle').value === 'solid';
  $('fcolor').disabled = $('fauto').checked;
  for (const b of $('templates').children) b.classList.toggle('sel', b.dataset.id === templateId);
}

async function doRender(my) {
  if (!qr) return;
  const data = currentData();
  const have = !!data;
  const vals = values[curType] || {};
  const hint = curType === 'bulk' ? '' : (typeById(curType).check?.(vals) || '');
  $('err').textContent = hint || (!have && touched && curType !== 'bulk' ? t('msg.empty', 'Enter some content to generate a QR code.') : '');

  qr.update(qrOptions(have ? data : SAMPLE));
  let blob;
  try {
    blob = await Promise.race([qr.getRawData('png'), new Promise((_, rej) => setTimeout(() => rej(new Error('render timeout')), 8000))]);
  } catch (e) {
    if (my === seq) {
      $('scan').className = 'scan bad';
      $('scan').textContent = logo ? 'Could not render with this logo. Try another image.' : 'Could not render the QR code. Reload the page.';
      console.error(e);
    }
    return;
  }
  if (my !== seq || !blob) return;
  const bmp = await createImageBitmap(blob);
  if (my !== seq) return;
  lastBitmap = bmp;

  const cv = composeCanvas(bmp, frameOpts());
  const pv = $('preview');
  pv.width = cv.width; pv.height = cv.height;
  pv.getContext('2d').drawImage(cv, 0, 0);
  pv.classList.toggle('dim', !have);

  renderMock();
  updatePrint(have ? data : '');
  scanCheck(have ? data : '', bmp, my);
  // Remember the look, never the content: Wi-Fi passwords, contacts and payment details stay out of storage.
  Store.saveLast({ ...getSettings(), values: {}, dyn: null });
  pushUndo(my);
}

async function scanCheck(expected, bmp, my) {
  const el_ = $('scan');
  if (!expected || typeof window.jsQR !== 'function') { el_.className = 'scan'; return; }
  const s = Math.min(bmp.width, 640);
  const cv = document.createElement('canvas'); cv.width = cv.height = s;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, s, s);
  const r = window.jsQR(ctx.getImageData(0, 0, s, s).data, s, s);
  if (my !== seq) return;
  const norm = (x) => x.replace(/\s+/g, '');
  const ok = !!r && norm(r.data) === norm(expected);
  if (!ok && autoMode && logo && repairs < 8) {
    repairs++;
    if ($('dots').value !== 'square') $('dots').value = 'square';
    else if ($('tstyle').value !== 'solid') $('tstyle').value = 'solid';
    else if (+$('lsize').value > 12) $('lsize').value = +$('lsize').value - 3;
    else repairs = 8;
    if (repairs < 8) { render(); return; }
  }
  el_.className = `scan ${ok ? 'ok' : 'bad'}`;
  el_.textContent = ok ? t('msg.scanok', '✓ Scan test passed') : t('msg.scanbad', '⚠ May not scan: lower logo size or raise contrast');
}

function updatePrint(data) {
  const chip = $('printChip');
  if (!data) { chip.hidden = true; return; }
  const res = printCheck({ data, widthCm: +$('pw').value || 5, distanceM: +$('pd').value || 0.5 });
  chip.hidden = false;
  chip.className = `print-chip ${res.ok ? 'ok' : 'bad'}`;
  chip.textContent = res.ok
    ? `Print check OK: about ${res.moduleMm.toFixed(2)} mm per dot, scans from up to ${(+$('pw').value * 10 / 100).toFixed(1)} m.`
    : res.issues.join(' ');
}

/* ------------------------------ mockups ------------------------------ */
const PTABS = [['qr', 'QR'], ['card', 'Card'], ['flyer', 'Flyer'], ['tent', 'Table tent'], ['sticker', 'Sticker'], ['phone', 'Phone']];
function buildPreviewTabs() {
  for (const [id, label] of PTABS) {
    const b = el('button', id === ptab ? 'active' : '', label);
    b.type = 'button'; b.dataset.p = id;
    b.addEventListener('click', () => {
      ptab = id;
      for (const x of $('ptabs').children) x.classList.toggle('active', x.dataset.p === id);
      renderMock();
    });
    $('ptabs').append(b);
  }
}
function renderMock() {
  const m = $('mock'); const pv = $('preview');
  if (ptab === 'qr') { pv.hidden = false; m.hidden = true; return; }
  pv.hidden = true; m.hidden = false;
  m.textContent = '';
  m.style.setProperty('--mc', $('fg').value);
  const src = pv.toDataURL('image/png');
  const img = () => { const i = el('img'); i.src = src; i.alt = 'QR code'; return i; };
  const v = values.vcard || {};
  const label = ($('ftext').value || 'Scan me').trim();
  if (ptab === 'card') {
    const c = el('div', 'm-card'); const who = el('div', 'who');
    who.append(el('b', '', `${v.first || ''} ${v.last || ''}`.trim() || 'Your Name'), el('span', '', v.title || v.org || 'Scan to connect'));
    c.append(who, img()); m.append(c);
  } else if (ptab === 'flyer') {
    const f = el('div', 'm-flyer'); f.append(el('div', 'hd', label), el('p', '', 'Scan the code for details'), img()); m.append(f);
  } else if (ptab === 'tent') {
    const f = el('div', 'm-tent'); f.append(el('b', '', label), el('span', '', 'Point your camera here'), img()); m.append(f);
  } else if (ptab === 'sticker') {
    const f = el('div', 'm-sticker'); f.append(img()); m.append(f);
  } else if (ptab === 'phone') {
    const p = el('div', 'm-phone'); const s = el('div', 'scr'); s.append(img(), el('small', '', label)); p.append(s); m.append(p);
  }
}

/* ------------------------------ logo & theme ------------------------------ */
function renderSwatches() {
  const box = $('swatches'); box.textContent = '';
  palette.forEach((c, i) => {
    const b = el('button'); b.type = 'button'; b.title = c; b.style.background = c; b.setAttribute('aria-label', `Use ${c}`);
    if (i === mainIdx) b.className = 'sel';
    b.addEventListener('click', () => { mainIdx = i; templateId = null; applyThemeColors(); renderSwatches(); render(); });
    box.append(b);
  });
}
function applyThemeColors() {
  if (!palette.length || !$('tauto').checked) return;
  const d = deriveColors(palette, mainIdx, { tintBg: $('btint').checked, bg: $('bg').value });
  $('fg').value = d.fg; $('c2').value = d.c2;
  if ($('btint').checked) $('bg').value = d.bg;
}
function autoDesign() {
  if (!palette.length) return;
  const d = designFromPalette(palette, logoRound);
  $('dots').value = d.dots; $('corner').value = d.corner; $('tstyle').value = d.tstyle;
  $('tauto').checked = true; $('btint').checked = d.tintBg;
  if (!d.tintBg) $('bg').value = '#ffffff';
  $('lsize').value = 22;
  templateId = null; mainIdx = 0; autoMode = true; repairs = 0;
  applyThemeColors(); renderSwatches(); render();
}
async function themeFromLogo({ design = true } = {}) {
  if (logo) { const r = await extractPalette(logo); palette = r.colors; logoRound = r.round; } else { palette = []; }
  mainIdx = 0;
  if (!logo) { $('fg').value = '#1d1d1f'; $('bg').value = '#ffffff'; }
  if (logo && design) autoDesign(); else { renderSwatches(); render(); }
}
async function loadLogo(file) {
  if (!file || !/^image\//.test(file.type)) { $('err').textContent = 'Please choose an image file.'; return; }
  if (file.size > 5 * 1024 * 1024) { $('err').textContent = 'Logo is too large (max 5 MB).'; return; }
  try { logo = await normalizeLogo(file); } catch { $('err').textContent = 'Could not read that image.'; return; }
  await themeFromLogo();
}

/* ------------------------------ templates ------------------------------ */
function buildTemplates() {
  for (const tp of TEMPLATES) {
    const b = el('button', 'tpl'); b.type = 'button'; b.dataset.id = tp.id;
    const th = el('div', 'thumb'); b.append(th, el('span', '', tp.name));
    if (window.QRCodeStyling) {
      const grad = tp.tstyle === 'gradient' ? { type: 'linear', rotation: Math.PI / 4, colorStops: [{ offset: 0, color: tp.fg }, { offset: 1, color: tp.c2 }] } : null;
      const cc = tp.tstyle === 'twotone' ? tp.c2 : tp.fg;
      new window.QRCodeStyling({
        width: 96, height: 96, type: 'canvas', data: SAMPLE, margin: 4, qrOptions: { errorCorrectionLevel: 'H' },
        dotsOptions: { color: tp.fg, type: tp.dots, gradient: grad }, cornersSquareOptions: { color: cc, type: tp.corner },
        cornersDotOptions: { color: cc }, backgroundOptions: { color: tp.bg },
      }).append(th);
    }
    b.addEventListener('click', () => {
      for (const [k, v] of Object.entries({ fg: tp.fg, bg: tp.bg, dots: tp.dots, corner: tp.corner, tstyle: tp.tstyle, c2: tp.c2 })) $(k).value = v;
      $('tauto').checked = false; $('btint').checked = false; autoMode = false; templateId = tp.id;
      render();
    });
    $('templates').append(b);
  }
}

/* ------------------------------ export ------------------------------ */
async function composed(fmt) {
  await flush();
  if (!lastBitmap) throw new Error('not ready');
  return composeCanvas(lastBitmap, frameOpts(), { pageBg: fmt === 'png' ? null : '#ffffff' });
}

async function exportFile() {
  const data = currentData();
  if (!data) { setStatus(t('msg.add', 'Add some content first.')); return; }
  if (!qr) { setStatus('The QR library did not load. Check your connection and reload.'); return; }
  const fmt = $('fmt').value;
  try {
    if (fmt === 'svg') {
      await flush();
      const text = await (await qr.getRawData('svg')).text();
      saveBlob(new Blob([composeSvg(text, frameOpts(), +$('size').value)], { type: 'image/svg+xml' }), 'qrcode.svg');
    } else if (fmt === 'pdf') {
      const cv = await composed('pdf');
      const wMm = Math.max(1, +$('pw').value || 5) * 10;
      const hMm = wMm * (cv.height / cv.width);
      // 300 dpi at the printed size is plenty; larger prints should use SVG.
      const targetW = Math.min(cv.width, Math.max(600, Math.round((wMm / 25.4) * 300)));
      let src = cv;
      if (targetW < cv.width) {
        src = document.createElement('canvas');
        src.width = targetW; src.height = Math.round((cv.height * targetW) / cv.width);
        const sctx = src.getContext('2d'); sctx.imageSmoothingQuality = 'high'; sctx.drawImage(cv, 0, 0, src.width, src.height);
      }
      saveBlob(new Blob([await canvasToPdf(src, wMm, hMm, 'QR code')], { type: 'application/pdf' }), 'qrcode.pdf');
    } else {
      const cv = await composed(fmt);
      saveBlob(await canvasBlob(cv, `image/${fmt}`), `qrcode.${fmt === 'jpeg' ? 'jpg' : fmt}`);
    }
    setStatus(t('msg.saved', 'Downloaded!'));
    await addToHistory(data);
  } catch (e) {
    console.error(e);
    setStatus('Could not create that file. Try another format.');
  }
}

async function copyImage() {
  if (!currentData()) { setStatus(t('msg.add', 'Add some content first.')); return; }
  try {
    const cv = await composed('png');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': await canvasBlob(cv) })]);
    toast(t('msg.copied', 'Copied to clipboard'));
  } catch { setStatus('Copy is not supported in this browser. Use Download.'); }
}

async function shareLink() {
  const s = getSettings({ withLogo: false });
  delete s.dyn; delete s.palette;
  s.values = { [curType]: s.values[curType] || {} };      // only the content being shared, never other tabs' data
  const url = `${location.origin}${location.pathname}#d=${b64e(s)}`;
  try { await navigator.clipboard.writeText(url); toast(t('msg.linkcopied', 'Share link copied')); } catch { setStatus(url); }
  if (logo) setTimeout(() => toast(t('msg.nologo', 'Logos are not included in share links')), 2800);
}

/* ------------------------------ history ------------------------------ */
async function addToHistory(data) {
  const cv = await composed('png');
  const t_ = document.createElement('canvas'); const k = 96 / Math.max(cv.width, cv.height);
  t_.width = Math.round(cv.width * k); t_.height = Math.round(cv.height * k);
  t_.getContext('2d').drawImage(cv, 0, 0, t_.width, t_.height);
  Store.pushHistory({ id: `${Date.now()}`, ts: Date.now(), type: curType, label: String(data).slice(0, 60), thumb: t_.toDataURL('image/png'), settings: getSettings() });
  renderHistory();
}
function renderHistory() {
  const list = Store.history();
  $('recent').hidden = !list.length;
  const strip = $('strip'); strip.textContent = '';
  for (const h of list) {
    const b = el('button'); b.type = 'button'; b.title = h.label;
    const i = el('img'); i.src = h.thumb; i.alt = h.label; b.append(i);
    b.addEventListener('click', () => applySettings(h.settings));
    strip.append(b);
  }
}

/* ------------------------------ brand kits ------------------------------ */
function renderKits() {
  const box = $('kits'); box.textContent = '';
  for (const k of Store.kits()) {
    const row = el('div', 'kit');
    if (k.logo) { const i = el('img'); i.src = k.logo; i.alt = ''; row.append(i); }
    const dots = el('div', 'dots');
    for (const c of [k.style?.fg, k.style?.c2, k.style?.bg]) { const d = el('i'); d.style.background = c || '#ccc'; dots.append(d); }
    const apply = el('button', 'btn small alt', 'Apply'); apply.type = 'button';
    apply.addEventListener('click', () => {
      applySettings({ ...getSettings(), style: k.style, frame: k.frame, logo: k.logo, palette: k.palette || [], mainIdx: k.mainIdx || 0, logoRound: !!k.logoRound });
      toast(`Applied "${k.name}"`);
    });
    const del = el('button', 'btn small danger', 'Delete'); del.type = 'button';
    del.addEventListener('click', () => { Store.saveKits(Store.kits().filter((x) => x.id !== k.id)); renderKits(); pushKitsToCloud(); });
    row.append(el('b', '', k.name), dots, apply, del);
    box.append(row);
  }
}
function saveKit() {
  const s = getSettings();
  const name = $('kitName').value.trim() || `Kit ${Store.kits().length + 1}`;
  const kit = { id: crypto.randomUUID(), name, ts: Date.now(), logo: s.logo, style: s.style, frame: s.frame, palette: s.palette, mainIdx: s.mainIdx, logoRound: s.logoRound };
  kit.style.tpl = null;
  Store.saveKits([kit, ...Store.kits()].slice(0, 20));
  $('kitName').value = '';
  renderKits(); toast(`Saved "${name}"`); pushKitsToCloud();
}
async function pushKitsToCloud() {
  if (!(await getMe())) { $('kitSync').textContent = 'Saved on this device. Log in to sync kits across devices.'; return; }
  try { await api('/api/brand', { method: 'PUT', body: { kits: Store.kits() } }); $('kitSync').textContent = 'Synced to your account.'; } catch { $('kitSync').textContent = 'Saved on this device (sync unavailable).'; }
}
async function pullKitsFromCloud() {
  if (!(await getMe())) { $('kitSync').textContent = 'Saved on this device. Log in to sync kits across devices.'; return; }
  try {
    const { brand } = await api('/api/brand');
    const merged = new Map(Store.kits().map((k) => [k.id, k]));
    for (const k of brand?.kits || []) if (!merged.has(k.id) || (merged.get(k.id).ts || 0) < (k.ts || 0)) merged.set(k.id, k);
    Store.saveKits([...merged.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 20));
    renderKits(); $('kitSync').textContent = 'Synced to your account.';
  } catch { /* offline */ }
}

/* ------------------------------ dynamic codes & auth ------------------------------ */
let dlgResolve = null;
let authMounted = false;
function askLogin() {
  return new Promise((res) => {
    dlgResolve = res;
    if (!authMounted) {
      authMounted = true;
      mountAuth($('authMount'), {
        idPrefix: 'dlg',
        onSuccess: () => { dlgResolve?.(true); dlgResolve = null; $('authDlg').close(); refreshAuthLink(); pullKitsFromCloud(); },
      });
    }
    $('authDlg').showModal();
  });
}
function updateDynUI() {
  $('dynBox').hidden = !(curType === 'url');
  $('dynOn').checked = dyn.on;
  $('dynInfo').hidden = !dyn.on;
  if (!dyn.on) return;
  const btn = $('dynCreate');
  btn.dataset.i18n = dyn.link ? 'dyn.update' : 'dyn.create';
  btn.dataset.en = dyn.link ? 'Update destination' : 'Create dynamic code';
  btn.textContent = btn.dataset.en;
  $('dynShort').textContent = dyn.link ? dyn.link.shortUrl : '';
  $('dynDash').hidden = !dyn.link;
  $('dynMsg').textContent = dyn.link
    ? 'This QR code points to your short link. Change the URL above and press Update to redirect it. No reprint needed.'
    : 'Enter your URL above, then create the code. It will redirect through a short link you can edit later.';
}
async function onDynToggle() {
  if ($('dynOn').checked) {
    if (!(await getMe()) && !(await askLogin())) { $('dynOn').checked = false; return; }
    dyn = { on: true, link: null };
  } else dyn = { on: false, link: null };
  updateDynUI(); render();
}
async function dynAction() {
  const vals = values.url || {};
  const url = withScheme(vals.url);
  if (!url || typeById('url').check(vals)) { $('err').textContent = 'Enter a valid URL first.'; return; }
  try {
    if (!dyn.link) {
      const { link } = await api('/api/links', { method: 'POST', body: { destUrl: url, name: new URL(url).hostname } });
      dyn.link = link; toast('Dynamic code created');
    } else {
      const { link } = await api(`/api/links/${dyn.link.id}`, { method: 'PATCH', body: { destUrl: url } });
      dyn.link = link; toast('Destination updated');
    }
    $('err').textContent = '';
  } catch (e) { $('err').textContent = e.offline ? 'Dynamic codes need the QRForge server.' : e.message; }
  updateDynUI(); render();
}

/* ------------------------------ bulk ------------------------------ */
async function bulkGenerate() {
  const st = $('bulkStatus');
  if (!qr || !window.JSZip) { st.textContent = 'Required libraries did not load. Check your connection and reload.'; return; }
  let rows = parseRows($('bulkText').value);
  if (!rows.length) { st.textContent = 'Add at least one line first.'; return; }
  if (rows.length > BULK_MAX) { rows = rows.slice(0, BULK_MAX); toast(`Only the first ${BULK_MAX} lines will be generated`); }
  const asUrl = $('bulkType').value === 'url';
  rows = rows.map((r) => ({ ...r, data: asUrl ? withScheme(r.data) : r.data }));
  const badIdx = asUrl ? rows.findIndex((r) => typeById('url').check({ url: r.data })) : -1;
  if (badIdx >= 0) { st.textContent = `Line ${badIdx + 1} is not a valid web address.`; return; }

  const fmt = $('bulkFmt').value;
  const names = uniqueNames(rows, fmt);
  const zip = new window.JSZip();
  const inst = new window.QRCodeStyling(qrOptions(SAMPLE));
  $('bulkGo').disabled = true;
  try {
    for (let i = 0; i < rows.length; i++) {
      inst.update({ data: rows[i].data });
      if (fmt === 'svg') {
        const text = await (await inst.getRawData('svg')).text();
        zip.file(names[i], composeSvg(text, frameOpts(), +$('size').value));
      } else {
        const bmp = await createImageBitmap(await inst.getRawData('png'));
        zip.file(names[i], await canvasBlob(composeCanvas(bmp, frameOpts())));
      }
      st.textContent = `Generating ${i + 1} of ${rows.length}…`;
      if (i % 5 === 4) await new Promise((r) => setTimeout(r));
    }
    saveBlob(await zip.generateAsync({ type: 'blob' }), 'qrcodes.zip');
    st.textContent = `Done: ${rows.length} codes downloaded.`;
  } catch (e) { console.error(e); st.textContent = 'Something went wrong while generating. Try fewer lines.'; }
  $('bulkGo').disabled = false;
}

/* ------------------------------ wiring ------------------------------ */
function wire() {
  for (const id of STYLE_IDS) {
    $(id).addEventListener('input', (e) => {
      if (e.isTrusted && !restoring) {
        templateId = null;
        if (id === 'fg' || id === 'c2') $('tauto').checked = false;
        if (id === 'bg') $('btint').checked = false;
        if (['dots', 'corner', 'tstyle', 'lsize', 'lpad', 'fg', 'bg', 'c2'].includes(id)) autoMode = false;
      }
      render();
    });
  }
  for (const id of ['lclear', 'fstyle', 'ftext', 'fcolor', 'pw', 'pd']) $(id).addEventListener('input', render);
  $('fauto').addEventListener('input', render);
  $('fcolor').addEventListener('input', () => { $('fauto').checked = false; render(); });
  $('tauto').addEventListener('input', () => { applyThemeColors(); render(); });
  $('btint').addEventListener('input', () => {
    if (!$('btint').checked) $('bg').value = '#ffffff';
    applyThemeColors(); render();
  });
  $('autodesign').addEventListener('click', autoDesign);
  $('rmlogo').addEventListener('click', () => { logo = null; themeFromLogo(); $('logo').value = ''; });

  $('logo').addEventListener('change', (e) => loadLogo(e.target.files[0]));
  const drop = $('drop');
  for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
  drop.addEventListener('drop', (e) => loadLogo(e.dataTransfer.files[0]));

  for (const [name, src] of Object.entries(ICONS)) {
    const b = el('button'); b.type = 'button'; b.title = name;
    const i = el('img'); i.src = src; i.alt = name; b.append(i);
    b.addEventListener('click', () => { logo = src; themeFromLogo(); });
    $('icons').append(b);
  }
  for (const txt of FRAME_PRESETS) {
    const b = el('button', 'btn small alt', txt); b.type = 'button';
    b.addEventListener('click', () => { $('ftext').value = txt; if ($('fstyle').value === 'none') $('fstyle').value = 'bottom'; render(); });
    $('fchips').append(b);
  }

  $('download').addEventListener('click', exportFile);
  $('copy').addEventListener('click', copyImage);
  $('share').addEventListener('click', shareLink);
  $('undo').addEventListener('click', () => stepUndo(-1));
  $('redo').addEventListener('click', () => stepUndo(1));
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.target.matches('input[type=text],input[type=url],input[type=email],input[type=tel],textarea')) return;
    if (e.key.toLowerCase() === 'z') { e.preventDefault(); stepUndo(e.shiftKey ? 1 : -1); }
  });

  $('kitSave').addEventListener('click', saveKit);
  $('dynOn').addEventListener('change', onDynToggle);
  $('dynCreate').addEventListener('click', dynAction);
  $('authCancel').addEventListener('click', () => $('authDlg').close());
  $('authDlg').addEventListener('close', () => { dlgResolve?.(false); dlgResolve = null; });

  $('clearHistory').addEventListener('click', () => { try { localStorage.removeItem('qrf.history'); } catch { /* ignore */ } renderHistory(); });
  $('bulkGo').addEventListener('click', bulkGenerate);
  $('bulkFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) $('bulkText').value = (await f.text()).slice(0, 500_000);
  });
  document.addEventListener('langchange', () => { updateDynUI(); render(); });
  document.addEventListener('themechange', () => render());
}

function init() {
  initChrome();
  buildTabs(); buildPreviewTabs();
  if (window.QRCodeStyling) {
    qr = new window.QRCodeStyling(qrOptions(SAMPLE));
    qr.append($('qrHost'));
  } else setStatus('The QR library could not be loaded. Check your connection and reload the page.');
  buildTemplates(); wire();

  const hashMatch = /^#d=(.+)$/.exec(location.hash);
  const shared = hashMatch ? b64d(hashMatch[1]) : null;
  const saved = shared || Store.last();
  if (saved && saved.v === 1) {
    if (!shared) saved.type = document.body.dataset.type || 'url';   // every page opens on its own type; only the look is remembered
    applySettings(saved);
  } else { setType(curType); }
  const preset = document.body.dataset.preset;
  if (preset && !shared) {
    try { values[curType] = { ...JSON.parse(preset), ...(values[curType] || {}) }; renderFields(); render(); } catch { /* ignore bad preset */ }
  }
  renderKits(); renderHistory(); pullKitsFromCloud();
  applyI18n();
}

init();
