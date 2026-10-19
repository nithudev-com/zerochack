import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { BaseCheckpointSaver, compareWritesSortKeys, writesSortKey, WRITES_IDX_MAP, type ChannelVersions, type Checkpoint, type CheckpointListOptions, type CheckpointMetadata, type CheckpointTuple, type PendingWrite } from '@langchain/langgraph-checkpoint';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { scopeSchema, securityThread, SecurityWorkflowError, uuid, type SecurityScope } from './contracts.js';

export type EncryptedCheckpoint = { checkpointId: string; parentCheckpointId: string | null; encryptedEnvelope: string; digest: string };
export type EncryptedWrite = { taskId: string; index: number; taskPath: string; encryptedEnvelope: string; digest: string };
/** Every implementation must bind its SQL predicates/foreign keys to this scope.
 * No unscoped checkpoint listing or caller-selected thread exists in the API.
 */
export interface SecurityCheckpointStorage {
  assertLease(): Promise<void>;
  checkpoint(scope: SecurityScope, checkpointId?: string): Promise<EncryptedCheckpoint | undefined>;
  checkpoints(scope: SecurityScope, limit: number, before?: string): Promise<EncryptedCheckpoint[]>;
  putCheckpoint(scope: SecurityScope, value: EncryptedCheckpoint): Promise<void>;
  writes(scope: SecurityScope, checkpointId: string): Promise<EncryptedWrite[]>;
  putWrite(scope: SecurityScope, checkpointId: string, value: EncryptedWrite): Promise<void>;
}
const failure = () => new SecurityWorkflowError('SECURITY_CHECKPOINT_INVALID');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
// LangGraph's initial uuid6(clockseq=-1) has variant ffff. This identifier is
// framework data, not an actor/resource UUID or permission. PostgreSQL uuid
// accepts its hexadecimal shape; do not weaken the authority UUID schemas.
const checkpointIdentifier = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u);

/** Only JSON primitives/records. Never revive constructors or executable values.
 * This is defense in depth, not a general-purpose secret detector: graph nodes
 * may return only strict artifact receipts, identifiers, digests and statuses.
 */
function boundedJson(value: unknown): Buffer {
  let count = 0;
  function inspect(item: unknown, depth: number): void {
    if (++count > 4096 || depth > 24) throw failure();
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item === 'string') {
      if (item.length > 1024 || /-----BEGIN|\bBearer\s|\bsk-[A-Za-z0-9_-]{12,}|\b(?:password|api[_-]?key|secret)\s*[:=]/iu.test(item)) throw failure();
      return;
    }
    if (Array.isArray(item)) { if (item.length > 256) throw failure(); for (const child of item) inspect(child, depth + 1); return; }
    if (!item || typeof item !== 'object' || Object.getPrototypeOf(item) !== Object.prototype) throw failure();
    const entries = Object.entries(item);
    if (entries.length > 256) throw failure();
    for (const [key, child] of entries) {
      if (/^(?:__proto__|prototype|constructor|password|secret|privateKey|credentialValue|prompt|untrustedContext|messages|content)$/iu.test(key) || key.length > 180) throw failure();
      // JSON intentionally omits undefined framework optional record members.
      if (child !== undefined) inspect(child, depth + 1);
    }
  }
  inspect(value, 0);
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > 65_536) throw failure();
  return bytes;
}

export class SecurityCheckpointer extends BaseCheckpointSaver {
  private readonly scope: SecurityScope;
  private readonly thread: string;
  private readonly key: Buffer;
  constructor(scope: SecurityScope, private readonly storage: SecurityCheckpointStorage, artifactKey: string) {
    super();
    this.scope = Object.freeze(scopeSchema.parse(scope));
    this.thread = securityThread(this.scope);
    this.key = Buffer.from(artifactKey, 'base64');
    if (this.key.length !== 32 || this.key.toString('base64') !== artifactKey) throw new SecurityWorkflowError('SECURITY_CHECKPOINT_KEY_REQUIRED');
  }
  private config(config: RunnableConfig, requireId = false) {
    const values = config.configurable;
    if (values?.thread_id !== this.thread || values.checkpoint_ns !== undefined && values.checkpoint_ns !== '') throw failure();
    const id = values.checkpoint_id === undefined ? undefined : checkpointIdentifier.parse(values.checkpoint_id);
    if (requireId && !id) throw failure();
    return id;
  }
  private aad(identity: string) { return Buffer.from(JSON.stringify(['security-checkpoint-v1', this.thread, identity])); }
  private seal(value: unknown, identity: string) {
    const bytes = boundedJson(value), nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(this.aad(identity));
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return { encryptedEnvelope: ['zrs2', nonce.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.'), digest: hash(bytes) };
  }
  private open(value: { encryptedEnvelope: string; digest: string }, identity: string): unknown {
    try {
      if (value.encryptedEnvelope.length > 90_000 || !/^[a-f0-9]{64}$/u.test(value.digest)) throw failure();
      const [format, nonce, tag, body, extra] = value.encryptedEnvelope.split('.');
      if (format !== 'zrs2' || !nonce || !tag || !body || extra) throw failure();
      const nonceBytes = Buffer.from(nonce, 'base64'), tagBytes = Buffer.from(tag, 'base64'), bodyBytes = Buffer.from(body, 'base64');
      if (nonceBytes.length !== 12 || tagBytes.length !== 16 || nonceBytes.toString('base64') !== nonce || tagBytes.toString('base64') !== tag || bodyBytes.toString('base64') !== body) throw failure();
      const decipher = createDecipheriv('aes-256-gcm', this.key, nonceBytes);
      decipher.setAAD(this.aad(identity)); decipher.setAuthTag(tagBytes);
      const bytes = Buffer.concat([decipher.update(bodyBytes), decipher.final()]);
      if (hash(bytes) !== value.digest) throw failure();
      const decoded: unknown = JSON.parse(bytes.toString('utf8'));
      boundedJson(decoded);
      return decoded;
    } catch { throw failure(); }
  }
  private runnable(checkpointId: string): RunnableConfig { return { configurable: { thread_id: this.thread, checkpoint_ns: '', checkpoint_id: checkpointId } }; }
  private async tuple(row: EncryptedCheckpoint): Promise<CheckpointTuple> {
    const body = this.open(row, JSON.stringify(['checkpoint', row.checkpointId, row.parentCheckpointId])) as { checkpoint: Checkpoint; metadata: CheckpointMetadata };
    if (!body?.checkpoint || body.checkpoint.id !== row.checkpointId || !body.metadata) throw failure();
    const writes = await this.storage.writes(this.scope, row.checkpointId);
    writes.sort((a, b) => compareWritesSortKeys(writesSortKey(a.taskPath, a.taskId, a.index), writesSortKey(b.taskPath, b.taskId, b.index)));
    const pendingWrites: NonNullable<CheckpointTuple['pendingWrites']> = writes.map(rowWrite => {
      const value = this.open(rowWrite, JSON.stringify(['write', row.checkpointId, rowWrite.taskId, rowWrite.index, rowWrite.taskPath])) as { channel: string; value: unknown };
      if (typeof value?.channel !== 'string') throw failure();
      return [rowWrite.taskId, value.channel, value.value];
    });
    return { config: this.runnable(row.checkpointId), checkpoint: body.checkpoint, metadata: body.metadata, pendingWrites, ...(row.parentCheckpointId ? { parentConfig: this.runnable(row.parentCheckpointId) } : {}) };
  }
  override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const id = this.config(config); await this.storage.assertLease();
    const row = await this.storage.checkpoint(this.scope, id);
    return row ? this.tuple(row) : undefined;
  }
  override async *list(config: RunnableConfig, options: CheckpointListOptions = {}): AsyncGenerator<CheckpointTuple> {
    this.config(config); await this.storage.assertLease();
    if (options.filter && Object.keys(options.filter).length) throw failure();
    const before = options.before ? this.config(options.before, true) : undefined;
    const limit = options.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw failure();
    for (const row of await this.storage.checkpoints(this.scope, limit, before)) { await this.storage.assertLease(); yield await this.tuple(row); }
  }
  override async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata, _newVersions: ChannelVersions): Promise<RunnableConfig> {
    const parentCheckpointId = this.config(config) ?? null;
    await this.storage.assertLease();
    const checkpointId = checkpointIdentifier.parse(checkpoint.id);
    const body = this.seal({ checkpoint, metadata }, JSON.stringify(['checkpoint', checkpointId, parentCheckpointId]));
    await this.storage.putCheckpoint(this.scope, { checkpointId, parentCheckpointId, ...body });
    return this.runnable(checkpointId);
  }
  override async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string, taskPath = ''): Promise<void> {
    const checkpointId = this.config(config, true)!; await this.storage.assertLease();
    uuid.parse(taskId);
    if (writes.length > 100 || taskPath.length > 512) throw failure();
    for (const [index, [channel, value]] of writes.entries()) {
      if (channel.length > 180) throw failure();
      const writeIndex = WRITES_IDX_MAP[channel] ?? index;
      const encrypted = this.seal({ channel, value: value ?? null }, JSON.stringify(['write', checkpointId, taskId, writeIndex, taskPath]));
      await this.storage.putWrite(this.scope, checkpointId, { taskId, index: writeIndex, taskPath, ...encrypted });
    }
  }
  override async deleteThread(_threadId: string): Promise<void> { throw new SecurityWorkflowError('SECURITY_HISTORY_PRESERVED'); }
}
