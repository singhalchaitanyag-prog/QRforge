// One sign-in / sign-up / second-step form, shared by the dashboard and the generator's dialog.
import { login, signup, verifySecondFactor } from './api.js';

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else e.setAttribute(k, v);
  }
  e.append(...kids);
  return e;
}

/** Length is what matters most; the server additionally blocks common and personal passwords. */
export function passwordStrength(pw) {
  if (!pw) return { level: 0, label: '' };
  if (pw.length < 10) return { level: 1, label: `Too short. ${10 - pw.length} more character${10 - pw.length === 1 ? '' : 's'} needed.` };
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter((r) => r.test(pw)).length;
  if (pw.length >= 16 || (pw.length >= 12 && kinds >= 3)) return { level: 3, label: 'Strong' };
  return { level: 2, label: 'Okay. Longer is stronger.' };
}

/** A password input with a show/hide button and an optional strength bar. */
export function passwordField({ id, label, autocomplete, meter = false }) {
  const input = el('input', { type: 'password', id, autocomplete, required: '' });
  const toggle = el('button', { type: 'button', class: 'pw-toggle', 'aria-label': 'Show password', 'aria-pressed': 'false', text: 'Show' });
  toggle.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'Hide' : 'Show';
    toggle.setAttribute('aria-pressed', String(show));
    toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
  const wrap = el('div', {}, el('label', { for: id, text: label }), el('div', { class: 'pw-wrap' }, input, toggle));
  if (meter) {
    const bar = el('i'); const track = el('div', { class: 'meter' }, bar); const msg = el('div', { class: 'hint' });
    input.addEventListener('input', () => {
      const s = passwordStrength(input.value);
      track.dataset.level = String(s.level); msg.textContent = s.label;
    });
    wrap.append(track, msg);
  }
  return { wrap, input };
}

/**
 * Renders the form into `root`.
 *  startSignup: open on the sign-up view.   onSuccess(user, extra): called once a session exists.
 */
export function mountAuth(root, { startSignup = false, onSuccess, idPrefix = 'au' } = {}) {
  let mode = startSignup ? 'signup' : 'login';
  let ticket = null;
  let useRecovery = false;

  function show(m) { mode = m; useRecovery = false; render(); }

  function render() {
    root.textContent = '';
    if (mode === 'login') renderLogin();
    else if (mode === 'signup') renderSignup();
    else renderSecondStep();
    const first = root.querySelector('form input');
    if (first && root.isConnected) first.focus({ preventScroll: true });
  }

  const errBox = () => el('div', { class: 'err', role: 'alert', 'aria-live': 'polite' });

  async function run(form, err, btn, task) {
    err.textContent = ''; btn.disabled = true;
    const label = btn.textContent; btn.textContent = 'Please wait…';
    try { await task(); } catch (e) { err.textContent = e.offline ? 'Accounts need the QRForge server to be running.' : e.message; } finally { btn.disabled = false; btn.textContent = label; }
  }

  function renderLogin() {
    const email = el('input', { type: 'email', id: `${idPrefix}Email`, autocomplete: 'username', required: '' });
    const pw = passwordField({ id: `${idPrefix}Pass`, label: 'Password', autocomplete: 'current-password' });
    const err = errBox();
    const btn = el('button', { type: 'submit', class: 'btn', style: 'width:100%;margin-top:8px', text: 'Log in' });
    const form = el('form', { novalidate: '' },
      el('div', {}, el('label', { for: email.id, text: 'Email' }), email), pw.wrap, err, btn);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!email.value.trim() || !pw.input.value) { err.textContent = 'Enter your email and password.'; return; }
      run(form, err, btn, async () => {
        const d = await login(email.value.trim(), pw.input.value);
        pw.input.value = '';
        if (d.needs2fa) { ticket = d.ticket; mode = '2fa'; render(); } else onSuccess?.(d.user, d);
      });
    });
    const switchBtn = el('button', { type: 'button', class: 'link-btn', text: 'Create one' });
    switchBtn.addEventListener('click', () => show('signup'));
    root.append(el('h1', { class: 'auth-title', text: 'Log in' }),
      el('p', { class: 'hint', text: 'Welcome back. Your dynamic codes and analytics are waiting.' }),
      form, el('p', { class: 'hint auth-switch' }, 'No account yet? ', switchBtn));
  }

  function renderSignup() {
    const name = el('input', { type: 'text', id: `${idPrefix}Name`, autocomplete: 'name', required: '', maxlength: '80' });
    const email = el('input', { type: 'email', id: `${idPrefix}Email`, autocomplete: 'email', required: '' });
    const pw = passwordField({ id: `${idPrefix}Pass`, label: 'Password', autocomplete: 'new-password', meter: true });
    const confirm = passwordField({ id: `${idPrefix}Pass2`, label: 'Confirm password', autocomplete: 'new-password' });
    const terms = el('input', { type: 'checkbox', id: `${idPrefix}Terms` });
    const honey = el('div', { class: 'honey', 'aria-hidden': 'true' }, el('label', { for: `${idPrefix}Web`, text: 'Website' }),
      el('input', { type: 'text', id: `${idPrefix}Web`, tabindex: '-1', autocomplete: 'off' }));
    const err = errBox();
    const btn = el('button', { type: 'submit', class: 'btn', style: 'width:100%;margin-top:8px', text: 'Create account' });
    const consent = el('label', { class: 'check', for: terms.id }, terms,
      el('span', {}, 'I agree to the ', el('a', { href: '/terms', target: '_blank', rel: 'noopener', text: 'Terms' }), ' and ',
        el('a', { href: '/privacy', target: '_blank', rel: 'noopener', text: 'Privacy policy' })));
    const form = el('form', { novalidate: '' },
      el('div', {}, el('label', { for: name.id, text: 'Full name' }), name),
      el('div', {}, el('label', { for: email.id, text: 'Email' }), email),
      pw.wrap, confirm.wrap, consent, honey, err, btn);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (name.value.trim().length < 2) { err.textContent = 'Enter your full name.'; return; }
      if (!email.value.trim()) { err.textContent = 'Enter your email address.'; return; }
      if (pw.input.value !== confirm.input.value) { err.textContent = 'The two passwords do not match.'; return; }
      if (!terms.checked) { err.textContent = 'Please accept the Terms and the Privacy policy to continue.'; return; }
      run(form, err, btn, async () => {
        const d = await signup({
          name: name.value.trim(), email: email.value.trim(), password: pw.input.value,
          acceptTerms: true, website: honey.querySelector('input').value,
        });
        pw.input.value = ''; confirm.input.value = '';
        onSuccess?.(d.user, { ...d, justCreated: true });
      });
    });
    const switchBtn = el('button', { type: 'button', class: 'link-btn', text: 'Log in' });
    switchBtn.addEventListener('click', () => show('login'));
    root.append(el('h1', { class: 'auth-title', text: 'Create your account' }),
      el('p', { class: 'hint', text: 'Free. Edit your codes later, see who scans them, and keep your brand kits on every device.' }),
      form, el('p', { class: 'hint auth-switch' }, 'Already have an account? ', switchBtn));
  }

  function renderSecondStep() {
    const code = el('input', {
      type: 'text', id: `${idPrefix}Code`, required: '', autocomplete: 'one-time-code', spellcheck: 'false',
      inputmode: useRecovery ? 'text' : 'numeric', maxlength: useRecovery ? '14' : '7',
      placeholder: useRecovery ? 'XXXXX-XXXXX' : '123 456', class: 'code-input',
    });
    const err = errBox();
    const btn = el('button', { type: 'submit', class: 'btn', style: 'width:100%;margin-top:8px', text: 'Verify and log in' });
    const form = el('form', { novalidate: '' },
      el('div', {}, el('label', { for: code.id, text: useRecovery ? 'Recovery code' : '6-digit code' }), code), err, btn);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!code.value.trim()) { err.textContent = 'Enter the code.'; return; }
      run(form, err, btn, async () => {
        try {
          const d = await verifySecondFactor(ticket, code.value.trim());
          onSuccess?.(d.user, d);
        } catch (e2) {
          if (/expired|sign in again/i.test(e2.message)) { ticket = null; mode = 'login'; render(); root.querySelector('.err').textContent = e2.message; return; }
          throw e2;
        }
      });
    });
    const toggle = el('button', { type: 'button', class: 'link-btn', text: useRecovery ? 'Use my authenticator app instead' : 'Use a recovery code instead' });
    toggle.addEventListener('click', () => { useRecovery = !useRecovery; render(); });
    const back = el('button', { type: 'button', class: 'link-btn', text: 'Back to log in' });
    back.addEventListener('click', () => { ticket = null; show('login'); });
    root.append(el('h1', { class: 'auth-title', text: 'Two-step verification' }),
      el('p', { class: 'hint', text: useRecovery
        ? 'Enter one of the recovery codes you saved when you turned on two-step verification. Each works once.'
        : 'Open your authenticator app and enter the 6-digit code for QRForge.' }),
      form, el('p', { class: 'hint auth-switch' }, toggle, ' · ', back));
  }

  render();
  return { show };
}
