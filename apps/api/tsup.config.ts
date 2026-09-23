import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'], format: ['esm'], platform: 'node', target: 'node22', outDir: 'dist', clean: true,
  sourcemap: true, minify: false, splitting: false,
  external: ['dotenv', 'pino', 'nodemailer', 'undici', 'ssh2', '@node-rs/argon2', '@prisma/client'],
  noExternal: [/^@zerochack\//]
});
