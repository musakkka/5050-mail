import { describe, expect, it } from 'vitest';
import { checklistComplete, connectChecklist, sendingHealth, zoneFor, type CloudflareDomainStatus, type ConnectResult } from './cloudflare';
import { loginDetailsText, MAIL_CLIENT_SETTINGS } from './mailSettings';
import type { Domain } from './types';

const domain: Domain = {
  id: 'd1',
  name: 'mail.example.com',
  description: null,
  isEnabled: true,
  createdAt: '2026-10-01T00:00:00Z',
  aliases: {},
  catchAllAddress: null,
  reportAddressUri: null,
  certificateManagement: { '@type': 'Automatic', acmeProviderId: 'a1' },
  dkimManagement: { '@type': 'Automatic' },
  dnsManagement: { '@type': 'Automatic', dnsServerId: 's1', origin: 'example.com', publishRecords: { mx: true } },
};

const cf = (over: Partial<CloudflareDomainStatus> = {}): CloudflareDomainStatus => ({
  domain: 'mail.example.com',
  zone: 'example.com',
  sending: { onboarded: true, enabled: true, returnPath: 'cf-bounce.mail.example.com' },
  bounceRecords: [{ type: 'MX', name: 'cf-bounce.mail.example.com', content: 'route1.mx.cloudflare.net', present: true }],
  stalwartRecords: [{ type: 'MX', name: 'mail.example.com', content: 'mail.example.com', present: true, kind: 'mx' }],
  sendingReady: true,
  ...over,
});
const okConnect: ConnectResult = { domain: 'mail.example.com', zone: 'example.com', ok: true, steps: [] };
const states = (s: ReturnType<typeof connectChecklist>) => Object.fromEntries(s.map((x) => [x.id, x.state]));

describe('zoneFor', () => {
  it('picks the most specific containing zone', () => {
    const zones = ['example.com', 'mail.example.com', 'other.com'];
    expect(zoneFor('MAIL.example.com', zones)).toBe('mail.example.com');
    expect(zoneFor('x.y.example.com', zones)).toBe('example.com');
    expect(zoneFor('notexample.com', zones)).toBeUndefined();
  });
});

describe('connectChecklist', () => {
  it('waits for creation first', () => {
    const s = connectChecklist({});
    expect(states(s)).toEqual({ created: 'active', dns: 'waiting', dkim: 'waiting', sending: 'waiting', tls: 'waiting', ready: 'waiting' });
    expect(states(connectChecklist({ createError: 'taken' })).created).toBe('error');
  });

  it('is ready when every step is done', () => {
    const s = connectChecklist({
      created: true,
      domain,
      signatures: [{ id: 'k', '@type': 'Dkim1Ed25519Sha256', domainId: 'd1', selector: 's', stage: 'active', createdAt: '', nextTransitionAt: null }],
      certificates: [{ id: 'c', subjectAlternativeNames: { 'mail.example.com': true }, notValidBefore: '2026-01-01T00:00:00Z', notValidAfter: '2999-01-01T00:00:00Z', issuer: 'LE' }],
      cf: cf(),
      connect: okConnect,
    });
    expect(Object.values(states(s)).every((x) => x === 'done')).toBe(true);
    expect(checklistComplete(s)).toBe(true);
  });

  it('shows spinners while DNS, keys, sending and the certificate are pending', () => {
    const s = connectChecklist({ created: true, domain, cf: cf({ stalwartRecords: [{ type: 'MX', name: 'x', content: 'y', present: false }], sendingReady: false }) });
    expect(states(s)).toMatchObject({ created: 'done', dns: 'active', dkim: 'active', sending: 'active', tls: 'active', ready: 'waiting' });
    expect(s.find((x) => x.id === 'tls')!.detail).toMatch(/few minutes/);
  });

  it('surfaces failures: DNS task retrying and Cloudflare connect errors', () => {
    const s = connectChecklist({
      created: true,
      domain,
      tasks: [{ id: 't', '@type': 'DnsManagement', domainId: 'd1', due: null, status: { '@type': 'Retry', failureReason: 'connection refused' } }],
      cf: cf({ sendingReady: false, stalwartRecords: [] }),
      connect: { ...okConnect, ok: false, steps: [{ id: 'records', status: 'error', detail: 'MX cf-bounce: boom' }] },
    });
    expect(s.find((x) => x.id === 'dns')).toMatchObject({ state: 'error', detail: 'Retrying: connection refused' });
    expect(s.find((x) => x.id === 'sending')).toMatchObject({ state: 'error', detail: 'MX cf-bounce: boom' });
    expect(checklistComplete(s)).toBe(false);
  });

  it('skips a manually managed certificate', () => {
    const s = connectChecklist({ created: true, domain: { ...domain, certificateManagement: { '@type': 'Manual' } }, cf: cf(), connect: okConnect });
    expect(states(s).tls).toBe('skipped');
  });
});

describe('sendingHealth', () => {
  it('maps the Cloudflare status to a health chip', () => {
    expect(sendingHealth(cf()).state).toBe('ok');
    expect(sendingHealth(cf({ zone: null })).state).toBe('off');
    expect(sendingHealth(cf({ sending: { onboarded: false, enabled: false }, sendingReady: false })).detail).toMatch(/550 5\.7\.1/);
    const missing = sendingHealth(cf({ sendingReady: false, bounceRecords: [{ type: 'TXT', name: 'cf-bounce.mail.example.com', content: 'v=spf1', present: false }] }));
    expect(missing).toMatchObject({ state: 'warning', detail: 'TXT cf-bounce.mail.example.com' });
  });
});

describe('loginDetailsText', () => {
  it('includes the webmail URL, credentials and client settings from the config constant', () => {
    const t = loginDetailsText({ webmailUrl: 'https://mail.example.com', email: 'dave@example.com', password: 'pw-1234' });
    expect(t).toContain('Webmail: https://mail.example.com');
    expect(t).toContain('Email: dave@example.com');
    expect(t).toContain('Password: pw-1234');
    expect(t).toContain(`IMAP: ${MAIL_CLIENT_SETTINGS.imap.host}:993 (SSL/TLS)`);
    expect(t).toContain(`SMTP: ${MAIL_CLIENT_SETTINGS.smtp.host}:465 (SSL/TLS)`);
    expect(MAIL_CLIENT_SETTINGS.imap.host).toBe('mail.example.com');
  });
});
