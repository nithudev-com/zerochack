import { describe, expect, it } from 'vitest';
import { renderEmailTemplate, validateEmailTemplate } from './index.js';

describe('safe email templates', () => {
  it('renders only declared scalar placeholders', () => expect(renderEmailTemplate('Hello {{user.name}}, ticket {{ticketId}}', { user: { name: 'Ada' }, ticketId: 42 })).toBe('Hello Ada, ticket 42'));
  it('rejects executable and malformed syntax', () => {
    expect(() => validateEmailTemplate('<script>alert(1)</script>', 1000)).toThrow('EMAIL_TEMPLATE_INVALID');
    expect(() => validateEmailTemplate('${process.env.SECRET}', 1000)).toThrow('EMAIL_TEMPLATE_INVALID');
    expect(() => renderEmailTemplate('Hello {{missing}}', {})).toThrow('EMAIL_TEMPLATE_VALUE_MISSING');
  });
});
