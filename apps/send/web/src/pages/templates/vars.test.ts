import { describe, expect, it } from 'vitest';
import { isValidKey, renderPreview, undeclared, usedVariables } from './vars';

describe('template variables', () => {
  it('finds variables in triple and double braces, with inline fallbacks', () => {
    expect(usedVariables('Hi {{{NAME}}} {{ORDER}} {{{CITY|Paris}}} {{{contact.first_name}}}')).toEqual(['NAME', 'ORDER', 'CITY', 'contact']);
  });
  it('reports undeclared variables, ignoring reserved ones', () => {
    expect(undeclared([{ key: 'NAME', type: 'string', fallback_value: null }], '{{{NAME}}} {{{FIRST_NAME}}} {{{PLAN}}}')).toEqual(['PLAN']);
  });
  it('validates keys', () => {
    expect(isValidKey('user_name')).toBe(true);
    expect(isValidKey('bad-key')).toBe(false);
    expect(isValidKey('EMAIL')).toBe(false);
  });
  it('renders previews with escaped fallbacks', () => {
    expect(renderPreview('<p>{{{NAME}}}</p>', [{ key: 'NAME', type: 'string', fallback_value: '<b>x</b>' }])).toBe('<p>&lt;b&gt;x&lt;/b&gt;</p>');
    expect(renderPreview('{{{CITY|Paris}}}', [])).toBe('Paris');
  });
});
