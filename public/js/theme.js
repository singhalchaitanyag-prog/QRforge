// Color maths, logo palette extraction, auto-design rules and the template list.

/* ---------- color helpers (pure) ---------- */
export const toHex = (r, g, b) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
export const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
export const lum = (hex) => {
  const c = rgb(hex).map((v) => v / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
export const contrast = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
export const saturation = (hex) => { const c = rgb(hex); return Math.max(...c) - Math.min(...c); };
export const isNeutral = (hex) => saturation(hex) < 40;
export const textOn = (hex) => (contrast(hex, '#ffffff') >= contrast(hex, '#111111') ? '#ffffff' : '#111111');

/** Darken `hex` until it reaches `min` contrast against `bg`. */
export function readable(hex, bg, min = 4.5) {
  let [r, g, b] = rgb(hex);
  for (let n = 0; n < 40 && contrast(toHex(r, g, b), bg) < min; n++) { r *= 0.93; g *= 0.93; b *= 0.93; }
  return toHex(r, g, b);
}
/** Move `hex` toward white. amount 0.92 gives a very light tint. */
export const tint = (hex, amount = 0.92) => toHex(...rgb(hex).map((v) => v + (255 - v) * amount));

/**
 * Pick QR colors from a logo palette.
 * `main` is the chosen swatch; the second color is the next distinct one (or a darker shade of main).
 */
export function deriveColors(palette, mainIdx = 0, { tintBg = true, bg = '#ffffff' } = {}) {
  if (!palette.length) return null;
  const main = palette[mainIdx % palette.length];
  const outBg = tintBg && !isNeutral(main) ? tint(main) : bg;
  const fg = readable(main, outBg);
  const next = palette[(mainIdx + 1) % palette.length];
  const second = next && next !== main ? next : toHex(...rgb(main).map((v) => v * 0.6));
  return { fg, c2: readable(second, outBg), bg: outBg };
}

/** Shape and color-style rules for a logo. */
export function designFromPalette(palette, round) {
  const neutral = !palette.length || isNeutral(palette[0]);
  const colorful = palette.filter((c) => !isNeutral(c));
  return {
    dots: round ? 'rounded' : 'square',
    corner: round ? 'extra-rounded' : 'square',
    tstyle: !neutral && colorful.length > 1 ? 'gradient' : 'solid',
    tintBg: !neutral,
    neutral,
  };
}

/* ---------- palette extraction (browser only) ---------- */
export function extractPalette(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const S = 64;
      const cv = document.createElement('canvas'); cv.width = cv.height = S;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, S, S);
      let d;
      try { d = ctx.getImageData(0, 0, S, S).data; } catch { resolve({ colors: [], round: false }); return; }
      const buckets = new Map();
      for (let i = 0; i < d.length; i += 4) {
        const [r, g, b, a] = [d[i], d[i + 1], d[i + 2], d[i + 3]];
        if (a < 128 || (r > 235 && g > 235 && b > 235)) continue;     // skip transparent and white
        const k = `${r >> 4},${g >> 4},${b >> 4}`;
        const bk = buckets.get(k) || { n: 0, r: 0, g: 0, b: 0 };
        bk.n++; bk.r += r; bk.g += g; bk.b += b; buckets.set(k, bk);
      }
      const list = [...buckets.values()].map((o) => {
        const c = [o.r / o.n, o.g / o.n, o.b / o.n];
        return { c, score: o.n * (1 + (Math.max(...c) - Math.min(...c)) / 128) };      // favor vivid colors
      }).sort((x, y) => y.score - x.score);
      const out = [];
      for (const it of list) {
        if (out.every((o) => Math.hypot(o[0] - it.c[0], o[1] - it.c[1], o[2] - it.c[2]) > 70)) out.push(it.c);
        if (out.length === 4) break;
      }
      // empty/white corners suggest a round logo
      let empty = 0; let total = 0;
      for (const [x0, y0] of [[0, 0], [S - 8, 0], [0, S - 8], [S - 8, S - 8]]) {
        for (let y = y0; y < y0 + 8; y++) for (let x = x0; x < x0 + 8; x++) {
          const i = (y * S + x) * 4; total++;
          if (d[i + 3] < 128 || (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235)) empty++;
        }
      }
      resolve({ colors: out.map((c) => toHex(...c)), round: empty / total > 0.6 });
    };
    img.onerror = () => resolve({ colors: [], round: false });
    img.src = src;
  });
}

/** Downscale a logo file to <=512px so it stays light in storage, history and exports. */
export async function normalizeLogo(file, max = 512) {
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file);
  });
  if (file.type === 'image/svg+xml' && file.size < 300_000) return dataUrl;
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
  const scale = Math.min(1, max / Math.max(img.naturalWidth || max, img.naturalHeight || max));
  if (scale === 1 && file.size < 200_000 && file.type !== 'image/svg+xml') return dataUrl;
  const w = Math.max(1, Math.round((img.naturalWidth || max) * scale));
  const h = Math.max(1, Math.round((img.naturalHeight || max) * scale));
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  cv.getContext('2d').drawImage(img, 0, 0, w, h);
  return cv.toDataURL('image/png');
}

/* ---------- templates ---------- */
export const TEMPLATES = [
  { id: 'classic', name: 'Classic', fg: '#1d1d1f', c2: '#1d1d1f', tstyle: 'solid', dots: 'square', corner: 'square', bg: '#ffffff' },
  { id: 'ocean', name: 'Ocean', fg: '#0b5fa5', c2: '#1e2a78', tstyle: 'gradient', dots: 'rounded', corner: 'extra-rounded', bg: '#f0f9ff' },
  { id: 'sunset', name: 'Sunset', fg: '#c2410c', c2: '#a3135f', tstyle: 'gradient', dots: 'rounded', corner: 'extra-rounded', bg: '#fff7ed' },
  { id: 'forest', name: 'Forest', fg: '#166534', c2: '#166534', tstyle: 'solid', dots: 'extra-rounded', corner: 'extra-rounded', bg: '#f0fdf4' },
  { id: 'royal', name: 'Royal', fg: '#4c1d95', c2: '#be185d', tstyle: 'twotone', dots: 'classy', corner: 'extra-rounded', bg: '#faf5ff' },
  { id: 'bubble', name: 'Bubble', fg: '#6d28d9', c2: '#0e7490', tstyle: 'gradient', dots: 'dots', corner: 'dot', bg: '#ffffff' },
  { id: 'pop', name: 'Pop', fg: '#111827', c2: '#e11d48', tstyle: 'twotone', dots: 'square', corner: 'square', bg: '#ffffff' },
  { id: 'mint', name: 'Mint', fg: '#0f766e', c2: '#1d4ed8', tstyle: 'gradient', dots: 'classy', corner: 'square', bg: '#f0fdfa' },
];

const iconSvg = (bg, body) => 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${bg}"/><g fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`);

export const ICONS = {
  Link: iconSvg('#5b3df5', '<path d="M27 37a9 9 0 0 0 13 0l8-8a9 9 0 0 0-13-13l-3 3M37 27a9 9 0 0 0-13 0l-8 8a9 9 0 0 0 13 13l3-3"/>'),
  Mail: iconSvg('#e8453c', '<rect x="12" y="17" width="40" height="30" rx="4"/><path d="M13 21l19 15 19-15"/>'),
  Phone: iconSvg('#1fa971', '<path d="M18 14h8l4 10-5 3a24 24 0 0 0 12 12l3-5 10 4v8a4 4 0 0 1-4 4C28 50 14 36 14 18a4 4 0 0 1 4-4z"/>'),
  Wifi: iconSvg('#0a84ff', '<path d="M10 28a31 31 0 0 1 44 0M17 36a21 21 0 0 1 30 0M24 43a11 11 0 0 1 16 0"/><circle cx="32" cy="50" r="1"/>'),
  Star: iconSvg('#f5a623', '<path d="M32 10l7 15 16 2-12 11 3 16-14-8-14 8 3-16L9 27l16-2z"/>'),
  Heart: iconSvg('#ff5c8a', '<path d="M32 52S10 38 10 24a11 11 0 0 1 22-3 11 11 0 0 1 22 3c0 14-22 28-22 28z"/>'),
};
