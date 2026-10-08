#!/usr/bin/env python3
"""Decrypt only authenticated backups; restore only to an empty disposable DB."""
import hashlib
import hmac
import os
from pathlib import Path
import re
import socket
import subprocess
import sys

if os.geteuid() != 0 or socket.gethostname() != 'vmi3643652':
    raise SystemExit('Run only as root on the verified VPS.')
manifest, encrypted, database = sys.argv[1:4]
if not re.fullmatch(r'codebandage_restore_test_[a-z0-9_]+', database):
    raise SystemExit('Only a uniquely named disposable restore-test database is allowed.')
root = Path(__file__).resolve().parents[2]
state = Path('/opt/codebandage/state')
backup = Path(encrypted).resolve()
auth = hmac.new((state / 'backup-auth.key').read_bytes(), digestmod=hashlib.sha256)
with backup.open('rb') as stream:
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        auth.update(chunk)
if not hmac.compare_digest(auth.hexdigest(), backup.with_suffix(backup.suffix + '.hmac').read_text().strip()):
    raise SystemExit('Backup authentication failed; decryption refused.')
compose = ['docker', 'compose', '--env-file', manifest, '-f', str(root / 'infrastructure/production/compose.yml'), 'exec', '-T', 'postgres']
prefix = 'export PGPASSWORD="$POSTGRES_PASSWORD" PGSSLMODE=verify-full PGSSLROOTCERT=/run/trust/ca.crt; '
# createdb fails when the target exists; never overwrites any database.
subprocess.run(compose + ['sh', '-c', prefix + f'createdb -h postgres -U zerochack {database}'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
decrypt = subprocess.Popen(['openssl', 'enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '600000',
    '-pass', 'file:' + str(state / 'backup.key'), '-in', str(backup)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
restore = subprocess.Popen(compose + ['sh', '-c', prefix + f'pg_restore -h postgres -U zerochack -d {database} --exit-on-error --no-owner'], stdin=decrypt.stdout, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
decrypt.stdout.close()
restore_status = restore.wait()
decrypt_status = decrypt.wait()
if restore_status or decrypt_status:
    raise SystemExit('Restore failed. Disposable database retained for investigation.')
subprocess.run(compose + ['sh', '-c', prefix + f'psql -h postgres -U zerochack -d {database} -v ON_ERROR_STOP=1 -c \'SELECT count(*) AS applied_migrations FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;\''], check=True)
print('Database restore completed into ' + database + '; retained for application/key recovery checks.')
