import { describe, expect, it } from 'vitest';
import { getWebsiteService, websiteServices, websiteWorkspaceHref } from './website-services';

describe('customer service selection', () => {
  it('defines exactly seven unique services with concrete scoping and verification prompts', () => {
    expect(websiteServices.map(service => service.id)).toEqual(['security', 'development', 'redesign', 'issue', 'server', 'seo', 'automation']);
    for (const service of websiteServices) {
      expect(getWebsiteService(service.id)).toBe(service);
      expect(service.hint.length).toBeGreaterThan(50); expect(service.success.length).toBeGreaterThan(30);
      expect(service.boundary.length).toBeGreaterThan(50);
      expect(service.links.every(link => /^\/[a-z]+$/.test(link.path))).toBe(true);
    }
  });
  it('rejects unsupported, malformed or case-mismatched service values', () => {
    for (const value of [null, undefined, '', 'SECURITY', 'release', 'https://example.test', '<script>', '__proto__', 'security&admin=true']) expect(getWebsiteService(value)).toBeUndefined();
  });
  it('preserves only the validated service in workspace and resource URLs', () => {
    expect(websiteWorkspaceHref('fixture', getWebsiteService('seo'))).toBe('/customer/websites/fixture?service=seo');
    expect(websiteWorkspaceHref('fixture', getWebsiteService('server'), '/access')).toBe('/customer/websites/fixture/access?service=server');
    expect(websiteWorkspaceHref('a/b?x=1')).toBe('/customer/websites/a%2Fb%3Fx%3D1');
    expect(websiteWorkspaceHref('fixture', getWebsiteService('malformed'))).toBe('/customer/websites/fixture');
  });
});
