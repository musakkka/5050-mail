import { describe, expect, it } from 'vitest';
import { handle } from './index';

describe('mock backend', () => {
  it('serves the session and a team', async () => {
    const me = (await handle('GET', '/me', undefined)).body as { teams: { id: string }[] };
    expect(me.teams.length).toBeGreaterThan(0);
  });
  it('creates an API key and returns the token once', async () => {
    const me = (await handle('GET', '/me', undefined)).body as { teams: { id: string }[] };
    const t = me.teams[0]!.id;
    const r = await handle('POST', `/teams/${t}/resend/api-keys`, { name: 'CI', permission: 'full_access' });
    expect(r.status).toBe(201);
    expect((r.body as { token: string }).token).toMatch(/^re_/);
    const list = (await handle('GET', `/teams/${t}/api-keys`, undefined)).body as { data: { name: string; token?: string }[] };
    expect(list.data.find((k) => k.name === 'CI')).toBeTruthy();
    expect(list.data.every((k) => k.token === undefined)).toBe(true);
  });
  it('filters emails by status', async () => {
    const me = (await handle('GET', '/me', undefined)).body as { teams: { id: string }[] };
    const r = (await handle('GET', `/teams/${me.teams[0]!.id}/emails?status=bounced&limit=100`, undefined)).body as { data: { last_event: string }[] };
    expect(r.data.every((e) => e.last_event === 'bounced')).toBe(true);
  });
  it('validates domains', async () => {
    const me = (await handle('GET', '/me', undefined)).body as { teams: { id: string }[] };
    expect((await handle('POST', `/teams/${me.teams[0]!.id}/resend/domains`, { name: 'not a domain' })).status).toBe(422);
  });
});
