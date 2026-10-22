// Apply the saved appearance before first paint (CSP: script-src 'self', so this is a file).
(function () {
  try {
    var t = localStorage.getItem('send.theme') || 'system';
    var dark = t === 'dark' || (t === 'system' && !window.matchMedia('(prefers-color-scheme: light)').matches);
    var r = document.documentElement;
    r.classList.toggle('dark', dark);
    r.style.colorScheme = dark ? 'dark' : 'light';
  } catch (e) {}
})();
