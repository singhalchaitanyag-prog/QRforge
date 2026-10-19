import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrast, readable, tint, deriveColors, designFromPalette, isNeutral, textOn, TEMPLATES } from '../public/js/theme.js';
import { parseRows, splitCsvLine, uniqueNames, safeFileName } from '../public/js/bulk.js';
import { b64e, b64d } from '../public/js/store.js';
import { layout } from '../public/js/frame.js';

test('readable() always reaches the requested contrast', () => {
  for (const c of ['#ffff00', '#ff6a1a', '#9be7ff', '#cccccc', '#ffffff']) {
    for (const bg of ['#ffffff', '#fff3ed', '#f0f9ff']) {
      const out = readable(c, bg, 4.5);
      assert.ok(contrast(out, bg) >= 4.5, `${c} on ${bg} -> ${out} (${contrast(out, bg).toFixed(2)})`);
    }
  }
});

test('tint moves toward white and keeps a light background', () => {
  const t = tint('#ff0000', 0.92);
  assert.ok(contrast(t, '#ffffff') < 1.2);
});

test('deriveColors keeps the QR scannable for any logo color', () => {
  for (const palette of [['#ffe600'], ['#ff6a1a', '#0f9d9a'], ['#ffffff'], ['#222222', '#e11d48']]) {
    const d = deriveColors(palette, 0, { tintBg: true });
    assert.ok(contrast(d.fg, d.bg) >= 4.5, `${palette} fg/bg`);
    assert.ok(contrast(d.c2, d.bg) >= 4.5, `${palette} c2/bg`);
  }
  assert.equal(deriveColors([], 0), null);
});

test('black-and-white logos stay plain and high-contrast', () => {
  assert.ok(isNeutral('#222222'));
  const d = designFromPalette(['#222222', '#888888'], false);
  assert.equal(d.neutral, true);
  assert.equal(d.tstyle, 'solid');
  assert.equal(d.tintBg, false);
  const colored = designFromPalette(['#ff6a1a', '#0f9d9a'], true);
  assert.equal(colored.tstyle, 'gradient');
  assert.equal(colored.dots, 'rounded');
  assert.equal(designFromPalette(['#ff6a1a', '#0f9d9a'], false).dots, 'square');
});

test('every built-in template is scannable', () => {
  for (const t of TEMPLATES) {
    assert.ok(contrast(t.fg, t.bg) >= 4.5, `${t.id} fg`);
    assert.ok(contrast(t.c2, t.bg) >= 4.5, `${t.id} c2`);
  }
});

test('label text color is readable on any frame color', () => {
  for (const c of ['#1d1d1f', '#ffe600', '#5258e4', '#ffffff']) {
    assert.ok(contrast(textOn(c), c) >= 4.5, c);
  }
});

test('csv parsing handles quotes, headers and blank lines', () => {
  assert.deepEqual(splitCsvLine('"https://x.com/a,b",name'), ['https://x.com/a,b', 'name']);
  assert.deepEqual(splitCsvLine('a,"he said ""hi""",c'), ['a', 'he said "hi"', 'c']);
  const rows = parseRows('url,name\r\n\r\nhttps://a.com,one\nhttps://b.com\n');
  assert.deepEqual(rows, [{ data: 'https://a.com', name: 'one' }, { data: 'https://b.com', name: '' }]);
  assert.deepEqual(parseRows('hello world'), [{ data: 'hello world', name: '' }]);   // a plain value is not mistaken for a header
});

test('file names are safe and unique inside a zip', () => {
  assert.equal(safeFileName('../../etc/passwd', 'x'), '_.._etc_passwd');   // no slashes, no leading dots
  assert.ok(!safeFileName('../../evil', 'x').includes('/'));
  assert.ok(!safeFileName('a\\b:c*?', 'x').match(/[\\/:*?]/));
  const names = uniqueNames([{ name: 'table' }, { name: 'table' }, { name: '' }, { name: 'table' }], 'png');
  assert.deepEqual(names, ['table.png', 'table-2.png', 'qr-003.png', 'table-3.png']);
});

test('share-link encoding round-trips unicode and rejects garbage', () => {
  const obj = { v: 1, type: 'text', values: { text: { text: 'नमस्ते ✓ & <b>' } } };
  assert.deepEqual(b64d(b64e(obj)), obj);
  assert.equal(b64d('%%%not-base64%%%'), null);
});

test('frame layouts keep the label and QR inside the canvas', () => {
  for (const style of ['bottom', 'top', 'pill']) {
    const L = layout(1000, style);
    assert.ok(L.qx >= 0 && L.qy >= 0, style);
    assert.ok(L.qx + 1000 <= L.W && L.qy + 1000 <= L.H, `${style} QR inside`);
    assert.ok(L.label.cy + L.label.size / 2 <= L.H && L.label.cy - L.label.size / 2 >= 0, `${style} label inside`);
  }
  assert.deepEqual(layout(800, 'none'), { style: 'none', W: 800, H: 800, qx: 0, qy: 0 });
});
