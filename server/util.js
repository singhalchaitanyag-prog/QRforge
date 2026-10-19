import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';

const B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const token = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function shortCode(len = 7) {
  const buf = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += B62[buf[i] % 62];
  return out;
}

export function hashPassword(pw) {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 64);
  return `s1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  try {
    const [v, saltB64, hashB64] = stored.split('$');
    if (v !== 's1') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = scryptSync(pw, Buffer.from(saltB64, 'base64'), expected.length);
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

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

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:');
  }
  return true;
}

/** Resolve a webhook host and refuse private / loopback targets (SSRF guard). */
export async function assertPublicHost(urlString) {
  const u = new URL(urlString);
  if (net.isIP(u.hostname)) {
    if (isPrivateIp(u.hostname)) throw new Error('private address');
    return;
  }
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('private address');
}

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

/** Fixed-window in-memory rate limiter. */
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
