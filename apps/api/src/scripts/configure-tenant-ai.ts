// Approval-gated server maintenance tool, never a public bootstrap endpoint.
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { database } from '@zerochack/database';
import { loadEnvironment } from '@zerochack/config';
import { configureApprovedTenantAi } from '../modules/ai/approved-setup.js';

async function main() {
  if (process.env.NODE_ENV !== 'production' || !process.argv[2]) throw new Error('PROTECTED_APPROVAL_REQUIRED');
  const environment = loadEnvironment(process.env);
  const path = resolve(process.argv[2]);
  if (path.startsWith(process.cwd() + sep) || (await stat(path)).mode & 0o077) throw new Error('PROTECTED_APPROVAL_REQUIRED');
  const result = await configureApprovedTenantAi(JSON.parse(await readFile(path, 'utf8')), { approvalReference: process.env.AI_SETUP_APPROVAL, encryptionKey: environment.AI_CREDENTIAL_ENCRYPTION_KEY });
  process.stdout.write(JSON.stringify(result) + '\n');
}

main().catch(error => {
  const safeCodes = ['PROTECTED_APPROVAL_REQUIRED', 'EXPLICIT_APPROVAL_REQUIRED', 'CONFIGURATION_CHANGED', 'PROVIDER_MODEL_NOT_AVAILABLE', 'CREDENTIAL_CHANGED', 'PROVIDER_CHANGED', 'EXISTING_POLICY_REQUIRES_REVIEW', 'EXISTING_MODEL_REQUIRES_REVIEW', 'EXISTING_PROVIDER_REQUIRES_REVIEW'];
  process.stderr.write((error instanceof Error && safeCodes.includes(error.message) ? error.message : 'AI_SETUP_FAILED: no credentials displayed; review protected inputs and provider access') + '\n');
  process.exitCode = 1;
}).finally(() => database.$disconnect());
