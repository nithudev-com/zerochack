#!/usr/bin/env python3
"""Explicit LOCAL disposable P1 TLS fixture; not a customer-code sandbox.

No administrative effects until --create --local-development-only. Never mounts
the live checkout, auth state, Docker socket or a production database/volume.
"""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import secrets
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from urllib.parse import quote

IMAGES = {
    'postgres': 'sha256:e684c11a6c7c127c1b7602063cc6a13db0a12b62dfd770d83936c089751d498d',
    'redis': 'sha256:f84b0c4678011602b9b98c227a4dcd5468bf8b088b02fdd4165cb7758bad8058',
    'tools': 'sha256:936cf01c0c76f3182a4939032d0545e68a1f13ef1bcc4dc17615d51bfb086b7c'
}
LABEL = 'codebandage.scope=local-p1-tls-fixture-v1'
FORBIDDEN = {'.git', 'node_modules', '.next', 'dist', 'coverage', 'test-results', 'playwright-report',
             '.ssh', '.aws', '.codex', '.cache', '.npm', '.auth', 'auth-state'}
EXCLUDED_PREFIXES = ('infrastructure/security-managed-target', 'infrastructure/security-runtime', 'scripts/security-runtime')
REQUIRED = {'package.json', 'package-lock.json', 'tsconfig.base.json', 'eslint.config.mjs',
            'vitest.config.ts', 'vitest.integration.config.ts', 'packages/database/prisma/schema.prisma',
            'packages/database/prisma/migrations/20261018000000_security_repair_journal/migration.sql',
            'packages/security-orchestration/package.json'}
MAX_ARCHIVE = 67108864
MAX_FILE = 16777216
MAX_EXPANDED = 134217728

# Reused verbatim by the executable probes and pure tests. No error messages,
# connection strings or driver objects are written to fixture evidence.
NEGATIVE_CLASSIFIERS = r'''
function safeFailureCode(error, service) {
  if (!error) return 'NO_FAILURE';
  if (service === 'redis' && typeof error.message === 'string' && /^WRONGPASS(?:\s|$)/.test(error.message)) return 'WRONGPASS';
  const code = error.code ?? error.errorCode;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
  // Prisma 6.12's lazy initial connection can expose the specific P1000
  // authentication text in PrismaClientInitializationError without any code,
  // errorCode or meta.code. Accept only that exact driver class and complete
  // authentication line; an arbitrary initialization/outage error is not proof.
  if (service === 'postgres' && error.name === 'PrismaClientInitializationError' &&
      typeof error.message === 'string' && /(?:^|\r?\n)Authentication failed against database server(?: at `[^`\r\n]{1,255}`)?, the provided database credentials for `[^`\r\n]{1,128}` are not valid\.(?=\r?\n|$)/.test(error.message)) return 'P1000';
  // The same lazy initialization wrapper can omit P1011. Require a complete TLS
  // opening line, certificate verification failure and a specific identity/trust
  // cause. Generic TLS/open/connection errors and the other negative's cause do
  // not pass. These are normalized classifications, not fabricated driver codes.
  if (service === 'postgres' && error.name === 'PrismaClientInitializationError' && typeof error.message === 'string') {
    const line = error.message.split(/\r?\n/).find(value => /^Error opening a TLS connection:/.test(value));
    if (line && line.length <= 4096 && /certificate verify failed|invalid peer certificate|certificate validation failure/i.test(line)) {
      if (/hostname mismatch|certificate is not valid for|not valid for name/i.test(line)) return 'PRISMA_INIT_TLS_HOSTNAME';
      if (/self.signed certificate|unable to get local issuer certificate|unknown issuer|UnknownIssuer/i.test(line)) return 'PRISMA_INIT_TLS_CA';
    }
  }
  return 'UNCLASSIFIED';
}
function classifyNegative(service, kind, caught, firstError) {
  const code = safeFailureCode(service === 'redis' ? (firstError ?? caught) : caught, service);
  let accepted = false;
  if (service === 'postgres') accepted = kind === 'password' ? code === 'P1000' :
    kind === 'hostname' ? ['P1011', 'PRISMA_INIT_TLS_HOSTNAME'].includes(code) :
    kind === 'ca' && ['P1011', 'PRISMA_INIT_TLS_CA'].includes(code);
  if (service === 'redis') accepted = kind === 'password' ? code === 'WRONGPASS' :
    kind === 'hostname' ? code === 'ERR_TLS_CERT_ALTNAME_INVALID' : kind === 'ca' && [
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT',
      'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_UNTRUSTED'
    ].includes(code);
  return {accepted, code};
}
function reportNegative(service, kind, observed, firstError) {
  const result = classifyNegative(service, kind, observed, firstError);
  console.log(JSON.stringify({service, check: kind, result: result.accepted ? 'PASS' : 'FAIL', code: result.code}));
  if (!result.accepted) process.exitCode = 1;
}
'''


def negative_probe(service, kind):
    require(service in ('postgres', 'redis') and kind in ('password', 'hostname', 'ca'), 'UNKNOWN_NEGATIVE_PROBE')
    common = NEGATIVE_CLASSIFIERS + 'const service=' + json.dumps(service) + ',kind=' + json.dumps(kind) + ';'
    if service == 'postgres':
        body = r'''let d,observed;
try {
  const u=new URL(process.env.DATABASE_URL);u.searchParams.set('connect_timeout','2');
  if(kind==='password')u.password='incorrect-test-password';
  if(kind==='hostname')u.hostname='postgres-wrong-name';
  if(kind==='ca')u.searchParams.set('sslcert','/etc/ssl/certs/ca-certificates.crt');
  process.env.DATABASE_URL=u.href;
  const{PrismaClient}=require('@prisma/client');d=new PrismaClient();await d.$queryRawUnsafe('SELECT 1');
} catch(error) {observed=error;}
finally {if(d)await d.$disconnect();}
reportNegative(service,kind,observed);'''
    else:
        body = r'''let r,observed,firstError;
try {
  const u=new URL(process.env.REDIS_URL);
  if(kind==='password')u.password='incorrect-test-password';
  if(kind==='hostname')u.hostname='redis-wrong-name';
  const R=require('ioredis');r=new R(u.href,{lazyConnect:true,maxRetriesPerRequest:0,retryStrategy:()=>null,connectTimeout:2500});
  r.on('error',error=>{firstError??=error;});
  await r.connect();await r.ping();
} catch(error) {observed=error;}
finally {if(r)r.disconnect();}
reportNegative(service,kind,observed,firstError);'''
    return common + '(async()=>{' + body + r'''})().catch(error=>{
console.log(JSON.stringify({service,check:kind,result:'FAIL',code:safeFailureCode(error,service)}));process.exitCode=1;
});'''


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


def fixture_identity(source_sha, attempt, legacy_integration=False):
    require(re.fullmatch(r'[a-f0-9]{64}', source_sha or '') is not None, 'EXACT_ARCHIVE_SHA256_REQUIRED')
    require(re.fullmatch(r'[a-f0-9]{8}', attempt or '') is not None, 'EXACT_ATTEMPT_REQUIRED')
    require(type(legacy_integration) is bool, 'EXPLICIT_FIXTURE_MODE_REQUIRED')
    binding = {
        'SECURITY_WORKPLACE_TEST_SOURCE_SHA': source_sha,
        'SECURITY_WORKPLACE_TEST_ATTEMPT': attempt,
        'SECURITY_WORKPLACE_TEST_DATABASE': 'codebandage_security_workplace_test_' + source_sha[:12] + '_' + attempt + ('_test' if legacy_integration else ''),
        'SECURITY_WORKPLACE_TEST_MARKER': 'codebandage-security-workplace-test-v1:' + source_sha + ':' + attempt + (':legacy-integration' if legacy_integration else '')
    }
    if legacy_integration:
        binding['SECURITY_WORKPLACE_TEST_MODE'] = 'LEGACY_INTEGRATION'
    return binding


# Both creation and verification derive the identity independently from the
# exact archive/attempt/mode. A convenient *_test name alone grants no access.
FIXTURE_BINDING_GUARD = r'''
const s=process.env.SECURITY_WORKPLACE_TEST_SOURCE_SHA??'',a=process.env.SECURITY_WORKPLACE_TEST_ATTEMPT??'',mode=process.env.SECURITY_WORKPLACE_TEST_MODE;
if(process.env.NODE_ENV!=='test'||!/^[a-f0-9]{64}$/.test(s)||!/^[a-f0-9]{8}$/.test(a)||(mode!==undefined&&mode!=='LEGACY_INTEGRATION'))throw Error('fixtureguard');
const legacy=mode==='LEGACY_INTEGRATION',n='codebandage_security_workplace_test_'+s.slice(0,12)+'_'+a+(legacy?'_test':''),m='codebandage-security-workplace-test-v1:'+s+':'+a+(legacy?':legacy-integration':'');
const u=new URL(process.env.DATABASE_URL);
if(process.env.SECURITY_WORKPLACE_TEST_DATABASE!==n||process.env.SECURITY_WORKPLACE_TEST_MARKER!==m||!['postgresql:','postgres:'].includes(u.protocol)||u.hostname!=='postgres'||u.pathname!=='/'+n||u.searchParams.get('sslmode')!=='require'||u.searchParams.get('sslaccept')!=='strict'||u.searchParams.get('sslcert')!=='/run/trust/ca.crt'||process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0')throw Error('fixtureguard');
'''


def fresh_database_probe():
    return r'''const{PrismaClient}=require('@prisma/client');const d=new PrismaClient();(async()=>{''' + FIXTURE_BINDING_GUARD + r'''
const b=await d.$queryRawUnsafe("SELECT current_database() AS name,shobj_description(oid,'pg_database') AS marker,datdba=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned FROM pg_database WHERE datname=current_database()");
if(b.length!==1||b[0].name!==n||b[0].owned!==true||b[0].marker!==null)throw Error('notfreshowned');
const t=await d.$queryRawUnsafe("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public'");if(t[0].count!==0)throw Error('notempty');
await d.$executeRawUnsafe('COMMENT ON DATABASE '+n+" IS '"+m+"'");
})().catch(()=>{process.exitCode=1}).finally(()=>d.$disconnect());'''


def positive_probe():
    return r'''const{PrismaClient}=require('@prisma/client');const R=require('ioredis');const d=new PrismaClient();let r;
(async()=>{try{''' + FIXTURE_BINDING_GUARD + r'''
const v=new URL(process.env.REDIS_URL);if(v.protocol!=='rediss:'||v.hostname!=='redis'||v.pathname!=='/3')throw Error('redisguard');
r=new R(v.href,{lazyConnect:true,connectTimeout:2500,retryStrategy:()=>null,maxRetriesPerRequest:1});r.on('error',()=>{});
const migrations=await d.$queryRawUnsafe('SELECT count(*)::int AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL');
const b=await d.$queryRawUnsafe("SELECT current_database() AS name,shobj_description(oid,'pg_database') AS marker,datdba=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned FROM pg_database WHERE datname=current_database()");
const ssl=await d.$queryRawUnsafe('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()');await r.connect();const pong=await r.ping();
if(migrations[0]?.count!==31||b.length!==1||b[0].name!==n||b[0].marker!==m||b[0].owned!==true||ssl[0]?.ssl!==true||pong!=='PONG'||r.connector.stream.encrypted!==true||r.connector.stream.authorized!==true)throw Error('positive');
console.log(JSON.stringify({service:'both',check:'positive',result:'PASS',postgresTls:true,redisTls:true,migrations:31,fixtureMarker:true,fixtureOwner:true}));
}catch{console.log(JSON.stringify({service:'both',check:'positive',result:'FAIL',code:'POSITIVE_OR_GUARD_FAILED'}));process.exitCode=1;}
finally{r?.disconnect();await d.$disconnect();}})().catch(()=>{console.log(JSON.stringify({result:'FAIL',code:'POSITIVE_PROCESS_FAILED'}));process.exitCode=1;});'''


def verified_archive(path, expected_sha):
    require(re.fullmatch(r'[a-f0-9]{64}', expected_sha or '') is not None, 'EXACT_ARCHIVE_SHA256_REQUIRED')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and info.st_nlink == 1 and
                stat.S_IMODE(info.st_mode) == 0o600 and 0 < info.st_size <= MAX_ARCHIVE, 'UNSAFE_SOURCE_ARCHIVE')
        payload = stream.read(MAX_ARCHIVE + 1)
    require(len(payload) == info.st_size and hashlib.sha256(payload).hexdigest() == expected_sha,
            'SOURCE_ARCHIVE_HASH_MISMATCH')
    return payload


def validated_source(payload):
    """Validate every bounded record/body before extracting any source files."""
    entries, total, seen, records, bodies = 0, 0, set(), [], {}
    with tarfile.open(fileobj=io.BytesIO(payload), mode='r|*') as archive:
        for member in archive:
            entries += 1
            require(entries <= 20000 and (member.isdir() or member.isfile()) and not member.issparse(), 'SOURCE_ARCHIVE_TYPE_OR_ENTRY_LIMIT')
            name = member.name
            while name.startswith('./'):
                name = name[2:]
            if not name and member.isdir():
                continue
            name = name.rstrip('/')
            require(name and not name.startswith('/') and '\\' not in name and
                    not any(ord(character) < 32 or ord(character) == 127 for character in name), 'SOURCE_ARCHIVE_PATH')
            parts = name.split('/')
            require(not any(part in ('', '.', '..') or part in FORBIDDEN for part in parts) and
                    posixpath.normpath(name) == name and name not in seen, 'SOURCE_ARCHIVE_PATH_SCOPE')
            require(not any(name == prefix or name.startswith(prefix + '/') for prefix in EXCLUDED_PREFIXES), 'SOURCE_ARCHIVE_EXCLUDED_SCOPE')
            seen.add(name)
            base = parts[-1].lower()
            env_file = base == '.env' or base.startswith('.env.') or base.endswith('.env')
            require(not (env_file and not base.endswith('.example')) and
                    base not in {'id_rsa', 'id_ed25519', 'known_hosts', 'authorized_keys', 'app.env', '.npmrc', 'auth.json'} and
                    not base.endswith(('.pem', '.key', '.p12', '.pfx', '.jks', '.dump', '.sql.gz', '.sql.zst', '.sqlite', '.sqlite3', '.db')) and
                    'storagestate' not in base and 'storage-state' not in base, 'SOURCE_ARCHIVE_SECRET_OR_AUTH_FILE')
            body = b''
            if member.isfile():
                require(0 <= member.size <= MAX_FILE, 'SOURCE_ARCHIVE_FILE_LIMIT')
                total += member.size
                require(total <= MAX_EXPANDED, 'SOURCE_ARCHIVE_EXPANDED_LIMIT')
                body = archive.extractfile(member).read(member.size + 1)
                require(len(body) == member.size, 'SOURCE_ARCHIVE_TRUNCATED')
                require(re.search(rb'(?m)^-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]{48}', body) is None and
                        re.search(rb'\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b', body) is None,
                        'SOURCE_ARCHIVE_CREDENTIAL_MATERIAL')
                if name in REQUIRED:
                    bodies[name] = body
            if not env_file:  # Even public .env examples need not enter the mount.
                records.append((name, member.isdir(), bool(member.mode & 0o111), body))
    require(REQUIRED.issubset(seen) and REQUIRED.issubset(bodies), 'REQUIRED_P1_SOURCE_MISSING')
    migrations = [name for name in seen if re.fullmatch(r'packages/database/prisma/migrations/[^/]+/migration\.sql', name)]
    require(len(migrations) == 31, 'EXACT_31_MIGRATIONS_REQUIRED')
    schema = bodies['packages/database/prisma/schema.prisma']
    require(b'model SecurityRepairRun {' in schema and b'model SecurityRepairAttempt {' in schema, 'P1_JOURNAL_SCHEMA_REQUIRED')
    require(json.loads(bodies['packages/security-orchestration/package.json'])['name'] == '@zerochack/security-orchestration', 'P1_ORCHESTRATION_PACKAGE_REQUIRED')
    return records, json.loads(bodies['package-lock.json'])


def dependency_mounts(modules, source_lock):
    require(modules.is_dir() and modules.name == 'node_modules' and not modules.is_symlink() and
            (modules / '@prisma/client/package.json').is_file(), 'REVIEWED_NEW_NODE_MODULES_REQUIRED')
    installed = json.loads((modules / '.package-lock.json').read_text())
    require(source_lock.get('lockfileVersion') == installed.get('lockfileVersion') == 3, 'COMPLETED_NPM_CI_LOCK_REQUIRED')
    installed_packages = installed.get('packages', {})
    expected = source_lock.get('packages', {})
    require(bool(expected) and bool(installed_packages), 'COMPLETED_NPM_CI_PACKAGES_REQUIRED')
    nested = set()
    for name, value in expected.items():
        if 'node_modules/' not in name or value.get('link'):
            continue
        if name not in installed_packages and value.get('optional'):
            continue  # npm omits unsupported platform-specific optional binaries.
        require(installed_packages.get(name, {}).get('version') == value.get('version') and value.get('version'), 'NPM_CI_LOCK_DOES_NOT_MATCH_ARCHIVE')
        if not name.startswith('node_modules/'):
            prefix = name.split('/node_modules/', 1)[0] + '/node_modules'
            require(re.fullmatch(r'(apps|packages)/[A-Za-z0-9_-]+/node_modules', prefix), 'UNREVIEWED_DEPENDENCY_MOUNT')
            nested.add(prefix)
    for name, value in installed_packages.items():
        if 'node_modules/' in name and not value.get('link'):
            require(expected.get(name, {}).get('version') == value.get('version') and value.get('version'), 'UNEXPECTED_INSTALLED_DEPENDENCY')
    result = [(modules, '/workspace/node_modules')]
    for relative in sorted(nested):
        path = modules.parent / relative
        require(path.is_dir() and not path.is_symlink() and path.resolve() == path, 'MISSING_NESTED_WORKSPACE_DEPENDENCIES')
        result.append((path, '/workspace/' + relative))
    return result


class Fixture:
    def __init__(self, args):
        self.args = args
        self.folder = None
        self.created = []
        self.redact = []
        self.client_arguments = []

    def command(self, args, timeout=30, allow_failure=False):
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, timeout=timeout, check=False)
        text = result.stdout + result.stderr
        for value in sorted(self.redact, key=len, reverse=True):
            text = text.replace(value, '<redacted-test-secret>')
        if self.folder:
            with (self.folder / 'commands.log').open('a', encoding='utf8') as stream:
                stream.write(text)
        require(allow_failure or result.returncode == 0, 'COMMAND_FAILED:' + Path(args[0]).name)
        return result.returncode, result.stdout

    def docker(self, *args, **kwargs):
        # Never follow a workstation DOCKER_HOST/context to a remote daemon.
        return self.command(['docker', '--host', 'unix:///var/run/docker.sock', *args], **kwargs)

    def write(self, relative, value, mode=0o600):
        path = self.folder / relative
        with path.open('x', encoding='utf8') as stream:
            stream.write(value)
        path.chmod(mode)

    def extract_source(self, records):
        destination = self.folder / 'source'
        destination.mkdir(mode=0o700)
        for name, is_directory, executable, body in records:
            target = destination / name
            if is_directory:
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
            else:
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with target.open('xb') as output:
                    output.write(body)
                target.chmod(0o700 if executable else 0o600)

    def certificates(self):
        for path in ('trust', 'postgres-tls', 'redis-tls'):
            (self.folder / path).mkdir(mode=0o700)
        self.command(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
                      '-subj', '/CN=Disposable local CodeBandage P1 CA', '-addext', 'basicConstraints=critical,CA:TRUE',
                      '-keyout', str(self.folder / 'ca.key'), '-out', str(self.folder / 'trust/ca.crt')])
        for service in ('postgres', 'redis'):
            self.write(service + '.ext', f'subjectAltName=DNS:{service}\nextendedKeyUsage=serverAuth\n')
            self.command(['openssl', 'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=' + service,
                          '-keyout', str(self.folder / (service + '-tls/server.key')), '-out', str(self.folder / (service + '.csr'))])
            self.command(['openssl', 'x509', '-req', '-days', '2', '-in', str(self.folder / (service + '.csr')),
                          '-CA', str(self.folder / 'trust/ca.crt'), '-CAkey', str(self.folder / 'ca.key'), '-CAcreateserial',
                          '-extfile', str(self.folder / (service + '.ext')), '-out', str(self.folder / (service + '-tls/server.crt'))])
            (self.folder / (service + '-tls/server.key')).chmod(0o600)
            (self.folder / (service + '-tls/server.crt')).chmod(0o644)
        (self.folder / 'ca.key').chmod(0o600)
        (self.folder / 'trust/ca.crt').chmod(0o644)

    def create(self):
        require(self.args.local_development_only and socket.gethostname() != 'vmi3643652' and
                os.geteuid() == 1000, 'LOCAL_UID1000_DEVELOPMENT_ONLY')
        require(self.args.npm_ci_completed, 'EXPLICIT_COMPLETED_NPM_CI_REQUIRED')
        payload = verified_archive(self.args.source_archive, self.args.source_sha)
        records, source_lock = validated_source(payload)
        modules = Path(self.args.node_modules).absolute()
        mounts = dependency_mounts(modules, source_lock)
        available = os.statvfs(tempfile.gettempdir())
        require(available.f_bavail * available.f_frsize >= 2 * 1024**3, 'LOCAL_DISK_RESERVE_REQUIRED')
        _, daemon = self.docker('info', '--format', '{{.Name}} {{.ServerVersion}}')
        require(daemon.strip() == socket.gethostname() + ' 28.5.2+dfsg3', 'REVIEWED_LOCAL_DAEMON_REQUIRED')
        for role, identity in IMAGES.items():
            _, output = self.docker('image', 'inspect', '--format', '{{.Id}} {{json .Config.User}}', identity)
            require(output.split()[0] == identity and (role != 'tools' or output.strip().endswith('"node"')), 'CACHED_IMAGE_ID_OR_USER_MISMATCH')
        attempt = secrets.token_hex(4)
        binding = fixture_identity(self.args.source_sha, attempt, self.args.legacy_integration)
        stem = ('codebandage-p1-legacy-' if self.args.legacy_integration else 'codebandage-p1-') + self.args.source_sha[:12] + '-' + attempt
        self.folder = Path(tempfile.mkdtemp(prefix=stem + '-'))
        self.folder.chmod(0o700)
        self.write('commands.log', '')
        self.extract_source(records)
        self.certificates()
        database = binding['SECURITY_WORKPLACE_TEST_DATABASE']
        marker = binding['SECURITY_WORKPLACE_TEST_MARKER']
        pg_password, redis_password = secrets.token_urlsafe(36), secrets.token_urlsafe(36)
        self.redact += [pg_password, redis_password]
        database_url = f'postgresql://p1fixture:{quote(pg_password,safe="")}@postgres:5432/{database}?sslmode=require&sslaccept=strict&sslcert=/run/trust/ca.crt'
        redis_url = f'rediss://default:{quote(redis_password,safe="")}@redis:6379/3'
        self.redact += [database_url, redis_url]
        values = {'NODE_ENV': 'test', 'DATABASE_URL': database_url, 'REDIS_URL': redis_url,
                  'NODE_EXTRA_CA_CERTS': '/run/trust/ca.crt', **binding,
                  'APP_URL': 'https://codebandage.com', 'NEXT_PUBLIC_API_URL': 'https://codebandage.com/v1',
                  'CORS_ORIGINS': 'https://codebandage.com', 'LOG_LEVEL': 'silent',
                  'SMTP_HOST': 'smtp.fixture.invalid', 'SMTP_PORT': '465', 'SMTP_SECURE': 'true',
                  'SMTP_FROM': 'fixture@codebandage.com'}
        for key in ('SESSION_SECRET', 'REPORT_SIGNING_KEY', 'METRICS_TOKEN'):
            values[key] = secrets.token_urlsafe(48)
            self.redact.append(values[key])
        for key in ('MFA_ENCRYPTION_KEY', 'AI_CREDENTIAL_ENCRYPTION_KEY', 'PAYMENT_CREDENTIAL_ENCRYPTION_KEY',
                    'INTEGRATION_CREDENTIAL_ENCRYPTION_KEY', 'CARE_VAULT_KEY', 'CARE_ARTIFACT_KEY'):
            values[key] = base64.b64encode(secrets.token_bytes(32)).decode()
            self.redact.append(values[key])
        for key in ('CARE_ENABLED', 'CARE_REVIEW_ENABLED', 'CARE_REPAIR_ENABLED', 'CARE_RELEASE_ENABLED',
                    'CARE_VERIFICATION_ENABLED', 'CARE_BROWSER_ENABLED', 'CARE_OBSERVATIONS_ENABLED', 'CARE_ADVISORIES_ENABLED'):
            values[key] = 'false'
        self.write('app.env', ''.join(f'{key}={value}\n' for key, value in values.items()))
        self.write('postgres.env', f'POSTGRES_USER=p1fixture\nPOSTGRES_DB={database}\nPOSTGRES_PASSWORD={pg_password}\nPOSTGRES_INITDB_ARGS=--auth-host=scram-sha-256\n')
        self.write('pg_hba.conf', 'local all all trust\nhostssl all all all scram-sha-256\nhostnossl all all all reject\n')
        self.write('redis.conf', '\n'.join(['port 0', 'tls-port 6379', 'tls-cert-file /run/tls/server.crt',
                   'tls-key-file /run/tls/server.key', 'tls-ca-cert-file /run/trust/ca.crt', 'tls-auth-clients no',
                   'requirepass ' + redis_password, 'dir /data', 'appendonly yes', 'maxmemory 64mb', 'maxmemory-policy noeviction']) + '\n')
        self.docker('network', 'create', '--internal', '--label', LABEL, stem)
        _, internal = self.docker('network', 'inspect', '--format', '{{.Internal}}', stem)
        require(internal.strip() == 'true', 'PRIVATE_INTERNAL_NETWORK_REQUIRED')
        common = ['--network', stem, '--user', '1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                  '--label', LABEL, '--log-opt', 'max-size=1m', '--log-opt', 'max-file=2', '--restart=no']
        for role, memory, cpu, data_path, data_size in (
                ('postgres', '768m', '0.5', '/var/lib/postgresql/data', '512m'),
                ('redis', '192m', '0.25', '/data', '64m')):
            name = stem + '-' + role
            args = ['run', '-d', '--name', name, *common, '--network-alias', role,
                    '--network-alias', role + '-wrong-name', '--memory', memory, '--cpus', cpu, '--pids-limit', '128',
                    '--tmpfs', data_path + ':rw,nosuid,nodev,size=' + data_size + ',uid=1000,gid=1000,mode=0700',
                    '-v', str(self.folder / (role + '-tls')) + ':/run/tls:ro',
                    '-v', str(self.folder / 'trust') + ':/run/trust:ro']
            if role == 'postgres':
                args += ['--env-file', str(self.folder / 'postgres.env'), '-v', str(self.folder / 'pg_hba.conf') + ':/etc/pg_hba.conf:ro',
                         IMAGES[role], 'postgres', '-c', 'ssl=on', '-c', 'ssl_cert_file=/run/tls/server.crt',
                         '-c', 'ssl_key_file=/run/tls/server.key', '-c', 'hba_file=/etc/pg_hba.conf', '-c', 'max_connections=40']
            else:
                args += ['-v', str(self.folder / 'redis.conf') + ':/run/redis.conf:ro', IMAGES[role], 'redis-server', '/run/redis.conf']
            _, identity = self.docker(*args)
            identity = identity.strip()
            require(re.fullmatch(r'[a-f0-9]{64}', identity), 'INVALID_FIXTURE_CONTAINER_ID')
            self.created.append(identity)
            _, published = self.docker('inspect', '--format', '{{json .HostConfig.PortBindings}}', identity)
            require(published.strip() in ('{}', 'null'), 'PUBLISHED_SERVICE_PORT_REFUSED')
        for _ in range(40):
            status, _ = self.docker('exec', stem + '-postgres', 'pg_isready', '-U', 'p1fixture', '-d', database, allow_failure=True)
            if status == 0:
                break
            time.sleep(0.5)
        else:
            raise RuntimeError('FRESH_POSTGRES_NOT_READY')
        tool_args = ['run', '--rm', '--network', stem, '--user', '1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                     '--memory', '2g', '--cpus', '1', '--pids-limit', '256', '--env-file', str(self.folder / 'app.env'),
                     '--label', LABEL, '-v', str(self.folder / 'trust') + ':/run/trust:ro',
                     '-v', str(self.folder / 'source') + ':/workspace:rw',
                     '--workdir', '/workspace']
        for host_path, target_path in mounts:
            tool_args += ['-v', str(host_path) + ':' + target_path + ':rw']
        self.client_arguments = ['docker', '--host', 'unix:///var/run/docker.sock', *tool_args]
        self.write('client-arguments.json', json.dumps({'prefix': self.client_arguments, 'toolsImage': IMAGES['tools'],
                   'sourceArchiveSha256': self.args.source_sha, 'binding': binding,
                   'appendExample': ['--entrypoint', 'npm', IMAGES['tools'], 'run', 'lint'],
                   'containsCredentials': False, 'envFileMustRemainProtected': True}, indent=2) + '\n')
        _, tool_uid = self.docker(*tool_args, '--entrypoint', 'id', IMAGES['tools'], '-u')
        require(tool_uid.strip() == '1000', 'EXACT_TOOLS_UID1000_REQUIRED')
        self.docker(*tool_args, '--entrypoint', 'npm', IMAGES['tools'], 'run', 'db:generate', timeout=120)
        self.docker(*tool_args, '--entrypoint', 'node', IMAGES['tools'], '-e', fresh_database_probe())
        self.docker(*tool_args, '--entrypoint', 'npm', IMAGES['tools'], 'run', 'db:migrate:deploy', timeout=120)
        verify = positive_probe()
        self.docker(*tool_args, '--entrypoint', 'node', IMAGES['tools'], '-e', verify)
        for service in ('postgres', 'redis'):
            for negative in ('password', 'hostname', 'ca'):
                extra = ['-e', 'NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt'] if service == 'redis' and negative == 'ca' else []
                self.docker(*tool_args, *extra, '--entrypoint', 'node', IMAGES['tools'], '-e', negative_probe(service, negative), timeout=30)
            # A stopped/broken fixture is not evidence of authentication or TLS
            # enforcement. Verify both services again after each negative group.
            self.docker(*tool_args, '--entrypoint', 'node', IMAGES['tools'], '-e', verify)
        self.write('receipt.json', json.dumps({'scope': LABEL, 'sourceArchiveSha256': self.args.source_sha,
                   'binding': binding, 'clientArguments': self.client_arguments,
                   'network': stem, 'database': database, 'databaseMarker': marker, 'images': IMAGES,
                   'containerIds': self.created, 'tls': 'PASS', 'negativeTlsAuthChecks': 6,
                   'migrations': 31, 'servicePortsPublished': False,
                   'dataStorage': 'bounded tmpfs; disposable on stop', 'externalProviders': 'NOT_CALLED',
                   'developmentFixtureNotCustomerSandbox': True}, indent=2) + '\n')
        print(json.dumps({'result': 'LOCAL_P1_TLS_FIXTURE_READY', 'fixtureDirectory': str(self.folder),
                          'network': stem, 'migrations': 31, 'secretsPrinted': False,
                          'servicesRetainedForReviewedTests': True}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--create', action='store_true')
    parser.add_argument('--local-development-only', action='store_true')
    parser.add_argument('--legacy-integration', action='store_true', help='Create a separate fresh SHA/attempt-bound *_test database for legacy destructive integration tests; never reuses an existing fixture')
    parser.add_argument('--source-sha')
    parser.add_argument('--source-archive')
    parser.add_argument('--node-modules')
    parser.add_argument('--npm-ci-completed', action='store_true', help='Coordinator attests the fresh matching npm ci exited zero')
    args = parser.parse_args()
    require(args.create and args.local_development_only, 'EXPLICIT_LOCAL_FIXTURE_APPROVAL_REQUIRED')
    require(all((args.source_sha, args.source_archive, args.node_modules)), 'SNAPSHOT_AND_MODULES_REQUIRED')
    fixture = Fixture(args)
    try:
        fixture.create()
    except Exception as error:
        # Preserve the new fixture paths/evidence; never stop/delete another user's
        # containers, reset any database or prune images/volumes. Print no raw logs.
        print(json.dumps({'result': 'LOCAL_FIXTURE_FAILED', 'errorType': type(error).__name__,
                          'errorCode': str(error) if type(error) is RuntimeError and re.fullmatch(r'[A-Z][A-Z0-9_:]{2,100}', str(error)) else 'LOCAL_FIXTURE_OPERATION_FAILED',
                          'fixtureDirectory': str(fixture.folder) if fixture.folder else None,
                          'createdContainerIds': fixture.created, 'resourcesPreserved': True}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (RuntimeError, OSError, ValueError) as error:
        print(json.dumps({'result': 'REFUSED', 'errorType': type(error).__name__}), file=sys.stderr)
        raise SystemExit(1)
