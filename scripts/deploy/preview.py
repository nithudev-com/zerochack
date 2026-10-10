#!/usr/bin/env python3
"""IP-restricted acceptance preview; never records public release gates as passed."""
import datetime
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import urllib.request

def run(*args):
    subprocess.run(args, check=True)

if os.geteuid() != 0 or socket.gethostname() != 'vmi3643652':
    raise SystemExit('Run only on the verified VPS as root.')
lock = open('/opt/codebandage/deployment.lock', 'a')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
manifest = Path(sys.argv[1]).resolve()
peer = os.environ.get('SSH_CONNECTION', '').split()
address = str(ipaddress.ip_address(sys.argv[2]))
if not peer or address != peer[0] or not ipaddress.ip_address(address).is_global:
    raise SystemExit('Preview must use the public peer IP of this authenticated SSH connection.')
root = Path(__file__).resolve().parents[2]
if subprocess.check_output(['git', '-C', str(root), 'status', '--porcelain'], text=True).strip():
    raise SystemExit('Commit and review the candidate first.')
revision = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
if manifest.stat().st_mode & 0o077:
    raise SystemExit('Release manifest must be mode 600.')
values = dict(line.split('=', 1) for line in manifest.read_text().splitlines() if line and not line.startswith('#'))
if values.get('RELEASE_COMMIT') != revision or values.get('STATE_DIR') != '/opt/codebandage/state':
    raise SystemExit('Manifest must identify this candidate and the protected production state.')
for name in ['API', 'WORKER', 'WEB', 'TOOLS']:
    identity = values.get(name + '_IMAGE', '')
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', identity):
        raise SystemExit('Immutable daemon-local image IDs required.')
    data = json.loads(subprocess.check_output(['docker', 'image', 'inspect', identity], text=True))[0]
    if (data['Config'].get('Labels') or {}).get('org.opencontainers.image.revision') != revision:
        raise SystemExit('Image revision mismatch.')
state = Path(values['STATE_DIR'])
if state.stat().st_mode & 0o077:
    raise SystemExit('Protected state directory required.')
for name in ['app.env', 'smtp.env', 'postgres.env']:
    item = state / name
    if not item.is_file() or item.stat().st_mode & 0o077 or item.stat().st_uid != 0:
        raise SystemExit('Missing or unprotected state: ' + name)
config = (root / 'infrastructure/production/Caddyfile.preview').read_text().replace('__PREVIEW_IP__', address)
fd, name = tempfile.mkstemp(prefix='Caddyfile.preview-', dir='/etc/caddy')
os.close(fd)
candidate = Path(name)
candidate.write_text(config)
candidate.chmod(0o644)
run('caddy', 'validate', '--config', str(candidate), '--adapter', 'caddyfile')
compose = ['docker', 'compose', '--ansi', 'never', '--progress', 'plain', '--env-file', str(manifest),
           '-f', str(root / 'infrastructure/production/compose.yml')]
run(*compose, 'config', '--quiet')
# No migration, secret replacement, Owner reset, or release-gate override here.
run(*compose, 'up', '-d', '--wait', '--wait-timeout', '180', 'postgres', 'redis', 'api', 'worker', 'web')
with urllib.request.urlopen('http://127.0.0.1:4000/v1/health/ready', timeout=10) as response:
    if response.status != 200:
        raise SystemExit('Dependency readiness failed.')
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
current = Path('/etc/caddy/Caddyfile')
backup = Path('/etc/caddy/Caddyfile.before-preview-' + stamp)
shutil.copy2(current, backup)
shutil.copy2(candidate, current)
try:
    run('systemctl', 'reload', 'caddy')
    for route in ['/sign-in', '/v1/health/ready']:
        run('curl', '--fail', '--silent', '--show-error', '--max-time', '15',
            '--resolve', 'codebandage.com:443:127.0.0.1', '--output', '/dev/null',
            'https://codebandage.com' + route)
except subprocess.CalledProcessError:
    shutil.copy2(backup, current)
    run('systemctl', 'reload', 'caddy')
    raise
record = state / ('preview-' + stamp + '.json')
record.write_text(json.dumps({'status': 'RESTRICTED PREVIEW', 'commit': revision,
    'manifest': str(manifest), 'allowed_peer': address, 'previous_caddy': str(backup)}, indent=2) + '\n')
record.chmod(0o600)
print('RESTRICTED PREVIEW enabled for the authenticated SSH peer only.')
print('Public launch gates remain incomplete; use cutover.sh only after passing them.')
