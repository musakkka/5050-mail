import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { integrationSnippets, smtpInfo } from '../../src/services/integrations.js';
import type { AppContext } from '../../src/context.js';

const ctx = { config: loadConfig({ NODE_ENV: 'test', SMTP_PORTS_TLS: '2465', SMTP_PORTS_STARTTLS: '2587,587' }) } as AppContext;

describe('integrations data', () => {
  it('describes the relay from config', () => {
    const s = smtpInfo(ctx);
    expect(s).toMatchObject({ host: 'smtp.example.com', username: 'resend' });
    expect(s.ports.map((p) => `${p.port}/${p.security}`)).toEqual(['2465/tls', '2587/starttls', '587/starttls']);
  });
  it('has snippets for every required integration, filled from config', () => {
    const list = integrationSnippets(ctx);
    const ids = new Set(list.map((i) => i.id));
    for (const id of ['nodemailer', 'django', 'laravel-smtp', 'rails', 'spring', 'supabase', 'clerk', 'auth0', 'firebase', 'wordpress', 'strapi', 'node', 'python', 'php', 'ruby', 'go', 'rust', 'java', 'dotnet', 'elixir']) expect(ids.has(id), id).toBe(true);
    expect(ids.size).toBe(list.length);
    for (const i of list) {
      expect(['smtp', 'sdk', 'framework', 'platform']).toContain(i.category);
      expect(i.docs_url).toMatch(/^https:\/\//);
      expect(i.snippet.length).toBeGreaterThan(10);
    }
    expect(list.find((i) => i.id === 'django')!.snippet).toContain('EMAIL_PORT = 2465');
    expect(list.find((i) => i.id === 'spring')!.snippet).toContain('spring.mail.port=587');
  });
});
