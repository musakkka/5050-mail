/**
 * Seed a local Stalwart with realistic mail for development and e2e tests.
 *
 *   npm run seed                      # bootstrap users (if missing) + reset + import mail for alice
 *   npm run seed -- --no-reset        # add mail without wiping first
 *   npm run seed -- --users-only      # just ensure the dev users exist
 *   npm run seed -- --automation      # also add a dummy DNS server + ACME provider (admin console)
 *
 * Env:
 *   STALWART_URL     default http://localhost:18090
 *   STALWART_ADMIN   default admin:devpass123   (recovery admin, used to create users)
 *   SMTP_HOST/PORT   default localhost:2525     (a few messages are delivered over SMTP too)
 *
 * Output is deterministic (seeded PRNG) relative to "now".
 */
import { createConnection } from 'node:net';
import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';
import { CATEGORY_KEYWORDS, wakeKeyword } from '../client/src/mail/mapping.ts';

const STALWART = (process.env.STALWART_URL ?? 'http://localhost:18090').replace(/\/$/, '');
const ADMIN = process.env.STALWART_ADMIN ?? 'admin:devpass123';
const SMTP_HOST = process.env.SMTP_HOST ?? 'localhost';
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 2525);
const DOMAIN = process.env.SEED_DOMAIN ?? 'dev.test';
const args = new Set(process.argv.slice(2));

export const DEV_USERS = [
  { name: 'alice', description: 'Alice Example', password: 'Demo-Alice-Orchid-2026', admin: true },
  { name: 'bob', description: 'Bob Builder', password: 'Demo-Bob-Granite-2026', admin: false },
  { name: 'carol', description: 'Carol Danvers', password: 'Demo-Carol-Lantern-2026', admin: false },
];

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

// ---------------------------------------------------------------- JMAP helpers
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
  if (!domain) throw new Error(`domain ${DOMAIN} not found — bootstrap the server first (x:Bootstrap/set with defaultDomain "${DOMAIN}")`);
  const [[, aq]] = await jmap(ADMIN, ADMINCAP, [['x:Account/query', {}, '0']]);
  const [[, ag]] = await jmap(ADMIN, ADMINCAP, [['x:Account/get', { ids: aq.ids, properties: ['name', 'domainId'] }, '0']]);
  const existing = new Set((ag.list as { name: string }[]).map((a) => a.name));
  const create: Record<string, unknown> = {};
  for (const u of DEV_USERS) {
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
    console.log(`created users: ${Object.keys(create).join(', ')}`);
  } else console.log('dev users already exist');
}

// ---------------------------------------------------------------- PRNG
let seed = 0x5eed;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)]!;
const chance = (p: number) => rand() < p;

// ---------------------------------------------------------------- tiny files
function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      const shade = 0.75 + 0.25 * Math.sin((x + y) / 18);
      raw[o] = Math.round(rgb[0] * shade);
      raw[o + 1] = Math.round(rgb[1] * shade);
      raw[o + 2] = Math.round(rgb[2] * shade);
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function pdf(title: string, lines: string[]): Buffer {
  const text = [title, '', ...lines].map((l, i) => `BT /F1 ${i === 0 ? 18 : 11} Tf 56 ${760 - i * 18} Td (${l.replace(/[()\\]/g, '')}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ---------------------------------------------------------------- MIME
interface Person {
  name: string;
  email: string;
}
interface Attachment {
  filename: string;
  type: string;
  data: Buffer;
  cid?: string;
}
interface Msg {
  from: Person;
  to: Person[];
  cc?: Person[];
  subject: string;
  date: Date;
  text: string;
  html?: string;
  attachments?: Attachment[];
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  listUnsubscribe?: string;
}
const addr = (p: Person) => (p.name ? `"${p.name.replace(/"/g, '')}" <${p.email}>` : `<${p.email}>`);
const encWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const wrap76 = (s: string) => s.replace(/.{1,76}/g, '$&\r\n').trimEnd();
let boundaryN = 0;
const boundary = () => `=_ff_${(++boundaryN).toString(36)}_${Math.floor(rand() * 1e9).toString(36)}`;

function buildMime(m: Msg): Buffer {
  const headers = [
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
  const textPart = `Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(m.text))}`;
  let body: string;
  if (m.html) {
    const b = boundary();
    body = `Content-Type: multipart/alternative; boundary="${b}"\r\n\r\n--${b}\r\n${textPart}\r\n--${b}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(m.html))}\r\n--${b}--`;
  } else body = textPart;
  const inline = m.attachments?.filter((a) => a.cid) ?? [];
  const files = m.attachments?.filter((a) => !a.cid) ?? [];
  if (inline.length) {
    const b = boundary();
    body = `Content-Type: multipart/related; boundary="${b}"\r\n\r\n--${b}\r\n${body}\r\n${inline
      .map(
        (a) =>
          `--${b}\r\nContent-Type: ${a.type}; name="${a.filename}"\r\nContent-Transfer-Encoding: base64\r\nContent-ID: <${a.cid}>\r\nContent-Disposition: inline; filename="${a.filename}"\r\n\r\n${wrap76(b64(a.data))}\r\n`,
      )
      .join('')}--${b}--`;
  }
  if (files.length) {
    const b = boundary();
    body = `Content-Type: multipart/mixed; boundary="${b}"\r\n\r\n--${b}\r\n${body}\r\n${files
      .map(
        (a) =>
          `--${b}\r\nContent-Type: ${a.type}; name="${a.filename}"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${a.filename}"\r\n\r\n${wrap76(b64(a.data))}\r\n`,
      )
      .join('')}--${b}--`;
  }
  return Buffer.from(`${headers.join('\r\n')}\r\n${body}\r\n`, 'utf8');
}

// ---------------------------------------------------------------- content
const ME: Person = { name: 'Alice Example', email: `alice@${DOMAIN}` };
const BOB: Person = { name: 'Bob Builder', email: `bob@${DOMAIN}` };
const CAROL: Person = { name: 'Carol Danvers', email: `carol@${DOMAIN}` };
const PEOPLE: Person[] = [
  BOB,
  CAROL,
  { name: 'Dana Whitfield', email: 'dana@lumenlabs.example' },
  { name: 'Eitan Shah', email: 'eitan.shah@northwind.example' },
  { name: 'Fatima Okafor', email: 'fatima@okafor-design.example' },
  { name: 'Greg Lindqvist', email: 'greg@lindqvist.example' },
  { name: 'Hana Takahashi', email: 'hana.t@kumo.example' },
  { name: 'Ivan Petrov', email: 'ivan@petrov-consulting.example' },
  { name: 'Julia Romero', email: 'julia.romero@familymail.example' },
  { name: 'Kwame Mensah', email: 'kwame@mensah.example' },
];
const TOPICS = [
  {
    subject: 'Q4 roadmap review',
    lines: ['Can we move the roadmap review to Thursday?', 'I have a conflict on Wednesday afternoon.', 'I added the open questions to the doc.'],
  },
  { subject: 'Lunch next week?', lines: ['Are you free for lunch next Tuesday?', 'There is a new ramen place near the office.', 'Let me know what works.'] },
  {
    subject: 'Design review: onboarding flow',
    lines: ['Attached are the latest mocks for onboarding.', 'The main change is the progress indicator on step 2.', 'Feedback welcome before Friday.'],
  },
  {
    subject: 'Invoice #2291 for September',
    lines: ['Please find the invoice for September attached.', 'Payment terms are net 30 as usual.', 'Thanks for your business!'],
  },
  {
    subject: 'Trip to Lisbon — itinerary',
    lines: ['Here is the draft itinerary for Lisbon.', 'Flights land at 10:40 on the 14th.', 'Hotel is booked in Alfama.'],
  },
  {
    subject: 'Migration plan for the mail server',
    lines: ['I wrote up the migration plan for the new mail server.', 'Cut-over is planned for Saturday night.', 'MX TTLs are already lowered to 300.'],
  },
  {
    subject: 'Re-org announcement draft',
    lines: ['Sharing an early draft of the announcement.', 'Please keep this confidential for now.', 'Comments in the margin are fine.'],
  },
  {
    subject: 'Birthday dinner for Mom',
    lines: ["We should book something for Mom's birthday.", 'She mentioned the Italian place on 5th.', 'Saturday at 7 works for me.'],
  },
  {
    subject: 'Contract renewal',
    lines: ['Our contract is up for renewal at the end of the month.', 'I attached the redlined version.', 'Main change is the SLA section.'],
  },
  {
    subject: 'Quick question about the API',
    lines: ['Does the /threads endpoint support pagination?', 'I could not find it in the docs.', 'Thanks in advance!'],
  },
  { subject: 'Photos from the weekend', lines: ['Here are a few photos from the hike!', 'The view from the ridge was unreal.', 'Same time next month?'] },
  {
    subject: 'Hiring: senior frontend engineer',
    lines: ['We opened the senior frontend role today.', 'If you know anyone great, send them my way.', 'Referral bonus applies.'],
  },
  {
    subject: 'Budget spreadsheet',
    lines: ['Updated the budget spreadsheet with Q3 actuals.', 'We are about 4% under plan.', 'CSV attached for your records.'],
  },
  {
    subject: 'Conference talk proposal',
    lines: ['I submitted our talk proposal to the conference.', 'Title: "Email is not dead: building on JMAP".', 'Fingers crossed!'],
  },
  {
    subject: 'Weekly sync notes',
    lines: ["Notes from today's sync are below.", 'Action items: finalize copy, ship beta, write tests.', 'Next sync is Monday.'],
  },
  {
    subject: 'Apartment viewing Saturday',
    lines: ['The landlord confirmed the viewing for Saturday 11am.', 'It is the two-bedroom on Elm street.', 'Want to come along?'],
  },
];
const REPLIES = [
  'Sounds good to me.',
  'Thanks — that works.',
  'Let me check and get back to you.',
  'Great, I will take a look this afternoon.',
  'Perfect. See you then!',
  'Could we push this by a day?',
  "Agreed. Let's go with option B.",
  'Looks great overall, a few small comments inline.',
  'Done — updated the doc.',
  'Thanks for pulling this together!',
];
const NEWSLETTERS = [
  {
    from: { name: 'Brightside Outfitters', email: 'deals@brightside-outfitters.example' },
    cat: 'promotions',
    subjects: ['Up to 40% off fall jackets', 'Your weekend deal is here', 'Last chance: free shipping ends tonight', 'New arrivals just for you'],
  },
  {
    from: { name: 'Café Lumière', email: 'hello@cafe-lumiere.example' },
    cat: 'promotions',
    subjects: ['A free pastry with any coffee this week', 'Our autumn menu has arrived', 'Members save 15% this month'],
  },
  {
    from: { name: 'Pixel Plaza', email: 'news@pixelplaza.example' },
    cat: 'promotions',
    subjects: ['Flash sale: headphones from $49', 'Gadgets of the week', 'Your cart misses you'],
  },
  {
    from: { name: 'Connectly', email: 'notifications@connectly.example' },
    cat: 'social',
    subjects: ['Dana Whitfield viewed your profile', 'You have 3 new connection requests', 'Eitan Shah mentioned you in a post'],
  },
  {
    from: { name: 'Pictogram', email: 'no-reply@pictogram.example' },
    cat: 'social',
    subjects: ['hana.t posted a new photo', 'You have new followers', 'See what your friends shared this week'],
  },
  {
    from: { name: 'CodeForge', email: 'notifications@codeforge.example' },
    cat: 'updates',
    subjects: [
      '[acme-app] PR #42: Add compose autosave',
      '[acme-app] Issue #57 was closed',
      '[acme-app] CI failed on main',
      '[acme-app] New release v0.3.0',
    ],
  },
  {
    from: { name: 'Northwind Bank', email: 'alerts@northwind-bank.example' },
    cat: 'updates',
    subjects: ['Your statement is ready', 'A payment of $1,240.00 was received', 'New sign-in to your account'],
  },
  {
    from: { name: 'SkyWays Airlines', email: 'booking@skyways.example' },
    cat: 'updates',
    subjects: ['Your flight to Lisbon is confirmed', 'Check-in is now open', 'Your boarding pass'],
  },
  {
    from: { name: 'ParcelPoint', email: 'tracking@parcelpoint.example' },
    cat: 'updates',
    subjects: ['Your package is out for delivery', 'Delivered: order #88213', 'Your package has shipped'],
  },
  {
    from: { name: 'Acme Community Forum', email: 'digest@forum.acme.example' },
    cat: 'forums',
    subjects: ['Weekly digest: 12 new topics', 'Re: Best practices for Sieve filters', 'New reply in "JMAP vs IMAP"'],
  },
];

function newsletterHtml(brand: string, subject: string, accent: string, withRemote: boolean, msgNo: number): string {
  const img = withRemote
    ? `<img src="https://picsum.photos/seed/acme${msgNo}/560/220" width="560" height="220" alt="${brand} banner" style="display:block;width:100%;height:auto;border-radius:8px">`
    : '';
  const tracker = withRemote ? `<img src="https://tracker.example/open.gif?u=alice&m=${msgNo}" width="1" height="1" alt="">` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  .wrap{max-width:600px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;color:#202124}
  .btn{display:inline-block;background:${accent};color:#fff !important;text-decoration:none;padding:12px 24px;border-radius:24px;font-weight:bold}
  .muted{color:#5f6368;font-size:12px}
</style></head><body style="margin:0;background:#f4f4f4">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:24px 0"><tr><td>
<div class="wrap" style="background:#ffffff;border-radius:12px;padding:24px">
  <h1 style="margin:0 0 8px;font-size:24px;color:${accent}">${brand}</h1>
  ${img}
  <h2 style="font-size:20px;margin:20px 0 8px">${subject}</h2>
  <p style="font-size:15px;line-height:1.5">We picked a few things we think you'll love. Offers are valid while supplies last, and members get early access to everything new this season.</p>
  <ul style="font-size:15px;line-height:1.6"><li>Hand-picked favourites</li><li>Free returns within 30 days</li><li>Exclusive member pricing</li></ul>
  <p style="text-align:center;margin:28px 0"><a class="btn" href="https://example.com/shop?utm_source=email">Shop now</a></p>
  <p class="muted">You are receiving this email because you subscribed. <a href="https://example.com/unsubscribe">Unsubscribe</a></p>
  <script>alert('this must never run')</script>
  ${tracker}
</div></td></tr></table></body></html>`;
}

let msgSeq = 0;
const mid = (host = DOMAIN) => `${Date.now().toString(36)}.${(++msgSeq).toString(36)}.${Math.floor(rand() * 1e9).toString(36)}@${host}`;
const hostOf = (p: Person) => p.email.split('@')[1]!;

interface Planned {
  msg: Msg;
  mailboxes: string[]; // role names or label names
  keywords: string[];
}

function plan(now: number): Planned[] {
  const out: Planned[] = [];
  const DAY = 86400_000;
  // --- human conversations
  for (let t = 0; t < 70; t++) {
    const topic = TOPICS[t % TOPICS.length]!;
    const other = pick(PEOPLE);
    const extra = chance(0.25) ? pick(PEOPLE.filter((p) => p !== other)) : undefined;
    const startedByMe = chance(0.35);
    const n = 1 + Math.floor(rand() * (chance(0.4) ? 6 : 3));
    let at = now - Math.floor(rand() * 120 * DAY) - 3600_000;
    if (t < 8) at = now - Math.floor(rand() * 20) * 3600_000 - 600_000; // a few fresh ones today
    const refs: string[] = [];
    const subject = t >= TOPICS.length ? `${topic.subject} (${Math.floor(t / TOPICS.length) + 1})` : topic.subject;
    const labels: string[] = [];
    if (/Invoice|Budget|Contract/.test(subject)) labels.push('Receipts');
    if (/Lisbon|Trip/.test(subject)) labels.push('Travel');
    if (/roadmap|Design|Migration|API|Hiring|sync|Conference|Re-org/i.test(subject)) labels.push('Work');
    if (/Mom|Photos|Apartment/.test(subject)) labels.push('Family');
    if (/Migration|API/.test(subject)) labels.push('Projects/Acme');
    const important = chance(0.3);
    const starred = chance(0.15);
    for (let i = 0; i < n; i++) {
      const mine = startedByMe ? i % 2 === 0 : i % 2 === 1;
      const from = mine ? ME : i > 1 && extra && chance(0.5) ? extra : other;
      const to = mine ? [other] : [ME];
      const cc = extra && i === 0 ? [extra] : undefined;
      const id = mid(hostOf(from));
      const lines = i === 0 ? topic.lines : [pick(REPLIES), ...(chance(0.5) ? [pick(topic.lines)] : [])];
      const greeting = `Hi ${(mine ? other : ME).name.split(' ')[0]},`;
      const sign = `${from.name.split(' ')[0]}`;
      const prevQuote = i > 0 ? `\n\nOn ${new Date(at).toUTCString()}, ${(mine ? other : ME).name} wrote:\n> ${pick(REPLIES)}` : '';
      const text = `${greeting}\n\n${lines.join('\n')}\n\n${sign}${prevQuote}`;
      const html = chance(0.6)
        ? `<div dir="ltr"><p>${greeting}</p>${lines.map((l) => `<p>${l}</p>`).join('')}<p>${sign}</p>${
            i > 0
              ? `<div class="gmail_quote"><div class="gmail_attr">On ${new Date(at).toUTCString()}, ${(mine ? other : ME).name} wrote:</div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex"><p>${pick(REPLIES)}</p></blockquote></div>`
              : ''
          }</div>`
        : undefined;
      const attachments: Attachment[] = [];
      if (i === 0 && /mocks|Photos/.test(text))
        attachments.push(
          { filename: 'mockup-step2.png', type: 'image/png', data: png(320, 200, [66, 133, 244]) },
          { filename: 'hike.png', type: 'image/png', data: png(240, 160, [52, 168, 83]) },
        );
      if (i === 0 && /invoice|redlined|itinerary|migration plan/i.test(text))
        attachments.push({
          filename: /invoice/i.test(text)
            ? 'invoice-2291.pdf'
            : /redlined/.test(text)
              ? 'contract-redline.pdf'
              : /itinerary/.test(text)
                ? 'lisbon-itinerary.pdf'
                : 'mail-migration-plan.pdf',
          type: 'application/pdf',
          data: pdf(subject, lines),
        });
      if (i === 0 && /CSV/.test(text))
        attachments.push({
          filename: 'budget-q3.csv',
          type: 'text/csv',
          data: Buffer.from('category,plan,actual\nhosting,1200,1100\npeople,54000,52500\ntools,900,940\n'),
        });
      const msg: Msg = {
        from,
        to,
        cc,
        subject: i === 0 ? subject : `Re: ${subject}`,
        date: new Date(at),
        text,
        html,
        attachments,
        messageId: id,
        inReplyTo: refs.at(-1),
        references: refs.length ? [...refs] : undefined,
      };
      refs.push(id);
      const isLast = i === n - 1;
      const recent = now - at < 3 * DAY;
      const keywords = ['$seen'];
      if (!mine && isLast && recent && chance(0.7)) keywords.pop();
      if (!mine && chance(0.08) && !recent) keywords.pop();
      if (important && !mine) keywords.push('$important');
      if (starred && isLast) keywords.push('$flagged');
      const archived = !recent && chance(0.35);
      const boxes = mine ? ['sent'] : archived ? ['archive'] : ['inbox'];
      out.push({ msg, mailboxes: [...boxes, ...labels], keywords });
      at += Math.floor((0.2 + rand() * 30) * 3600_000);
      if (at > now) at = now - 60_000 * (n - i);
    }
  }
  // --- newsletters / notifications
  let n = 0;
  for (const nl of NEWSLETTERS) {
    const count = 10 + Math.floor(rand() * 14);
    for (let k = 0; k < count; k++) {
      n++;
      const subject = pick(nl.subjects);
      const at = now - Math.floor(rand() * 90 * DAY) - 1800_000;
      const accent = pick(['#0b57d0', '#b3261e', '#146c2e', '#7d5260', '#8a4a00']);
      const remote = nl.cat === 'promotions' || chance(0.3);
      const isHtml = nl.cat !== 'updates' || chance(0.5);
      const msg: Msg = {
        from: nl.from,
        to: [ME],
        subject,
        date: new Date(at),
        text: `${nl.from.name}\n\n${subject}\n\nView this email in your browser: https://example.com/view/${n}\n\nUnsubscribe: https://example.com/unsubscribe`,
        html: isHtml ? newsletterHtml(nl.from.name, subject, accent, remote, n) : undefined,
        messageId: mid(hostOf(nl.from)),
        listUnsubscribe: 'https://example.com/unsubscribe',
      };
      const keywords = [now - at > 2 * DAY || chance(0.5) ? '$seen' : ''].filter(Boolean);
      const catKw = CATEGORY_KEYWORDS[nl.cat as keyof typeof CATEGORY_KEYWORDS];
      if (catKw) keywords.push(catKw);
      out.push({ msg, mailboxes: [chance(0.1) ? 'archive' : 'inbox'], keywords });
    }
  }
  // --- a few spam / trash / drafts
  for (let k = 0; k < 6; k++) {
    out.push({
      msg: {
        from: { name: 'Prize Department', email: `winner${k}@lottery-scam.example` },
        to: [ME],
        subject: pick(['You have WON $1,000,000!!!', 'Claim your reward now', 'URGENT: verify your account']),
        date: new Date(now - Math.floor(rand() * 20 * DAY)),
        text: 'Click here to claim your prize. This is definitely not spam.',
        messageId: mid('lottery-scam.example'),
      },
      mailboxes: ['junk'],
      keywords: chance(0.5) ? ['$seen'] : [],
    });
  }
  for (let k = 0; k < 4; k++) {
    out.push({
      msg: {
        from: pick(PEOPLE),
        to: [ME],
        subject: pick(['Old thread nobody needs', 'Re: Unused coupon', 'FYI: outdated schedule']),
        date: new Date(now - Math.floor(rand() * 25 * DAY)),
        text: 'This message lives in the trash.',
        messageId: mid(),
      },
      mailboxes: ['trash'],
      keywords: ['$seen'],
    });
  }
  out.push(
    {
      msg: {
        from: ME,
        to: [BOB],
        subject: 'Draft: offsite agenda',
        date: new Date(now - 5 * 3600_000),
        text: 'Morning: strategy. Afternoon: hackathon. Evening: dinner by the lake.',
        messageId: mid(),
      },
      mailboxes: ['drafts'],
      keywords: ['$draft', '$seen'],
    },
    {
      msg: {
        from: ME,
        to: [CAROL],
        subject: 'Thank-you note',
        date: new Date(now - 26 * 3600_000),
        text: 'Carol — thank you so much for the help last week.',
        messageId: mid(),
      },
      mailboxes: ['drafts'],
      keywords: ['$draft', '$seen'],
    },
  );
  // two snoozed conversations (wake up tomorrow / next week)
  for (const [k, days] of [
    [0, 1],
    [1, 6],
  ] as const) {
    const wake = new Date(now + days * DAY);
    wake.setUTCHours(8, 0, 0, 0);
    out.push({
      msg: {
        from: PEOPLE[4 + k]!,
        to: [ME],
        subject: k === 0 ? 'Follow up on the venue booking' : 'Read later: team offsite ideas',
        date: new Date(now - (k + 2) * DAY),
        text: k === 0 ? 'Can you confirm the venue booking by Friday?' : 'A few ideas for the offsite: hiking, cooking class, escape room.',
        messageId: mid(hostOf(PEOPLE[4 + k]!)),
      },
      mailboxes: ['snoozed'],
      keywords: ['$seen', wakeKeyword(wake)],
    });
  }
  // an inline-image (cid:) message
  out.push({
    msg: {
      from: CAROL,
      to: [ME],
      subject: 'Logo concepts (inline images)',
      date: new Date(now - 2 * 3600_000),
      text: 'Here are two logo concepts inline. Which do you prefer?',
      html: '<p>Here are two logo concepts inline. Which do you prefer?</p><p><img src="cid:concept-a@acme" alt="Concept A" width="160"> <img src="cid:concept-b@acme" alt="Concept B" width="160"></p><p>— Carol</p>',
      attachments: [
        { filename: 'concept-a.png', type: 'image/png', data: png(160, 160, [11, 87, 208]), cid: 'concept-a@acme' },
        { filename: 'concept-b.png', type: 'image/png', data: png(160, 160, [179, 38, 30]), cid: 'concept-b@acme' },
      ],
      messageId: mid(),
    },
    mailboxes: ['inbox', 'Work'],
    keywords: ['$important'],
  });
  return out;
}

// ---------------------------------------------------------------- import
async function seedAccount(user: (typeof DEV_USERS)[number]) {
  const auth = `${user.name}@${DOMAIN}:${user.password}`;
  const sres = await fetch(`${STALWART}/jmap/session`, { headers: { Authorization: `Basic ${b64(auth)}` } });
  if (!sres.ok) throw new Error(`login failed for ${user.name}: ${sres.status}`);
  const session = (await sres.json()) as { primaryAccounts: Record<string, string> };
  const accountId = session.primaryAccounts['urn:ietf:params:jmap:mail']!;

  if (!args.has('--no-reset')) {
    const [[, q]] = await jmap(auth, MAIL, [['Email/query', { accountId, limit: 5000 }, '0']]);
    const ids = q.ids as string[];
    let destroyed = 0;
    for (let i = 0; i < ids.length; i += 200) {
      const [[, r]] = await jmap(auth, MAIL, [['Email/set', { accountId, destroy: ids.slice(i, i + 200) }, '0']]);
      destroyed += ((r.destroyed as string[] | null) ?? []).length;
      if (r.notDestroyed) console.warn('not destroyed:', JSON.stringify(r.notDestroyed).slice(0, 300));
    }
    if (destroyed !== ids.length) console.warn(`only ${destroyed}/${ids.length} emails destroyed`);
    const [[, mb]] = await jmap(auth, MAIL, [['Mailbox/get', { accountId }, '0']]);
    const custom = (mb.list as { id: string; role: string | null; parentId: string | null }[]).filter((m) => !m.role);
    // children first
    custom.sort((a, b) => (a.parentId ? -1 : 0) - (b.parentId ? -1 : 0));
    if (custom.length) await jmap(auth, MAIL, [['Mailbox/set', { accountId, destroy: custom.map((m) => m.id), onDestroyRemoveEmails: true }, '0']]);
    console.log(`reset ${user.name}: removed ${ids.length} emails, ${custom.length} mailboxes`);
  }

  // mailboxes
  const [[, mb]] = await jmap(auth, MAIL, [['Mailbox/get', { accountId }, '0']]);
  const byRole = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const m of mb.list as { id: string; role: string | null; name: string }[]) {
    if (m.role) byRole.set(m.role, m.id);
    byName.set(m.name, m.id);
  }
  const wanted: { key: string; name: string; role?: string; parent?: string }[] = [
    { key: 'archive', name: 'Archive', role: 'archive' },
    { key: 'snoozed', name: 'Snoozed', role: 'snoozed' },
    { key: 'scheduled', name: 'Scheduled', role: 'scheduled' },
    { key: 'Work', name: 'Work' },
    { key: 'Travel', name: 'Travel' },
    { key: 'Receipts', name: 'Receipts' },
    { key: 'Family', name: 'Family' },
    { key: 'Projects', name: 'Projects' },
  ];
  const create: Record<string, unknown> = {};
  for (const w of wanted) {
    if (w.role && byRole.has(w.role)) continue;
    if (!w.role && byName.has(w.name)) continue;
    create[w.key] = { name: w.name, ...(w.role ? { role: w.role } : {}) };
  }
  if (Object.keys(create).length) {
    const [[, r]] = await jmap(auth, MAIL, [['Mailbox/set', { accountId, create }, '0']]);
    for (const [k, v] of Object.entries((r.created ?? {}) as Record<string, { id: string }>)) {
      if (k === 'archive' || k === 'snoozed' || k === 'scheduled') byRole.set(k, v.id);
      else byName.set(k, v.id);
    }
    if (r.notCreated) console.warn('mailboxes not created', r.notCreated);
  }
  if (!byName.has('Acme') && byName.has('Projects')) {
    const [[, r]] = await jmap(auth, MAIL, [['Mailbox/set', { accountId, create: { k: { name: 'Acme', parentId: byName.get('Projects') } } }, '0']]);
    const created = (r.created ?? {}) as Record<string, { id: string }>;
    if (created.k) byName.set('Projects/Acme', created.k.id);
  } else if (byName.has('Acme')) byName.set('Projects/Acme', byName.get('Acme')!);

  const resolve = (k: string) => byRole.get(k) ?? byName.get(k);
  const planned = plan(Date.now());
  console.log(`importing ${planned.length} messages for ${user.name}…`);
  let done = 0;
  const BATCH = 40;
  for (let i = 0; i < planned.length; i += BATCH) {
    const chunk = planned.slice(i, i + BATCH);
    const uploads = await Promise.all(
      chunk.map(async (p) => {
        const res = await fetch(`${STALWART}/jmap/upload/${accountId}/`, {
          method: 'POST',
          headers: { Authorization: `Basic ${b64(auth)}`, 'Content-Type': 'message/rfc822' },
          body: new Uint8Array(buildMime(p.msg)),
        });
        if (!res.ok) throw new Error(`upload failed ${res.status}`);
        return ((await res.json()) as { blobId: string }).blobId;
      }),
    );
    const emails: Record<string, unknown> = {};
    chunk.forEach((p, j) => {
      const mailboxIds: Record<string, boolean> = {};
      for (const m of p.mailboxes) {
        const id = resolve(m);
        if (id) mailboxIds[id] = true;
      }
      emails[`e${i + j}`] = {
        blobId: uploads[j],
        mailboxIds,
        keywords: Object.fromEntries(p.keywords.map((k) => [k, true])),
        receivedAt: p.msg.date.toISOString().replace(/\.\d+Z$/, 'Z'),
      };
    });
    const [[, r]] = await jmap(auth, MAIL, [['Email/import', { accountId, emails }, '0']]);
    if (r.notCreated) console.warn('not imported:', JSON.stringify(r.notCreated).slice(0, 500));
    done += Object.keys((r.created ?? {}) as object).length;
  }
  console.log(`imported ${done} messages`);
}

// ---------------------------------------------------------------- SMTP delivery (exercises the real inbound path)
function smtpSend(from: string, to: string[], data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: SMTP_HOST, port: SMTP_PORT });
    const steps = [`EHLO seed.dev.test`, `MAIL FROM:<${from}>`, ...to.map((t) => `RCPT TO:<${t}>`), 'DATA'];
    let buf = '';
    let stage = -1; // -1 = greeting
    let sentData = false;
    sock.setTimeout(120_000, () => sock.destroy(new Error('SMTP timeout')));
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\r\n');
      buf = lines.pop()!;
      for (const line of lines) {
        if (/^\d{3}-/.test(line)) continue; // multi-line
        const code = Number(line.slice(0, 3));
        if (code >= 400) {
          sock.end('QUIT\r\n');
          return reject(new Error(`SMTP: ${line}`));
        }
        if (sentData) {
          sock.end('QUIT\r\n');
          return resolve();
        }
        stage++;
        if (stage < steps.length) sock.write(steps[stage] + '\r\n');
        else {
          const body = data.toString('utf8').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
          sock.write(body + '\r\n.\r\n');
          sentData = true;
        }
      }
    });
    sock.on('error', reject);
  });
}

async function smtpSeed() {
  // The dev server's SPF/DNS checks can take ~15–30 s per session, so deliver in parallel.
  const now = new Date();
  const subjects = ['Welcome to 5050 Mail', 'Your account is ready', 'Delivered over SMTP: hello from Bob'];
  const results = await Promise.allSettled(
    subjects.map(async (s, i) => {
      const from = i === 2 ? BOB : { name: '5050 Mail Team', email: `team@${DOMAIN}` };
      const msg: Msg = {
        from,
        to: [ME],
        subject: s,
        date: new Date(now.getTime() - (3 - i) * 60_000),
        text: `${s}.\n\nThis message was delivered through the local SMTP listener so the inbound pipeline is exercised too.`,
        html: `<p><b>${s}.</b></p><p>This message was delivered through the local SMTP listener so the inbound pipeline is exercised too.</p>`,
        messageId: mid(),
      };
      await smtpSend(from.email, [ME.email], buildMime(msg));
    }),
  );
  const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  if (failed.length) console.warn(`SMTP delivery: ${failed.length} failed (${(failed[0]!.reason as Error).message})`);
  console.log(`delivered ${results.length - failed.length} messages over SMTP`);
}

// ---------------------------------------------------------------- admin automation (local only)
/**
 * The admin console offers automatic DNS / TLS only when an x:DnsServer / x:AcmeProvider exists.
 * Locally we can't reach Cloudflare or Let's Encrypt, so create stand-ins:
 *  - a TSIG DnsServer pointing at 127.0.0.1:5399 inside the container (nothing listens; publishing fails visibly);
 *  - an AcmeProvider registered against a throwaway in-process ACME directory (Stalwart registers an
 *    account on create, so the directory must answer once; certificate orders then fail visibly).
 * ACME_HOST is how the Stalwart container reaches this machine (default host.docker.internal).
 */
async function ensureDevAutomation() {
  const [[, dns], [, acme]] = await jmap(ADMIN, ADMINCAP, [
    ['x:DnsServer/get', { ids: null, properties: ['description'] }, '0'],
    ['x:AcmeProvider/get', { ids: null, properties: ['directory'] }, '1'],
  ]);
  if (!(dns.list as unknown[]).length) {
    const [[, r]] = await jmap(ADMIN, ADMINCAP, [
      [
        'x:DnsServer/set',
        {
          create: {
            d: {
              '@type': 'Tsig',
              description: 'Dummy DNS (local dev)',
              host: '127.0.0.1',
              port: 5399,
              keyName: 'dummy',
              key: { '@type': 'Value', secret: 'ZHVtbXk=' },
              protocol: 'udp',
              tsigAlgorithm: 'hmac-sha512',
            },
          },
        },
        '0',
      ],
    ]);
    if (r.notCreated) throw new Error(`could not create DnsServer: ${JSON.stringify(r.notCreated)}`);
    console.log('created dummy DnsServer');
  }
  if ((acme.list as unknown[]).length) return console.log('dev automation already configured');
  const port = Number(process.env.ACME_PORT ?? 14000);
  const base = `http://${process.env.ACME_HOST ?? 'host.docker.internal'}:${port}`;
  let n = 0;
  const server = createServer((req, res) => {
    res.setHeader('Replay-Nonce', `5050-dev-${++n}`);
    if (req.url === '/dir') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(
        JSON.stringify({
          newNonce: `${base}/nonce`,
          newAccount: `${base}/acct`,
          newOrder: `${base}/order`,
          revokeCert: `${base}/revoke`,
          keyChange: `${base}/key`,
        }),
      );
    }
    if (req.url === '/nonce') return res.end();
    if (req.url === '/acct') {
      req.resume();
      req.on('end', () => {
        res.statusCode = 201;
        res.setHeader('Location', `${base}/acct/1`);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ status: 'valid' }));
      });
      return;
    }
    res.statusCode = 503;
    res.end(JSON.stringify({ type: 'urn:ietf:params:acme:error:serverInternal', detail: '5050 dev stand-in: no certificates here' }));
  });
  await new Promise<void>((resolve) => server.listen(port, '0.0.0.0', resolve));
  try {
    const [[, r]] = await jmap(ADMIN, ADMINCAP, [
      ['x:AcmeProvider/set', { create: { a: { directory: `${base}/dir`, challengeType: 'Dns01', contact: { [`postmaster@${DOMAIN}`]: true } } } }, '0'],
    ]);
    if (r.notCreated) throw new Error(`could not create AcmeProvider: ${JSON.stringify(r.notCreated)}`);
    console.log('created dev AcmeProvider');
  } finally {
    server.close();
  }
}

async function main() {
  await ensureUsers();
  if (args.has('--automation')) await ensureDevAutomation();
  if (args.has('--users-only')) return;
  await seedAccount(DEV_USERS[0]!);
  if (!args.has('--no-smtp')) await smtpSeed();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
