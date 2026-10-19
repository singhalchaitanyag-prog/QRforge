import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { canvasToPdf } from '../public/js/pdf.js';

// A tiny fake canvas: 8x8, left half black, right half white.
function fakeCanvas(w = 8, h = 8) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4; const v = x < w / 2 ? 0 : 255;
    data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
  }
  return { width: w, height: h, getContext: () => ({ getImageData: () => ({ data }) }) };
}

test('writes a structurally valid PDF with correct page size and xref offsets', async () => {
  const pdf = await canvasToPdf(fakeCanvas(), 50, 60, 'Test (code)');
  const s = Buffer.from(pdf).toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4'));
  assert.ok(s.trimEnd().endsWith('%%EOF'));
  assert.match(s, /\/MediaBox \[0 0 141\.73 170\.08\]/);          // 50 x 60 mm in points
  assert.match(s, /\/Title \(Test code\)/);                       // parentheses stripped from the title

  const xrefPos = Number(/startxref\n(\d+)/.exec(s)[1]);
  assert.ok(s.slice(xrefPos).startsWith('xref'));
  const offsets = [...s.slice(xrefPos).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.equal(offsets.length, 6);
  offsets.forEach((off, i) => assert.ok(s.slice(off).startsWith(`${i + 1} 0 obj`), `object ${i + 1} offset`));
});

test('image stream inflates back to the exact RGB pixels', async () => {
  const pdf = Buffer.from(await canvasToPdf(fakeCanvas(), 10, 10));
  const s = pdf.toString('latin1');
  const len = Number(/\/Length (\d+) >>\nstream\n/.exec(s.slice(s.indexOf('/Subtype /Image')))[1]);
  const start = s.indexOf('stream\n', s.indexOf('/Subtype /Image')) + 'stream\n'.length;
  const raw = inflateSync(pdf.subarray(start, start + len));
  assert.equal(raw.length, 8 * 8 * 3);
  assert.deepEqual([...raw.subarray(0, 3)], [0, 0, 0]);             // first pixel black
  assert.deepEqual([...raw.subarray(7 * 3, 7 * 3 + 3)], [255, 255, 255]); // last pixel in row white
});
