// Thin client for the QRForge backend. Everything degrades gracefully when the server is absent
// (for example when the static files are hosted without the API).
let me;       // undefined = unknown, null = logged out, object = user

export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    const e = new Error('Cannot reach the QRForge server'); e.offline = true; throw e;
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON (e.g. static host 404 page) */ }
  if (!res.ok || data === null) {
    const e = new Error((data && data.error) || `Request failed (${res.status})`);
    e.status = res.status; e.offline = data === null; throw e;
  }
  return data;
}

export async function getMe(force = false) {
  if (me !== undefined && !force) return me;
  try { me = (await api('/api/me')).user; } catch { me = null; }
  return me;
}
export const setMe = (u) => { me = u; };

/** Step 1. Resolves to { user } or, when two-step verification is on, { needs2fa: true, ticket }. */
export async function login(email, password) {
  const d = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  if (d.user) me = d.user;
  return d;
}
/** Step 2 (only when needed). `code` is a 6-digit authenticator code or a recovery code. */
export async function verifySecondFactor(ticket, code) {
  const d = await api('/api/auth/2fa', { method: 'POST', body: { ticket, code } });
  me = d.user;
  return d;
}
export async function signup(fields) {
  const d = await api('/api/auth/signup', { method: 'POST', body: fields });
  me = d.user;
  return d;
}
export async function logout() {
  await api('/api/auth/logout', { method: 'POST' });
  me = null;
}
