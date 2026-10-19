// Helpers shared by the Node server and the Cloudflare Worker. Only uses APIs both runtimes provide
// (Web Crypto, TextEncoder, URL, and node:crypto through the Workers `nodejs_compat` flag).
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import * as nodeCrypto from 'node:crypto';

const B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const token = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function shortCode(len = 7) {
  const buf = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += B62[buf[i] % 62];
  return out;
}

/* ------------------------------ passwords ------------------------------ */
// New hashes use PBKDF2-HMAC-SHA256 through Web Crypto, which exists in Node and in Cloudflare Workers.
// Format: p1$<iterations>$<salt b64>$<hash b64>. Older accounts have scrypt hashes (s1$...). They still verify
// where scrypt is available, and are upgraded to p1 on their next successful login.
export const DEFAULT_PBKDF2_ITERATIONS = 100_000;
const enc = new TextEncoder();

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return Buffer.from(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function hashPassword(pw, iterations = DEFAULT_PBKDF2_ITERATIONS) {
  const salt = randomBytes(16);
  const hash = await pbkdf2(pw, salt, iterations);
  return `p1$${iterations}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(pw, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts[0] === 'p1') {
      const iterations = Number(parts[1]);
      if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 5_000_000) return false;
      const expected = Buffer.from(parts[3], 'base64');
      return timingSafeEqual(expected, await pbkdf2(pw, Buffer.from(parts[2], 'base64'), iterations));
    }
    if (parts[0] === 's1' && typeof nodeCrypto.scryptSync === 'function') {
      const expected = Buffer.from(parts[2], 'base64');
      return timingSafeEqual(expected, nodeCrypto.scryptSync(pw, Buffer.from(parts[1], 'base64'), expected.length));
    }
  } catch { /* malformed hash or scrypt unavailable: treat as a failed check */ }
  return false;
}

/** True when a stored hash should be replaced with a fresh one (legacy format or fewer iterations than now). */
export function needsRehash(stored, iterations = DEFAULT_PBKDF2_ITERATIONS) {
  const parts = String(stored).split('$');
  return parts[0] !== 'p1' || Number(parts[1]) < iterations;
}

/* ------------------------------- strings & urls ------------------------------- */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Only absolute http(s) URLs without embedded credentials. Returns normalized string or null. */
export function cleanUrl(input, { maxLen = 2048 } = {}) {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw || raw.length > maxLen) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  return u.toString();
}

/* ------------------------------- SSRF guard ------------------------------- */
const isIPv4 = (s) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) && s.split('.').every((n) => Number(n) <= 255);
const isIPv6 = (s) => s.includes(':') && /^[0-9a-fA-F:.]+$/.test(s);
const stripBrackets = (h) => h.replace(/^\[|\]$/g, '');

export function isPrivateIp(ip) {
  if (isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIPv6(ip)) {
    const l = ip.toLowerCase();
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:');
  }
  return true;
}

/**
 * Refuse webhook targets that point at private or loopback addresses.
 * `resolve(hostname)` (optional) returns the IP addresses a name resolves to; the Node server supplies a DNS lookup.
 * Cloudflare Workers cannot reach private networks at all, so there the literal-address and reserved-name checks apply.
 */
export async function assertPublicHost(urlString, resolve) {
  const host = stripBrackets(new URL(urlString).hostname);
  if (isIPv4(host) || isIPv6(host)) {
    if (isPrivateIp(host)) throw new Error('private address');
    return;
  }
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home|corp)$/i.test(host)) throw new Error('private address');
  if (resolve) {
    const addrs = await resolve(host);
    if (!addrs.length || addrs.some((a) => isPrivateIp(a))) throw new Error('private address');
  }
}

/* ------------------------------- request metadata ------------------------------- */
export function parseUA(ua = '') {
  const s = String(ua);
  let device = 'Desktop';
  if (/ipad|tablet/i.test(s)) device = 'Tablet';
  else if (/mobi|iphone|android/i.test(s)) device = 'Mobile';
  if (/bot|crawl|spider|preview|facebookexternalhit|slackbot|whatsapp\/|telegrambot/i.test(s)) device = 'Bot';

  let os = 'Other';
  if (/windows/i.test(s)) os = 'Windows';
  else if (/iphone|ipad|ios/i.test(s)) os = 'iOS';
  else if (/android/i.test(s)) os = 'Android';
  else if (/mac os x|macintosh/i.test(s)) os = 'macOS';
  else if (/linux/i.test(s)) os = 'Linux';

  let browser = 'Other';
  if (/edg\//i.test(s)) browser = 'Edge';
  else if (/opr\/|opera/i.test(s)) browser = 'Opera';
  else if (/samsungbrowser/i.test(s)) browser = 'Samsung Internet';
  else if (/chrome|crios/i.test(s)) browser = 'Chrome';
  else if (/firefox|fxios/i.test(s)) browser = 'Firefox';
  else if (/safari/i.test(s)) browser = 'Safari';
  return { device, os, browser };
}

export function refHost(ref) {
  if (!ref) return 'Direct';
  try { return new URL(ref).hostname || 'Direct'; } catch { return 'Direct'; }
}

/**
 * Fixed-window in-memory limiter. Good enough as a cheap first filter, but each server process (or Worker
 * isolate) has its own counters, so anything security-critical uses the database-backed throttle in core.js.
 */
export function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  return function hit(key) {
    const now = Date.now();
    const rec = hits.get(key);
    if (!rec || now - rec.start > windowMs) {
      hits.set(key, { start: now, n: 1 });
      if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
      return true;
    }
    rec.n++;
    return rec.n <= max;
  };
}

export const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.woff2': 'font/woff2',
};
