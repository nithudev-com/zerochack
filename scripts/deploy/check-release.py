#!/usr/bin/env python3
import json
import os
from pathlib import Path
import re
import subprocess
import sys

manifest = Path(sys.argv[1]).resolve()
gates = json.loads(Path(sys.argv[2]).read_text())
if manifest.stat().st_mode & 0o077:
    raise SystemExit('Release manifest must have mode 600.')
values = dict(line.split('=', 1) for line in manifest.read_text().splitlines() if line and not line.startswith('#'))
revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
if values.get('RELEASE_COMMIT') != revision or gates.get('commit') != revision:
    raise SystemExit('Candidate, manifest and gate revision must match.')
required = ['host_identity', 'github_published', 'dependencies', 'containers', 'unit', 'integration', 'browser',
            'production_images', 'tls_negative_tests', 'smtp_verified', 'restore_drill', 'migration_review']
if any(gates.get(name) != 'passed' for name in required):
    raise SystemExit('Release gates incomplete: ' + ', '.join(name for name in required if gates.get(name) != 'passed'))
if not gates.get('evidence_directory') or not Path(gates['evidence_directory']).is_dir():
    raise SystemExit('Retained test/audit evidence directory required.')
if values.get('STATE_DIR') != '/opt/codebandage/state':
    raise SystemExit('Unexpected production state directory.')
for service in ['API', 'WORKER', 'WEB', 'TOOLS']:
    identity = values.get(f'{service}_IMAGE', '')
    if not re.fullmatch(r'(?:[\w./:-]+@)?sha256:[a-f0-9]{64}', identity):
        raise SystemExit('Immutable image identity required for ' + service)
    image = json.loads(subprocess.check_output(['docker', 'image', 'inspect', identity], text=True))[0]
    if (image['Config'].get('Labels') or {}).get('org.opencontainers.image.revision') != revision:
        raise SystemExit('Image revision mismatch for ' + service)
    if gates.get('images', {}).get(service.lower()) != image['Id']:
        raise SystemExit('Tested image mismatch for ' + service)
state = Path(values['STATE_DIR'])
if state.stat().st_mode & 0o077:
    raise SystemExit('State directory must have mode 700.')
for name in ['app.env', 'smtp.env', 'postgres.env', 'backup.key', 'backup-auth.key']:
    path = state / name
    if not path.is_file() or path.stat().st_mode & 0o077 or path.stat().st_uid != os.geteuid():
        raise SystemExit('Missing or unprotected state file: ' + name)
print('Release identity and recorded gates match. Proceeding with private deployment.')
