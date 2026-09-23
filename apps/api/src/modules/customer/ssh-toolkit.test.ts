import { describe, expect, it } from 'vitest';
import { parseServerInspectionOutput, serverInspectionScript } from './ssh-toolkit.js';

describe('read-only SSH inspection', () => {
  it('parses measured coverage and real server indicators without file contents', () => {
    const result = parseServerInspectionOutput([
      'PLATFORM\tLinux 6.8 x86_64',
      'ROOT\t/var/www/site\t',
      'SCANNED_FILES\t824',
      'SCAN_LIMIT_REACHED\t0',
      'MALWARE_SCANNER\tCLAMAV',
      'MALWARE_SIGNATURE\t/var/www/site/uploads/cache.php\thigh-confidence obfuscated web-shell signature',
      'CLAMAV_DETECTION\t/var/www/site/tmp/payload.php\tWin.Trojan.Agent',
      'SUSPICIOUS_CRON\tuser-crontab\tscheduled downloader',
      'EXCESSIVE_SECRET_PERMISSIONS\t/var/www/site/.env\tcredential-bearing file is readable by other local users',
      'SSH_AUTH_FILE_WRITABLE\t/home/deploy/.ssh/authorized_keys\tSSH authorization file is writable by group or other users',
      'WORLD_WRITABLE\trelative/path\tignored because it is not an absolute server path'
    ].join('\n'));

    expect(result).toMatchObject({ platform: 'Linux 6.8 x86_64', roots: ['/var/www/site'], scannedFiles: 824, scanLimitReached: false, malwareScanner: 'CLAMAV' });
    expect(result.observations.map((item) => item.kind)).toEqual(['MALWARE_SIGNATURE', 'CLAMAV_DETECTION', 'SUSPICIOUS_CRON', 'EXCESSIVE_SECRET_PERMISSIONS', 'SSH_AUTH_FILE_WRITABLE']);
    expect(JSON.stringify(result)).not.toContain('file contents');
  });

  it('keeps the remote workflow read-only and resource bounded', () => {
    expect(serverInspectionScript).toContain('MAX_CODE_FILES=25000');
    expect(serverInspectionScript).toContain('timeout 75s clamscan');
    expect(serverInspectionScript).not.toMatch(/\b(?:rm|mv|cp|chmod|chown|truncate|mktemp)\b/u);
  });
});
