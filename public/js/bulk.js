// Bulk generation helpers (pure parsing; the ZIP loop lives in app.js because it needs the QR library).
export const BULK_MAX = 500;

/** Split one CSV line, honoring "quoted, values" and "" escapes. */
export function splitCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** "value" or "value,filename" per line. Skips blanks and a header row. */
export function parseRows(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows = [];
  lines.forEach((line, i) => {
    const [data, name] = splitCsvLine(line);
    if (!data) return;
    if (i === 0 && /^(data|url|text|value|link)$/i.test(data) && (!name || /^(name|file|filename|label)$/i.test(name))) return;
    rows.push({ data, name: name || '' });
  });
  return rows;
}

export function safeFileName(name, fallback) {
  const base = String(name || fallback).replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '-').replace(/^\.+/, '').slice(0, 60);
  return base || fallback;
}

/** Unique file names inside a zip: a, a-2, a-3 ... */
export function uniqueNames(rows, ext) {
  const seen = new Map();
  return rows.map((r, i) => {
    const base = safeFileName(r.name, `qr-${String(i + 1).padStart(3, '0')}`);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return `${n === 1 ? base : `${base}-${n}`}.${ext}`;
  });
}
