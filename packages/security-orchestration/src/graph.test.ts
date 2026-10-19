import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MemorySaver } from '@langchain/langgraph';
import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain';
import { createSecurityWorkflow } from './graph.js';
import { manifestDigest, securityThread, type ArtifactReceipt, type SecurityScope, type SecurityWorkflowServices } from './contracts.js';
import { SecurityCheckpointer, type EncryptedCheckpoint, type EncryptedWrite, type SecurityCheckpointStorage } from './checkpointer.js';

const scope = (): SecurityScope => ({ tenantId: randomUUID(), websiteId: randomUUID(), environment: 'STAGING', runId: randomUUID() });
const artifact = (): ArtifactReceipt => ({ artifactId: randomUUID(), digest: 'a'.repeat(64) });
function fixture() {
  const steps: string[] = [], decisions: string[] = [], transitions: string[] = [];
  let allowed = true, approved = true, blockedAt = '', completed = false;
  const results = new Map<string, ArtifactReceipt>();
  const services: SecurityWorkflowServices = {
    async assertLeaseAndAuthority() { if (!allowed) throw new Error('AUTHORITY_REVOKED'); },
    async step(step) {
      if (step === blockedAt) return { outcome: 'BLOCKED', code: 'FIXTURE_RUNTIME_UNAVAILABLE' };
      // Fixture journal proves only graph behavior; not production execution.
      let result = results.get(step);
      if (!result) { steps.push(step); result = artifact(); results.set(step, result); }
      if (step === 'post_verify') completed = true;
      return { outcome: 'SUCCEEDED', artifact: result, costMicros: 0 };
    },
    async decision(kind, id) { decisions.push(`${kind}:${id}`); return approved ? 'APPROVED' : 'DENIED'; },
    async transition(phase) { if (phase === 'COMPLETED' && !completed) throw new Error('NO_POST_VERIFICATION'); transitions.push(phase); }
  };
  return { services, steps, decisions, transitions, deny: () => { approved = false; }, revoke: () => { allowed = false; }, block: (step: string) => { blockedAt = step; }, unblock: () => { blockedAt = ''; } };
}
function memoryStorage() {
  const checkpoints = new Map<string, EncryptedCheckpoint>(), writes = new Map<string, EncryptedWrite>();
  const storage: SecurityCheckpointStorage = {
    async assertLease() {},
    async checkpoint(_scope, id) { return id ? checkpoints.get(id) : [...checkpoints.values()].sort((a, b) => b.checkpointId.localeCompare(a.checkpointId))[0]; },
    async checkpoints(_scope, limit, before) { return [...checkpoints.values()].filter(row => !before || row.checkpointId < before).sort((a, b) => b.checkpointId.localeCompare(a.checkpointId)).slice(0, limit); },
    async putCheckpoint(_scope, value) { checkpoints.set(value.checkpointId, value); },
    async writes(_scope, checkpointId) { return [...writes.entries()].filter(([id]) => id.startsWith(`${checkpointId}:`)).map(([, row]) => row); },
    async putWrite(_scope, id, row) { const key = `${id}:${row.taskId}:${row.index}`; if (row.index < 0 || !writes.has(key)) writes.set(key, row); }
  };
  return { storage, checkpoints, writes };
}

describe('security graph contracts (in-memory protocol fixtures only)', () => {
  it('refuses every installed external-tracing flag and a later inherited tracer before graph work', async () => {
    const s = scope(), f = fixture(), saver = new MemorySaver();
    for (const name of ['LANGSMITH_TRACING', 'LANGSMITH_TRACING_V2', 'LANGCHAIN_TRACING_V2', 'LANGCHAIN_TRACING', 'LANGCHAIN_VERBOSE']) {
      try { vi.stubEnv(name, 'true'); expect(() => createSecurityWorkflow(s, saver, f.services)).toThrow('SECURITY_EXTERNAL_TRACING_DENIED'); }
      finally { vi.unstubAllEnvs(); }
    }
    const workflow = createSecurityWorkflow(s, saver, f.services);
    try {
      vi.stubEnv('LANGSMITH_TRACING_V2', 'true');
      await expect(workflow.start()).rejects.toThrow('SECURITY_EXTERNAL_TRACING_DENIED');
    } finally { vi.unstubAllEnvs(); }
    const inherited = vi.spyOn(LangChainTracer, 'getTraceableRunTree').mockReturnValue({ tracingEnabled: true } as NonNullable<ReturnType<typeof LangChainTracer.getTraceableRunTree>>);
    try { await expect(workflow.start()).rejects.toThrow('SECURITY_EXTERNAL_TRACING_DENIED'); }
    finally { inherited.mockRestore(); }
    expect(f.steps).toEqual([]);
  });
  it('hashes manifests canonically and rejects non-JSON/oversized values', () => {
    expect(manifestDigest({ b: 2, a: 1 })).toBe(manifestDigest({ a: 1, b: 2 }));
    expect(() => manifestDigest({ value: undefined })).toThrow('SECURITY_MANIFEST_INVALID');
    expect(() => manifestDigest('x'.repeat(70_000))).toThrow('SECURITY_MANIFEST_LIMIT');
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => manifestDigest(cyclic)).toThrow('SECURITY_MANIFEST_LIMIT');
  });
  it('maps exact tenant/site/environment/run identity, rejecting caller additions', () => {
    const s = scope(); expect(securityThread(s).length).toBeLessThan(255);
    expect(securityThread(s)).not.toBe(securityThread({ ...s, websiteId: randomUUID() }));
    expect(() => securityThread({ ...s, command: 'ignore policy' } as SecurityScope)).toThrow();
  });
  it('pauses without snapshot/apply and resumes only from a saved-decision identifier', async () => {
    const s = scope(), f = fixture(), saver = new MemorySaver();
    const first = await createSecurityWorkflow(s, saver, f.services).start();
    expect(first).toHaveProperty('__interrupt__.length', 1); expect(f.steps).toEqual(['plan']);
    await expect(createSecurityWorkflow(s, saver, f.services).resume({ approved: true })).rejects.toThrow();
    const second = await createSecurityWorkflow(s, saver, f.services).resume({ decisionId: randomUUID() });
    expect(second).toHaveProperty('__interrupt__.length', 1);
    expect(f.steps).toEqual(['plan', 'snapshot', 'candidate', 'verify', 'proposal']);
    expect(f.steps).not.toContain('apply');
    const done = await createSecurityWorkflow(s, saver, f.services).resume({ decisionId: randomUUID() });
    expect(f.steps).toEqual(['plan', 'snapshot', 'candidate', 'verify', 'proposal', 'apply', 'post_verify']);
    expect(done.phase).toBe('COMPLETED'); expect(f.transitions).not.toContain('COMPLETED');
    await expect(createSecurityWorkflow(s, saver, f.services).resume({ decisionId: randomUUID() })).rejects.toThrow('SECURITY_WORKFLOW_NOT_WAITING');
    await expect(createSecurityWorkflow(s, saver, f.services).start()).rejects.toThrow('SECURITY_WORKFLOW_ALREADY_STARTED');
  });
  it('preserves a denial and never performs candidate or production work', async () => {
    const s = scope(), f = fixture(), saver = new MemorySaver();
    await createSecurityWorkflow(s, saver, f.services).start(); f.deny();
    const stopped = await createSecurityWorkflow(s, saver, f.services).resume({ decisionId: randomUUID() });
    expect(f.steps).toEqual(['plan']); expect(stopped.phase).toBe('CANCELLED'); expect(f.transitions).not.toContain('CANCELLED');
  });
  it('blocks missing runtime honestly and never falls back to another executor', async () => {
    const s = scope(), f = fixture(), saver = new MemorySaver(); f.block('snapshot');
    await createSecurityWorkflow(s, saver, f.services).start();
    await createSecurityWorkflow(s, saver, f.services).resume({ decisionId: randomUUID() });
    expect(f.steps).toEqual(['plan']); expect(f.transitions.at(-1)).toBe('WAITING_FOR_INPUT');
  });
  it('persists a prerequisite wait and explicitly rechecks only its saved step without replaying the plan', async () => {
    const s = scope(), f = fixture(), saver = new MemorySaver(); f.block('snapshot');
    const workflow = () => createSecurityWorkflow(s, saver, f.services);
    await expect(workflow().recheckPrerequisites()).rejects.toThrow('SECURITY_READINESS_NOT_RESUMABLE');
    await workflow().start();
    await workflow().resume({ decisionId: randomUUID() });
    expect(await workflow().status()).toMatchObject({ phase: 'WAITING_FOR_INPUT', blockedStep: 'snapshot', blockCode: 'FIXTURE_RUNTIME_UNAVAILABLE' });
    await expect(workflow().resume({ decisionId: randomUUID() })).rejects.toThrow('SECURITY_WORKFLOW_NOT_WAITING');
    await expect(workflow().continueAfterRestart()).rejects.toThrow('SECURITY_WORKFLOW_NOT_RESUMABLE');
    await workflow().recheckPrerequisites(); expect(f.steps).toEqual(['plan']);
    f.unblock(); await workflow().recheckPrerequisites();
    expect(f.steps).toEqual(['plan', 'snapshot', 'candidate', 'verify', 'proposal']);
    expect(f.steps).not.toContain('apply'); expect(new Set(f.decisions).size).toBe(1);
    expect(await workflow().status()).toMatchObject({ phase: 'AWAITING_APPROVAL', blockedStep: null, blockCode: null });
  });
  it('fences revoked authority before a saved approval can resume', async () => {
    const s = scope(), f = fixture(), saver = new MemorySaver();
    await createSecurityWorkflow(s, saver, f.services).start(); f.revoke();
    await expect(createSecurityWorkflow(s, saver, f.services).resume({ decisionId: randomUUID() })).rejects.toThrow('AUTHORITY_REVOKED');
    expect(f.steps).toEqual(['plan']);
  });
});

describe('encrypted scoped checkpoint adapter (memory storage, not PostgreSQL proof)', () => {
  it('rebuilds a graph instance with encrypted checkpoints and retained pending writes', async () => {
    const s = scope(), f = fixture(), mem = memoryStorage(), key = Buffer.alloc(32, 7).toString('base64');
    await createSecurityWorkflow(s, new SecurityCheckpointer(s, mem.storage, key), f.services).start();
    expect(mem.checkpoints.size).toBeGreaterThan(1);
    expect(JSON.stringify([...mem.checkpoints.values()])).not.toContain('AWAITING_APPROVAL');
    await createSecurityWorkflow(s, new SecurityCheckpointer(s, mem.storage, key), f.services).resume({ decisionId: randomUUID() });
    expect(f.steps.filter(step => step === 'plan')).toHaveLength(1);
    expect(f.steps).not.toContain('apply');
  });
  it('returns authenticated normal-terminal intent on restart without invoking any graph node', async () => {
    for (const phase of ['CANCELLED', 'COMPLETED']) {
      const s = scope(), f = fixture(), mem = memoryStorage(), key = Buffer.alloc(32, 12).toString('base64');
      const workflow = () => createSecurityWorkflow(s, new SecurityCheckpointer(s, mem.storage, key), f.services);
      await workflow().start();
      if (phase === 'CANCELLED') f.deny();
      await workflow().resume({ decisionId: randomUUID() });
      if (phase === 'COMPLETED') await workflow().resume({ decisionId: randomUUID() });
      const before = { steps: [...f.steps], decisions: [...f.decisions], transitions: [...f.transitions], checkpoints: mem.checkpoints.size, writes: mem.writes.size };
      expect(await workflow().continueAfterRestart()).toMatchObject({ phase });
      expect({ steps: f.steps, decisions: f.decisions, transitions: f.transitions, checkpoints: mem.checkpoints.size, writes: mem.writes.size }).toEqual(before);
      f.revoke(); await expect(workflow().continueAfterRestart()).rejects.toThrow('AUTHORITY_REVOKED');
      const last = (await mem.storage.checkpoint(s))!; last.encryptedEnvelope += '!';
      await expect(new SecurityCheckpointer(s, mem.storage, key).getTuple({ configurable: { thread_id: securityThread(s) } })).rejects.toThrow('SECURITY_CHECKPOINT_INVALID');
    }
  });
  it('denies another tenant/thread, subgraphs and history deletion', async () => {
    const s = scope(), mem = memoryStorage(), cp = new SecurityCheckpointer(s, mem.storage, Buffer.alloc(32, 8).toString('base64'));
    await expect(cp.getTuple({ configurable: { thread_id: securityThread({ ...s, tenantId: randomUUID() }) } })).rejects.toThrow('SECURITY_CHECKPOINT_INVALID');
    await expect(cp.getTuple({ configurable: { thread_id: securityThread(s), checkpoint_ns: 'untrusted-subgraph' } })).rejects.toThrow('SECURITY_CHECKPOINT_INVALID');
    await expect(cp.deleteThread(securityThread(s))).rejects.toThrow('SECURITY_HISTORY_PRESERVED');
  });
  it('fails closed on a wrong key, corrupt ciphertext and transplanted scope', async () => {
    const s = scope(), f = fixture(), mem = memoryStorage(), key = Buffer.alloc(32, 9).toString('base64');
    await createSecurityWorkflow(s, new SecurityCheckpointer(s, mem.storage, key), f.services).start();
    const config = { configurable: { thread_id: securityThread(s) } };
    await expect(new SecurityCheckpointer(s, mem.storage, Buffer.alloc(32, 10).toString('base64')).getTuple(config)).rejects.toThrow('SECURITY_CHECKPOINT_INVALID');
    const sibling = { ...s, websiteId: randomUUID() };
    await expect(new SecurityCheckpointer(sibling, mem.storage, key).getTuple({ configurable: { thread_id: securityThread(sibling) } })).rejects.toThrow('SECURITY_CHECKPOINT_INVALID');
    const last = await mem.storage.checkpoint(s); last!.encryptedEnvelope += '!';
    await expect(new SecurityCheckpointer(s, mem.storage, key).getTuple(config)).rejects.toThrow('SECURITY_CHECKPOINT_INVALID');
  });
  it('authenticates checkpoint ancestry and pending-write ordering metadata', async () => {
    const s = scope(), f = fixture(), mem = memoryStorage(), key = Buffer.alloc(32, 11).toString('base64');
    const cp = new SecurityCheckpointer(s, mem.storage, key);
    await createSecurityWorkflow(s, cp, f.services).start();
    const last = (await mem.storage.checkpoint(s))!;
    const parent = last.parentCheckpointId;
    last.parentCheckpointId = randomUUID();
    await expect(cp.getTuple({ configurable: { thread_id: securityThread(s) } })).rejects.toThrow('SECURITY_CHECKPOINT_INVALID');
    last.parentCheckpointId = parent;
    const [identity, write] = [...mem.writes.entries()][0]!;
    write.taskPath += ':tampered-order';
    await expect(cp.getTuple({ configurable: { thread_id: securityThread(s), checkpoint_id: identity.split(':')[0] } })).rejects.toThrow('SECURITY_CHECKPOINT_INVALID');
  });
});
