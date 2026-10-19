// Generates the static pages in /public from templates/page.html and the content in scripts/pages.mjs.
// Usage: BASE_URL=https://your-domain.com npm run build
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, PAGES, FOOT_LINKS } from './pages.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');
// BASE_URL comes from the environment, or else from wrangler.jsonc (the single place the production domain is written).
function baseFromWrangler() {
  try {
    const text = readFileSync(join(root, 'wrangler.jsonc'), 'utf8')
      .split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');   // drop whole-line comments
    return JSON.parse(text).vars?.BASE_URL || '';
  } catch { return ''; }
}
const base = (process.env.BASE_URL || baseFromWrangler()).replace(/\/$/, '');
const tpl = readFileSync(join(root, 'templates', 'page.html'), 'utf8');
const sriPath = join(root, 'scripts', 'sri.json');
const sri = existsSync(sriPath) ? JSON.parse(readFileSync(sriPath, 'utf8')) : {};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const write = (rel, body) => { const p = join(pub, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); };
const fill = (str, map) => str.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in map ? map[k] : m));
const sriAttr = (k) => (sri[k] ? `integrity="${sri[k]}" crossorigin="anonymous"` : '');
const abs = (path) => (base ? `${base}${path}` : '');

const faqHtml = (faq) => faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('\n');
const useCases = PAGES.map((p) => `<a href="/${p.slug}">${esc(p.short)}<small>${esc(p.blurb)}</small></a>`).join('');
const footLinks = FOOT_LINKS.map((s) => PAGES.find((p) => p.slug === s)).map((p) => `<a href="/${p.slug}">${esc(p.short)} QR code</a>`).join('');

function jsonLd(page, path, crumbs) {
  const graph = [
    {
      '@type': 'WebApplication', name: 'QRForge', applicationCategory: 'UtilitiesApplication', operatingSystem: 'Any',
      description: page.description, offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }, ...(base ? { url: abs(path || '/') } : {}),
    },
    { '@type': 'FAQPage', mainEntity: page.faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
  ];
  if (crumbs && base) {
    graph.push({
      '@type': 'BreadcrumbList',
      itemListElement: [{ '@type': 'ListItem', position: 1, name: 'QRForge', item: abs('/') }, { '@type': 'ListItem', position: 2, name: page.short, item: abs(path) }],
    });
  }
  // "<" is escaped so the JSON can never close its own <script> element.
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c');
}

function stripAbsoluteOnly(html) {
  // Without BASE_URL there is no honest absolute URL, so omit canonical/og:url instead of inventing one.
  return base ? html : html.split('\n').filter((l) => !/rel="canonical"|property="og:url"/.test(l)).join('\n');
}

function landing(page, { path, home }) {
  const html = fill(tpl, {
    TITLE: esc(page.title), DESCRIPTION: esc(page.description), CANONICAL: abs(path || '/'),
    JSONLD: jsonLd(page, path, !home),
    DEFAULT_TYPE: page.type || 'url',
    LANDING_ATTR: home ? '' : ` data-landing="1"${page.preset ? ` data-preset="${esc(JSON.stringify(page.preset))}"` : ''}`,
    CRUMBS: home ? '' : `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">QRForge</a> / ${esc(page.short)}</nav>`,
    H1: esc(page.h1), SUB: esc(page.sub),
    H1_I18N: home ? 'data-i18n="hero.h1"' : '', SUB_I18N: home ? 'data-i18n="hero.sub"' : '',
    EXTRA: '', USECASES: useCases, FAQ: faqHtml(page.faq), FOOTLINKS: footLinks,
    SRI_QRS: sriAttr('qrs'), SRI_JSQR: sriAttr('jsqr'), SRI_JSZIP: sriAttr('jszip'),
  });
  return stripAbsoluteOnly(html);
}

/* Shared header/footer for non-generator pages (docs, legal, dashboard, 404). */
const headerHtml = /<header class="top">[\s\S]*?<\/header>/.exec(tpl)[0];
const footerHtml = fill(/<footer class="site">[\s\S]*?<\/footer>/.exec(tpl)[0], { FOOTLINKS: footLinks });
const headEnd = tpl.indexOf('</head>');

function shell({ title, description, path, main, scripts = '', noindex = false, extraHead = '' }) {
  let head = tpl.slice(0, headEnd);
  head = fill(head, { TITLE: esc(title), DESCRIPTION: esc(description), CANONICAL: abs(path), JSONLD: '{}' });
  head = head.replace(/<script type="application\/ld\+json">[^<]*<\/script>\n?/, '');
  head = stripAbsoluteOnly(head);
  if (noindex) head += '<meta name="robots" content="noindex">\n';
  return `${head}${extraHead}</head>\n<body>\n${headerHtml}\n${main}\n${footerHtml}\n<div class="toast" id="toast" role="status" aria-live="polite"></div>\n${scripts}\n</body>\n</html>\n`;
}
const chromeScript = '<script type="module" src="/js/chrome.js"></script>';
const frag = (name) => fill(readFileSync(join(root, 'templates', name), 'utf8'), { BASE: base || 'https://YOUR-QRFORGE-HOST' });

/* ---------- generate ---------- */
write('index.html', landing({ ...HOME, type: 'url', short: 'QRForge', faq: HOME.faq }, { path: '/', home: true }));
for (const p of PAGES) write(`${p.slug}.html`, landing(p, { path: `/${p.slug}`, home: false }));

write('privacy.html', shell({
  title: 'Privacy | QRForge', description: 'What QRForge stores, what stays in your browser, and which third parties are involved.',
  path: '/privacy', main: `<div class="wrap"><article class="prose">${frag('privacy.html')}</article></div>`, scripts: chromeScript,
}));
write('terms.html', shell({
  title: 'Terms of use | QRForge', description: 'The rules for using QRForge, including acceptable use of dynamic links.',
  path: '/terms', main: `<div class="wrap"><article class="prose">${frag('terms.html')}</article></div>`, scripts: chromeScript,
}));
write('404.html', shell({
  title: 'Page not found | QRForge', description: 'Page not found.', path: '/404', noindex: true,
  main: '<div class="wrap"><div class="empty" style="padding:96px 0"><h1>Page not found</h1><p>That page does not exist. <a class="btn small" href="/">Back to the generator</a></p></div></div>',
  scripts: chromeScript,
}));
write('dashboard.html', shell({
  title: 'Dashboard | QRForge', description: 'Manage dynamic QR codes and view scan analytics.', path: '/dashboard', noindex: true,
  main: frag('dashboard.html'),
  scripts: `<script src="https://cdn.jsdelivr.net/npm/qr-code-styling@1.6.0-rc.1/lib/qr-code-styling.js" defer ${sriAttr('qrs')}></script>\n<script type="module" src="/js/dashboard.js"></script>`,
}));

write('robots.txt', `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /r/\nDisallow: /p/\nDisallow: /dashboard\n${base ? `Sitemap: ${base}/sitemap.xml\n` : ''}`);
if (base) {
  const urls = ['/', ...PAGES.map((p) => `/${p.slug}`), '/privacy', '/terms'];
  write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${base}${u === '/' ? '/' : u}</loc></url>`).join('\n')}\n</urlset>\n`);
} else {
  console.warn('BASE_URL is not set: skipping sitemap.xml and canonical URLs. Set it for production builds.');
}
console.log(`Built ${2 + PAGES.length + 4} pages${base ? ` for ${base}` : ''}.`);
