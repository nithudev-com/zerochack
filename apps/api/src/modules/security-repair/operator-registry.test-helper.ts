import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import type { Prisma, SecurityRepairRun } from '@prisma/client';
import type { Environment } from '@zerochack/config';
import { manifestDigest } from '@zerochack/security-orchestration';
import { createSecurityOperatorRegistry, SECURITY_OPERATOR_DIRECTORY, type SecurityOperatorAttestation } from './operator-registry.js';
import type { SecurityManagedEnrollment, SecurityRepairAdmission } from './product-contracts.js';

export function operatorFixture() {
  const now = new Date(); const workerId = randomUUID();
  const environment = { SECURITY_REPAIR_ENABLED: true, SECURITY_REPAIR_CONFIG_FILE: `${SECURITY_OPERATOR_DIRECTORY}/fixture.json`, SECURITY_REPAIR_IMPLEMENTATION_DIGEST: 'b'.repeat(64), CARE_VAULT_KEY: randomBytes(32).toString('base64'), CARE_ARTIFACT_KEY: randomBytes(32).toString('base64'), INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64') } as Environment;
  const enrollment: SecurityManagedEnrollment = { id: randomUUID(), revision: 1, tenantId: randomUUID(), websiteId: randomUUID(), actorId: randomUUID(), label: 'Operator managed staging fixture', environment: 'STAGING', adapter: 'MANAGED_STATIC_PERMISSION_V1', enabled: true, expiresAt: new Date(now.getTime() + 600000).toISOString(), credentialId: randomUUID(), credentialVersion: 1, namespaceId: randomUUID(), targetId: randomUUID(), hostKeyFingerprint: `SHA256:${'a'.repeat(43)}`, attestationDigest: 'a'.repeat(64), implementationDigest: environment.SECURITY_REPAIR_IMPLEMENTATION_DIGEST!, allowanceMicros: 0, proof: { independentWriterExcluded: true, publisherReadOnly: true, rootOwned: true, forcedCommandOnly: true, recoveryEncrypted: true } };
  const attestation: SecurityOperatorAttestation = { version: 1, adapter: enrollment.adapter, environment: 'STAGING', enrollmentId: enrollment.id, enrollmentRevision: enrollment.revision, tenantId: enrollment.tenantId, websiteId: enrollment.websiteId, actorId: enrollment.actorId, namespaceId: enrollment.namespaceId, targetId: enrollment.targetId, credentialId: enrollment.credentialId, credentialVersion: enrollment.credentialVersion, implementationDigest: enrollment.implementationDigest, expiresAt: enrollment.expiresAt, proof: { ...enrollment.proof }, access: { address: '8.8.8.8', port: 2222, username: 'codebandage-managed-target', hostKeyFingerprint: enrollment.hostKeyFingerprint }, forcedCommand: 'codebandage-managed-target-v1' };
  const entry = { enrollment, permitKeyFile: `${SECURITY_OPERATOR_DIRECTORY}/permit.key`, recoveryKeyFile: `${SECURITY_OPERATOR_DIRECTORY}/recovery.key`, attestationFile: `${SECURITY_OPERATOR_DIRECTORY}/attestation.json` };
  const document = { version: 1, enrollments: [entry] };
  type File = { bytes: Buffer; uid: number; gid: number; mode: number; nlink: number; inode: number; symlink: boolean; directory: boolean; mtime: number };
  const nodes = new Map<string, File>(); const buffers = new Map<string, Buffer>(); const opens: Array<{ path: string; flags: number }> = []; const closed: string[] = [];
  let inode = 1; let onRead: ((path: string) => void) | undefined;
  function put(path: string, bytes: Buffer, directory = false) { nodes.set(path, { bytes: Buffer.from(bytes), uid: 0, gid: 0, mode: directory ? 0o755 : 0o440, nlink: directory ? 2 : 1, inode: inode++, symlink: false, directory, mtime: 1 }); }
  for (const path of ['/', '/etc', '/etc/codebandage', SECURITY_OPERATOR_DIRECTORY]) put(path, Buffer.alloc(0), true);
  nodes.get(SECURITY_OPERATOR_DIRECTORY)!.mode = 0o700;
  put(entry.permitKeyFile, randomBytes(32)); put(entry.recoveryKeyFile, randomBytes(32));
  nodes.get(entry.permitKeyFile)!.mode = 0o400; nodes.get(entry.recoveryKeyFile)!.mode = 0o400;
  function writeDocument() { const old = nodes.get(environment.SECURITY_REPAIR_CONFIG_FILE!); put(environment.SECURITY_REPAIR_CONFIG_FILE!, Buffer.from(JSON.stringify(document))); if (old) nodes.get(environment.SECURITY_REPAIR_CONFIG_FILE!)!.mode = old.mode; }
  function writeAttestation() { const bytes = Buffer.from(JSON.stringify(attestation)); enrollment.attestationDigest = createHash('sha256').update(bytes).digest('hex'); put(entry.attestationFile, bytes); writeDocument(); }
  writeAttestation();
  function stat(path: string): Stats { const node = nodes.get(path); if (!node) throw new Error('ENOENT'); return { dev: 1, ino: node.inode, uid: node.uid, gid: node.gid, mode: node.mode, nlink: node.nlink, size: node.bytes.length, mtimeMs: node.mtime, ctimeMs: node.mtime, isDirectory: () => node.directory, isFile: () => !node.directory && !node.symlink, isSymbolicLink: () => node.symlink } as Stats; }
  const files = {
    async lstat(path: string) { return stat(path); },
    async open(path: string, flags: number) {
      opens.push({ path, flags }); if ((flags & constants.O_NOFOLLOW) === 0 || (flags & constants.O_NONBLOCK) === 0) throw new Error('Unprotected open');
      return { stat: async () => stat(path), async read(buffer: Buffer, offset: number, length: number, position: number) { buffers.set(path, buffer); const bytesRead = nodes.get(path)!.bytes.copy(buffer, offset, position, position + length); onRead?.(path); return { bytesRead, buffer }; }, async close() { closed.push(path); } } as unknown as FileHandle;
    }
  };
  const registry = createSecurityOperatorRegistry(environment, { files, identity: { uid: 0, gid: 0 } });
  const tx = {} as Prisma.TransactionClient;
  const admission: SecurityRepairAdmission = { version: 1, scope: { tenantId: enrollment.tenantId, websiteId: enrollment.websiteId, environment: 'STAGING', runId: randomUUID() }, actorId: enrollment.actorId, sessionId: randomUUID(), requestKey: randomUUID(), operation: 'HARDEN', recoveryRunId: null, enrollment: structuredClone(enrollment), enrollmentDigest: manifestDigest(enrollment), entitlement: { kind: 'PAID_SUBSCRIPTION', id: randomUUID(), packageVersionId: randomUUID(), termsDigest: 'c'.repeat(64), expiresAt: enrollment.expiresAt }, authorityDigest: 'd'.repeat(64), requestDigest: 'e'.repeat(64), implementationDigest: enrollment.implementationDigest, allowanceMicros: 0, expiresAt: enrollment.expiresAt };
  const run = { id: admission.scope.runId, tenantId: admission.scope.tenantId, websiteId: admission.scope.websiteId, environment: 'STAGING', actorId: admission.actorId, sessionId: admission.sessionId, requestKey: admission.requestKey, authorityDigest: admission.authorityDigest, inputDigest: 'f'.repeat(64), allowanceMicros: admission.allowanceMicros, expiresAt: new Date(admission.expiresAt), executionProfile: enrollment.adapter, admissionArtifactId: randomUUID(), admissionDigest: '0'.repeat(64) } as SecurityRepairRun;
  return { now, workerId, environment, enrollment, attestation, entry, document, nodes, buffers, opens, closed, files, registry, tx, admission, run, writeDocument, writeAttestation, onRead(fn: (path: string) => void) { onRead = fn; } };
}
