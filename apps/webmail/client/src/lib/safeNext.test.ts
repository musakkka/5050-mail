import { describe, expect, it } from 'vitest';
import { safeNext } from './safeNext';

describe('safeNext', () => {
  const O = 'https://mail.example';
  it('keeps same-origin paths', () => {
    expect(safeNext('/mail/sent/T1?x=1#y', O)).toBe('/mail/sent/T1?x=1#y');
    expect(safeNext('/admin/domains', O)).toBe('/admin/domains');
  });
  it('rejects anything that could leave the origin', () => {
    for (const bad of [null, '', 'mail/inbox', '//evil.test', '/\\evil.test', '/\\/evil.test', 'https://evil.test/', '/\t/evil.test', 'javascript:alert(1)', '/login?next=/x'])
      expect(safeNext(bad, O)).toBe('/mail/inbox');
  });
});
