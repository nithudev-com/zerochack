"""Operator-only importer. Pin a reviewed official archive hash; never use customer references."""
import argparse
import hashlib
import io
import json
import re
import urllib.request
import urllib.parse
import zipfile
from pathlib import PurePosixPath, Path


class OfficialRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        url = urllib.parse.urlparse(newurl)
        if url.scheme != 'https' or url.hostname not in ('wordpress.org', 'downloads.wordpress.org') or url.port not in (None, 443) or url.username or url.password:
            raise ValueError('Redirect outside official WordPress HTTPS hosts')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', required=True)
    parser.add_argument('--sha256', required=True, help='Independently reviewed expected archive digest')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'\d+\.\d+(?:\.\d+)?', args.version) or not re.fullmatch(r'[a-f0-9]{64}', args.sha256):
        raise ValueError('Exact stable version and SHA-256 required')
    url = f'https://wordpress.org/wordpress-{args.version}.zip'
    opener = urllib.request.build_opener(OfficialRedirects())
    with opener.open(url, timeout=30) as response:
        archive = response.read(32_000_001)
    if len(archive) > 32_000_000 or hashlib.sha256(archive).hexdigest() != args.sha256:
        raise ValueError('Archive size or digest mismatch')
    files = []
    total = 0
    with zipfile.ZipFile(io.BytesIO(archive)) as package:
        entries = package.infolist()
        if len(entries) > 10000 or sum(item.file_size for item in entries) > 100_000_000:
            raise ValueError('Archive limits exceeded')
        for item in entries:
            if not item.filename.startswith('wordpress/') or item.is_dir():
                continue
            path = item.filename[len('wordpress/'):]
            if not re.fullmatch(r'[A-Za-z0-9_@./-]{1,180}', path) or '..' in PurePosixPath(path).parts or path.startswith('wp-content/'):
                continue
            if PurePosixPath(path).suffix.lower() not in ('.php', '.js', '.css', '.json', '.txt', '.html'):
                continue
            if (item.external_attr >> 16) & 0o170000 == 0o120000 or item.file_size > 1_000_000:
                raise ValueError('Unsupported archive entry')
            raw = package.read(item)
            text = raw.decode('utf-8').replace('\r\n', '\n').replace('\r', '\n')
            total += len(text.encode('utf-8'))
            if total > 15_000_000:
                raise ValueError('Reference content too large')
            files.append({'path': path, 'content': text, 'sha256': hashlib.sha256(text.encode('utf-8')).hexdigest()})
    declarations = next(item['content'] for item in files if item['path'] == 'wp-includes/version.php')
    version = re.search(r"\$wp_version\s*=\s*['\"]([0-9.]+)['\"]", declarations)
    php = re.search(r"\$required_php_version\s*=\s*['\"]([0-9.]+)['\"]", declarations)
    if not version or version[1] != args.version or not php or len({item['path'].lower() for item in files}) != len(files) or len(files) > 3000:
        raise ValueError('Invalid package declarations')
    result = {'schema': 1, 'reviewedByOperator': True, 'wordpressVersion': args.version, 'phpMinimum': php[1], 'provenance': {'url': url, 'archiveSha256': args.sha256}, 'files': sorted(files, key=lambda item: item['path'])}
    encoded = json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    if len(encoded) > 20_000_000:
        raise ValueError('Reference too large')
    Path(args.output).write_bytes(encoded)
    print(json.dumps({'version': args.version, 'files': len(files), 'referenceSha256': hashlib.sha256(encoded).hexdigest()}))


if __name__ == '__main__':
    main()
