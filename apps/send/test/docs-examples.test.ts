/**
 * Runs every Node.js and cURL example from Resend's API reference
 * (test/docs-examples/examples.json, regenerate with scripts/extract-doc-examples.ts)
 * against this server. Only the base URL and the API key are changed; the IDs in
 * the examples exist because seed.ts creates resources with exactly those IDs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestServer, type TestServer } from './helpers.js';
import { createApiKey } from '../src/services/apiKeys.js';
import { IDS, seed, type SeedOptions } from './docs-examples/seed.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const examples = JSON.parse(readFileSync(path.join(here, 'docs-examples/examples.json'), 'utf8')) as { page: string; lang: string; code: string }[];
const workdir = path.join(here, 'docs-examples/.run');

/** Pages whose examples need a different starting state. */
const SEED_FOR: Record<string, SeedOptions & { claim?: boolean }> = {
  'domains/create-domain': { noExampleDomain: true },
  'domains/claim-domain': { exampleDomainOnOtherTeam: true },
  'domains/get-domain-claim': { exampleDomainOnOtherTeam: true, claim: true },
  'domains/verify-domain-claim': { exampleDomainOnOtherTeam: true, claim: true },
  'events/create-event': { noEventDefinition: true },
  'broadcasts/cancel-broadcast': { broadcastStatus: 'scheduled' },
};

/** Examples that are expected to return an error, with the reason. */
const EXPECTED_ERROR: Record<string, string> = {
  // Backward pagination example uses the literal cursor 'some-contact-id'; Resend rejects non-ID cursors too.
  pagination: 'validation_error',
  // Sends from onboarding@resend.dev to foo@gmail.com: on Resend too this is a 403 unless it is your own address.
  'emails/send-batch-emails': 'validation_error',
  // The cURL example reschedules to 2026-08-05, which is in the past now; Resend answers 422 as well.
  'emails/update-email': 'validation_error',
  // OAuth authorization server (authorize/token/register/revoke) is phase 2.
  'oauth/token': 'not_found',
};
/** Not runnable as extracted (preview-only SDK build / prose captured in the block). */
const SKIP = new Set(['segments/get-segment-metrics']);

let t: TestServer;
let teamId = '';
let otherId = '';
let key = '';

async function reset(page: string) {
  const sql = t.ctx.sql;
  await sql`delete from jobs`;
  await sql`delete from api_logs`;
  await sql`delete from idempotency_keys`;
  await sql`delete from teams`;
  const [a] = await sql`insert into teams (name, rate_limit) values ('Docs', 1000) returning id`;
  const [b] = await sql`insert into teams (name, rate_limit) values ('Other', 1000) returning id`;
  teamId = a!.id as string;
  otherId = b!.id as string;
  await sql`insert into team_members (team_id, email, role) values (${teamId}, 'owner@dev.test', 'admin')`;
  key = (await createApiKey(sql, teamId, 'docs-runner', 'full_access', null, null)).token;
  const o = SEED_FOR[page] ?? {};
  await seed(sql, teamId, otherId, o);
  if (o.claim) {
    await sql`insert into domain_claims (team_id, domain_id, name, region, token) values (${teamId}, ${IDS.domain}, 'example.com', 'us-east-1', 'docs-token')`;
  }
}

function run(cmd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve) =>
    execFile(cmd, args, { cwd: workdir, timeout: 30_000, env: { ...process.env, ...env } }, (err, stdout, stderr) => resolve(`${stdout}${err ? `\n__ERR__${stderr || err.message}` : ''}`)),
  );
}

beforeAll(async () => {
  t = await startTestServer();
  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(workdir, { recursive: true });
  writeFileSync(path.join(workdir, 'contacts.csv'), 'Email,First Name,Last Name,Plan\nada@example.com,Ada,Lovelace,pro\n');
  writeFileSync(path.join(workdir, 'package.json'), '{"type":"module"}');
}, 60_000);
afterAll(async () => {
  rmSync(workdir, { recursive: true, force: true });
  await t?.close();
});

const node = examples.filter((e) => e.lang === 'Node.js' && !SKIP.has(e.page));
const curl = examples.filter((e) => e.lang === 'cURL' && !SKIP.has(e.page));

describe('Resend API reference — Node.js examples', () => {
  it.each(node.map((e, i) => [`${e.page} #${i}`, e] as const))('%s', async (_n, e) => {
    await reset(e.page);
    const file = path.join(workdir, `ex.mjs`);
    let code = e.code.replace(/re_xxxxxxxxx/g, key);
    if (!/import \{ Resend \}/.test(code)) code = `import { Resend } from 'resend';\n${code}`;
    writeFileSync(
      file,
      `${code}\n;console.log('__RESULT__' + JSON.stringify({ data: typeof data !== 'undefined' ? data : null, error: typeof error !== 'undefined' ? error : null }));\n`,
    );
    // Resolve 'resend' from this package's node_modules.
    const out = await run(process.execPath, ['--import', 'data:text/javascript,', file], { RESEND_BASE_URL: t.apiBase, NODE_PATH: path.resolve(here, '../node_modules'), NODE_NO_WARNINGS: '1' });
    const expected = EXPECTED_ERROR[e.page];
    // An example that dereferences `data` after the documented error may crash; the error itself is what we check.
    if (expected && out.includes('__ERR__')) {
      expect(out).toContain(expected);
      return;
    }
    expect(out, out).not.toContain('__ERR__');
    const line = out.split('\n').find((l) => l.startsWith('__RESULT__'));
    expect(line, out).toBeTruthy();
    const r = JSON.parse(line!.slice('__RESULT__'.length)) as { data: unknown; error: { name: string; message: string } | null };
    if (expected) {
      if (r.error) expect(r.error.name).toBe(expected);
    } else {
      expect(r.error, `${e.page}: ${JSON.stringify(r.error)}`).toBeNull();
    }
  });
});

/** Split a cURL block into commands (drops `//` and `#` comment lines). */
function curlCommands(code: string): string[] {
  const lines = code.split('\n').filter((l) => !/^\s*(\/\/|#)/.test(l));
  const cmds: string[] = [];
  let cur = '';
  for (const l of lines) {
    if (/^\s*curl\s/.test(l) && cur.trim()) {
      cmds.push(cur);
      cur = '';
    }
    cur += `${l}\n`;
  }
  if (cur.trim()) cmds.push(cur);
  return cmds.map((c) => c.trimEnd().replace(/\\$/, '').trimEnd()).filter((c) => c.startsWith('curl'));
}

describe('Resend API reference — cURL examples', () => {
  const cases = curl.flatMap((e, i) => curlCommands(e.code).map((c, j) => [`${e.page} #${i}.${j}`, e.page, c] as const));
  it.each(cases)('%s', async (_n, page, cmd) => {
    await reset(page);
    const fixed = cmd.replace(/https:\/\/api\.resend\.com/g, t.apiBase).replace(/re_xxxxxxxxx/g, key);
    const out = await run('bash', ['-c', `${fixed} -s -w '\\n__STATUS__%{http_code}'`]);
    const status = Number(/__STATUS__(\d+)/.exec(out)?.[1] ?? 0);
    const expected = EXPECTED_ERROR[page];
    if (expected) expect(status, out).toBeGreaterThan(0);
    else expect(status, `${page}\n${fixed}\n${out}`).toBeLessThan(300);
    expect(status, out).toBeGreaterThanOrEqual(200);
  });
});
