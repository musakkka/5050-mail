/**
 * Official Python SDK (`pip install resend`) against the server with only the base URL changed.
 * Uses RESEND_PY (default send/.venv-sdk/bin/python); skipped when it is missing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestServer, type TestServer } from '../helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const py = process.env.RESEND_PY ?? path.resolve(here, '../../.venv-sdk/bin/python');
const available = existsSync(py);

let t: TestServer;
let key: string;
beforeAll(async () => {
  if (!available) return;
  t = await startTestServer();
  const team = await t.createTeam('Python');
  await t.verifiedDomain(team, 'acme.test');
  key = await t.createKey(team);
});
afterAll(() => t?.close());

describe.skipIf(!available)('Python SDK compatibility', () => {
  it('sends, reads, lists and surfaces errors', async () => {
    const out = await new Promise<string>((resolve, reject) =>
      execFile(py, ['-I', path.join(here, 'python_smoke.py'), t.apiBase, key], { timeout: 30_000 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))),
    );
    const r = JSON.parse(out);
    expect(r.sent_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.get_subject).toBe('py');
    expect(r.domains).toEqual(['acme.test']);
    expect(r.batch_n).toBe(1);
    expect(r.error).toMatchObject({ code: 403, error_type: 'validation_error' });
    const [row] = await t.ctx.sql`select user_agent from api_logs where endpoint = '/emails' and method = 'POST' order by created_at limit 1`;
    expect(String(row!.user_agent)).toMatch(/^resend-python/);
  });
});
