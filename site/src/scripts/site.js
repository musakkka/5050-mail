// Shared behaviour: theme toggle and copy buttons. Everything works without it.
(function () {
  var root = document.documentElement;

  function effectiveTheme() {
    var t = root.dataset.theme;
    if (t === 'light' || t === 'dark') return t;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function labelToggles() {
    var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    document.querySelectorAll('[data-theme-toggle]').forEach(function (b) {
      var text = 'Switch to ' + next + ' theme';
      if (b.classList.contains('icon-btn')) { b.setAttribute('aria-label', text); b.title = text; }
      else b.textContent = text;
    });
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-theme-toggle]');
    if (!t) return;
    var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch (err) {}
    labelToggles();
  });
  labelToggles();

  // Copy buttons: [data-copy-text] copies its value; [data-copy] copies the sibling code block.
  function copy(text, btn) {
    var done = function () {
      var old = btn.textContent;
      btn.textContent = 'Copied';
      btn.setAttribute('data-done', '');
      setTimeout(function () { btn.textContent = old === 'Copied' ? 'Copy' : old; btn.removeAttribute('data-done'); }, 1600);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(text); done(); });
    } else { fallback(text); done(); }
  }
  function fallback(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }
  document.querySelectorAll('[data-copy]').forEach(function (b) { b.hidden = false; });
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-copy-text], [data-copy]');
    if (!b) return;
    var text = b.hasAttribute('data-copy-text')
      ? b.getAttribute('data-copy-text')
      : (b.closest('.code').querySelector('pre').innerText || '').replace(/\n$/, '');
    copy(text, b);
  });
  window.__copy = copy;
})();
