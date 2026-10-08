#!/usr/bin/env python3
"""Enter credentials directly on the verified VPS, never via command arguments."""
import getpass
import os
from pathlib import Path
import socket

if os.geteuid() != 0 or socket.gethostname() != 'vmi3643652':
    raise SystemExit('Run only on the verified CodeBandage VPS as root.')
path = Path('/opt/codebandage/state/smtp.env')
if path.exists():
    raise SystemExit('Existing SMTP config preserved. Review/edit it securely for rotation.')
host = input('SMTP host: ').strip()
port = int(input('SMTP port (465 implicit TLS or 587 STARTTLS): '))
sender = input('Verified sender email: ').strip()
user = input('SMTP username: ').strip()
password = getpass.getpass('SMTP password/API credential: ')
if port not in [465, 587] or not host or '@' not in sender or not user or not password:
    raise SystemExit('Complete provider configuration required.')
values = {'SMTP_HOST': host, 'SMTP_PORT': str(port), 'SMTP_SECURE': str(port == 465).lower(),
          'SMTP_FROM': sender, 'SMTP_USER': user, 'SMTP_PASSWORD': password}
if any('\n' in value or '\r' in value for value in values.values()):
    raise SystemExit('Multiline values are not supported.')
os.umask(0o077)
with path.open('x') as stream:
    stream.write(''.join(f'{key}={value}\n' for key, value in values.items()))
print('SMTP stored without displaying credentials. Actual provider verification still required.')
