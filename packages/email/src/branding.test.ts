import { describe, expect, it } from 'vitest';
import { renderBrandedEmail } from './index.js';
import { emailLogoBase64 } from './brand-asset.js';

describe('CodeBandage email branding', () => {
  it('embeds the supplied logo without loading a remote URL', () => {
    const html = renderBrandedEmail('A safe notification');
    expect(html).toContain('cid:codebandage-logo'); expect(html).toContain('alt="CodeBandage"');
    expect(html).not.toMatch(/<img[^>]+https?:/); expect(Buffer.from(emailLogoBase64, 'base64').subarray(1,4).toString()).toBe('PNG');
  });
  it('escapes untrusted notification content, including markup and quotes', () => {
    const html = renderBrandedEmail('<script>alert("x")</script> & \'customer\'');
    expect(html).not.toContain('<script>'); expect(html).toContain('&lt;script&gt;'); expect(html).toContain('&amp;'); expect(html).toContain('&#39;customer&#39;');
  });
});
