#!/usr/bin/env python3
"""Disposable local TLS/native-dependency checks, not a production release verdict.

Uses synthetic credentials, a private test CA and no external mail/model calls.
Retains resources/evidence for inspection; never touches production volumes.
"""
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

root = Path(__file__).resolve().parents[2]
folder = Path(tempfile.mkdtemp(prefix='codebandage-image-fixture-'))
network = 'codebandage-image-fixture'
uid = str(os.getuid())

def command(args, capture=False, allowed_failure=False):
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                            stderr=subprocess.PIPE)
    if result.returncode and not allowed_failure:
        raise RuntimeError('Fixture command failed: ' + args[0] + '\n' + result.stderr[-2000:])
    return result

def docker(*args, **kwargs):
    return command(['docker', *args], **kwargs)

def write(path, content, mode=0o600):
    path.write_text(content)
    path.chmod(mode)

for name in ['trust', 'postgres-tls', 'redis-tls', 'postgres-data', 'redis-data']:
    (folder / name).mkdir(mode=0o755 if 'tls' in name or name == 'trust' else 0o700)
command(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
         '-subj', '/CN=Disposable CodeBandage test CA', '-keyout', str(folder / 'ca.key'),
         '-out', str(folder / 'trust/ca.crt'), '-addext', 'basicConstraints=critical,CA:TRUE'])
(folder / 'trust/ca.crt').chmod(0o644)
for service in ['postgres', 'redis']:
    tls = folder / f'{service}-tls'
    write(folder / f'{service}.ext', f'subjectAltName=DNS:{service}\nextendedKeyUsage=serverAuth\n')
    command(['openssl', 'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', f'/CN={service}',
             '-keyout', str(tls / 'server.key'), '-out', str(folder / f'{service}.csr')])
    command(['openssl', 'x509', '-req', '-days', '2', '-in', str(folder / f'{service}.csr'),
             '-CA', str(folder / 'trust/ca.crt'), '-CAkey', str(folder / 'ca.key'), '-CAcreateserial',
             '-extfile', str(folder / f'{service}.ext'), '-out', str(tls / 'server.crt')])
    (tls / 'server.crt').chmod(0o644)
    (tls / 'server.key').chmod(0o600)
password = 'synthetic-fixture-password'
values = {
    'NODE_ENV': 'production', 'APP_URL': 'https://codebandage.com',
    'NEXT_PUBLIC_API_URL': 'https://codebandage.com/v1', 'CORS_ORIGINS': 'https://codebandage.com',
    'DATABASE_URL': f'postgresql://zerochack:{password}@postgres:5432/codebandage_image_test?sslmode=require&sslaccept=strict&sslcert=/run/trust/ca.crt',
    'REDIS_URL': f'rediss://default:{password}@redis:6379', 'NODE_EXTRA_CA_CERTS': '/run/trust/ca.crt',
    'SESSION_SECRET': 'synthetic-fixture-session-credential-abcdef1234567890',
    'REPORT_SIGNING_KEY': 'synthetic-fixture-signing-credential-abcdef1234567890',
    'METRICS_TOKEN': 'synthetic-fixture-metrics-credential-abcdef1234567890',
    'SMTP_HOST': 'smtp.example.invalid', 'SMTP_PORT': '465', 'SMTP_SECURE': 'true',
    'SMTP_FROM': 'fixture@example.invalid', 'LOG_LEVEL': 'silent',
}
for index, name in enumerate(['MFA_ENCRYPTION_KEY', 'AI_CREDENTIAL_ENCRYPTION_KEY',
                             'PAYMENT_CREDENTIAL_ENCRYPTION_KEY', 'INTEGRATION_CREDENTIAL_ENCRYPTION_KEY',
                             'CARE_VAULT_KEY', 'CARE_ARTIFACT_KEY'], 1):
    values[name] = base64.b64encode(bytes([index]) * 32).decode()
write(folder / 'app.env', ''.join(f'{key}={value}\n' for key, value in values.items()))
docker('network', 'create', '--label', 'codebandage.scope=image-fixture', network)
docker('run', '-d', '--name', 'codebandage-image-fixture-postgres', '--network', network,
       '--network-alias', 'postgres', '--user', uid + ':' + uid,
       '--label', 'codebandage.scope=image-fixture', '-e', 'POSTGRES_USER=zerochack',
       '-e', 'POSTGRES_DB=codebandage_image_test', '-e', 'POSTGRES_PASSWORD=' + password,
       '-v', str(folder / 'postgres-data') + ':/var/lib/postgresql/data',
       '-v', str(folder / 'postgres-tls') + ':/run/tls:ro',
       '-v', str(root / 'infrastructure/production/pg_hba.conf') + ':/etc/pg_hba.conf:ro',
       'postgres:16-alpine@sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb',
       'postgres', '-c', 'ssl=on', '-c', 'ssl_cert_file=/run/tls/server.crt',
       '-c', 'ssl_key_file=/run/tls/server.key', '-c', 'hba_file=/etc/pg_hba.conf')
docker('run', '-d', '--name', 'codebandage-image-fixture-redis', '--network', network,
       '--network-alias', 'redis', '--user', uid + ':' + uid, '--label', 'codebandage.scope=image-fixture',
       '-v', str(folder / 'redis-data') + ':/data', '-v', str(folder / 'redis-tls') + ':/run/tls:ro',
       '-v', str(folder / 'trust') + ':/run/trust:ro',
       'redis:7-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499',
       'redis-server', '--port', '0', '--tls-port', '6379', '--tls-cert-file', '/run/tls/server.crt',
       '--tls-key-file', '/run/tls/server.key', '--tls-ca-cert-file', '/run/trust/ca.crt',
       '--tls-auth-clients', 'no', '--requirepass', password, '--appendonly', 'yes')
for attempt in range(30):
    if docker('exec', 'codebandage-image-fixture-postgres', 'pg_isready', '-U', 'zerochack',
              '-d', 'codebandage_image_test', allowed_failure=True).returncode == 0:
        break
    time.sleep(1)
else:
    raise SystemExit('Fixture PostgreSQL failed to become ready; retained for inspection.')

def probe(script, extra=()):
    return docker('run', '--rm', '--network', network, '--env-file', str(folder / 'app.env'),
                  '-v', str(folder / 'trust') + ':/run/trust:ro', *extra,
                  '--entrypoint', 'node', 'codebandage-candidate-api', '-e', script,
                  capture=True)

positive = 'const {PrismaClient}=require("@prisma/client");const R=require("ioredis");const p=new PrismaClient();const r=new R(process.env.REDIS_URL,{maxRetriesPerRequest:1,connectTimeout:2000});Promise.all([p.$queryRawUnsafe("SELECT 1"),r.ping()]).then(()=>{r.disconnect();return p.$disconnect()}).catch(()=>{r.disconnect();p.$disconnect().finally(()=>process.exit(1))})'
probe(positive)
for change in ['process.env.REDIS_URL=process.env.REDIS_URL.replace("redis:6379","codebandage-image-fixture-redis:6379");',
               'process.env.REDIS_URL=process.env.REDIS_URL.replace("synthetic-fixture-password","wrong-password");']:
    script = change + 'const R=require("ioredis");const r=new R(process.env.REDIS_URL,{maxRetriesPerRequest:0,retryStrategy:()=>null,connectTimeout:2000});r.on("error",()=>{});r.ping().then(()=>{r.disconnect();process.exit(1)}).catch(()=>{r.disconnect();process.exit(0)})'
    probe(script)
for change in ['process.env.DATABASE_URL=process.env.DATABASE_URL.replace("postgres:5432","codebandage-image-fixture-postgres:5432");',
               'process.env.DATABASE_URL=process.env.DATABASE_URL.replace("synthetic-fixture-password","wrong-password");',
               'process.env.DATABASE_URL=process.env.DATABASE_URL.replace("sslcert=/run/trust/ca.crt","sslcert=/etc/ssl/certs/ca-certificates.crt");']:
    script = change + 'const {PrismaClient}=require("@prisma/client");const p=new PrismaClient();p.$queryRawUnsafe("SELECT 1").then(()=>p.$disconnect().finally(()=>process.exit(1))).catch(()=>p.$disconnect().finally(()=>process.exit(0)))'
    probe(script)
probe('const R=require("ioredis");const r=new R(process.env.REDIS_URL,{maxRetriesPerRequest:0,retryStrategy:()=>null,connectTimeout:2000});r.on("error",()=>{});r.ping().then(()=>{r.disconnect();process.exit(1)}).catch(()=>{r.disconnect();process.exit(0)})',
      ('-e', 'NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt'))
identity = docker('image', 'inspect', 'codebandage-candidate-api', '--format', '{{.Id}}', capture=True).stdout.strip()
write(folder / 'results.json', json.dumps({'api_image': identity, 'database_tls': 'passed',
      'redis_tls': 'passed', 'hostname_password_ca_rejection': 'passed',
      'production_migration_worker_auth': 'not tested'}, indent=2) + '\n')
print('Disposable image TLS/native-engine tests passed. Evidence and resources retained: ' + str(folder))
