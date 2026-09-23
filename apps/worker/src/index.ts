import { AiService } from '../../api/src/modules/ai/service.js';
import { runOneRepair } from '../../api/src/modules/care/repair-service.js';
import { runOneRelease } from '../../api/src/modules/care/release-service.js';
import { maintainCareRecords } from './care-maintenance.js';
import { createLogger, loadEnvironment } from '@zerochack/config';
import { createQueueRegistry, queueNames } from './queues.js';
import { createScanWorker } from './scan-worker.js';
import { createBackupWorker } from './backup-worker.js';
import { createMonitoringWorker } from './monitoring-worker.js';
import { reconcileSchedulers } from './schedulers.js';
import Redis from 'ioredis';
import { SmtpEmailProvider } from '@zerochack/email';
import { createNotificationWorker } from './notification-worker.js';
import { createEmailWorker } from './email-worker.js';
import { createReportWorker } from './report-worker.js';

const environment = loadEnvironment();
const logger = createLogger('worker', environment.LOG_LEVEL);
const registry = createQueueRegistry(environment.REDIS_URL);
const scanWorker = createScanWorker(environment.REDIS_URL, logger, { timeoutMs: environment.SCANNER_TIMEOUT_MS, maxRedirects: environment.SCANNER_MAX_REDIRECTS, maxBytes: environment.SCANNER_MAX_RESPONSE_BYTES });
const backupWorker = createBackupWorker(environment.REDIS_URL, logger);
const monitoringWorker = createMonitoringWorker(environment.REDIS_URL, logger);
const emailProvider = new SmtpEmailProvider({ host: environment.SMTP_HOST, port: environment.SMTP_PORT, secure: environment.SMTP_SECURE, from: environment.SMTP_FROM, ...(environment.SMTP_USER && environment.SMTP_PASSWORD ? { user: environment.SMTP_USER, password: environment.SMTP_PASSWORD } : {}) });
const notificationWorker = createNotificationWorker(environment.REDIS_URL, logger);
const emailWorker = createEmailWorker(environment.REDIS_URL, logger, emailProvider);
const reportWorker = createReportWorker(environment.REDIS_URL, logger, environment);
const schedules = await reconcileSchedulers(registry.queues);
const heartbeatRedis = new Redis(environment.REDIS_URL, { maxRetriesPerRequest: 1 });
const heartbeat = async () => heartbeatRedis.set('zerochack:worker:heartbeat', new Date().toISOString(), 'EX', 90);
await heartbeat();
const careAi = new AiService(environment, heartbeatRedis);
let repairBusy = false; let releaseBusy = false;
const repairTimer = setInterval(() => { if (repairBusy || !environment.CARE_REPAIR_ENABLED) return; repairBusy = true; void runOneRepair(environment, careAi).catch(() => logger.error({ errorCode: 'REPAIR_WORKER_FAILED' }, 'care.repair_failed')).finally(() => { repairBusy = false; }); }, 2000);
const releaseTimer = setInterval(() => { if (releaseBusy || !environment.CARE_RELEASE_ENABLED) return; releaseBusy = true; void runOneRelease(environment).catch(() => logger.error({ errorCode: 'RELEASE_WORKER_FAILED' }, 'care.release_failed')).finally(() => { releaseBusy = false; }); }, 2000);
let careMaintenanceBusy = false;
const careMaintenance = setInterval(() => { if (!environment.CARE_ENABLED || careMaintenanceBusy) return; careMaintenanceBusy = true; void maintainCareRecords().catch(() => logger.error({ errorCode: 'CARE_MAINTENANCE_FAILED' }, 'care.maintenance_failed')).finally(() => { careMaintenanceBusy = false; }); }, 60000);
const heartbeatTimer = setInterval(() => void heartbeat().catch((error) => logger.error({ err: error, errorCode: 'WORKER_HEARTBEAT_FAILED' }, 'worker.heartbeat_failed')), 30_000);

for (const events of registry.events) {
  events.on('failed', ({ jobId, failedReason }) => logger.error({ queue: events.name, jobId, errorCode: 'JOB_FAILED', reason: failedReason }, 'queue.job.failed'));
}

logger.info({ queues: queueNames, schedules }, 'worker.ready');

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'service.shutdown');
  clearInterval(heartbeatTimer);
  clearInterval(careMaintenance);
  clearInterval(repairTimer);
  clearInterval(releaseTimer);
  await scanWorker.close();
  await backupWorker.close();
  await monitoringWorker.close();
  await notificationWorker.worker.close();
  await notificationWorker.emailQueue.close();
  await emailWorker.close();
  await reportWorker.close();
  await registry.close();
  heartbeatRedis.disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
