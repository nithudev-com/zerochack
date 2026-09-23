import ssh2 from 'ssh2';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';

export const credentialKinds = ['SSH', 'SFTP', 'CMS', 'DATABASE', 'REPOSITORY', 'API', 'HOSTING'] as const;
export const environments = ['PRODUCTION', 'STAGING'] as const;
export class CareError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'CareError'; }
}
const credentialSchema = z.object({
  kind: z.enum(credentialKinds).default('SSH'),
  host: z.string().trim().min(1).max(253).regex(/^[a-zA-Z0-9.-]+$/),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1).max(120),
  hostKeyFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/).optional(),
  secret: z.string().min(1).max(50000),
  authMethod: z.enum(['PASSWORD', 'SSH_KEY', 'TOKEN']).default('PASSWORD')
}).strict();
export type CapturedCredential = z.infer<typeof credentialSchema>;
/** All text is sensitive; parsing never invokes a model or returns submitted text in an error. */
export function parseSecureCapture(content: string): CapturedCredential[] {
  if (!content || Buffer.byteLength(content) > 100000) throw new CareError('SECRET_CAPTURE_AMBIGUOUS', 'Use at most 100 KB of access details.');
  let value: unknown;
  try {
    if (content.trim().startsWith('{') || content.trim().startsWith('[')) {
      const parsed: unknown = JSON.parse(content);
      value = Array.isArray(parsed) ? parsed : [parsed];
    } else {
      value = content.trim().split(/\r?\n\s*---\s*\r?\n/).map((block) => {
        const key = block.match(/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/);
        const fields: Record<string, unknown> = {};
        const aliases: Record<string, string> = { fingerprint: 'hostKeyFingerprint', hostkeyfingerprint: 'hostKeyFingerprint', sshhost: 'host', sshport: 'port', sshusername: 'username', sshpassword: 'secret', type: 'kind', kind: 'kind', host: 'host', hostname: 'host', server: 'host', port: 'port', user: 'username', username: 'username', password: 'secret', passwd: 'secret', secret: 'secret', token: 'secret', authmethod: 'authMethod' };
        const rest = key ? block.replace(key[0], '').replace(/^\s*(?:private[ _-]?key|key)\s*:\s*$/gim, '') : block;
        for (const line of rest.split(/\r?\n/).filter((line) => line.trim())) {
          const match = line.match(/^\s*([a-zA-Z_ -]+)\s*[:=]\s*(.*?)\s*$/);
          if (!match) throw new Error('ambiguous');
          const name = aliases[match[1]!.toLowerCase().replace(/[ _-]/g, '')];
          if (!name || name in fields) throw new Error('ambiguous');
          fields[name] = name === 'port' ? Number(match[2]) : ['kind', 'authMethod'].includes(name) ? match[2]!.toUpperCase() : match[2];
          if (match[1]!.toLowerCase() === 'token') fields.authMethod = 'TOKEN';
        }
        if (key) { if (fields.secret) throw new Error('ambiguous'); fields.secret = key[0]; fields.authMethod = 'SSH_KEY'; }
        return fields;
      });
    }
    const result = z.array(credentialSchema).min(1).max(10).parse(value);
    const destinations = new Set<string>();
    for (const item of result) {
      if (item.authMethod === 'SSH_KEY' && ssh2.utils.parseKey(item.secret) instanceof Error) throw new Error('invalid key');
      const id = `${item.kind}:${item.host.toLowerCase()}:${item.port}:${item.username}`;
      if (destinations.has(id)) throw new Error('duplicate');
      destinations.add(id);
    }
    return result;
  } catch { throw new CareError('SECRET_CAPTURE_AMBIGUOUS', 'Access details were not saved or sent to AI. Include type, host, username, and password or private key on separate labelled lines. Separate accounts with a line containing ---.'); }
}

export function looksSensitive(value: string): boolean {
  return /-----BEGIN .*PRIVATE KEY-----|\b(?:password|passwd|pwd|secret|token|api[_ -]?key|private[_ -]?key)\s*[:=]\s*\S+|\bBearer\s+\S+|\bsk-[a-zA-Z0-9_-]{12,}|\w+:\/\/[^\s/@]+:[^\s/@]+@/iu.test(value);
}
export type VaultContext = { tenantId: string; websiteId: string; environment: string; id: string; version: number };
const aad = (scope: VaultContext, keyVersion: string) => Buffer.from(JSON.stringify([scope.tenantId, scope.websiteId, scope.environment, scope.id, scope.version, keyVersion]));
export function sealSecret(secret: string, scope: VaultContext, key: string, keyVersion = 'v1'): string {
  const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), nonce);
  cipher.setAAD(aad(scope, keyVersion));
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return ['zr1', keyVersion, nonce.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
}
export function openSecret(envelope: string, scope: VaultContext, keys: Readonly<Record<string, string>>): string {
  try {
    const [format, version, nonce, tag, body, extra] = envelope.split('.');
    if (format !== 'zr1' || !version || !keys[version] || !nonce || !tag || !body || extra) throw new Error('envelope');
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keys[version]!, 'base64'), Buffer.from(nonce, 'base64'));
    decipher.setAAD(aad(scope, version)); decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
  } catch { throw new CareError('CREDENTIAL_UNAVAILABLE', 'Credential cannot be opened in this context.'); }
}
