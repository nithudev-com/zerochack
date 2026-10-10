#!/usr/bin/env python3
"""First provision only. Never replace any existing secret or certificate."""
import base64
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
from urllib.parse import quote

STATE = Path('/opt/codebandage/state')

def run(*args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def write(path, value, uid=0, gid=0, mode=0o600):
    path.write_text(value)
    os.chmod(path, mode)
    os.chown(path, uid, gid)

def main():
    if os.geteuid() != 0 or socket.gethostname() != 'vmi3643652':
        raise SystemExit('Run only as root on the verified CodeBandage VPS.')
    if STATE.exists():
        required = ['app.env', 'postgres.env', 'trust/ca.crt', 'ca/ca.key',
                    'postgres-tls/server.key', 'redis-tls/server.key',
                    'redis-config/redis.conf', 'backup.key', 'backup-auth.key']
        if not all((STATE / item).is_file() for item in required):
            raise SystemExit('Incomplete state: recover existing secrets; regeneration refused.')
        print('Existing state preserved; no secrets regenerated.')
        return
    volumes = subprocess.check_output(['docker', 'volume', 'ls', '--format', '{{.Name}}'], text=True)
    if any(name in volumes.splitlines() for name in ['codebandage_postgres_data', 'codebandage_redis_data']):
        raise SystemExit('Existing volumes without state: recover keys before proceeding.')
    os.umask(0o077)
    # Retain a failed partial directory for investigation; never automatically delete it.
    staging = Path(tempfile.mkdtemp(prefix='state-provision-', dir='/opt/codebandage'))
    for name in ['ca', 'trust', 'postgres-tls', 'redis-tls', 'redis-config']:
        (staging / name).mkdir()
    for name in ['trust', 'postgres-tls', 'redis-tls', 'redis-config']:
        os.chmod(staging / name, 0o755)
    ca = staging / 'ca'
    run('openssl', 'req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-days', '3650',
        '-subj', '/CN=CodeBandage private service CA', '-keyout', str(ca / 'ca.key'),
        '-out', str(staging / 'trust/ca.crt'), '-addext', 'basicConstraints=critical,CA:TRUE',
        '-addext', 'keyUsage=critical,keyCertSign,cRLSign')
    os.chmod(staging / 'trust/ca.crt', 0o644)
    for host, uid, gid in [('postgres', 70, 70), ('redis', 999, 1000)]:
        tls = staging / f'{host}-tls'
        csr = ca / f'{host}.csr'
        ext = ca / f'{host}.ext'
        write(ext, f'subjectAltName=DNS:{host}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n')
        run('openssl', 'req', '-new', '-newkey', 'rsa:3072', '-nodes', '-subj', f'/CN={host}',
            '-keyout', str(tls / 'server.key'), '-out', str(csr))
        run('openssl', 'x509', '-req', '-in', str(csr), '-CA', str(staging / 'trust/ca.crt'),
            '-CAkey', str(ca / 'ca.key'), '-CAcreateserial', '-days', '365',
            '-extfile', str(ext), '-out', str(tls / 'server.crt'))
        os.chown(tls / 'server.key', uid, gid)
        os.chmod(tls / 'server.key', 0o600)
        os.chmod(tls / 'server.crt', 0o644)
        run('openssl', 'verify', '-CAfile', str(staging / 'trust/ca.crt'),
            '-verify_hostname', host, str(tls / 'server.crt'))
    database_password = secrets.token_urlsafe(36)
    redis_password = secrets.token_urlsafe(36)
    write(staging / 'postgres.env', f'POSTGRES_PASSWORD={database_password}\n')
    write(staging / 'redis-config/password', redis_password, 999, 1000)
    write(staging / 'redis-config/redis.conf', '\n'.join([
        'bind 0.0.0.0', 'protected-mode yes', 'port 0', 'tls-port 6379',
        'tls-cert-file /run/tls/server.crt', 'tls-key-file /run/tls/server.key',
        'tls-ca-cert-file /run/trust/ca.crt', 'tls-auth-clients no',
        f'requirepass {redis_password}', 'appendonly yes', 'appendfsync everysec',
        'dir /data', 'maxmemory 512mb', 'maxmemory-policy noeviction',
        'save 900 1', 'save 300 10', 'save 60 10000', '']) ,999,1000)
    values = {
        'NODE_ENV': 'production', 'APP_URL': 'https://codebandage.com',
        'NEXT_PUBLIC_API_URL': 'https://codebandage.com/v1',
        'CORS_ORIGINS': 'https://codebandage.com', 'TRUST_PROXY': 'true',
        'DATABASE_URL': f'postgresql://zerochack:{quote(database_password, safe="")}@postgres:5432/zerochack?schema=public&sslmode=require&sslaccept=strict&sslcert=/run/trust/ca.crt',
        'REDIS_URL': f'rediss://default:{quote(redis_password, safe="")}@redis:6379',
        'LOG_LEVEL': 'info',
    }
    for name in ['SESSION_SECRET', 'REPORT_SIGNING_KEY', 'METRICS_TOKEN']:
        values[name] = secrets.token_urlsafe(48)
    for name in ['MFA_ENCRYPTION_KEY', 'AI_CREDENTIAL_ENCRYPTION_KEY',
                 'PAYMENT_CREDENTIAL_ENCRYPTION_KEY', 'INTEGRATION_CREDENTIAL_ENCRYPTION_KEY',
                 'CARE_VAULT_KEY', 'CARE_ARTIFACT_KEY']:
        values[name] = base64.b64encode(secrets.token_bytes(32)).decode()
    for name in ['CARE_ENABLED', 'CARE_REVIEW_ENABLED', 'CARE_REPAIR_ENABLED',
                 'CARE_RELEASE_ENABLED', 'CARE_BROWSER_ENABLED', 'CARE_VERIFICATION_ENABLED',
                 'CARE_OBSERVATIONS_ENABLED', 'CARE_ADVISORIES_ENABLED']:
        values[name] = 'false'
    write(staging / 'app.env', ''.join(f'{key}={value}\n' for key, value in values.items()))
    write(staging / 'backup.key', secrets.token_hex(48))
    write(staging / 'backup-auth.key', secrets.token_hex(48))
    staging.rename(STATE)
    print('Protected state created. SMTP configuration is still required; launch remains gated.')

if __name__ == '__main__':
    main()
