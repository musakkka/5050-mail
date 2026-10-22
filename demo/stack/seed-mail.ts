/**
 * Seed a throw-away Stalwart with a small, curated, entirely fictional mailbox for the demo video.
 * Every address is on acme.test or an .example domain. Nothing here is real data.
 *
 *   STALWART_URL=http://localhost:18190 STALWART_ADMIN=admin:devpass123 npx tsx demo/stack/seed-mail.ts
 *
 * Creates (if missing) the users below, wipes their mail and imports the threads, then prints READY.
 */
const STALWART = (process.env.STALWART_URL ?? 'http://localhost:18190').replace(/\/$/, '');
const ADMIN = process.env.STALWART_ADMIN ?? 'admin:devpass123';
const DOMAIN = process.env.DEMO_DOMAIN ?? 'acme.test';

export const USERS = [
  { name: 'maya', description: 'Maya Chen', password: 'Demo-Maya-Lantern-2026', admin: true },
  { name: 'jordan', description: 'Jordan Lee', password: 'Demo-Jordan-Granite-2026', admin: false },
  { name: 'priya', description: 'Priya Nair', password: 'Demo-Priya-Orchid-2026', admin: false },
];

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
type Call = [string, Record<string, unknown>, string];
async function jmap(auth: string, using: string[], calls: Call[]): Promise<Call[]> {
  const res = await fetch(`${STALWART}/jmap/`, {
    method: 'POST',
    headers: { Authorization: `Basic ${b64(auth)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', ...using], methodCalls: calls }),
  });
  if (!res.ok) throw new Error(`JMAP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { methodResponses: Call[] };
  for (const r of json.methodResponses) if (r[0] === 'error') throw new Error(`JMAP error: ${JSON.stringify(r[1])}`);
  return json.methodResponses;
}
const MAIL = ['urn:ietf:params:jmap:mail'];
const ADMINCAP = ['urn:stalwart:jmap'];

async function ensureUsers() {
  const [[, dq]] = await jmap(ADMIN, ADMINCAP, [['x:Domain/query', {}, '0']]);
  const [[, dg]] = await jmap(ADMIN, ADMINCAP, [['x:Domain/get', { ids: dq.ids }, '0']]);
  const domain = (dg.list as { id: string; name: string }[]).find((d) => d.name === DOMAIN);
  if (!domain) throw new Error(`domain ${DOMAIN} not found (bootstrap Stalwart with defaultDomain ${DOMAIN})`);
  const [[, aq]] = await jmap(ADMIN, ADMINCAP, [['x:Account/query', {}, '0']]);
  const [[, ag]] = await jmap(ADMIN, ADMINCAP, [['x:Account/get', { ids: aq.ids, properties: ['name'] }, '0']]);
  const existing = new Set((ag.list as { name: string }[]).map((a) => a.name));
  const create: Record<string, unknown> = {};
  for (const u of USERS) {
    if (existing.has(u.name) || existing.has(`${u.name}@${DOMAIN}`)) continue;
    create[u.name] = {
      '@type': 'User',
      name: u.name,
      domainId: domain.id,
      description: u.description,
      credentials: { '0': { '@type': 'Password', secret: u.password } },
      ...(u.admin ? { roles: { '@type': 'Admin' } } : {}),
    };
  }
  if (Object.keys(create).length) {
    const [[, r]] = await jmap(ADMIN, ADMINCAP, [['x:Account/set', { create }, '0']]);
    if (r.notCreated) throw new Error(`could not create users: ${JSON.stringify(r.notCreated)}`);
  }
}

// ---------------------------------------------------------------- content
interface Person { name: string; email: string }
interface Msg {
  from: Person; to: Person[]; cc?: Person[]; subject: string; date: Date; text: string; html?: string;
  messageId: string; inReplyTo?: string; references?: string[]; listUnsubscribe?: string;
  attachments?: { filename: string; type: string; data: Buffer }[];
}
const addr = (p: Person) => `"${p.name}" <${p.email}>`;
const encWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const wrap76 = (s: string) => s.replace(/.{1,76}/g, '$&\r\n').trimEnd();
let bn = 0;
function mime(m: Msg): Buffer {
  const h = [
    `From: ${addr(m.from)}`,
    `To: ${m.to.map(addr).join(', ')}`,
    ...(m.cc?.length ? [`Cc: ${m.cc.map(addr).join(', ')}`] : []),
    `Subject: ${encWord(m.subject)}`,
    `Date: ${m.date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${m.messageId}>`,
    ...(m.inReplyTo ? [`In-Reply-To: <${m.inReplyTo}>`] : []),
    ...(m.references?.length ? [`References: ${m.references.map((r) => `<${r}>`).join(' ')}`] : []),
    ...(m.listUnsubscribe ? [`List-Unsubscribe: <${m.listUnsubscribe}>`] : []),
    'MIME-Version: 1.0',
  ];
  const text = `Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(m.text))}`;
  let body = text;
  if (m.html) {
    const b = `=_demo_${++bn}`;
    body = `Content-Type: multipart/alternative; boundary="${b}"\r\n\r\n--${b}\r\n${text}\r\n--${b}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(m.html))}\r\n--${b}--`;
  }
  if (m.attachments?.length) {
    const b = `=_demo_${++bn}`;
    body = `Content-Type: multipart/mixed; boundary="${b}"\r\n\r\n--${b}\r\n${body}\r\n${m.attachments
      .map((a) => `--${b}\r\nContent-Type: ${a.type}; name="${a.filename}"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${a.filename}"\r\n\r\n${wrap76(b64(a.data))}\r\n`)
      .join('')}--${b}--`;
  }
  return Buffer.from(`${h.join('\r\n')}\r\n${body}\r\n`, 'utf8');
}
function pdf(title: string, lines: string[]): Buffer {
  const t = [title, '', ...lines].map((l, i) => `BT /F1 ${i === 0 ? 18 : 11} Tf 56 ${760 - i * 18} Td (${l.replace(/[()\\]/g, '')}) Tj ET`).join('\n');
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${t.length} >>\nstream\n${t}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n';
  const off: number[] = [];
  objs.forEach((o, i) => { off.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${off.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const ME: Person = { name: 'Maya Chen', email: `maya@${DOMAIN}` };
const JORDAN: Person = { name: 'Jordan Lee', email: `jordan@${DOMAIN}` };
const PRIYA: Person = { name: 'Priya Nair', email: `priya@${DOMAIN}` };
const P = {
  sam: { name: 'Sam Rivera', email: 'sam@northwind.example' },
  elena: { name: 'Elena Garcia', email: 'elena@lumen-studio.example' },
  theo: { name: 'Theo Becker', email: 'theo@becker-legal.example' },
  aiko: { name: 'Aiko Tanaka', email: 'aiko@kumo.example' },
  noah: { name: 'Noah Williams', email: 'noah@fieldnotes.example' },
  grace: { name: 'Grace Okafor', email: 'grace@okafor-design.example' },
  lucas: { name: 'Lucas Martin', email: 'lucas@harbor-ventures.example' },
} satisfies Record<string, Person>;

interface Thread {
  subject: string; label?: string[]; starred?: boolean; important?: boolean; unread?: boolean; cat?: string;
  hoursAgo: number; msgs: { from: Person; to?: Person[]; cc?: Person[]; body: string[]; gapH?: number }[];
  attach?: { filename: string; lines: string[] };
  html?: (body: string[]) => string;
}

const THREADS: Thread[] = [
  {
    subject: 'Launch plan for the new pricing page', label: ['Work'], important: true, unread: true, hoursAgo: 0.4,
    msgs: [
      { from: PRIYA, cc: [JORDAN], body: ['Here is the launch plan for Thursday.', 'Copy is final, design signed off this morning, and the announcement email is queued for 9:00.', 'Can you give it a last read before lunch?'] },
    ],
    attach: { filename: 'pricing-launch-plan.pdf', lines: ['Thursday 09:00  announcement email', 'Thursday 10:00  pricing page live', 'Friday         follow-up with early customers'] },
  },
  {
    subject: 'Q4 roadmap review', label: ['Work'], starred: true, hoursAgo: 1.2,
    msgs: [
      { from: JORDAN, body: ['Can we move the roadmap review to Thursday at 2pm?', 'I added the open questions to the doc.'] },
      { from: ME, to: [JORDAN], body: ['Thursday works. I will bring the usage numbers.'], gapH: 0.5 },
      { from: JORDAN, body: ['Perfect, see you then.'], gapH: 0.4 },
    ],
  },
  {
    subject: 'Contract renewal: Northwind', label: ['Clients'], important: true, unread: true, hoursAgo: 2.1,
    msgs: [{ from: P.sam, body: ['Our contract is up for renewal at the end of the month.', 'I attached the redlined version; the main change is the SLA section.', 'Happy to jump on a call this week.'] }],
    attach: { filename: 'northwind-renewal.pdf', lines: ['Term: 12 months', 'SLA: 99.95% monthly uptime', 'Support: next business day'] },
  },
  {
    subject: 'Homepage illustrations, round 2', label: ['Work'], unread: true, hoursAgo: 3.4,
    msgs: [{ from: P.elena, body: ['Round two of the homepage illustrations is ready.', 'I pushed the palette closer to lime and aqua and simplified the hero.', 'Let me know which direction you prefer.'] }],
  },
  {
    subject: 'Invoice INV-1042 for October', label: ['Receipts'], hoursAgo: 5,
    msgs: [{ from: P.grace, body: ['Please find the invoice for October attached.', 'Payment terms are net 30 as usual. Thank you!'] }],
    attach: { filename: 'INV-1042.pdf', lines: ['Brand refresh, October', 'Total: $4,800.00', 'Due: net 30'] },
  },
  {
    subject: 'Offsite in Lisbon: itinerary', label: ['Travel'], hoursAgo: 7,
    msgs: [
      { from: P.aiko, body: ['Draft itinerary for the Lisbon offsite is attached.', 'Flights land at 10:40 on the 14th, hotel is in Alfama.'] },
      { from: ME, to: [P.aiko], body: ['Looks great. Can we add a half day for the workshop?'], gapH: 1 },
      { from: P.aiko, body: ['Done, moved the river tour to Saturday.'], gapH: 1.2 },
    ],
  },
  {
    subject: 'Weekly metrics: 18% more signups', label: ['Work'], hoursAgo: 20, cat: 'updates',
    msgs: [{ from: JORDAN, body: ['Signups are up 18% week over week.', 'Activation held steady at 41%. Full dashboard in the doc.'] }],
  },
  {
    subject: 'Intro: Lucas from Harbor Ventures', hoursAgo: 26, important: true,
    msgs: [
      { from: P.noah, to: [ME], cc: [P.lucas], body: ['Maya, meet Lucas. Lucas, meet Maya.', 'I think you two should talk about the developer platform.'] },
      { from: P.lucas, to: [ME], body: ['Thanks Noah! Maya, do you have 30 minutes next week?'], gapH: 2 },
    ],
  },
  {
    subject: 'Security review notes', label: ['Work'], hoursAgo: 30,
    msgs: [{ from: PRIYA, body: ['Notes from the security review are below.', 'Action items: rotate API keys quarterly, enable 2FA for admins, document the webhook signing secret.'] }],
  },
  {
    subject: 'Lunch on Friday?', hoursAgo: 44,
    msgs: [
      { from: P.theo, body: ['Are you free for lunch on Friday? There is a new ramen place near the office.'] },
      { from: ME, to: [P.theo], body: ['Yes! 12:30?'], gapH: 1 },
    ],
  },
  {
    subject: 'Customer interview recap', label: ['Clients'], hoursAgo: 52,
    msgs: [{ from: P.elena, body: ['Recap of the three customer interviews from this week.', 'Top request: scheduled sending and shared inboxes.'] }],
  },
  {
    subject: 'Your order has shipped', hoursAgo: 60, cat: 'updates',
    msgs: [{ from: { name: 'Parcel Point', email: 'tracking@parcelpoint.example' }, body: ['Your order #88213 is on its way.', 'Estimated delivery: Thursday.'] }],
  },
  {
    subject: 'Hiring: senior frontend engineer', label: ['Work'], hoursAgo: 75,
    msgs: [{ from: JORDAN, body: ['We opened the senior frontend role today.', 'If you know anyone great, send them my way.'] }],
  },
  {
    subject: 'Board deck draft', label: ['Work'], hoursAgo: 96, starred: true,
    msgs: [{ from: P.lucas, body: ['Sharing an early draft of the board deck.', 'Comments in the margin are fine.'] }],
  },
  {
    subject: 'Design system tokens v2', label: ['Work'], hoursAgo: 120,
    msgs: [{ from: P.grace, body: ['Tokens v2 are published.', 'Spacing scale and colour ramps are updated.'] }],
  },
  {
    subject: 'Receipt for your coffee subscription', label: ['Receipts'], hoursAgo: 140, cat: 'updates',
    msgs: [{ from: { name: 'Bean Box', email: 'hello@beanbox.example' }, body: ['Thanks for your order. Your next bag ships Monday.'] }],
  },
  {
    subject: 'Up to 40% off fall jackets', hoursAgo: 8, cat: 'promotions', unread: true,
    msgs: [{ from: { name: 'Brightside Outfitters', email: 'deals@brightside.example' }, body: ['Fall sale: up to 40% off jackets this weekend.'] }],
  },
  {
    subject: 'Aiko mentioned you in a post', hoursAgo: 9, cat: 'social', unread: true,
    msgs: [{ from: { name: 'Connectly', email: 'notifications@connectly.example' }, body: ['Aiko Tanaka mentioned you in a post.'] }],
  },
];

async function seedAccount() {
  const u = USERS[0]!;
  const auth = `${u.name}@${DOMAIN}:${u.password}`;
  const s = await fetch(`${STALWART}/jmap/session`, { headers: { Authorization: `Basic ${b64(auth)}` } });
  if (!s.ok) throw new Error(`login failed ${s.status}`);
  const accountId = ((await s.json()) as { primaryAccounts: Record<string, string> }).primaryAccounts['urn:ietf:params:jmap:mail']!;

  // wipe
  const [[, q]] = await jmap(auth, MAIL, [['Email/query', { accountId, limit: 5000 }, '0']]);
  if ((q.ids as string[]).length) await jmap(auth, MAIL, [['Email/set', { accountId, destroy: q.ids }, '0']]);
  const [[, mb0]] = await jmap(auth, MAIL, [['Mailbox/get', { accountId }, '0']]);
  const custom = (mb0.list as { id: string; role: string | null }[]).filter((m) => !m.role);
  if (custom.length) await jmap(auth, MAIL, [['Mailbox/set', { accountId, destroy: custom.map((m) => m.id), onDestroyRemoveEmails: true }, '0']]);

  // mailboxes
  const [[, mb]] = await jmap(auth, MAIL, [['Mailbox/get', { accountId }, '0']]);
  const ids = new Map<string, string>();
  for (const m of mb.list as { id: string; role: string | null; name: string }[]) ids.set(m.role ?? m.name, m.id);
  const want = ['Clients', 'Receipts', 'Travel', 'Work'];
  const create: Record<string, unknown> = {};
  for (const r of ['archive', 'snoozed', 'scheduled']) if (!ids.has(r)) create[r] = { name: r[0]!.toUpperCase() + r.slice(1), role: r };
  for (const n of want) create[n] = { name: n };
  const [[, r]] = await jmap(auth, MAIL, [['Mailbox/set', { accountId, create }, '0']]);
  for (const [k, v] of Object.entries((r.created ?? {}) as Record<string, { id: string }>)) ids.set(k, v.id);

  const now = Date.now();
  let n = 0;
  const emails: Record<string, unknown> = {};
  const uploads: Promise<void>[] = [];
  for (const t of THREADS) {
    const refs: string[] = [];
    let at = now - t.hoursAgo * 3600_000;
    // the thread's newest message lands at `hoursAgo`; earlier ones before it
    const total = t.msgs.reduce((a, m) => a + (m.gapH ?? 0), 0);
    at -= total * 3600_000;
    t.msgs.forEach((m, i) => {
      at += (m.gapH ?? 0) * 3600_000;
      const mine = m.from === ME;
      const id = `demo.${++n}.${now.toString(36)}@${m.from.email.split('@')[1]}`;
      const first = (mine ? (m.to?.[0] ?? JORDAN) : ME).name.split(' ')[0];
      const text = `Hi ${first},\n\n${m.body.join('\n\n')}\n\n${m.from.name.split(' ')[0]}`;
      const html = `<div dir="ltr"><p>Hi ${first},</p>${m.body.map((l) => `<p>${l}</p>`).join('')}<p>${m.from.name.split(' ')[0]}</p></div>`;
      const msg: Msg = {
        from: m.from, to: m.to ?? (mine ? [JORDAN] : [ME]), cc: m.cc,
        subject: i === 0 ? t.subject : `Re: ${t.subject}`, date: new Date(at), text, html, messageId: id,
        inReplyTo: refs.at(-1), references: refs.length ? [...refs] : undefined,
        attachments: i === 0 && t.attach ? [{ filename: t.attach.filename, type: 'application/pdf', data: pdf(t.subject, t.attach.lines) }] : undefined,
        listUnsubscribe: t.cat && t.cat !== 'updates' ? 'https://example.com/unsubscribe' : undefined,
      };
      refs.push(id);
      const last = i === t.msgs.length - 1;
      const kw: Record<string, boolean> = {};
      if (!(t.unread && last && !mine)) kw.$seen = true;
      if (t.important && !mine) kw.$important = true;
      if (t.starred && last) kw.$flagged = true;
      if (t.cat) kw[`$ff_cat_${t.cat}`] = true;
      const boxes: Record<string, boolean> = { [ids.get(mine ? 'sent' : 'inbox')!]: true };
      for (const l of t.label ?? []) boxes[ids.get(l)!] = true;
      const key = `e${n}`;
      uploads.push(
        fetch(`${STALWART}/jmap/upload/${accountId}/`, {
          method: 'POST', headers: { Authorization: `Basic ${b64(auth)}`, 'Content-Type': 'message/rfc822' }, body: new Uint8Array(mime(msg)),
        }).then(async (res) => {
          if (!res.ok) throw new Error(`upload ${res.status}`);
          const { blobId } = (await res.json()) as { blobId: string };
          emails[key] = { blobId, mailboxIds: boxes, keywords: kw, receivedAt: msg.date.toISOString().replace(/\.\d+Z$/, 'Z') };
        }),
      );
    });
  }
  await Promise.all(uploads);
  const [[, ir]] = await jmap(auth, MAIL, [['Email/import', { accountId, emails }, '0']]);
  if (ir.notCreated) throw new Error(`not imported: ${JSON.stringify(ir.notCreated).slice(0, 400)}`);
  console.log(`imported ${Object.keys(ir.created as object).length} messages for ${ME.email}`);
}

/** Undo what a previous recording created: extra accounts and the domain added on camera. */
async function resetAdmin() {
  const [[, aq]] = await jmap(ADMIN, ADMINCAP, [['x:Account/query', {}, '0']]);
  const [[, ag]] = await jmap(ADMIN, ADMINCAP, [['x:Account/get', { ids: aq.ids, properties: ['name'] }, '0']]);
  const keep = new Set(USERS.flatMap((u) => [u.name, `${u.name}@${DOMAIN}`]));
  const extra = (ag.list as { id: string; name: string }[]).filter((a) => !keep.has(a.name) && a.name !== 'admin').map((a) => a.id);
  if (extra.length) await jmap(ADMIN, ADMINCAP, [['x:Account/set', { destroy: extra }, '0']]);
  const [[, dq]] = await jmap(ADMIN, ADMINCAP, [['x:Domain/query', {}, '0']]);
  const [[, dg]] = await jmap(ADMIN, ADMINCAP, [['x:Domain/get', { ids: dq.ids, properties: ['name'] }, '0']]);
  const doms = (dg.list as { id: string; name: string }[]).filter((d) => d.name !== DOMAIN).map((d) => d.id);
  if (doms.length) {
    for (const domainId of doms) {
      const [[, sq]] = await jmap(ADMIN, ADMINCAP, [['x:DkimSignature/query', { filter: { domainId } }, '0']]);
      if ((sq.ids as string[]).length) await jmap(ADMIN, ADMINCAP, [['x:DkimSignature/set', { destroy: sq.ids }, '0']]);
    }
    const [[, r]] = await jmap(ADMIN, ADMINCAP, [['x:Domain/set', { destroy: doms }, '0']]);
    if (r.notDestroyed) console.warn('domains not removed:', JSON.stringify(r.notDestroyed).slice(0, 300));
  }
  // automatic DNS needs a DnsServer: a TSIG stand-in on localhost (nothing listens, nothing leaves the box)
  const [[, ds]] = await jmap(ADMIN, ADMINCAP, [['x:DnsServer/get', { ids: null, properties: ['description'] }, '0']]);
  if (!(ds.list as unknown[]).length) {
    await jmap(ADMIN, ADMINCAP, [['x:DnsServer/set', { create: { d: {
      '@type': 'Tsig', description: 'Cloudflare', host: '127.0.0.1', port: 5399, keyName: 'demo',
      key: { '@type': 'Value', secret: 'ZGVtbw==' }, protocol: 'udp', tsigAlgorithm: 'hmac-sha512',
    } } }, '0']]);
  }
}

await ensureUsers();
await resetAdmin();
await seedAccount();
console.log('READY');
