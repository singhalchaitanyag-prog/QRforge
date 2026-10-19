// Time-based one-time passwords (RFC 6238) and single-use recovery codes. Works with Google Authenticator,
// Microsoft Authenticator, 1Password, Authy and any other TOTP app. No third-party service involved.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  let bits = 0; let value = 0; const out = [];
  for (const ch of String(str).toUpperCase().replace(/=+$/, '')) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function hotp(secret, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const newSecret = () => base32Encode(randomBytes(20));

export function totp(secretB32, time = Date.now(), { step = 30, digits = 6 } = {}) {
  return hotp(base32Decode(secretB32), Math.floor(time / 1000 / step), digits);
}

/**
 * Check a code against the current time step +/- `window` steps (clock drift).
 * Returns the matched time step, or null. Pass `lastStep` to reject replays of an already-used code.
 */
export function verifyTotp(secretB32, code, { time = Date.now(), window = 1, lastStep = 0, step = 30, digits = 6 } = {}) {
  const clean = String(code ?? '').replace(/\s+/g, '');
  if (!/^\d+$/.test(clean) || clean.length !== digits) return null;
  const secret = base32Decode(secretB32);
  const now = Math.floor(time / 1000 / step);
  const given = Buffer.from(clean);
  let matched = null;
  for (let w = -window; w <= window; w++) {
    const counter = now + w;
    const expected = Buffer.from(hotp(secret, counter, digits));
    if (timingSafeEqual(expected, given) && counter > lastStep) matched = counter;   // no early exit: constant work
  }
  return matched;
}

export function otpauthUrl({ secret, account, issuer = 'QRForge' }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/* ---------- recovery codes ---------- */
export const normalizeRecovery = (s) => String(s ?? '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();

export function newRecoveryCodes(n = 10) {
  return Array.from({ length: n }, () => {
    const raw = base32Encode(randomBytes(7)).slice(0, 10);     // 50 bits of randomness each
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}
