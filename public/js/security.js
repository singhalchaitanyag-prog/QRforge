// Dashboard "Security" tab: two-step verification, password change, other devices, recent activity.
import { api, getMe } from './api.js';
import { passwordField } from './authui.js';
import { toast } from './common.js';

const LABELS = {
  account_created: 'Account created', login: 'Signed in', login_failed: 'Failed sign-in attempt',
  second_factor_failed: 'Wrong two-step code', password_changed: 'Password changed',
  two_factor_enabled: 'Two-step verification turned on', two_factor_disabled: 'Two-step verification turned off',
  recovery_codes_regenerated: 'New recovery codes created', other_sessions_revoked: 'Signed out other devices',
  reauth_failed: 'Wrong password on a security action',
};
const BAD = new Set(['login_failed', 'second_factor_failed', 'reauth_failed']);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const when = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const group = (s) => s.replace(/(.{4})/g, '$1 ').trim();

function field(labelText, input, id) {
  input.id = id; const w = el('div'); const l = el('label', '', labelText); l.htmlFor = id; w.append(l, input); return w;
}
function textInput(attrs = {}) { const i = el('input'); i.type = 'text'; Object.assign(i, attrs); return i; }

/** Small inline form that re-asks for the password (and a code) before a sensitive action. */
function confirmForm({ title, description, needsCode, button, danger, run, onCancel }) {
  const box = el('form', 'box'); box.noValidate = true;
  const pw = passwordField({ id: `cf${Math.random().toString(36).slice(2, 7)}`, label: 'Your password', autocomplete: 'current-password' });
  const code = textInput({ autocomplete: 'one-time-code', placeholder: '123 456', maxLength: 14, spellcheck: false });
  code.classList.add('code-input');
  const err = el('div', 'err'); err.setAttribute('role', 'alert');
  const go = el('button', danger ? 'btn small danger' : 'btn small', button); go.type = 'submit';
  const cancel = el('button', 'btn small alt', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', onCancel);
  const row = el('div', 'tools-row'); row.style.cssText = 'justify-content:flex-start;margin-top:12px'; row.append(go, cancel);
  box.append(el('strong', '', title));
  if (description) box.append(el('p', 'hint', description));
  box.append(pw.wrap);
  if (needsCode) box.append(field('Authenticator code (or a recovery code)', code, `${pw.input.id}c`));
  box.append(err, row);
  box.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = ''; go.disabled = true;
    try { await run({ password: pw.input.value, code: code.value.trim() }); } catch (x) { err.textContent = x.message; go.disabled = false; }
  });
  return box;
}

function recoveryPanel(codes, onDone) {
  const box = el('div', 'box');
  box.append(el('strong', '', 'Save your recovery codes'),
    el('p', 'hint', 'If you lose your phone, each of these signs you in once. Store them somewhere safe, like a password manager. They are shown only now.'));
  const grid = el('div', 'recovery');
  for (const c of codes) grid.append(el('code', '', c));
  const copy = el('button', 'btn small alt', 'Copy'); copy.type = 'button';
  copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(codes.join('\n')); toast('Recovery codes copied'); } catch { toast('Select and copy them manually'); } });
  const dl = el('button', 'btn small alt', 'Download .txt'); dl.type = 'button';
  dl.addEventListener('click', () => {
    const blob = new Blob([`QRForge recovery codes\nEach code works once.\n\n${codes.join('\n')}\n`], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'qrforge-recovery-codes.txt'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  });
  const saved = el('label', 'check'); const cb = document.createElement('input'); cb.type = 'checkbox';
  saved.append(cb, el('span', '', 'I have saved these codes'));
  const done = el('button', 'btn small', 'Done'); done.type = 'button'; done.disabled = true;
  cb.addEventListener('change', () => { done.disabled = !cb.checked; });
  done.addEventListener('click', onDone);
  const row = el('div', 'tools-row'); row.style.justifyContent = 'flex-start'; row.append(copy, dl);
  box.append(grid, row, saved, done);
  done.style.marginTop = '12px';
  return box;
}

export async function mountSecurity(root) {
  root.textContent = '';
  let sec;
  try { sec = await api('/api/me/security'); } catch (e) { root.append(el('p', 'err', e.message)); return; }
  const me = await getMe();
  const refresh = () => { document.dispatchEvent(new CustomEvent('securitychange')); return mountSecurity(root); };
  const stack = el('div', 'sec-stack');

  /* ---- two-step verification ---- */
  const tf = el('div', 'card');
  const head = el('div', 'sec-row');
  const title = el('h3', '', 'Two-step verification');
  const badge = el('span', `badge ${sec.twoFactor ? 'on' : 'off'}`, sec.twoFactor ? 'On' : 'Off');
  head.append(title, badge);
  tf.append(head);
  const body = el('div'); tf.append(body);

  if (!sec.twoFactor) {
    body.append(el('p', 'hint', 'Adds a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy) to every log in. Even if someone learns your password, they cannot sign in without your phone.'));
    const on = el('button', 'btn small', 'Turn on'); on.type = 'button';
    on.addEventListener('click', async () => {
      on.disabled = true;
      try { renderSetup(await api('/api/me/2fa/setup', { method: 'POST' })); } catch (e) { toast(e.message); on.disabled = false; }
    });
    body.append(on);
  } else {
    body.append(el('p', 'hint', sec.recoveryLeft > 3 ? `${sec.recoveryLeft} recovery codes left.` : `Only ${sec.recoveryLeft} recovery code${sec.recoveryLeft === 1 ? '' : 's'} left. Create new ones.`));
    const row = el('div', 'tools-row'); row.style.justifyContent = 'flex-start';
    const regen = el('button', 'btn small alt', 'New recovery codes'); regen.type = 'button';
    const off = el('button', 'btn small danger', 'Turn off'); off.type = 'button';
    row.append(regen, off); body.append(row);
    const slot = el('div'); body.append(slot);
    regen.addEventListener('click', () => {
      slot.textContent = '';
      slot.append(confirmForm({
        title: 'Create new recovery codes', description: 'This replaces your old codes.', needsCode: true, button: 'Create codes',
        onCancel: () => { slot.textContent = ''; },
        run: async ({ password, code }) => { const d = await api('/api/me/2fa/recovery', { method: 'POST', body: { password, code } }); slot.textContent = ''; slot.append(recoveryPanel(d.recoveryCodes, refresh)); },
      }));
    });
    off.addEventListener('click', () => {
      slot.textContent = '';
      slot.append(confirmForm({
        title: 'Turn off two-step verification', description: 'Your account will be protected by your password alone. Other devices will be signed out.', needsCode: true, button: 'Turn off', danger: true,
        onCancel: () => { slot.textContent = ''; },
        run: async ({ password, code }) => { await api('/api/me/2fa/disable', { method: 'POST', body: { password, code } }); toast('Two-step verification is off'); refresh(); },
      }));
    });
  }

  function renderSetup({ secret, otpauthUrl }) {
    body.textContent = '';
    const grid = el('div', 'setup-grid');
    const qrBox = el('div', 'qr-box');
    if (window.QRCodeStyling) {
      new window.QRCodeStyling({ width: 190, height: 190, type: 'canvas', data: otpauthUrl, margin: 4, qrOptions: { errorCorrectionLevel: 'M' }, dotsOptions: { color: '#111111', type: 'square' }, backgroundOptions: { color: '#ffffff' } }).append(qrBox);
    } else qrBox.textContent = 'QR unavailable';
    const side = el('div');
    side.append(el('strong', '', '1. Scan with your authenticator app'),
      el('p', 'hint', 'Cannot scan? Enter this key instead:'));
    const key = el('div', 'mono', group(secret)); key.style.cssText = 'user-select:all;margin:6px 0 14px;font-size:1rem';
    side.append(key, el('strong', '', '2. Enter the 6-digit code it shows'));
    grid.append(qrBox, side);
    const form = el('form'); form.noValidate = true;
    const code = textInput({ autocomplete: 'one-time-code', placeholder: '123 456', maxLength: 7, inputMode: 'numeric', spellcheck: false });
    code.classList.add('code-input');
    const err = el('div', 'err'); err.setAttribute('role', 'alert');
    const verify = el('button', 'btn small', 'Verify and turn on'); verify.type = 'submit';
    form.append(field('Code', code, 'tfCode'), err, verify);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = ''; verify.disabled = true;
      try {
        const d = await api('/api/me/2fa/enable', { method: 'POST', body: { code: code.value.trim() } });
        body.textContent = ''; badge.className = 'badge on'; badge.textContent = 'On';
        body.append(recoveryPanel(d.recoveryCodes, refresh));
      } catch (x) { err.textContent = x.message; verify.disabled = false; }
    });
    body.append(grid, form);
  }

  /* ---- password ---- */
  const pwCard = el('div', 'card');
  pwCard.append(el('h3', '', 'Change password'),
    el('p', 'hint', me?.name ? `Signed in as ${me.name}. Changing your password signs out all your other devices.` : 'Changing your password signs out all your other devices.'));
  const pwForm = el('form'); pwForm.noValidate = true;
  const cur = passwordField({ id: 'pwCur', label: 'Current password', autocomplete: 'current-password' });
  const nxt = passwordField({ id: 'pwNew', label: 'New password', autocomplete: 'new-password', meter: true });
  const cnf = passwordField({ id: 'pwCnf', label: 'Confirm new password', autocomplete: 'new-password' });
  const pwErr = el('div', 'err'); pwErr.setAttribute('role', 'alert');
  const pwBtn = el('button', 'btn small', 'Update password'); pwBtn.type = 'submit'; pwBtn.style.marginTop = '8px';
  pwForm.append(cur.wrap, nxt.wrap, cnf.wrap, pwErr, pwBtn);
  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault(); pwErr.textContent = '';
    if (nxt.input.value !== cnf.input.value) { pwErr.textContent = 'The new passwords do not match.'; return; }
    pwBtn.disabled = true;
    try { await api('/api/me/password', { method: 'POST', body: { current: cur.input.value, next: nxt.input.value } }); toast('Password updated'); refresh(); } catch (x) { pwErr.textContent = x.message; pwBtn.disabled = false; }
  });
  pwCard.append(pwForm);

  /* ---- sessions & activity ---- */
  const act = el('div', 'card');
  const arow = el('div', 'sec-row');
  const left = el('div'); left.append(el('h3', '', 'Devices & activity'), el('p', 'hint', `${sec.sessions} active session${sec.sessions === 1 ? '' : 's'}.`));
  const out = el('button', 'btn small alt', 'Sign out other devices'); out.type = 'button'; out.disabled = sec.sessions <= 1;
  out.addEventListener('click', async () => { await api('/api/me/sessions/revoke-others', { method: 'POST' }); toast('Other devices signed out'); refresh(); });
  arow.append(left, out); act.append(arow);
  const list = el('ul', 'events');
  if (!sec.events.length) list.append(el('li', '', 'No activity yet.'));
  for (const ev of sec.events) {
    const li = el('li'); const what = el('span', BAD.has(ev.type) ? 'bad' : '', `${LABELS[ev.type] || ev.type}${ev.detail ? ` · ${ev.detail}` : ''}`);
    li.append(what, el('span', 'when', when(ev.ts))); list.append(li);
  }
  act.append(list);
  if (sec.events.some((e) => BAD.has(e.type))) act.append(el('p', 'hint', 'See something you do not recognize? Change your password and turn on two-step verification.'));

  stack.append(tf, pwCard, act);
  root.append(stack);
}
