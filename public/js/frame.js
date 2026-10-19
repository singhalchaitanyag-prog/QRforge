// Frames with a call-to-action label. One layout function drives both the canvas (PNG/JPG/WebP/PDF)
// and SVG exports so every format looks the same.
import { textOn } from './theme.js';

export const FRAME_PRESETS = ['SCAN ME', 'MENU', 'WI-FI', 'PAY HERE', 'FOLLOW US', 'BOOK NOW'];

/** Geometry for a QR bitmap of width S. All numbers are in the same unit as S. */
export function layout(S, style) {
  const pad = Math.round(S * 0.05);
  const bw = Math.round(S * 0.025);
  const lh = Math.round(S * 0.17);
  const r = Math.round(S * 0.06);
  const cardW = S + 2 * pad;
  const cardH = S + 2 * pad;

  if (style === 'bottom') {
    return { style, r, bw, W: cardW + 2 * bw, H: cardH + 2 * bw + lh, qx: bw + pad, qy: bw + pad,
      panel: { x: bw, y: bw, w: cardW, h: cardH, r: Math.round(r * 0.6) }, label: { cx: (cardW + 2 * bw) / 2, cy: bw + cardH + (lh + bw) / 2, maxW: cardW * 0.9, size: lh * 0.46 } };
  }
  if (style === 'top') {
    const top = lh + bw;
    return { style, r, bw, W: cardW + 2 * bw, H: top + cardH + bw, qx: bw + pad, qy: top + pad,
      panel: { x: bw, y: top, w: cardW, h: cardH, r: Math.round(r * 0.6) }, label: { cx: (cardW + 2 * bw) / 2, cy: top / 2, maxW: cardW * 0.9, size: lh * 0.46 } };
  }
  if (style === 'pill') {
    const ph = Math.round(lh * 0.8);
    return { style, r, bw, W: cardW, H: cardH + Math.round(ph / 2) + bw, qx: pad, qy: pad,
      panel: { x: bw / 2, y: bw / 2, w: cardW - bw, h: cardH - bw, r },
      pill: { w: Math.round(cardW * 0.62), h: ph, y: cardH - Math.round(ph / 2) },
      label: { cx: cardW / 2, cy: cardH, maxW: cardW * 0.62 * 0.86, size: ph * 0.5 } };
  }
  return { style: 'none', W: S, H: S, qx: 0, qy: 0 };
}

const FONT = '"Inter", "Segoe UI", Arial, sans-serif';
const clean = (t) => String(t ?? '').trim().slice(0, 28);

function rr(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

/**
 * Draw `bitmap` (the QR) inside the chosen frame.
 * opts: { style, text, color, bg }.  pageBg: null keeps the corners transparent.
 */
export function composeCanvas(bitmap, opts, { pageBg = null } = {}) {
  const S = bitmap.width;
  const L = layout(S, opts.style);
  const cv = document.createElement('canvas');
  cv.width = L.W; cv.height = L.H;
  const ctx = cv.getContext('2d');
  if (pageBg) { ctx.fillStyle = pageBg; ctx.fillRect(0, 0, L.W, L.H); }

  if (L.style === 'none') { ctx.drawImage(bitmap, 0, 0); return cv; }

  const text = clean(opts.text);
  const color = opts.color;
  const fit = (size, maxW) => {
    ctx.font = `800 ${size}px ${FONT}`;
    let s = size;
    while (s > 8 && ctx.measureText(text).width > maxW) { s -= 1; ctx.font = `800 ${s}px ${FONT}`; }
  };

  if (L.style === 'bottom' || L.style === 'top') {
    ctx.fillStyle = color; rr(ctx, 0, 0, L.W, L.H, L.r); ctx.fill();
    ctx.fillStyle = opts.bg; rr(ctx, L.panel.x, L.panel.y, L.panel.w, L.panel.h, L.panel.r); ctx.fill();
  } else {
    ctx.fillStyle = opts.bg; ctx.strokeStyle = color; ctx.lineWidth = L.bw;
    rr(ctx, L.panel.x, L.panel.y, L.panel.w, L.panel.h, L.panel.r); ctx.fill(); ctx.stroke();
    const px = (L.W - L.pill.w) / 2;
    ctx.fillStyle = color; rr(ctx, px, L.pill.y, L.pill.w, L.pill.h, L.pill.h / 2); ctx.fill();
  }
  ctx.drawImage(bitmap, L.qx, L.qy);

  if (text) {
    fit(L.label.size, L.label.maxW);
    ctx.fillStyle = textOn(color);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, L.label.cx, L.label.cy + L.label.size * 0.04);
  }
  return cv;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** SVG version of the same frame. `qrSvg` is the SVG text produced by the QR library. */
export function composeSvg(qrSvg, opts, S) {
  const L = layout(S, opts.style);
  const doc = new DOMParser().parseFromString(qrSvg, 'image/svg+xml').documentElement;
  if (L.style === 'none') return new XMLSerializer().serializeToString(doc);

  doc.setAttribute('x', L.qx); doc.setAttribute('y', L.qy);
  doc.setAttribute('width', S); doc.setAttribute('height', S);
  const inner = new XMLSerializer().serializeToString(doc);
  const text = clean(opts.text);
  const color = opts.color;
  const tc = textOn(color);
  let shapes;
  if (L.style === 'bottom' || L.style === 'top') {
    shapes = `<rect width="${L.W}" height="${L.H}" rx="${L.r}" fill="${color}"/>` +
      `<rect x="${L.panel.x}" y="${L.panel.y}" width="${L.panel.w}" height="${L.panel.h}" rx="${L.panel.r}" fill="${opts.bg}"/>`;
  } else {
    shapes = `<rect x="${L.panel.x}" y="${L.panel.y}" width="${L.panel.w}" height="${L.panel.h}" rx="${L.panel.r}" fill="${opts.bg}" stroke="${color}" stroke-width="${L.bw}"/>` +
      `<rect x="${(L.W - L.pill.w) / 2}" y="${L.pill.y}" width="${L.pill.w}" height="${L.pill.h}" rx="${L.pill.h / 2}" fill="${color}"/>`;
  }
  // SVG has no text measuring, so estimate the width (about 0.62em per bold capital) and shrink to fit.
  const fontSize = Math.min(L.label.size, L.label.maxW / Math.max(1, text.length * 0.62));
  const label = text
    ? `<text x="${L.label.cx}" y="${L.label.cy}" font-family="Inter, Segoe UI, Arial, sans-serif" font-weight="800" font-size="${fontSize.toFixed(1)}" fill="${tc}" text-anchor="middle" dominant-baseline="central">${esc(text)}</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${L.W}" height="${L.H}" viewBox="0 0 ${L.W} ${L.H}">${shapes}${inner}${label}</svg>`;
}
