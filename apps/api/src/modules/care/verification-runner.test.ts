import { describe, expect, it, vi } from 'vitest';
import { loadEnvironment } from '@zerochack/config';
import { containerArguments, verificationPreflight, verificationResultSchema } from './verification-runner.js';
const image = `sha256:${'a'.repeat(64)}`;
describe('verification deployment boundary', () => {
  it('constructs only an immutable offline, bounded, unprivileged invocation with no host mounts', () => {
    const args = containerArguments(image, 'care-verify-00000000-0000-4000-8000-000000000000');
    for (const control of ['--pull=never','--network=none','--http-proxy=false','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--user=65532:65532','--pids-limit=64','--memory=256m','--cpus=1','--timeout=50']) expect(args).toContain(control);
    expect(args.some((item) => /^--(?:volume|privileged|publish|env-host|device)/.test(item))).toBe(false);
    expect(() => containerArguments('latest', 'care-verify-00000000-0000-4000-8000-000000000000')).toThrow();
  });
  it('fails closed for root without attempting execution', async () => {
    const getuid = vi.spyOn(process, 'getuid').mockReturnValue(0);
    try { await expect(verificationPreflight({ CARE_VERIFICATION_IMAGE: image } as ReturnType<typeof loadEnvironment>)).rejects.toMatchObject({ code: 'VERIFICATION_ROOTLESS_REQUIRED' }); }
    finally { getuid.mockRestore(); }
  });
  it('does not accept an empty successful report', () => {
    expect(verificationResultSchema.safeParse({ policy: 'offline-verification-v1', toolId: 'T35', nodeVersion: 'v24', outcome: 'PASSED', checks: [], limitations: ['Synthetic.'] }).success).toBe(false);
  });
});
