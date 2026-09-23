import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEnvironment } from '@zerochack/config';
import { buildApp } from './app.js';

const environment = loadEnvironment({
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://zerochack:zerochack@127.0.0.1:5432/zerochack',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  SESSION_SECRET: process.env.SESSION_SECRET ?? 'openapi-generation-secret-at-least-32-characters',
  CORS_ORIGINS: process.env.CORS_ORIGINS ?? 'http://localhost:3000'
});
const app = await buildApp(environment);
await app.ready();
await writeFile(resolve('docs/openapi.json'), `${JSON.stringify(app.swagger(), null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
await app.close();
