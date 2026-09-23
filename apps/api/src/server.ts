import { loadEnvironment } from '@zerochack/config';
import { buildApp } from './app.js';

const environment = loadEnvironment();
const app = await buildApp(environment);

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'service.shutdown');
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try { await app.listen({ host: environment.API_HOST, port: environment.API_PORT }); }
catch (error) { app.log.fatal({ err: error, errorCode: 'API_START_FAILED' }, 'service.start.failed'); process.exit(1); }
