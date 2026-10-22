// The landing page. Copy rules: no em dashes, no invented numbers. Every price
// below comes from the vendor's public page on the date in PRICES_CHECKED.
import { SITE, head, siteHeader, mark, ICONS } from '../build/layout.mjs';
import { escapeHtml } from '../build/markdown.mjs';

export const PRICES_CHECKED = '22 October 2026';

// Google Workspace, USD per user per month (Google's Business editions help page).
const WORKSPACE = [
  { id: 'starter', name: 'Business Starter', annual: 7, flexible: 8.4, storage: '30 GB pooled per user' },
  { id: 'standard', name: 'Business Standard', annual: 14, flexible: 16.8, storage: '2 TB pooled per user' },
  { id: 'plus', name: 'Business Plus', annual: 22, flexible: 26.4, storage: '5 TB pooled per user' },
];
// Akamai Cloud (Linode) shared CPU plans, USD per month.
const VM_SMALL = { name: 'Linode 4 GB', price: 24, spec: '2 vCPU, 4 GB RAM, 80 GB disk' };
const VM_LARGE = { name: 'Linode 8 GB', price: 48, spec: '4 vCPU, 8 GB RAM, 160 GB disk' };
// Resend transactional plans, USD per month.
const RESEND = [
  { emails: '3,000', plan: 'Free (100 a day)', price: '$0' },
  { emails: '50,000', plan: 'Pro', price: '$20' },
  { emails: '100,000', plan: 'Pro', price: '$35' },
  { emails: '200,000', plan: 'Scale', price: '$160' },
  { emails: '500,000', plan: 'Scale', price: '$350' },
  { emails: '1,000,000', plan: 'Scale', price: '$650' },
];

const SOURCES = {
  workspace: 'https://knowledge.workspace.google.com/admin/getting-started/editions/business-editions',
  resend: 'https://resend.com/pricing',
  akamai: 'https://www.akamai.com/cloud/pricing/cpu',
};

const copyBtn = (text, label = 'Copy') =>
  `<button type="button" class="copy" data-copy-text="${escapeHtml(text)}" aria-label="${escapeHtml(label === 'Copy' ? 'Copy install command' : label)}">Copy</button>`;

// ---------------------------------------------------------------- interface fragments
// Built in HTML from the real product's layout and labels (data-ui marks them as product UI).
const STAR_OFF = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="none" stroke="currentColor" stroke-width="2" d="m12 3.5 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg>';
const STAR_ON = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="m12 3.5 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg>';

const INBOX_ROWS = [
  { from: 'Priya, me', n: 3, subj: 'Re: Q4 supplier contract', snip: 'Signed copy attached. Can you countersign by Friday?', time: '10:42', unread: true, chip: 'Work', att: 'contract-v3.pdf' },
  { from: 'Ops alerts', subj: 'Backup finished', snip: 'Nightly database dump completed in 4 min, uploaded off-site.', time: '09:15', unread: true },
  { from: 'Marco Bianchi', subj: 'Lunch next week?', snip: 'There is a new place by the office. Tuesday works for me.', time: '08:03', chip: 'Team' },
  { from: 'support@example.com', n: 2, subj: 'Ticket #1182: invoice address', snip: 'Updated the billing address as requested. Thanks!', time: 'Oct 21', chip: 'Support' },
  { from: 'Dana, Ali, me', n: 5, subj: 'Launch checklist', snip: 'DNS is done, DKIM passes. Only the PTR record left.', time: 'Oct 21', star: true },
  { from: 'Hiring', subj: 'New application: front-end engineer', snip: 'A new application arrived through the careers page.', time: 'Oct 20' },
];

function inboxFragment() {
  const rows = INBOX_ROWS.map(
    (r, i) => `<li class="ui-row${r.unread ? ' is-unread' : ''}${i === 0 ? ' is-hover' : ''}">
      <span class="ui-check" aria-hidden="true"></span>
      <span class="ui-star${r.star ? ' is-on' : ''}" aria-hidden="true">${r.star ? STAR_ON : STAR_OFF}</span>
      <span class="ui-from">${escapeHtml(r.from)}${r.n ? ` <small>${r.n}</small>` : ''}</span>
      <span class="ui-subj">${r.chip ? `<span class="ui-chip">${r.chip}</span>` : ''}<b>${escapeHtml(r.subj)}</b><span class="ui-snip"> - ${escapeHtml(r.snip)}</span>
        ${r.att ? `<span class="ui-att">${escapeHtml(r.att)}</span>` : ''}</span>
      <span class="ui-time">${r.time}</span>
    </li>`,
  ).join('');
  return `<div class="ui ui-inbox" data-ui aria-hidden="true">
    <div class="ui-search"><span>${ICONS.search}</span>Search mail</div>
    <div class="ui-tabs"><span class="is-on">Primary</span><span>Promotions</span><span>Social</span><span>Updates</span></div>
    <ul class="ui-list">${rows}</ul>
  </div>`;
}

function dnsFragment() {
  const rec = [
    ['MX', '@', '10 mail.example.com.'],
    ['TXT', '@', 'v=spf1 mx -all'],
    ['TXT', 'v1-ed25519-20261022._domainkey', 'v=DKIM1; k=ed25519; h=sha256; p=MCowBQYDK2VwAyEA…'],
    ['TXT', 'v1-rsa-20261022._domainkey', 'v=DKIM1; k=rsa; h=sha256; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA…'],
    ['TXT', '_dmarc', 'v=DMARC1; p=reject; rua=mailto:postmaster@example.com'],
    ['TXT', '_smtp._tls', 'v=TLSRPTv1; rua=mailto:postmaster@example.com'],
  ];
  return `<div class="ui ui-dns" data-ui aria-hidden="true">
    <div class="ui-dns__head"><b>example.com</b><span class="ui-ok">Active</span><span class="ui-muted">DNS: Cloudflare, automatic</span></div>
    <table><thead><tr><th>Type</th><th>Name</th><th>Status</th><th>Content</th></tr></thead><tbody>
    ${rec.map(([t, n, v]) => `<tr><td><span class="ui-type">${t}</span></td><td>${n}</td><td><span class="ui-pub">Published</span></td><td class="ui-val">${escapeHtml(v)}</td></tr>`).join('')}
    </tbody></table>
  </div>`;
}

function logsFragment() {
  const rows = [
    ['POST', '/emails', 200, 'resend-node:6.34.1', '31 ms'],
    ['POST', '/emails/batch', 200, 'resend-python:2.50.0', '58 ms'],
    ['GET', '/emails/4ef9a417…', 200, 'curl/8.5.0', '9 ms'],
    ['POST', '/emails', 422, 'resend-node:6.34.1', '6 ms'],
    ['POST', '/domains/…/verify', 200, 'dashboard', '212 ms'],
  ];
  return `<div class="ui ui-logs" data-ui aria-hidden="true">
    <p class="ui-logs__head"><b>Logs</b><span class="ui-muted">Last 15 days</span></p>
    <ul>${rows.map(([m, e, s, ua, d]) => `<li><span class="ui-method">${m}</span><span class="ui-ep">${e}</span><span class="ui-code ui-code--${s < 400 ? 'ok' : 'bad'}">${s}</span><span class="ui-ua">${ua}</span><span class="ui-ms">${d}</span></li>`).join('')}</ul>
  </div>`;
}

function emailCard(stage) {
  const steps = [
    { status: 'queued', extra: '' },
    { status: 'sent', extra: '<p class="ui-kv"><span>DKIM</span> d=example.com s=send5050</p>' },
    { status: 'delivered', extra: '<p class="ui-kv"><span>DKIM</span> d=example.com s=send5050</p><p class="ui-kv"><span>Remote</span> 250 2.0.0 OK</p>' },
    { status: 'delivered', extra: '<p class="ui-kv"><span>Webhook</span> email.delivered</p><p class="ui-kv"><span>svix-signature</span> v1,9LQ…</p><p class="ui-kv"><span>Your app</span> 200 OK</p>' },
  ][stage];
  return `<div class="ui ui-card" data-ui aria-hidden="true">
    <p class="ui-card__top"><span class="ui-status ui-status--${steps.status}">${steps.status}</span><span class="ui-muted">POST /emails</span></p>
    <p class="ui-kv"><span>From</span> hello@example.com</p>
    <p class="ui-kv"><span>To</span> you@example.org</p>
    <p class="ui-kv"><span>Subject</span> Your receipt</p>
    ${steps.extra}
  </div>`;
}

// ---------------------------------------------------------------- code samples (Send)
const SDK = [
  {
    id: 'node', label: 'Node.js',
    code: `import { Resend } from 'resend';

const resend = new Resend('re_xxxxxxxxx', {
  baseUrl: 'https://api.example.com',   // was https://api.resend.com
});

await resend.emails.send({
  from: 'Acme <hello@example.com>',
  to: 'you@example.org',
  subject: 'Your receipt',
  html: '<p>Thanks for your order.</p>',
});`,
  },
  {
    id: 'python', label: 'Python',
    code: `import resend

resend.api_key = "re_xxxxxxxxx"
resend.api_url = "https://api.example.com"   # or RESEND_API_URL

resend.Emails.send({
    "from": "Acme <hello@example.com>",
    "to": ["you@example.org"],
    "subject": "Your receipt",
    "html": "<p>Thanks for your order.</p>",
})`,
  },
  {
    id: 'go', label: 'Go',
    code: `client := resend.NewClient("re_xxxxxxxxx")
client.BaseURL, _ = url.Parse("https://api.example.com/")

client.Emails.Send(&resend.SendEmailRequest{
    From:    "Acme <hello@example.com>",
    To:      []string{"you@example.org"},
    Subject: "Your receipt",
    Html:    "<p>Thanks for your order.</p>",
})`,
  },
  {
    id: 'php', label: 'PHP',
    code: `# .env: the PHP and Laravel SDKs read the base URL from here
RESEND_BASE_URL=https://api.example.com
RESEND_API_KEY=re_xxxxxxxxx`,
  },
  {
    id: 'ruby', label: 'Ruby',
    code: `# read when the gem loads; keep the trailing slash
export RESEND_BASE_URL=https://api.example.com/`,
  },
  {
    id: 'curl', label: 'curl',
    code: `curl https://api.example.com/emails \\
  -H 'Authorization: Bearer re_xxxxxxxxx' \\
  -H 'Content-Type: application/json' \\
  -d '{"from":"Acme <hello@example.com>","to":["you@example.org"],
       "subject":"Your receipt","html":"<p>Thanks for your order.</p>"}'`,
  },
];

function hl(code) {
  return escapeHtml(code)
    .replace(/(&quot;[^&\n]*?&quot;|'[^'\n]*')/g, '<span class="t-s">$1</span>')
    .replace(/(^|\s)(\/\/[^\n]*|# [^\n]*|#\s[^\n]*)/gm, '$1<span class="t-c">$2</span>');
}

function sdkTabs() {
  return `<div class="tabs" data-tabs>
    <div class="tabs__list" role="tablist" aria-label="SDK language">
      ${SDK.map((s, i) => `<button type="button" role="tab" id="tab-${s.id}" aria-controls="panel-${s.id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${s.label}</button>`).join('')}
    </div>
    ${SDK.map(
      (s, i) => `<div class="code tabs__panel" role="tabpanel" id="panel-${s.id}" aria-labelledby="tab-${s.id}" tabindex="0"${i === 0 ? '' : ' hidden'}>
        <div class="code__head"><span class="code__label">${s.label}</span><button type="button" class="copy" data-copy hidden>Copy</button></div>
        <pre><code>${hl(s.code)}</code></pre></div>`,
    ).join('')}
  </div>`;
}

// ---------------------------------------------------------------- sections
function hero() {
  return `<section class="hero" aria-labelledby="hero-title">
  <div class="hero__copy">
    <h1 id="hero-title" class="display">Own your email.<br>One command.</h1>
    <p class="lede">5050 Mail is a Gmail-style webmail and admin console for your own domains, plus 5050 Send, an email API that speaks Resend's. Both install on one Linux VM, and both are open source.</p>
    <div class="cmd" data-reveal>
      <code tabindex="0">${escapeHtml(SITE.install)}</code>
      ${copyBtn(SITE.install)}
    </div>
    <p class="hero__links"><a href="/docs/quickstart/">Read the quickstart</a><a href="${SITE.repo}" rel="noopener">Source on GitHub</a></p>
    <ul class="hero__facts" aria-label="At a glance">
      <li>Ubuntu 24.04 or Debian 12</li><li>2 vCPU and 4 GB RAM to start</li><li>Any number of domains and mailboxes</li><li>AGPL-3.0</li>
    </ul>
  </div>
  <div class="hero__stage" aria-hidden="true">
    <div class="plate plate-a"></div>
    <div class="plate plate-b"></div>
    <div class="hero__ui">${inboxFragment()}</div>
  </div>
</section>`;
}

function demo({ hasDemo, hasPoster, hasMp4, hasWebm }) {
  if (!hasDemo) return '<!-- Demo video slot: drop demo.mp4 (and poster.jpg) into site/public/demo/ and rebuild. -->';
  return `<section class="demo" aria-labelledby="demo-title" data-demo>
  <div class="wrap demo__inner">
    <h2 id="demo-title" class="h2">Watch it run</h2>
    <p class="demo__note">A recording of a fresh install: the webmail, the admin console adding a domain and a user, and an email sent through 5050 Send.</p>
    <figure class="demo__figure">
      <video controls muted playsinline preload="metadata" width="1920" height="1080"${hasPoster ? ' poster="/demo/poster.jpg"' : ''}>
        ${hasWebm ? '<source src="/demo/demo.webm" type="video/webm">' : ''}
        ${hasMp4 ? '<source src="/demo/demo.mp4" type="video/mp4">' : ''}
      </video>
      <figcaption>Recorded on a test install with example data.</figcaption>
    </figure>
  </div>
</section>`;
}

function showcase() {
  return `<section class="showcase" data-switch-field data-mode="mail" aria-labelledby="showcase-title">
  <div class="wrap showcase__inner">
    <div class="showcase__copy">
      <h2 id="showcase-title" class="h2">Email for your <span data-word>team</span></h2>
      <p class="showcase__lede">The 5050 mark is two inks that overlap. So is the product: mail for the people on your team, and an API for the code in your apps, sharing one machine and one database.</p>
      <div class="seg" role="tablist" aria-label="Product">
        <button type="button" role="tab" id="seg-mail" aria-controls="seg-panel-mail" aria-selected="true" data-mode-btn="mail" data-word-value="team">Mail</button>
        <button type="button" role="tab" id="seg-send" aria-controls="seg-panel-send" aria-selected="false" tabindex="-1" data-mode-btn="send" data-word-value="code">Send</button>
      </div>
    </div>
    <div class="showcase__panels">
      <div class="seg-panel" role="tabpanel" id="seg-panel-mail" aria-labelledby="seg-mail">
        <h3>5050 Mail, for people</h3>
        <ul class="ticks">
          <li>Inbox with Primary, Promotions, Social and Updates tabs, threads, stars, labels and snooze.</li>
          <li>Compose with attachments, schedule send and undo send, plus Gmail's keyboard shortcuts.</li>
          <li>Light and dark themes, three densities, and a reading pane beside or below the list.</li>
          <li>IMAP and SMTP for Apple Mail, Outlook, Thunderbird and phones.</li>
          <li>Admin console: domains, users, aliases, groups, mailing lists, roles and storage limits.</li>
        </ul>
        <p><a href="/docs/webmail/">Webmail guide</a> · <a href="/docs/admin-console/">Admin console</a></p>
      </div>
      <div class="seg-panel" role="tabpanel" id="seg-panel-send" aria-labelledby="seg-send" data-js-hidden>
        <h3>5050 Send, for code</h3>
        <ul class="ticks">
          <li>Resend's REST API: emails, batch, scheduling, domains, API keys, contacts, broadcasts, templates.</li>
          <li>The official Resend SDKs work after you change the base URL.</li>
          <li>SMTP relay with your API key as the password, for apps that only speak SMTP.</li>
          <li>Webhooks with Svix signatures, retries and replay.</li>
          <li>Dashboard with logs, metrics, suppressions and team quotas.</li>
        </ul>
        <p><a href="/docs/send-api/">Send API</a> · <a href="/docs/webhooks/">Webhooks</a></p>
      </div>
    </div>
  </div>
</section>`;
}

function admin() {
  return `<section class="admin" aria-labelledby="admin-title">
  <div class="wrap admin__grid">
    <div class="admin__copy" data-reveal>
      <h2 id="admin-title" class="h2">Your domains, done properly</h2>
      <p>Add a domain and 5050 Mail creates its DKIM keys (Ed25519 and RSA, rotated for you), its SPF, DMARC and TLS-reporting records, and its certificate.</p>
      <p>With a Cloudflare token it publishes every record itself. Without one, it shows the exact records with a copy button each, and a zone file for the lot.</p>
      <p><a href="/docs/dns/">Every record, explained</a></p>
    </div>
    <div class="admin__ui" data-reveal>${dnsFragment()}</div>
  </div>
</section>`;
}

function send() {
  return `<section class="send" id="send" aria-labelledby="send-title">
  <div class="wrap send__grid">
    <div class="send__copy" data-reveal>
      <h2 id="send-title" class="h2">Keep your Resend code</h2>
      <p>5050 Send answers on the same paths, with the same fields, errors, status codes, rate-limit headers and pagination. Point the SDK at your server and use a key from your dashboard.</p>
      <p class="send__fine">Node.js and Python are covered by contract tests that run every SDK method against the server. Go, PHP and Ruby overrides are taken from those SDKs' source.</p>
      <p><a href="/docs/send-api/">All endpoints and SDKs</a></p>
      <div class="send__logs" data-reveal>${logsFragment()}</div>
    </div>
    <div class="send__code" data-reveal>${sdkTabs()}</div>
  </div>
</section>`;
}

const REASONS = [
  {
    s: 'Add people without adding cost.',
    c: 'There is no per-user price. A mailbox costs disk space, nothing else. The math is in the next section.',
    on: true,
  },
  {
    s: 'Your mail stays on your disk.',
    c: 'Mail, accounts and API logs live in Postgres on your VM. Nobody else hosts, scans or mines it, and you can take it anywhere over IMAP.',
    on: true,
  },
  {
    s: 'The whole thing is AGPL.',
    c: 'Webmail, admin, Send and the installer are AGPL-3.0, and the mail server underneath, Stalwart, is AGPL too. Read it, change it, run it for any purpose.',
  },
  {
    s: 'Every core does work.',
    c: 'The Node services start one process per CPU core, and Stalwart is multi-threaded. A bigger VM is used fully, with no tuning.',
  },
  {
    s: 'DNS in one click, or by hand.',
    c: 'Give it a Cloudflare token and it publishes records and gets certificates. Use any other DNS host and it prints exactly what to add.',
  },
];

function reasons() {
  return `<section class="reasons" aria-labelledby="reasons-title">
  <h2 id="reasons-title" class="visually-hidden">Why run it yourself</h2>
  <ul class="bands">
    ${REASONS.map(
      (r, i) => `<li class="band${r.on ? ' is-on' : ''}" data-band data-reveal>
        <div class="wrap band__inner">
          <p class="band__s" id="band-${i}">${escapeHtml(r.s)}</p>
          <button type="button" class="switch" role="switch" aria-checked="${r.on ? 'true' : 'false'}" aria-labelledby="band-${i}" aria-controls="band-c-${i}"><span></span></button>
          <p class="band__c" id="band-c-${i}">${escapeHtml(r.c)}</p>
        </div>
      </li>`,
    ).join('')}
  </ul>
</section>`;
}

function cost() {
  const ws = WORKSPACE.map((w) => `<li data-plan="${w.id}" data-price="${w.annual}" data-reveal>
      <span class="bar__label">Google Workspace ${w.name.replace('Business ', '')}<small>$${w.annual} per user a month, annual plan</small></span>
      <span class="bar__track"><span class="bar__fill bar__fill--ws"></span></span>
      <span class="bar__value" data-value>$${(w.annual * 12 * 25).toLocaleString('en-US')}</span>
    </li>`).join('');
  return `<section class="cost" id="cost" aria-labelledby="cost-title">
  <div class="wrap">
    <div class="cost__head">
      <h2 id="cost-title" class="h2" data-reveal>What a year of email costs</h2>
      <div class="cost__control">
        <label for="team">People on your team: <output id="team-out" for="team">25</output></label>
        <input id="team" type="range" min="1" max="300" value="25" step="1">
      </div>
    </div>
    <ul class="bars" data-bars aria-live="polite">
      ${ws}
      <li data-self data-reveal>
        <span class="bar__label">5050 Mail on one VM<small data-vm-note>${VM_SMALL.name}, ${VM_SMALL.spec}, $${VM_SMALL.price} a month</small></span>
        <span class="bar__track"><span class="bar__fill bar__fill--self"></span></span>
        <span class="bar__value" data-value>$${VM_SMALL.price * 12}</span>
      </li>
    </ul>
    <div class="cost__notes">
      <p>Yearly totals. Workspace bills per user: $${WORKSPACE[0].annual}, $${WORKSPACE[1].annual} or $${WORKSPACE[2].annual} a month on an annual plan, $${WORKSPACE[0].flexible.toFixed(2)}, $${WORKSPACE[1].flexible.toFixed(2)} or $${WORKSPACE[2].flexible.toFixed(2)} on the flexible plan. The VM bill is flat: we assume the $${VM_SMALL.price} ${VM_SMALL.name} plan up to 50 people and the $${VM_LARGE.price} ${VM_LARGE.name} plan (${VM_LARGE.spec}) above that. Any provider with similar specs works.</p>
      <p>What the VM price leaves out: Workspace includes ${WORKSPACE[0].storage} on Starter, plus Docs, Drive, Meet and Google's support. On your own server, mail storage is the VM's disk, and the admin work is yours. Backups and upgrades take a few commands; the <a href="/docs/backups-upgrades/">docs</a> show them.</p>
    </div>

    <h3 class="cost__sub">Sending from code</h3>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Resend prices compared with 5050 Send">
      <table class="price-table">
        <thead><tr><th scope="col">Emails a month</th><th scope="col">Resend plan</th><th scope="col">Resend price a month</th></tr></thead>
        <tbody>${RESEND.map((r) => `<tr><td>${r.emails}</td><td>${r.plan}</td><td>${r.price}</td></tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="cost__notes"><strong>5050 Send has no per-email price: it runs on the same VM as your mail.</strong> Resend also charges for overage above each tier and sells marketing plans by contact count. 5050 Send has no tiers, but high volumes from a new IP need a warm-up period, and at scale you may want a bigger VM or a paid relay for outbound mail.</p>
    <p class="cost__src">Prices in US dollars before tax, checked on ${PRICES_CHECKED} from <a href="${SOURCES.workspace}" rel="noopener">Google's Business editions page</a>, <a href="${SOURCES.resend}" rel="noopener">Resend's pricing page</a> and <a href="${SOURCES.akamai}" rel="noopener">Akamai Cloud's CPU pricing</a>. They change; check before you decide.</p>
  </div>
</section>`;
}

function flow() {
  const clauses = ['First the API takes it.', 'Then Send signs it.', 'Then it lands.', 'Then your app hears.'];
  return `<section class="flow" aria-labelledby="flow-title">
  <h2 id="flow-title" class="h2 flow__title" data-reveal>One email, start to finish</h2>
  <ol class="flow__fields">
    ${clauses.map((c, i) => `<li class="flow__field flow__field--${i}" data-reveal>${emailCard(i)}<p class="flow__clause">${c}</p></li>`).join('')}
  </ol>
  <div class="wrap"><p class="flow__note">5050 Send signs each message with your domain's own DKIM key and hands it to your mail server on an internal port, which delivers it on port 25 or through your relay. Delivery events come back as signed webhooks. <a href="/docs/webhooks/">How webhooks work</a></p></div>
</section>`;
}

const FAQ = [
  { tab: 'Cloudflare', q: 'Do I need Cloudflare?', a: 'No. With a Cloudflare API token, DNS records, DKIM and certificates are set up for you. Without one, the installer and the admin console show the exact records to add at any DNS host.' },
  { tab: 'Port 25', q: 'My cloud blocks port 25. Now what?', a: 'Receiving still works. For sending, ask the provider to lift the block, or set any SMTP relay (Amazon SES, Postmark, Mailgun, Cloudflare Email Service and others) in .env and re-run the installer.' },
  { tab: 'Inbox', q: 'Will my mail land in the inbox?', a: 'With SPF, DKIM, DMARC and reverse DNS in place and a clean IP, business mail usually does. A new IP has no reputation yet, so start with normal mail before bulk sends. The troubleshooting page has the checklist.' },
  { tab: 'Moving', q: 'Can I bring my old mail?', a: 'There is no built-in migration yet. Any IMAP copy tool, such as imapsync, copies each mailbox from your old provider. Copy, switch the MX record, then copy again.' },
  { tab: 'Licence', q: 'What does AGPL ask of me?', a: 'Nothing, if you run it unmodified for your own mail. If you change it and let others use your version over a network, offer them its source under the same licence.' },
];

function faq() {
  return `<section class="faq" aria-labelledby="faq-title">
  <div class="wrap faq__inner">
    <h2 id="faq-title" class="h2" data-reveal>Before you install</h2>
    <div class="cards" data-cards>
      ${FAQ.map(
        (f, i) => `<div class="card card--${i % 3}" style="--i:${i}" data-reveal>
          <h3 class="card__q"><button type="button" aria-expanded="${i === 0}" aria-controls="faq-a-${i}" id="faq-q-${i}"><span class="card__tab">${f.tab}</span><span class="card__text">${escapeHtml(f.q)}</span></button></h3>
          <div class="card__a" id="faq-a-${i}" role="region" aria-labelledby="faq-q-${i}"${i === 0 ? '' : ' data-collapsed'}><p>${escapeHtml(f.a)}</p></div>
        </div>`,
      ).join('')}
    </div>
    <p class="faq__more"><a href="/docs/faq/">More questions in the docs</a></p>
  </div>
</section>`;
}

function cta() {
  return `<section class="cta" aria-labelledby="cta-title">
  <div class="wrap cta__grid">
    <div class="cta__copy">
      <h2 id="cta-title" class="display display--cta">Start on your server</h2>
      <p>Fill in your domain, copy the command, paste it into an SSH session on a fresh Ubuntu 24.04 or Debian 12 VM. The installer asks for anything missing.</p>
    </div>
    <form class="dialog" data-ui data-builder aria-labelledby="builder-title" onsubmit="return false">
      <p class="dialog__title" id="builder-title">Install 5050 Mail</p>
      <label class="field"><span>Your mail domain</span>
        <input name="domain" type="text" value="example.com" inputmode="url" autocomplete="off" spellcheck="false" aria-describedby="domain-hint">
      </label>
      <p class="field__hint" id="domain-hint">Mail will live at mail.<b data-domain-echo>example.com</b></p>
      <fieldset class="choice">
        <legend>DNS records</legend>
        <label><input type="radio" name="dns" value="manual" checked><span>I'll add them</span></label>
        <label><input type="radio" name="dns" value="cloudflare"><span>Cloudflare token</span></label>
      </fieldset>
      <div class="cmd cmd--block"><code data-builder-out tabindex="0">${escapeHtml(SITE.install)}</code></div>
      <button type="button" class="btn btn--block" data-builder-copy>Copy install command</button>
      <p class="dialog__status" role="status" aria-live="polite"></p>
    </form>
  </div>
</section>`;
}

function footer() {
  return `<footer class="site-footer">
  <div class="wrap">
    <div class="footer__mark">${mark({ cls: 'mark mark--xl' })}</div>
    <div class="footer__cols">
      <nav aria-label="Start"><p>Start</p><ul>
        <li><a href="/docs/quickstart/">Quickstart</a></li><li><a href="/docs/requirements/">Requirements</a></li><li><a href="/docs/dns/">DNS and domains</a></li></ul></nav>
      <nav aria-label="Products"><p>Use</p><ul>
        <li><a href="/docs/webmail/">Webmail</a></li><li><a href="/docs/admin-console/">Admin console</a></li><li><a href="/docs/send-api/">Send API</a></li></ul></nav>
      <nav aria-label="Operate"><p>Operate</p><ul>
        <li><a href="/docs/backups-upgrades/">Backups and upgrades</a></li><li><a href="/docs/security/">Security</a></li><li><a href="/docs/troubleshooting/">Troubleshooting</a></li></ul></nav>
      <nav aria-label="Project"><p>Project</p><ul>
        <li><a href="${SITE.repo}" rel="noopener">GitHub</a></li><li><a href="${SITE.repo}/blob/main/LICENSE" rel="noopener">AGPL-3.0 licence</a></li><li><a href="${SITE.repo}/issues" rel="noopener">Issues</a></li></ul></nav>
    </div>
    <div class="footer__base">
      <p>5050 Mail is open source under the AGPL-3.0. Built on <a href="https://stalw.art" rel="noopener">Stalwart</a>. Not affiliated with Google or Resend.</p>
      <button type="button" class="btn btn--ghost btn--small" data-theme-toggle>Switch theme</button>
    </div>
  </div>
</footer>`;
}

export function renderLanding(opts) {
  return `${head({
    title: SITE.name,
    description: 'Self-hosted business email for your own domains: Gmail-style webmail, an admin console and a Resend-compatible email API, on one VM with one command. Open source, AGPL-3.0.',
    path: '/',
    extraCss: ['landing.css'],
  })}
<body class="landing">
${siteHeader()}
<main id="main">
${hero()}
${demo(opts)}
${showcase()}
${admin()}
${send()}
${reasons()}
${cost()}
${flow()}
${faq()}
${cta()}
</main>
${footer()}
<script>window.__COST=${JSON.stringify({ ws: WORKSPACE.map((w) => w.annual), small: VM_SMALL.price, large: VM_LARGE.price, smallName: `${VM_SMALL.name}, ${VM_SMALL.spec}`, largeName: `${VM_LARGE.name}, ${VM_LARGE.spec}` })}</script>
<script src="/assets/site.js" defer></script>
<script src="/assets/landing.js" defer></script>
</body>
</html>`;
}
