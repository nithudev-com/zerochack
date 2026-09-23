import { afterAll, describe, expect, it } from 'vitest';
import { database } from '@zerochack/database';

describe('database integration', () => {
  afterAll(() => database.$disconnect());
  it('connects to PostgreSQL', async () => {
    const result = await database.$queryRaw<Array<{ value: number }>>`SELECT 1 AS value`;
    expect(result[0]?.value).toBe(1);
  });
});
