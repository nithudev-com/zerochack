import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'], format: ['esm'], platform: 'node', target: 'node22', outDir: 'dist', clean: true,
  sourcemap: true, minify: false, splitting: false, external: ['dotenv', 'pino', 'nodemailer', 'undici', '@prisma/client'], noExternal: [/^@zerochack\//]
});
