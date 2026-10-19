// Shared page chrome: theme toggle, language switch, account link, toast.
import { applyI18n, setLang, getLang } from './i18n.js';
import { getMe } from './api.js';

let toastTimer;
export function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

export async function refreshAuthLink() {
  const link = document.getElementById('authLink');
  if (!link) return;
  const user = await getMe();
  if (user) { link.textContent = 'Dashboard'; link.removeAttribute('data-i18n'); }
}

export function initChrome() {
  const yr = document.getElementById('yr');
  if (yr) yr.textContent = new Date().getFullYear();

  const themeBtn = document.getElementById('themeBtn');
  themeBtn?.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('qrf.theme', next); } catch { /* ignore */ }
    document.dispatchEvent(new CustomEvent('themechange'));
  });

  const sel = document.getElementById('langSel');
  if (sel) {
    sel.value = getLang();
    sel.addEventListener('change', () => setLang(sel.value));
  }
  applyI18n();
  refreshAuthLink();
}
