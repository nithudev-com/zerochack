import { afterAll, describe, expect, it } from 'vitest';
import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { database } from '@zerochack/database';
import { createScanWorker } from './scan-worker.js';
import { createLogger } from '@zerochack/config';

const live = process.env.RUN_LIVE_SCAN === 'true';
describe.runIf(live)('live read-only scan pipeline', () => {
  afterAll(async () => { await database.$disconnect(); });
  it('moves a queued verified website scan through the worker and persists evidence', async () => {
    const tenant = await database.tenant.create({ data: { name: 'Live Scan Test', slug: `live-scan-${crypto.randomUUID()}` } });
    const website = await database.website.create({ data: { tenantId: tenant.id, name: 'Example', url: 'https://example.com/', normalizedHost: 'example.com', connectionStatus: 'VERIFIED', connectedAt: new Date() } });
    const scan = await database.scan.create({ data: { tenantId: tenant.id, websiteId: website.id } });
    const connection = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null }); const queue = new Queue('scans', { connection }); const events = new QueueEvents('scans', { connection: new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null }) }); const worker = createScanWorker(process.env.REDIS_URL!, createLogger('live-scan-test', 'silent'));
    try {
      await events.waitUntilReady(); const job = await queue.add('scan.requested', { scanId: scan.id, websiteId: website.id, tenantId: tenant.id }, { jobId: scan.id, attempts: 3 }); await job.waitUntilFinished(events, 45_000);
      const completed = await database.scan.findUniqueOrThrow({ where: { id: scan.id }, include: { findings: { include: { evidence: true } } } });
      expect(completed.status).toBe('SUCCEEDED'); expect(completed.progress).toBe(100); expect(completed.findings.length).toBeGreaterThan(0); expect(completed.findings.every((finding) => finding.evidence.length === 1)).toBe(true);
    } finally { await worker.close(); await queue.close(); await events.close(); connection.disconnect(); await database.tenant.delete({ where: { id: tenant.id } }); }
  }, 60_000);
});
