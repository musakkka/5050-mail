// Landing page behaviour: product switch, SDK tabs, reason switches, the cost
// calculator, FAQ cards, the install command builder and section entrances.
(function () {
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Generic roving tabs: arrow keys move between tabs (WAI-ARIA tabs pattern).
  function tablist(list, onSelect) {
    var tabs = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
    function select(tab, focus) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
        var panel = document.getElementById(t.getAttribute('aria-controls'));
        if (panel) { panel.hidden = !on; panel.removeAttribute('data-js-hidden'); }
      });
      if (focus) tab.focus();
      if (onSelect) onSelect(tab);
    }
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { select(t); });
      t.addEventListener('keydown', function (e) {
        var j = null;
        if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
        if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
        if (e.key === 'Home') j = 0;
        if (e.key === 'End') j = tabs.length - 1;
        if (j !== null) { e.preventDefault(); select(tabs[j], true); }
      });
    });
    var current = tabs.filter(function (t) { return t.getAttribute('aria-selected') === 'true'; })[0] || tabs[0];
    select(current);
  }

  // Product switch: swaps the field colour and one word of the heading.
  var field = document.querySelector('[data-switch-field]');
  if (field) {
    var word = field.querySelector('[data-word]');
    tablist(field.querySelector('[role="tablist"]'), function (tab) {
      field.setAttribute('data-mode', tab.getAttribute('data-mode-btn'));
      if (word) word.textContent = tab.getAttribute('data-word-value');
    });
  }
  document.querySelectorAll('[data-tabs] .tabs__list').forEach(function (l) { tablist(l); });

  // Reason bands: switches reveal the consequence line.
  document.querySelectorAll('[data-band] .switch').forEach(function (sw) {
    sw.addEventListener('click', function () {
      var on = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', on ? 'true' : 'false');
      sw.closest('[data-band]').classList.toggle('is-on', on);
    });
  });

  // Cost calculator: yearly cost for the chosen team size.
  var C = window.__COST;
  var range = document.getElementById('team');
  var out = document.getElementById('team-out');
  var bars = document.querySelector('[data-bars]');
  function money(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
  function updateCost() {
    if (!range || !bars || !C) return;
    var n = Number(range.value);
    out.value = out.textContent = String(n);
    var ws = C.ws.map(function (p) { return p * 12 * n; });
    var large = n > 50;
    var self = (large ? C.large : C.small) * 12;
    var max = Math.max.apply(null, ws.concat([self]));
    var rows = bars.querySelectorAll('li');
    ws.forEach(function (v, i) {
      rows[i].querySelector('.bar__fill').style.setProperty('--w', (v / max * 100).toFixed(2) + '%');
      rows[i].querySelector('[data-value]').textContent = money(v);
    });
    var last = rows[rows.length - 1];
    last.querySelector('.bar__fill').style.setProperty('--w', (self / max * 100).toFixed(2) + '%');
    last.querySelector('[data-value]').textContent = money(self);
    last.querySelector('[data-vm-note]').textContent = (large ? C.largeName : C.smallName) + ', ' + money(large ? C.large : C.small) + ' a month';
  }
  if (range) { range.addEventListener('input', updateCost); updateCost(); }

  // FAQ cards: one open at a time.
  var cards = document.querySelector('[data-cards]');
  if (cards) {
    var buttons = cards.querySelectorAll('.card__q button');
    buttons.forEach(function (b) {
      b.addEventListener('click', function () {
        buttons.forEach(function (o) {
          var open = o === b ? o.getAttribute('aria-expanded') !== 'true' : false;
          o.setAttribute('aria-expanded', open ? 'true' : 'false');
          var a = document.getElementById(o.getAttribute('aria-controls'));
          if (open) a.removeAttribute('data-collapsed'); else a.setAttribute('data-collapsed', '');
        });
      });
    });
  }

  // Install command builder.
  var form = document.querySelector('[data-builder]');
  if (form) {
    var base = 'curl -fsSL https://raw.githubusercontent.com/musakkka/5050-mail/main/install.sh | sudo bash';
    var input = form.querySelector('input[name="domain"]');
    var outEl = form.querySelector('[data-builder-out]');
    var echo = form.querySelector('[data-domain-echo]');
    var status = form.querySelector('.dialog__status');
    var copyBtn = form.querySelector('[data-builder-copy]');
    var valid = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
    function build() {
      var d = input.value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      var ok = valid.test(d);
      input.setAttribute('aria-invalid', ok ? 'false' : 'true');
      echo.textContent = ok ? d : 'example.com';
      var cf = form.querySelector('input[name="dns"]:checked').value === 'cloudflare';
      var cmd = base + ' -s -- \\\n  --domain ' + (ok ? d : 'example.com') + (cf ? ' \\\n  --cloudflare-token "$CF_TOKEN"' : '');
      if (cf) cmd = 'CF_TOKEN=paste-your-cloudflare-token\n' + cmd;
      outEl.textContent = cmd;
      copyBtn.disabled = !ok;
      status.textContent = ok ? '' : 'Enter a domain like example.com';
      return cmd;
    }
    form.addEventListener('input', build);
    form.addEventListener('change', build);
    copyBtn.addEventListener('click', function () {
      window.__copy(build(), copyBtn);
      status.textContent = 'Copied. Paste it into an SSH session on your server.';
    });
    build();
  }

  // Demo video: if it fails to load, remove the section rather than show a broken player.
  var demo = document.querySelector('[data-demo] video');
  if (demo) {
    var src = demo.querySelector('source');
    (src || demo).addEventListener('error', function () { demo.closest('[data-demo]').remove(); });
  }

  // Entrances: heading, text, picture, staggered as each section enters.
  var items = document.querySelectorAll('[data-reveal]');
  if (reduce || !('IntersectionObserver' in window)) {
    items.forEach(function (el) { el.classList.add('is-in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.classList.add('is-in');
        io.unobserve(en.target);
      });
    }, { rootMargin: '0px 0px -10% 0px' });
    items.forEach(function (el) {
      var sibs = el.parentElement ? Array.prototype.indexOf.call(el.parentElement.children, el) : 0;
      el.style.setProperty('--d', Math.min(sibs, 4) * 80 + 'ms');
      io.observe(el);
    });
  }
})();
