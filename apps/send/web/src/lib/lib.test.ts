import { describe, expect, it } from 'vitest';
import { contactsFromCsv, parseCsv, toCsv } from './csv';
import { timeAgoShort, formatPercent, tokenPreview } from './format';
import { sendSnippet, SDKS } from './snippets';
import { emailStatus, EMAIL_STATUS_ORDER } from './status';

describe('csv', () => {
  it('quotes and neutralises formulas', () => {
    expect(toCsv(['a', 'b'], [['x,y', '=SUM(A1)'], ['"q"', null]])).toBe('a,b\r\n"x,y",\'=SUM(A1)\r\n"""q""",\r\n');
  });
  it('parses quoted fields and newlines', () => {
    expect(parseCsv('a,b\n"1,2","x\ny"\n')).toEqual([['a', 'b'], ['1,2', 'x\ny']]);
  });
  it('maps contacts and counts invalid/duplicate rows', () => {
    const r = contactsFromCsv('Email,First Name,unsubscribed\nA@x.com,Ada,true\nbad,,\na@x.com,dup,\n');
    expect(r.contacts).toEqual([{ email: 'a@x.com', first_name: 'Ada', unsubscribed: true }]);
    expect(r.invalid).toBe(2);
  });
  it('requires an email column', () => {
    expect(contactsFromCsv('name\nAda').error).toMatch(/email/);
  });
});

describe('format', () => {
  const now = new Date('2026-10-22T12:00:00Z');
  it('compact relative times', () => {
    expect(timeAgoShort('2026-10-22T09:00:00Z', now)).toBe('3h ago');
    expect(timeAgoShort('2026-10-21T09:00:00Z', now)).toBe('1d ago');
    expect(timeAgoShort('2025-12-01T09:00:00Z', now)).toBe('10mo ago');
    expect(timeAgoShort('2026-10-22T14:00:00Z', now)).toBe('in 2h');
    expect(timeAgoShort(null, now)).toBe('—');
  });
  it('percent and token preview', () => {
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(0.0123, 2)).toBe('1.23%');
    expect(tokenPreview('re_abcdefgh_ijklmnop')).toBe('re_abcdefgh...');
  });
});

describe('snippets', () => {
  const s = { apiKey: 're_test', from: 'A <a@x.com>', to: 'b@y.com', subject: "It's", html: '<p>hi</p>' };
  it('every SDK points at the 5050 Send base URL', () => {
    for (const sdk of SDKS) {
      const code = sendSnippet(sdk.id, s);
      expect(code).toContain('api.example.com');
      expect(code).not.toContain('api.resend.com');
    }
  });
  it('escapes quotes', () => {
    expect(sendSnippet('node', s)).toContain("subject: 'It\\'s'");
  });
});

describe('status', () => {
  it('knows every status and falls back', () => {
    for (const s of EMAIL_STATUS_ORDER) expect(emailStatus(s).label).toBeTruthy();
    expect(emailStatus('weird_new').label).toBe('weird new');
  });
});
