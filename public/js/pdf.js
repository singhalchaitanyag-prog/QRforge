// Minimal single-page image PDF writer. Deflates raw RGB with the platform CompressionStream, so a QR
// code (large flat areas) compresses to tens of kilobytes. No third-party library needed.

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));   // zlib format, as PDF FlateDecode expects
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** canvas: an opaque canvas-like object. widthMm/heightMm: the printed page size. Returns a Uint8Array. */
export async function canvasToPdf(canvas, widthMm, heightMm, title = 'QR code') {
  const w = canvas.width; const h = canvas.height;
  const { data } = canvas.getContext('2d').getImageData(0, 0, w, h);
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < data.length; i += 4) { rgb[j++] = data[i]; rgb[j++] = data[i + 1]; rgb[j++] = data[i + 2]; }
  const img = await deflate(rgb);

  const pw = +(widthMm * 72 / 25.4).toFixed(2);
  const ph = +(heightMm * 72 / 25.4).toFixed(2);
  const enc = new TextEncoder();
  const content = enc.encode(`q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`);
  const safeTitle = String(title).replace(/[()\\]/g, '');

  const parts = []; const offsets = []; let pos = 0;
  const push = (u8) => { parts.push(u8); pos += u8.length; };
  const text = (s) => push(enc.encode(s));
  const obj = (n, body) => { offsets[n] = pos; text(`${n} 0 obj\n${body}\nendobj\n`); };

  text('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  offsets[4] = pos;
  text(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Interpolate false /Filter /FlateDecode /Length ${img.length} >>\nstream\n`);
  push(img);
  text('\nendstream\nendobj\n');
  offsets[5] = pos;
  text(`5 0 obj\n<< /Length ${content.length} >>\nstream\n`);
  push(content);
  text('\nendstream\nendobj\n');
  obj(6, `<< /Title (${safeTitle}) /Producer (QRForge) >>`);

  const xref = pos;
  let table = `xref\n0 7\n0000000000 65535 f \n`;
  for (let n = 1; n <= 6; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  text(`${table}trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(pos); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
