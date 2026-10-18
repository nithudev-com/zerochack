#!/usr/bin/env python3
"""Enable only base encrypted capture after exact-image SSH acceptance evidence."""
import base64
import datetime
import fcntl
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

def protected(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_uid != 0 or path.stat().st_mode & 0o077:
        raise SystemExit('Protected root-owned regular file required: ' + str(path))

def values(path):
    pairs = [line.split('=', 1) for line in path.read_text().splitlines() if line and not line.startswith('#')]
    if any(len(pair) != 2 for pair in pairs) or len({pair[0] for pair in pairs}) != len(pairs):
        raise SystemExit('Ambiguous configuration; no changes made.')
    return dict(pairs)

if os.geteuid() != 0 or socket.gethostname() != 'vmi3643652':
    raise SystemExit('Run only on the verified VPS as root.')
if len(sys.argv) != 3:
    raise SystemExit('Usage: enable-ssh-capture.py IMMUTABLE_MANIFEST SSH_ACCEPTANCE_JSON')
lock = open('/opt/codebandage/deployment.lock', 'a')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
root = Path(__file__).resolve().parents[2]
if subprocess.check_output(['git', '-C', str(root), 'status', '--porcelain'], text=True).strip():
    raise SystemExit('Reviewed clean revision required.')
revision = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
manifest, evidence = map(Path, sys.argv[1:])
for item in [manifest, evidence]: protected(item)
release = values(manifest); checks = json.loads(evidence.read_text())
required = ['ssh_protocol', 'authenticated_capture', 'credential_replacement', 'expiry', 'browser_production', 'production_readiness']
if release.get('STATE_DIR') != '/opt/codebandage/state' or release.get('RELEASE_COMMIT') != revision or checks.get('commit') != revision or any(checks.get('checks', {}).get(name) != 'PASS' for name in required):
    raise SystemExit('Exact-revision acceptance evidence incomplete; capture remains unchanged.')
for name in ['API', 'WORKER', 'WEB', 'TOOLS']:
    identity = release.get(name + '_IMAGE', '')
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', identity) or checks.get('images', {}).get(name) != identity:
        raise SystemExit('Tested immutable image identity required.')
    label = subprocess.check_output(['docker', 'image', 'inspect', '--format', '{{ index .Config.Labels "org.opencontainers.image.revision" }}', identity], text=True).strip()
    if label != revision: raise SystemExit('Image revision mismatch.')
state = Path(release['STATE_DIR']); env = state / 'app.env'; protected(env)
if state.is_symlink() or state.stat().st_uid != 0 or state.stat().st_mode & 0o077:
    raise SystemExit('Protected state directory required.')
config = values(env)
advanced = ['CARE_REVIEW_ENABLED', 'CARE_REPAIR_ENABLED', 'CARE_RELEASE_ENABLED', 'CARE_VERIFICATION_ENABLED', 'CARE_BROWSER_ENABLED', 'CARE_OBSERVATIONS_ENABLED', 'CARE_ADVISORIES_ENABLED']
if config.get('NODE_ENV') != 'production' or config.get('CARE_ENABLED') not in ['true', 'false'] or any(config.get(name) != 'false' for name in advanced):
    raise SystemExit('Production configuration with all advanced Care capabilities disabled required.')
try: vault = base64.b64decode(config.get('CARE_VAULT_KEY', ''), validate=True)
except ValueError: raise SystemExit('Existing vault key is invalid; never regenerate it as a repair.')
if len(vault) != 32 or config['CARE_VAULT_KEY'] in [config.get(name) for name in ['MFA_ENCRYPTION_KEY', 'AI_CREDENTIAL_ENCRYPTION_KEY', 'INTEGRATION_CREDENTIAL_ENCRYPTION_KEY']] or vault == b'\x00' * 32:
    raise SystemExit('Distinct existing vault key required; no keys were changed.')
compose = ['docker', 'compose', '--ansi', 'never', '--env-file', str(manifest), '-f', str(root / 'infrastructure/production/compose.yml')]
for name in ['api', 'worker', 'web']:
    container = subprocess.check_output([*compose, 'ps', '-q', name], text=True).strip()
    if not container or '\n' in container: raise SystemExit('One running tested container per service required.')
    image = subprocess.check_output(['docker', 'inspect', '--format', '{{.Image}}', container], text=True).strip()
    if image != release[name.upper() + '_IMAGE']: raise SystemExit('Deploy tested images before enabling capture.')
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = state / ('app.env.before-ssh-' + stamp)
changed = config['CARE_ENABLED'] == 'false'
if changed:
    # Preserve every existing secret byte; replace exactly one unambiguous flag.
    shutil.copy2(env, backup); backup.chmod(0o600)
    content, count = re.subn(r'^CARE_ENABLED=false$', 'CARE_ENABLED=true', env.read_text(), flags=re.MULTILINE)
    if count != 1: raise SystemExit('Ambiguous flag; no changes made.')
    fd, temporary = tempfile.mkstemp(prefix='app.env.ssh-', dir=state)
    with os.fdopen(fd, 'w') as stream:
        stream.write(content); stream.flush(); os.fsync(stream.fileno())
    os.chmod(temporary, 0o600); os.replace(temporary, env)
try:
    run(*compose, 'config', '--quiet')
    run(*compose, 'up', '-d', '--wait', '--wait-timeout', '180', 'api', 'worker')
    for service in ['api', 'worker']:
        run(*compose, 'exec', '-T', service, 'node', '-e', 'if(process.env.CARE_ENABLED!=="true"||Object.entries(process.env).some(([k,v])=>/^CARE_.+_ENABLED$/.test(k)&&v!=="false"))process.exit(1);console.log("Base capture enabled; advanced capabilities disabled")')
    with urllib.request.urlopen('http://127.0.0.1:4000/v1/health/ready', timeout=10) as response:
        if response.status != 200: raise RuntimeError('Readiness failed')
except Exception:
    if changed:
        shutil.copy2(backup, env)
        run(*compose, 'up', '-d', '--wait', '--wait-timeout', '180', 'api', 'worker')
    raise
record = state / ('ssh-capture-' + stamp + '.json')
record.write_text(json.dumps({'commit': revision, 'manifest': str(manifest), 'acceptance': str(evidence), 'base_capture': True, 'advanced_capabilities': False, 'previous_environment': str(backup) if changed else None, 'status': 'RESTRICTED PREVIEW'}, indent=2) + '\n')
record.chmod(0o600)
print('Base encrypted SSH capture enabled. No key rotation, migration, assessment or repair performed.')
