// Content types: what the QR code encodes. Pure functions, no DOM, so they can be unit-tested.

const trim = (v) => String(v ?? '').trim();

export function withScheme(u) {
  const s = trim(u);
  if (!s) return '';
  return /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
}

const wifiEsc = (s) => String(s).replace(/([\\;,:"])/g, '\\$1');
const vcardEsc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
const icsEsc = vcardEsc;

/** "2026-03-14T18:30" -> "20260314T183000" (floating local time) */
export function icsDate(local) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local || '');
  return m ? `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}00` : '';
}

const digits = (s) => String(s ?? '').replace(/\D/g, '');

export const SOCIAL = {
  instagram: (h) => `https://instagram.com/${h}`,
  youtube: (h) => `https://youtube.com/@${h}`,
  facebook: (h) => `https://facebook.com/${h}`,
  x: (h) => `https://x.com/${h}`,
  linkedin: (h) => `https://linkedin.com/in/${h}`,
  tiktok: (h) => `https://tiktok.com/@${h}`,
  telegram: (h) => `https://t.me/${h}`,
  github: (h) => `https://github.com/${h}`,
};

export const TYPES = [
  {
    id: 'url', label: 'URL', dynamic: true,
    fields: [{ id: 'url', label: 'Website URL', type: 'url', ph: 'https://example.com', required: true }],
    build: (v) => withScheme(v.url),
    check: (v) => {
      const s = withScheme(v.url);
      if (!s) return '';
      try { const u = new URL(s); return /^https?:$/.test(u.protocol) ? '' : 'Use a web address starting with http:// or https://'; } catch { return 'That does not look like a valid web address'; }
    },
  },
  {
    id: 'text', label: 'Text',
    fields: [{ id: 'text', label: 'Text', type: 'textarea', ph: 'Type anything…', required: true }],
    build: (v) => String(v.text ?? ''),
  },
  {
    id: 'email', label: 'Email',
    fields: [
      { id: 'to', label: 'Email address', type: 'email', ph: 'name@example.com', required: true },
      { id: 'subject', label: 'Subject', type: 'text', ph: 'Optional' },
      { id: 'body', label: 'Message', type: 'textarea', ph: 'Optional' },
    ],
    build: (v) => {
      if (!trim(v.to)) return '';
      const qs = [];
      if (trim(v.subject)) qs.push(`subject=${encodeURIComponent(v.subject)}`);
      if (trim(v.body)) qs.push(`body=${encodeURIComponent(v.body)}`);
      return `mailto:${trim(v.to)}${qs.length ? `?${qs.join('&')}` : ''}`;
    },
    check: (v) => (trim(v.to) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trim(v.to)) ? 'Enter a valid email address' : ''),
  },
  {
    id: 'phone', label: 'Phone',
    fields: [{ id: 'tel', label: 'Phone number', type: 'tel', ph: '+91 98765 43210', required: true }],
    build: (v) => (trim(v.tel) ? `tel:${trim(v.tel).replace(/[^\d+]/g, '')}` : ''),
  },
  {
    id: 'sms', label: 'SMS',
    fields: [
      { id: 'num', label: 'Phone number', type: 'tel', ph: '+91 98765 43210', required: true },
      { id: 'msg', label: 'Message', type: 'textarea', ph: 'Optional' },
    ],
    build: (v) => (trim(v.num) ? `SMSTO:${trim(v.num).replace(/[^\d+]/g, '')}:${v.msg ?? ''}` : ''),
  },
  {
    id: 'wifi', label: 'Wi-Fi',
    fields: [
      { id: 'ssid', label: 'Network name (SSID)', type: 'text', ph: 'MyWiFi', required: true },
      { id: 'pass', label: 'Password', type: 'text', ph: '' },
      { id: 'enc', label: 'Security', type: 'select', opts: ['WPA', 'WEP', 'nopass'], half: true },
      { id: 'hidden', label: 'Hidden network', type: 'select', opts: ['No', 'Yes'], half: true },
    ],
    build: (v) => {
      if (!trim(v.ssid)) return '';
      const enc = v.enc || 'WPA';
      return `WIFI:T:${enc};S:${wifiEsc(v.ssid)};${enc === 'nopass' ? '' : `P:${wifiEsc(v.pass ?? '')};`}${v.hidden === 'Yes' ? 'H:true;' : ''};`;
    },
  },
  {
    id: 'vcard', label: 'Contact',
    fields: [
      { id: 'first', label: 'First name', type: 'text', required: true, half: true },
      { id: 'last', label: 'Last name', type: 'text', half: true },
      { id: 'org', label: 'Company', type: 'text', half: true },
      { id: 'title', label: 'Job title', type: 'text', half: true },
      { id: 'tel', label: 'Phone', type: 'tel', half: true },
      { id: 'email', label: 'Email', type: 'email', half: true },
      { id: 'url', label: 'Website', type: 'url', ph: 'https://' },
      { id: 'adr', label: 'Address', type: 'text' },
    ],
    build: (v) => {
      if (!trim(v.first) && !trim(v.last)) return '';
      const lines = ['BEGIN:VCARD', 'VERSION:3.0',
        `N:${vcardEsc(trim(v.last))};${vcardEsc(trim(v.first))};;;`,
        `FN:${vcardEsc(`${trim(v.first)} ${trim(v.last)}`.trim())}`];
      if (trim(v.org)) lines.push(`ORG:${vcardEsc(trim(v.org))}`);
      if (trim(v.title)) lines.push(`TITLE:${vcardEsc(trim(v.title))}`);
      if (trim(v.tel)) lines.push(`TEL;TYPE=CELL:${trim(v.tel).replace(/[^\d+]/g, '')}`);
      if (trim(v.email)) lines.push(`EMAIL:${trim(v.email)}`);
      if (trim(v.url)) lines.push(`URL:${withScheme(v.url)}`);
      if (trim(v.adr)) lines.push(`ADR:;;${vcardEsc(trim(v.adr))};;;;`);
      lines.push('END:VCARD');
      return lines.join('\n');
    },
  },
  {
    id: 'location', label: 'Location',
    fields: [
      { id: 'lat', label: 'Latitude', type: 'text', ph: '28.6139', required: true, half: true },
      { id: 'lng', label: 'Longitude', type: 'text', ph: '77.2090', required: true, half: true },
    ],
    build: (v) => {
      const lat = Number(trim(v.lat)); const lng = Number(trim(v.lng));
      if (!trim(v.lat) || !trim(v.lng) || !Number.isFinite(lat) || !Number.isFinite(lng)) return '';
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return '';
      return `geo:${lat},${lng}`;
    },
    check: (v) => {
      if (!trim(v.lat) && !trim(v.lng)) return '';
      const lat = Number(trim(v.lat)); const lng = Number(trim(v.lng));
      if (!Number.isFinite(lat) || Math.abs(lat) > 90) return 'Latitude must be between -90 and 90';
      if (!Number.isFinite(lng) || Math.abs(lng) > 180) return 'Longitude must be between -180 and 180';
      return '';
    },
  },
  {
    id: 'event', label: 'Event',
    fields: [
      { id: 'title', label: 'Event title', type: 'text', required: true },
      { id: 'start', label: 'Starts', type: 'datetime-local', required: true, half: true },
      { id: 'end', label: 'Ends', type: 'datetime-local', half: true },
      { id: 'place', label: 'Location', type: 'text' },
      { id: 'desc', label: 'Description', type: 'textarea' },
    ],
    build: (v) => {
      const s = icsDate(v.start);
      if (!trim(v.title) || !s) return '';
      const e = icsDate(v.end);
      return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', `SUMMARY:${icsEsc(trim(v.title))}`, `DTSTART:${s}`,
        ...(e ? [`DTEND:${e}`] : []),
        ...(trim(v.place) ? [`LOCATION:${icsEsc(trim(v.place))}`] : []),
        ...(trim(v.desc) ? [`DESCRIPTION:${icsEsc(trim(v.desc))}`] : []),
        'END:VEVENT', 'END:VCALENDAR'].join('\n');
    },
    check: (v) => (v.start && v.end && v.end < v.start ? 'The end time is before the start time' : ''),
  },
  {
    id: 'whatsapp', label: 'WhatsApp',
    fields: [
      { id: 'num', label: 'Phone number with country code', type: 'tel', ph: '919876543210', required: true },
      { id: 'msg', label: 'Pre-filled message', type: 'textarea', ph: 'Optional' },
    ],
    build: (v) => {
      const n = digits(v.num);
      if (n.length < 8) return '';
      return `https://wa.me/${n}${trim(v.msg) ? `?text=${encodeURIComponent(v.msg)}` : ''}`;
    },
    check: (v) => (trim(v.num) && digits(v.num).length < 8 ? 'Include the country code, e.g. 91 for India' : ''),
  },
  {
    id: 'social', label: 'Social',
    fields: [
      { id: 'platform', label: 'Platform', type: 'select', opts: Object.keys(SOCIAL), half: true },
      { id: 'handle', label: 'Username', type: 'text', ph: 'yourname', required: true, half: true },
    ],
    build: (v) => {
      const h = trim(v.handle).replace(/^@/, '');
      if (!h || !/^[\w.\-]+$/.test(h)) return '';
      return (SOCIAL[v.platform] || SOCIAL.instagram)(h);
    },
    check: (v) => (trim(v.handle) && !/^[\w.\-]+$/.test(trim(v.handle).replace(/^@/, '')) ? 'Usernames can only contain letters, numbers, dots, dashes and underscores' : ''),
  },
  {
    id: 'upi', label: 'UPI payment',
    fields: [
      { id: 'pa', label: 'UPI ID', type: 'text', ph: 'name@bank', required: true },
      { id: 'pn', label: 'Payee name', type: 'text', required: true, half: true },
      { id: 'am', label: 'Amount (optional)', type: 'text', ph: '499', half: true },
      { id: 'tn', label: 'Note (optional)', type: 'text' },
    ],
    build: (v) => {
      const pa = trim(v.pa);
      if (!/^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(pa) || !trim(v.pn)) return '';
      const am = trim(v.am);
      if (am && !/^\d{1,9}(\.\d{1,2})?$/.test(am)) return '';
      const qs = [`pa=${encodeURIComponent(pa)}`, `pn=${encodeURIComponent(trim(v.pn))}`];
      if (am) qs.push(`am=${am}`);
      qs.push('cu=INR');
      if (trim(v.tn)) qs.push(`tn=${encodeURIComponent(trim(v.tn))}`);
      return `upi://pay?${qs.join('&')}`;
    },
    check: (v) => {
      if (trim(v.pa) && !/^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(trim(v.pa))) return 'A UPI ID looks like name@bank';
      if (trim(v.am) && !/^\d{1,9}(\.\d{1,2})?$/.test(trim(v.am))) return 'Enter the amount as a number, e.g. 499 or 499.50';
      return '';
    },
  },
];

export const typeById = (id) => TYPES.find((t) => t.id === id) || TYPES[0];

/** QR spec: max bytes at error-correction level H, per version (byte mode). Used for the print-size estimate. */
const H_BYTES = [0, 7, 14, 24, 34, 44, 58, 64, 84, 98, 119, 137, 155, 177, 194, 220, 250, 280, 310, 338, 382,
  403, 439, 461, 511, 535, 593, 625, 658, 698, 742, 790, 842, 898, 958, 983, 1051, 1093, 1139, 1219, 1273];

export function estimateModules(data) {
  const n = new TextEncoder().encode(String(data)).length;
  for (let v = 1; v < H_BYTES.length; v++) if (n <= H_BYTES[v]) return 17 + 4 * v;
  return 17 + 4 * 40;
}

/**
 * Print-size sanity check.
 * Rule of thumb: a phone scans reliably at about 10x the code width; modules smaller than ~0.4 mm
 * are hard for many printers to reproduce.
 */
export function printCheck({ data, widthCm, distanceM }) {
  const modules = estimateModules(data);
  const moduleMm = (widthCm * 10) / (modules + 2);
  const minWidthCm = Math.max(2, distanceM * 100 / 10);
  const issues = [];
  if (moduleMm < 0.4) issues.push(`Modules would be ${moduleMm.toFixed(2)} mm. Print larger or shorten the content (minimum about 0.4 mm).`);
  if (widthCm < minWidthCm) issues.push(`For scanning from ${distanceM} m the code should be at least ${minWidthCm.toFixed(1)} cm wide.`);
  return { ok: issues.length === 0, modules, moduleMm, minWidthCm, issues };
}
