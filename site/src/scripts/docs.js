// Docs behaviour: search (static index, loaded on first use), the mobile menu,
// and the "On this page" highlight.
(function () {
  // ---------------------------------------------------------------- search
  var input = document.getElementById('q');
  var box = document.getElementById('search-results');
  var index = null;
  var loading = null;
  var active = -1;
  var results = [];

  function load() {
    if (index) return Promise.resolve(index);
    if (!loading) loading = fetch('/assets/search.json').then(function (r) { return r.json(); }).then(function (j) { index = j; return j; });
    return loading;
  }
  function esc(s) { return s.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function snippet(text, terms) {
    var lower = text.toLowerCase();
    var at = -1;
    terms.forEach(function (t) { var i = lower.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; });
    var start = Math.max(0, at - 40);
    var s = (start > 0 ? '…' : '') + text.slice(start, start + 140) + (start + 140 < text.length ? '…' : '');
    var out = esc(s);
    terms.forEach(function (t) {
      if (t.length < 2) return;
      out = out.replace(new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig'), '<mark>$1</mark>');
    });
    return out;
  }
  function search(q) {
    var terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    return index
      .map(function (e) {
        var t = e.t.toLowerCase(), h = e.h.toLowerCase(), x = e.x.toLowerCase();
        var score = 0;
        for (var i = 0; i < terms.length; i++) {
          var term = terms[i];
          var s = 0;
          if (t.indexOf(term) >= 0) s += 8;
          if (h.indexOf(term) >= 0) s += 5;
          var n = x.split(term).length - 1;
          s += Math.min(n, 5);
          if (!s) return null;
          score += s;
        }
        return { e: e, score: score };
      })
      .filter(Boolean)
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, 8)
      .map(function (r) { r.terms = terms; return r; });
  }
  function render() {
    if (!results.length) {
      box.innerHTML = input.value.trim() ? '<p class="search__empty">No results. Try another word.</p>' : '';
    } else {
      box.innerHTML = results
        .map(function (r, i) {
          var title = esc(r.e.t) + (r.e.h ? ' <span>› ' + esc(r.e.h) + '</span>' : '');
          return '<a role="option" id="sr-' + i + '" href="' + r.e.u + '"' + (i === active ? ' aria-selected="true"' : '') + '><b>' + title + '</b><small>' + snippet(r.e.x, r.terms) + '</small></a>';
        })
        .join('');
    }
    var open = !!input.value.trim();
    box.hidden = !open;
    input.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (active >= 0) input.setAttribute('aria-activedescendant', 'sr-' + active);
    else input.removeAttribute('aria-activedescendant');
  }
  if (input) {
    input.addEventListener('focus', function () { load(); });
    input.addEventListener('input', function () {
      var q = input.value;
      load().then(function () { results = search(q); active = results.length ? 0 : -1; render(); }, function () {
        box.hidden = false; box.innerHTML = '<p class="search__empty">Search could not load. Use the menu instead.</p>';
      });
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' && results.length) { e.preventDefault(); active = (active + 1) % results.length; render(); }
      else if (e.key === 'ArrowUp' && results.length) { e.preventDefault(); active = (active - 1 + results.length) % results.length; render(); }
      else if (e.key === 'Enter' && active >= 0 && results[active]) { e.preventDefault(); location.href = results[active].e.u; }
      else if (e.key === 'Escape') { input.value = ''; results = []; active = -1; render(); input.blur(); }
    });
    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
      if (e.key === '/' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) { e.preventDefault(); input.focus(); }
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.search')) { box.hidden = true; input.setAttribute('aria-expanded', 'false'); }
    });
  }

  // ---------------------------------------------------------------- mobile menu
  var btn = document.querySelector('[data-docs-menu]');
  var nav = document.getElementById('sidenav');
  function setMenu(open) {
    document.body.classList.toggle('menu-open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.setAttribute('aria-label', open ? 'Close documentation menu' : 'Open documentation menu');
    if (open) { var cur = nav.querySelector('[aria-current]') || nav.querySelector('a'); if (cur) cur.focus(); }
  }
  if (btn && nav) {
    btn.addEventListener('click', function () { setMenu(!document.body.classList.contains('menu-open')); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && document.body.classList.contains('menu-open')) { setMenu(false); btn.focus(); }
    });
    nav.addEventListener('click', function (e) { if (e.target.closest('a')) setMenu(false); });
  }

  // ---------------------------------------------------------------- toc highlight
  var links = Array.prototype.slice.call(document.querySelectorAll('.toc a'));
  if (links.length && 'IntersectionObserver' in window) {
    var map = {};
    links.forEach(function (a) { map[a.getAttribute('href').slice(1)] = a; });
    var visible = {};
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { visible[en.target.id] = en.isIntersecting; });
      var first = links.map(function (a) { return a.getAttribute('href').slice(1); }).filter(function (id) { return visible[id]; })[0];
      if (first) links.forEach(function (a) { a.classList.toggle('is-current', a === map[first]); });
    }, { rootMargin: '-64px 0px -60% 0px' });
    Object.keys(map).forEach(function (id) { var el = document.getElementById(id); if (el) io.observe(el); });
  }
})();
