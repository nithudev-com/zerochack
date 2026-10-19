import { constants, type Stats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { Environment } from '@zerochack/config';
import { manifestDigest, SecurityWorkflowError, sha256, uuid } from '@zerochack/security-orchestration';
import { z } from 'zod';
import { isPublicIpv4 } from '../../../../../infrastructure/security-managed-target/broker.cjs';
import { SECURITY_MANAGED_ADAPTER, securityEnrollmentSchema, type SecurityEnrollmentRegistry, type SecurityManagedEnrollment } from './product-contracts.js';

export const SECURITY_OPERATOR_DIRECTORY = '/etc/codebandage/security-repair';
const CONFIG_LIMIT = 256_000;
const ATTESTATION_LIMIT = 16_000;
const proofSchema = securityEnrollmentSchema.shape.proof;
/** An operator's independently provisioned, immutable attestation. A request's
 * checkboxes are never an alternative to this protected file and its byte hash. */
export const securityOperatorAttestationSchema = z.object({
  version: z.literal(1), adapter: z.literal(SECURITY_MANAGED_ADAPTER), environment: z.literal('STAGING'),
  enrollmentId: uuid, enrollmentRevision: z.number().int().positive(), tenantId: uuid, websiteId: uuid, actorId: uuid,
  namespaceId: uuid, targetId: uuid, credentialId: uuid, credentialVersion: z.number().int().positive(),
  implementationDigest: sha256, expiresAt: z.iso.datetime(), proof: proofSchema,
  access: z.object({ address: z.string().max(253).refine(isPublicIpv4), port: z.number().int().min(1).max(65535), username: z.literal('codebandage-managed-target'), hostKeyFingerprint: securityEnrollmentSchema.shape.hostKeyFingerprint }).strict(),
  forcedCommand: z.literal('codebandage-managed-target-v1')
}).strict();
export type SecurityOperatorAttestation = z.infer<typeof securityOperatorAttestationSchema>;
const registrySchema = z.object({ version: z.literal(1), enrollments: z.array(z.object({ enrollment: securityEnrollmentSchema, permitKeyFile: z.string().min(1).max(512), recoveryKeyFile: z.string().min(1).max(512), attestationFile: z.string().min(1).max(512) }).strict()).max(256) }).strict();
type Entry = z.infer<typeof registrySchema>['enrollments'][number];
export type SecurityOperatorMaterial = { enrollment: SecurityManagedEnrollment; attestation: SecurityOperatorAttestation; permitKey: Buffer; recoveryKey: Buffer };
export type SecurityOperatorRegistry = SecurityEnrollmentRegistry & {
  readonly configured: boolean;
  /** Caller owns these fresh buffers and must zero them on success and failure. */
  resolve(enrollment: SecurityManagedEnrollment): Promise<SecurityOperatorMaterial>;
};
type FileSystem = { lstat(path: string): Promise<Stats>; open(path: string, flags: number): Promise<FileHandle> };
type ServiceIdentity = { uid: number; gid: number };
const fail = (): never => { throw new SecurityWorkflowError('SECURITY_OPERATOR_CONFIG_UNAVAILABLE'); };
function protectedPath(path: string, registry = false) {
  if (!isAbsolute(path) || resolve(path) !== path || !path.startsWith(SECURITY_OPERATOR_DIRECTORY + '/') || path.includes('\0') || registry && (dirname(path) !== SECURITY_OPERATOR_DIRECTORY || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}\.json$/u.test(path.slice(SECURITY_OPERATOR_DIRECTORY.length + 1)))) fail();
  return path;
}
function validDirectory(stat: Stats) { return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0; }
function validFile(stat: Stats, maximum: number) { return stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && stat.nlink === 1 && (stat.mode & 0o222) === 0 && stat.size > 0 && stat.size <= maximum; }
function sameFile(left: Stats, right: Stats) { return ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every(key => left[key as keyof Stats] === right[key as keyof Stats]); }
async function protectedRead(files: FileSystem, path: string, maximum: number, secretIdentity?: ServiceIdentity): Promise<Buffer> {
  let handle: FileHandle | undefined; let bytes: Buffer | undefined;
  try {
    protectedPath(path);
    const parents: Array<{ path: string; stat: Stats }> = [];
    for (let current = dirname(path); ; current = dirname(current)) {
      const stat = await files.lstat(current); if (!validDirectory(stat)) fail(); parents.push({ path: current, stat }); if (current === '/') break;
    }
    const link = await files.lstat(path); if (!validFile(link, maximum)) fail();
    if (secretIdentity) {
      const mode = link.mode & 0o777;
      const shared = mode === 0o440 && secretIdentity.uid > 0 && secretIdentity.gid > 0 && link.gid === secretIdentity.gid;
      if (mode !== 0o400 && !shared) fail();
      for (const parent of parents.filter(item => item.path === SECURITY_OPERATOR_DIRECTORY || item.path.startsWith(SECURITY_OPERATOR_DIRECTORY + '/'))) {
        const permissions = parent.stat.mode & 0o777;
        if (shared ? permissions !== 0o750 || parent.stat.gid !== secretIdentity.gid : permissions !== 0o700 && permissions !== 0o750) fail();
      }
    }
    handle = await files.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat(); if (!validFile(before, maximum) || !sameFile(link, before)) fail();
    bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (bytesRead <= 0) fail(); offset += bytesRead; }
    const after = await handle.stat(); if (!validFile(after, maximum) || !sameFile(before, after) || !sameFile(after, await files.lstat(path))) fail();
    for (const parent of parents) { const current = await files.lstat(parent.path); if (!validDirectory(current) || current.dev !== parent.stat.dev || current.ino !== parent.stat.ino || current.mode !== parent.stat.mode || current.uid !== parent.stat.uid || current.gid !== parent.stat.gid) fail(); }
    return bytes;
  } catch { bytes?.fill(0); return fail(); }
  finally { await handle?.close().catch(() => undefined); }
}
function parseJson<T>(bytes: Buffer, schema: z.ZodType<T>): T { try { return schema.parse(JSON.parse(bytes.toString('utf8'))); } catch { return fail(); } finally { bytes.fill(0); } }
function canonicalKey(value: string) { const bytes = Buffer.from(value, 'base64'); if (bytes.length !== 32 || bytes.toString('base64') !== value) { bytes.fill(0); return fail(); } return bytes; }

/** Production always uses the fixed directory mounted read-only into the API and
 * worker. Root processes use root-owned 0400 keys below 0700/0750 directories.
 * A non-root Docker USER must have a dedicated nonzero UID/GID: root-owned keys
 * may be 0440 only with that exact GID, and protected directories must be 0750
 * with the same GID. Never use group 0, world-readable keys or writable mounts.
 * The filesystem/identity seams are trusted tests only, never route parameters. */
export function createSecurityOperatorRegistry(environment: Environment, internal?: { files?: FileSystem; identity?: ServiceIdentity }): SecurityOperatorRegistry {
  const files = internal?.files ?? { lstat, open };
  const identity = internal?.identity ?? { uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1 };
  const config = environment.SECURITY_REPAIR_CONFIG_FILE;
  const implementationDigest = environment.SECURITY_REPAIR_IMPLEMENTATION_DIGEST;
  const configured = environment.SECURITY_REPAIR_ENABLED === true && Boolean(config) && Boolean(implementationDigest);
  async function entries() {
    if (!configured || !config || !implementationDigest || !sha256.safeParse(implementationDigest).success) return fail();
    protectedPath(config, true);
    const value = parseJson(await protectedRead(files, config, CONFIG_LIMIT), registrySchema);
    const identities = new Set<string>(), targets = new Set<string>();
    for (const entry of value.enrollments) {
      const identity = entry.enrollment.id, target = `${entry.enrollment.namespaceId}:${entry.enrollment.targetId}`;
      if (identities.has(identity) || targets.has(target)) fail(); identities.add(identity); targets.add(target);
      for (const path of [entry.permitKeyFile, entry.recoveryKeyFile, entry.attestationFile]) protectedPath(path);
      if (entry.permitKeyFile === entry.recoveryKeyFile || entry.enrollment.implementationDigest !== implementationDigest) fail();
    }
    return value.enrollments;
  }
  async function material(entry: Entry): Promise<SecurityOperatorMaterial> {
    let permitKey: Buffer | undefined, recoveryKey: Buffer | undefined; const otherKeys: Buffer[] = [];
    try {
      const { enrollment } = entry;
      const bytes = await protectedRead(files, entry.attestationFile, ATTESTATION_LIMIT);
      if (createHash('sha256').update(bytes).digest('hex') !== enrollment.attestationDigest) { bytes.fill(0); fail(); }
      const attestation = parseJson(bytes, securityOperatorAttestationSchema);
      if (attestation.enrollmentId !== enrollment.id || attestation.enrollmentRevision !== enrollment.revision || attestation.tenantId !== enrollment.tenantId || attestation.websiteId !== enrollment.websiteId || attestation.actorId !== enrollment.actorId || attestation.namespaceId !== enrollment.namespaceId || attestation.targetId !== enrollment.targetId || attestation.credentialId !== enrollment.credentialId || attestation.credentialVersion !== enrollment.credentialVersion || attestation.access.hostKeyFingerprint !== enrollment.hostKeyFingerprint || attestation.implementationDigest !== implementationDigest || manifestDigest(attestation.proof) !== manifestDigest(enrollment.proof) || new Date(attestation.expiresAt) < new Date(enrollment.expiresAt)) fail();
      permitKey = await protectedRead(files, entry.permitKeyFile, 32, identity); recoveryKey = await protectedRead(files, entry.recoveryKeyFile, 32, identity);
      if (permitKey.length !== 32 || recoveryKey.length !== 32 || permitKey.every(byte => byte === 0) || recoveryKey.every(byte => byte === 0) || timingSafeEqual(permitKey, recoveryKey)) fail();
      for (const value of [environment.CARE_VAULT_KEY ?? environment.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY, environment.CARE_ARTIFACT_KEY ?? environment.CARE_VAULT_KEY ?? environment.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY]) otherKeys.push(canonicalKey(value));
      if (otherKeys.some(key => timingSafeEqual(recoveryKey!, key) || timingSafeEqual(permitKey!, key))) fail();
      return { enrollment, attestation, permitKey, recoveryKey };
    } catch { permitKey?.fill(0); recoveryKey?.fill(0); return fail(); }
    finally { for (const key of otherKeys) key.fill(0); }
  }
  return {
    configured,
    async list(_tx, tenantId, websiteId) {
      if (!configured) return [];
      const result: SecurityManagedEnrollment[] = [];
      for (const entry of (await entries()).filter(item => item.enrollment.tenantId === tenantId && item.enrollment.websiteId === websiteId)) {
        const value = await material(entry);
        try { result.push(value.enrollment); } finally { value.permitKey.fill(0); value.recoveryKey.fill(0); }
      }
      return result;
    },
    async resolve(input) {
      const checked = securityEnrollmentSchema.parse(input);
      const found = (await entries()).find(entry => entry.enrollment.id === checked.id);
      if (!found || !found.enrollment.enabled || manifestDigest(found.enrollment) !== manifestDigest(checked)) return fail();
      return material(found);
    }
  };
}
