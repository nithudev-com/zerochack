import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'], format: ['esm'], platform: 'node', target: 'node22', outDir: 'dist', clean: true,
  sourcemap: true, minify: false, splitting: false, external: ['playwright', 'postcss', 'yaml', 'typescript', 'ssh2', '@node-rs/argon2', 'sharp', 'dotenv', 'pino', 'nodemailer', 'undici', '@prisma/client'], noExternal: [/^@zerochack\//],
  banner: { js: "import { createRequire as __codebandageCreateRequire } from 'node:module'; const require = __codebandageCreateRequire(import.meta.url);" }
});
