#!/usr/bin/env python3
"""Authenticated encrypted PostgreSQL snapshot. Never writes plaintext to disk."""
import datetime
import hashlib
import hmac
import os
from pathlib import Path
import socket
import subprocess
import sys

if os.geteuid() != 0 or socket.gethostname() != 'vmi3643652':
    raise SystemExit('Run only as root on the verified VPS.')
root = Path(__file__).resolve().parents[2]
manifest = Path(sys.argv[1]).resolve()
destination = Path('/opt/codebandage/backups')
destination.mkdir(mode=0o700, exist_ok=True)
if destination.stat().st_mode & 0o077:
    raise SystemExit('Backup directory must have mode 700.')
state = Path('/opt/codebandage/state')
os.umask(0o077)
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
output = destination / f'postgres-{stamp}.dump.enc'
compose = ['docker', 'compose', '--env-file', str(manifest), '-f', str(root / 'infrastructure/production/compose.yml')]
dump = subprocess.Popen(compose + ['exec', '-T', 'postgres', 'sh', '-c',
    'PGPASSWORD="$POSTGRES_PASSWORD" PGSSLMODE=verify-full PGSSLROOTCERT=/run/trust/ca.crt pg_dump -h postgres -U zerochack -d zerochack --format=custom'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
encrypt = subprocess.Popen(['openssl', 'enc', '-aes-256-cbc', '-salt', '-pbkdf2', '-iter', '600000',
    '-pass', 'file:' + str(state / 'backup.key'), '-out', str(output)], stdin=dump.stdout, stderr=subprocess.DEVNULL)
dump.stdout.close()
enc_status = encrypt.wait()
dump_status = dump.wait()
if enc_status or dump_status:
    raise SystemExit('Backup failed; incomplete encrypted file retained for investigation, without authentication marker.')
auth = hmac.new((state / 'backup-auth.key').read_bytes(), digestmod=hashlib.sha256)
with output.open('rb') as stream:
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        auth.update(chunk)
output.with_suffix(output.suffix + '.hmac').write_text(auth.hexdigest() + '\n')
print('Encrypted database snapshot created: ' + str(output))
print('Redis queues are not included. Off-server upload and full key/artifact recovery remain separate requirements.')
