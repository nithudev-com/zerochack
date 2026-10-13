import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const config = readFileSync(new URL('../../infrastructure/production/Caddyfile.preview', import.meta.url), 'utf8');
const deploy = readFileSync(new URL('./preview.py', import.meta.url), 'utf8');
test('preview access is session-backed, not a changing peer IP or mere cookie presence', () => {
  assert.equal((config.match(/forward_auth 127\.0\.0\.1:4000/g) ?? []).length, 2);
  assert.equal((config.match(/uri \/v1\/auth\/me/g) ?? []).length, 2);
  assert(!config.includes('__PREVIEW_IP__')); assert(!config.includes('@preview remote_ip'));
  assert(!/header\s+Cookie|copy_headers|\*zerochack_session/.test(config));
  assert(config.includes('redir * /sign-in 303')); assert(!config.includes('redir /sign-in 303')); assert(deploy.includes('approved-application-session'));
});
test('registration and private endpoints never enter a broad anonymous bypass', () => {
  assert(config.includes('@registration path /v1/auth/register /customer/register /agency/register /affiliate/register'));
  const entry = config.split('\n').find(line => line.includes('@account_entry path'));
  assert(entry && !entry.includes('*') && !entry.includes('/v1/auth/register'));
  const assets = config.split('\n').find(line => line.includes('@public_web path'));
  assert(assets && !assets.includes('/_next/data') && !assets.includes('/_next/*') && !assets.includes('/customer/*'));
  assert(!config.includes('/v1/metrics')); assert(config.includes('remote_ip 127.0.0.1 ::1'));
});
test('preview keeps forwarding trust, streaming, CSP and public-release gates intact', () => {
  assert(config.includes('flush_interval -1')); assert(config.includes('header_up -CF-Connecting-IP'));
  assert(!config.includes("default-src 'none'")); assert(deploy.includes('Public launch gates remain incomplete'));
  assert(deploy.includes("'access_mode': 'approved-application-session'"));
});
