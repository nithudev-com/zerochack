#!/usr/bin/env python3
"""Secure interactive Owner bootstrap; preserves existing Owner credentials."""
import getpass
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile

if os.geteuid() != 0 or socket.gethostname() != 'vmi3643652':
    raise SystemExit('Run only as root on the verified CodeBandage VPS.')
root = Path(__file__).resolve().parents[2]
manifest = str(Path(sys.argv[1]).resolve())
values = {'OWNER_EMAIL': input('Owner email: ').strip(),
          'OWNER_NAME': input('Owner name: ').strip(),
          'OWNER_TENANT_NAME': input('Tenant label [CodeBandage]: ').strip() or 'CodeBandage',
          'OWNER_PASSWORD': getpass.getpass('Owner password (existing accounts are never reset): ')}
if any(not value or '\n' in value or '\r' in value for value in values.values()):
    raise SystemExit('Complete single-line Owner values required.')
os.umask(0o077)
folder = Path(tempfile.mkdtemp(prefix='owner-bootstrap-', dir='/opt/codebandage/state'))
environment = folder / 'owner.env'
override = folder / 'compose.json'
try:
    environment.write_text(''.join(f'{key}={value}\n' for key, value in values.items()))
    override.write_text(json.dumps({'services': {'tools': {'env_file': [
        {'path': str(environment), 'format': 'raw'}]}}}))
    subprocess.run(['docker', 'compose', '--env-file', manifest,
                    '-f', str(root / 'infrastructure/production/compose.yml'), '-f', str(override),
                    'run', '--rm', 'tools', 'node', 'apps/api/dist/scripts/create-owner.js'], check=True)
finally:
    # Remove only this invocation's known ephemeral credential files.
    environment.unlink(missing_ok=True)
    override.unlink(missing_ok=True)
    folder.rmdir()
print('Owner provisioning completed/preserved. Enroll MFA before privileged use.')
