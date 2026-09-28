import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/scripts/care-browser-preflight.ts'], format: ['esm'], platform: 'node', target: 'node22', outDir: 'dist', clean: true,
  sourcemap: true, minify: false, splitting: false,
  external: ['playwright', 'postcss', 'yaml', 'sharp', 'dotenv', 'pino', 'nodemailer', 'undici', 'ssh2', '@node-rs/argon2', '@prisma/client'],
  noExternal: [/^@zerochack\//]
});
