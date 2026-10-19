// Fetches the pinned CDN files and records their Subresource Integrity hashes in scripts/sri.json.
// Re-run this only when you deliberately change a pinned library version.
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILES = {
  qrs: 'https://cdn.jsdelivr.net/npm/qr-code-styling@1.6.0-rc.1/lib/qr-code-styling.js',
  jsqr: 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js',
  jszip: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
};

const out = {};
for (const [key, url] of Object.entries(FILES)) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  out[key] = `sha384-${createHash('sha384').update(Buffer.from(await res.arrayBuffer())).digest('base64')}`;
  console.log(key, out[key]);
}
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'sri.json'), `${JSON.stringify(out, null, 2)}\n`);
