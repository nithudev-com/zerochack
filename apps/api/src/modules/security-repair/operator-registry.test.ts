import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSecurityOperatorRegistry, SECURITY_OPERATOR_DIRECTORY } from './operator-registry.js';
import { operatorFixture } from './operator-registry.test-helper.js';

describe('protected operator security registry', () => {
  it('remains empty with the feature disabled or absent configuration, without opening a file', async () => {
    const f = operatorFixture();
    for (const environment of [{ ...f.environment, SECURITY_REPAIR_ENABLED: false }, { ...f.environment, SECURITY_REPAIR_CONFIG_FILE: undefined }]) {
      const registry = createSecurityOperatorRegistry(environment, { files: f.files });
      expect(registry.configured).toBe(false); expect(await registry.list(f.tx, f.enrollment.tenantId, f.enrollment.websiteId)).toEqual([]);
      await expect(registry.resolve(f.enrollment)).rejects.toMatchObject({ code: 'SECURITY_OPERATOR_CONFIG_UNAVAILABLE' });
    }
    expect(f.opens).toEqual([]);
  });
  it('validates root-owned protected files, reloads each authority call and returns fresh owned keys', async () => {
    const f = operatorFixture();
    expect(await f.registry.list(f.tx, f.enrollment.tenantId, f.enrollment.websiteId)).toEqual([f.enrollment]);
    expect(f.buffers.get(f.entry.permitKeyFile)!.every(byte => byte === 0)).toBe(true);
    expect(f.buffers.get(f.entry.recoveryKeyFile)!.every(byte => byte === 0)).toBe(true);
    const first = await f.registry.resolve(f.enrollment), second = await f.registry.resolve(f.enrollment);
    expect(first.permitKey).not.toBe(second.permitKey); expect(first.permitKey.equals(second.permitKey)).toBe(true);
    first.permitKey.fill(0); first.recoveryKey.fill(0); expect(second.permitKey.some(byte => byte !== 0)).toBe(true); second.permitKey.fill(0); second.recoveryKey.fill(0);
    f.document.enrollments.length = 0; f.writeDocument();
    expect(await f.registry.list(f.tx, f.enrollment.tenantId, f.enrollment.websiteId)).toEqual([]);
    await expect(f.registry.resolve(f.enrollment)).rejects.toMatchObject({ code: 'SECURITY_OPERATOR_CONFIG_UNAVAILABLE' });
    expect(f.closed).toHaveLength(f.opens.length);
  });
  it('rejects writable, symlinked, hard-linked and non-root files or parent directories', async () => {
    for (const alter of [
      (f: ReturnType<typeof operatorFixture>) => { f.nodes.get(f.entry.permitKeyFile)!.mode = 0o640; },
      (f: ReturnType<typeof operatorFixture>) => { f.nodes.get(f.entry.attestationFile)!.symlink = true; },
      (f: ReturnType<typeof operatorFixture>) => { f.nodes.get(f.entry.recoveryKeyFile)!.nlink = 2; },
      (f: ReturnType<typeof operatorFixture>) => { f.nodes.get(f.entry.permitKeyFile)!.uid = 1000; },
      (f: ReturnType<typeof operatorFixture>) => { f.nodes.get(SECURITY_OPERATOR_DIRECTORY)!.mode = 0o775; },
      (f: ReturnType<typeof operatorFixture>) => { f.nodes.get('/etc/codebandage')!.symlink = true; }
    ]) { const f = operatorFixture(); alter(f); await expect(f.registry.resolve(f.enrollment)).rejects.toMatchObject({ code: 'SECURITY_OPERATOR_CONFIG_UNAVAILABLE' }); }
  });
  it('bounds files, refuses changed metadata during the FD read and closes every handle', async () => {
    const f = operatorFixture(); f.onRead(path => { if (path === f.entry.attestationFile) f.nodes.get(path)!.mtime++; });
    await expect(f.registry.resolve(f.enrollment)).rejects.toMatchObject({ code: 'SECURITY_OPERATOR_CONFIG_UNAVAILABLE' }); expect(f.closed).toHaveLength(f.opens.length);
    const huge = operatorFixture(); huge.nodes.get(huge.environment.SECURITY_REPAIR_CONFIG_FILE!)!.bytes = Buffer.alloc(256001);
    await expect(huge.registry.resolve(huge.enrollment)).rejects.toMatchObject({ code: 'SECURITY_OPERATOR_CONFIG_UNAVAILABLE' }); expect(huge.opens).toEqual([]);
  });
  it('refuses escaping operator paths and duplicate enrollment or target identities', async () => {
    for (const path of ['/tmp/operator.json', `${SECURITY_OPERATOR_DIRECTORY}/../outside.json`, `${SECURITY_OPERATOR_DIRECTORY}/sub/config.json`]) {
      const f = operatorFixture(); const registry = createSecurityOperatorRegistry({ ...f.environment, SECURITY_REPAIR_CONFIG_FILE: path }, { files: f.files });
      await expect(registry.list(f.tx, f.enrollment.tenantId, f.enrollment.websiteId)).rejects.toMatchObject({ code: 'SECURITY_OPERATOR_CONFIG_UNAVAILABLE' }); expect(f.opens).toEqual([]);
    }
    const f = operatorFixture(); f.entry.permitKeyFile = '/tmp/permit.key'; f.writeDocument();
    await expect(f.registry.resolve(f.enrollment)).rejects.toMatchObject({ code: 'SECURITY_OPERATOR_CONFIG_UNAVAILABLE' });
    const duplicate = operatorFixture(); duplicate.document.enrollments.push(structuredClone(duplicate.entry)); duplicate.writeDocument();
    await expect(duplicate.registry.resolve(duplicate.enrollment)).rejects.toMatchObject({ code: 'SECURITY_OPERATOR_CONFIG_UNAVAILABLE' });
  });
  it('requires independently stored exact attestation bytes and the pinned reviewed implementation', async () => {
    for (const alter of [
      (f: ReturnType<typeof operatorFixture>) => { f.nodes.get(f.entry.attestationFile)!.bytes[0] = 0; },
      (f: ReturnType<typeof operatorFixture>) => { f.attestation.actorId = randomUUID(); f.writeAttestation(); },
      (f: ReturnType<typeof operatorFixture>) => { f.attestation.namespaceId = randomUUID(); f.writeAttestation(); },
      (f: ReturnType<typeof operatorFixture>) => { f.attestation.proof.independentWriterExcluded = false as true; f.writeAttestation(); },
      (f: ReturnType<typeof operatorFixture>) => { f.attestation.forcedCommand = 'shell' as 'codebandage-managed-target-v1'; f.writeAttestation(); },
      (f: ReturnType<typeof operatorFixture>) => { f.enrollment.implementationDigest = 'c'.repeat(64); f.writeDocument(); }
    ]) { const f = operatorFixture(); alter(f); await expect(f.registry.resolve(f.enrollment)).rejects.toMatchObject({ code: 'SECURITY_OPERATOR_CONFIG_UNAVAILABLE' }); }
  });
  it('requires 32 raw bytes and separate permit, recovery, vault and artifact keys; zeros refusal buffers', async () => {
    for (const value of ['permit', 'vault', 'artifact', 'short']) {
      const f = operatorFixture(); f.nodes.get(f.entry.recoveryKeyFile)!.bytes = value === 'permit' ? Buffer.from(f.nodes.get(f.entry.permitKeyFile)!.bytes) : value === 'vault' ? Buffer.from(f.environment.CARE_VAULT_KEY!, 'base64') : value === 'artifact' ? Buffer.from(f.environment.CARE_ARTIFACT_KEY!, 'base64') : Buffer.alloc(31, 1);
      await expect(f.registry.resolve(f.enrollment)).rejects.toMatchObject({ code: 'SECURITY_OPERATOR_CONFIG_UNAVAILABLE' });
      for (const path of [f.entry.permitKeyFile, f.entry.recoveryKeyFile]) expect(f.buffers.get(path)!.every(byte => byte === 0)).toBe(true);
    }
  });
  it('keeps signing and recovery keys confidential from world, executable and generic groups', async () => {
    for (const mode of [0o444, 0o445, 0o450, 0o440]) {
      const f = operatorFixture(); f.nodes.get(f.entry.permitKeyFile)!.mode = mode;
      await expect(f.registry.resolve(f.enrollment)).rejects.toMatchObject({ code: 'SECURITY_OPERATOR_CONFIG_UNAVAILABLE' });
    }
    const f = operatorFixture(); f.nodes.get(SECURITY_OPERATOR_DIRECTORY)!.mode = 0o755;
    await expect(f.registry.resolve(f.enrollment)).rejects.toMatchObject({ code: 'SECURITY_OPERATOR_CONFIG_UNAVAILABLE' });
  });
  it('allows non-root Docker reads only through exact dedicated service GID and protected ancestors', async () => {
    const f = operatorFixture();
    for (const path of [f.entry.permitKeyFile, f.entry.recoveryKeyFile]) { f.nodes.get(path)!.mode = 0o440; f.nodes.get(path)!.gid = 1000; }
    f.nodes.get(SECURITY_OPERATOR_DIRECTORY)!.mode = 0o750; f.nodes.get(SECURITY_OPERATOR_DIRECTORY)!.gid = 1000;
    const registry = createSecurityOperatorRegistry(f.environment, { files: f.files, identity: { uid: 1000, gid: 1000 } });
    const material = await registry.resolve(f.enrollment); material.permitKey.fill(0); material.recoveryKey.fill(0);
    f.nodes.get(f.entry.recoveryKeyFile)!.gid = 1001;
    await expect(registry.resolve(f.enrollment)).rejects.toMatchObject({ code: 'SECURITY_OPERATOR_CONFIG_UNAVAILABLE' });
    f.nodes.get(f.entry.recoveryKeyFile)!.gid = 1000; f.nodes.get(SECURITY_OPERATOR_DIRECTORY)!.gid = 1001;
    await expect(registry.resolve(f.enrollment)).rejects.toMatchObject({ code: 'SECURITY_OPERATOR_CONFIG_UNAVAILABLE' });
  });
  it('matches the default broker public IPv4 eligibility before reporting an enrolled capability', async () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '203.0.113.10', '2606:4700:4700::1111', 'example.com']) {
      const f = operatorFixture(); f.attestation.access.address = address; f.writeAttestation();
      await expect(f.registry.list(f.tx, f.enrollment.tenantId, f.enrollment.websiteId)).rejects.toMatchObject({ code: 'SECURITY_OPERATOR_CONFIG_UNAVAILABLE' });
    }
  });
});
