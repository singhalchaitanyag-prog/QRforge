// localStorage wrapper. Every call is guarded: storage can be disabled, full or blocked.
const read = (key, fallback) => {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
};
const write = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
};

export const Store = {
  kits: () => read('qrf.kits', []),
  saveKits: (kits) => write('qrf.kits', kits),

  history: () => read('qrf.history', []),
  pushHistory(entry, max = 12) {
    let list = [entry, ...this.history().filter((h) => h.id !== entry.id)].slice(0, max);
    // Logos can be large; if storage is full drop them from the oldest entries until it fits.
    while (!write('qrf.history', list) && list.length) {
      const idx = list.findLastIndex((h) => h.settings?.logo);
      if (idx > 0) { list[idx] = { ...list[idx], settings: { ...list[idx].settings, logo: null } }; } else { list = list.slice(0, -1); }
    }
    return list;
  },

  last: () => read('qrf.last', null),
  saveLast: (s) => write('qrf.last', s),
};

export const b64e = (obj) => btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const b64d = (str) => {
  try {
    const pad = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
    return JSON.parse(decodeURIComponent(escape(atob(pad))));
  } catch { return null; }
};
