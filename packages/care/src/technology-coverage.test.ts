import { describe, expect, it } from 'vitest';
import { agentCatalogue, toolCatalogue, prepareReviewSnapshot, reviewSteps } from './index.js';
import { technologyCoverage, technologyChecks } from './technology-coverage.js';
import { isSupportedReviewPath, reviewPathProblem } from './source-formats.js';

describe('technology directory matches executable source-review contracts', () => {
  it('accepts every advertised example through the real server intake and maps teams to implemented roles', () => {
    const assigned = new Set<string>();
    for (const area of technologyCoverage) {
      expect(prepareReviewSnapshot(area.examples.map(path => ({ path, content: 'Sanitized review example' }))).files).toHaveLength(area.examples.length);
      const steps = reviewSteps(area.roleIds);
      expect(steps).toHaveLength(area.roleIds.length);
      for (const step of steps) {
        assigned.add(step.roleId);
        expect(agentCatalogue.find(role => role.id === step.roleId)).toMatchObject({ enabled: true, sourceReview: true });
      }
      for (const id of area.checkIds) {
        expect(technologyChecks[id]).toBeTruthy();
        expect(toolCatalogue.find(tool => tool.id === id)).toMatchObject({ enabled: true, implementation: 'OFFLINE_SOURCE_REVIEW' });
      }
    }
    expect([...assigned].sort()).toEqual(agentCatalogue.map(role => role.id).sort());
  });
  it.each(['.env','src/.env.production','secrets.yaml','credentials.json','infra/state.tfstate','infra/production.tfvars','private.pem','archive.zip','/etc/nginx.conf','../server.conf','src/./Program.cs','src//view.liquid','C:\\server.conf'])('keeps sensitive and non-source paths blocked in both browser and API: %s', (path) => {
    expect(isSupportedReviewPath(path)).toBe(false);
    expect(reviewPathProblem([path])).toBeTruthy();
    expect(() => prepareReviewSnapshot([{ path, content: 'Sanitized text' }])).toThrow();
  });
  it('preserves content screening and case-insensitive unique paths for newly accepted configurations', () => {
    for (const path of ['infra/terraform.tfstate.json','infra/production.tfvars.json']) {
      expect(isSupportedReviewPath(path)).toBe(false);
      expect(() => prepareReviewSnapshot([{ path, content: '{}' }])).toThrow();
    }
    expect(reviewPathProblem(['src/View.LIQUID','src/view.liquid'])).toContain('unique');
    expect(() => prepareReviewSnapshot([{ path: 'server.conf', content: 'password: synthetic-private-credential' }])).toThrow();
    expect(() => prepareReviewSnapshot([{ path: 'Program.cs', content: 'binary\u0000content' }])).toThrow();
    expect(prepareReviewSnapshot([{ path: 'app.service', content: '[Unit]\r\nDescription=Example\r\n' }]).files[0]?.content).toBe('[Unit]\nDescription=Example\n');
  });
});
