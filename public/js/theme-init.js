// Runs before first paint so the page never flashes the wrong theme or language.
(function () {
  try {
    var saved = localStorage.getItem('qrf.theme');
    var dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    var lang = localStorage.getItem('qrf.lang');
    if (lang) document.documentElement.lang = lang;
  } catch (e) { /* storage unavailable: keep defaults */ }
})();
