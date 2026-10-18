import { afterAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { database } from '@zerochack/database';

// Disposable PostgreSQL fixture; TEMP objects shadow the table only on this transaction connection.
describe('CodeBandage stock-template migration', () => {
  afterAll(() => database.$disconnect());
  it('versions exact stock defaults, preserves customization/history and is repeat-safe', async () => {
    if (!new URL(process.env.DATABASE_URL ?? '').pathname.includes('test')) throw new Error('Disposable test database required');
    const sql=await readFile('packages/database/prisma/migrations/20261007000000_codebandage_branding/migration.sql','utf8');
    const migration=sql.slice(sql.indexOf('WITH stock AS'),sql.indexOf('\nCOMMIT;'));
    await database.$transaction(async tx => {
      await tx.$executeRawUnsafe('CREATE TEMP TABLE email_template_versions (id UUID PRIMARY KEY, event_type TEXT NOT NULL, version INT NOT NULL, subject_template TEXT NOT NULL, body_template TEXT NOT NULL, enabled BOOLEAN NOT NULL, created_by_user_id UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(event_type,version)) ON COMMIT DROP');
      await tx.$executeRawUnsafe('CREATE UNIQUE INDEX cb_fixture_one_enabled ON email_template_versions(event_type) WHERE enabled=true');
      const oldBody='Hello {{recipientName}},\n\n{{message}}\n\nOpen ZeroRoot: {{actionUrl}}';
      await tx.$executeRaw`INSERT INTO email_template_versions VALUES (gen_random_uuid(),'STOCK',1,'ZeroRoot: {{title}}',${oldBody},true,NULL,CURRENT_TIMESTAMP),(gen_random_uuid(),'CUSTOM',1,'Custom subject',${oldBody},true,NULL,CURRENT_TIMESTAMP),(gen_random_uuid(),'AUTHORED',1,'ZeroRoot: {{title}}',${oldBody},true,gen_random_uuid(),CURRENT_TIMESTAMP)`;
      await tx.$executeRawUnsafe(migration);
      const rows=await tx.$queryRaw<Array<{event_type:string;version:number;subject_template:string;enabled:boolean}>>`SELECT event_type,version,subject_template,enabled FROM email_template_versions ORDER BY event_type,version`;
      expect(rows).toHaveLength(4);
      expect(rows.filter(r=>r.event_type==='STOCK')).toEqual([{event_type:'STOCK',version:1,subject_template:'ZeroRoot: {{title}}',enabled:false},{event_type:'STOCK',version:2,subject_template:'CodeBandage: {{title}}',enabled:true}]);
      expect(rows.find(r=>r.event_type==='CUSTOM')).toMatchObject({version:1,subject_template:'Custom subject',enabled:true});
      expect(rows.find(r=>r.event_type==='AUTHORED')).toMatchObject({version:1,subject_template:'ZeroRoot: {{title}}',enabled:true});
      await tx.$executeRawUnsafe(migration);
      const count=await tx.$queryRaw<Array<{count:bigint}>>`SELECT COUNT(*) AS count FROM email_template_versions`;
      expect(count[0]?.count).toBe(4n);
    });
  });
});
