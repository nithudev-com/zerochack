import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { database } from '@zerochack/database';

describe('controlled Owner bootstrap', () => {
  it('preserves credentials and identity on rerun and refuses a non-Owner account', async () => {
    if (!process.env.DATABASE_URL || !new URL(process.env.DATABASE_URL).pathname.includes('test')) throw new Error('Disposable test database required');
    const email = `bootstrap-${randomUUID()}@example.test`;
    const execute = (password: string) => spawnSync(process.execPath,
      ['node_modules/tsx/dist/cli.mjs', 'apps/api/src/scripts/create-owner.ts'],
      { env: { ...process.env, OWNER_EMAIL: email, OWNER_NAME: 'Bootstrap fixture', OWNER_PASSWORD: password }, encoding: 'utf8' });
    expect(execute('Synthetic-Owner-Fixture9!').status).toBe(0);
    const before = await database.user.findUniqueOrThrow({ where: { email } });
    expect(execute('Different-Owner-Fixture8!').status).toBe(0);
    const after = await database.user.findUniqueOrThrow({ where: { email } });
    expect(after).toEqual(before);
    await database.userRole.deleteMany({ where: { userId: before.id } });
    expect(execute('Different-Owner-Fixture8!').status).not.toBe(0);
    expect(await database.user.findUniqueOrThrow({ where: { email } })).toEqual(before);
  });
});
