"""Pure/local tests only. Never invokes SSH, apt, systemd, Docker or a provider."""
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from provision import PROFILE, PUBLIC_RUNTIME_BASE, Refusal, Runtime, ZSTD_DECODER_MEMORY_MB, check_ranges, daemon_config, extract_bounded, extract_zstd_bounded, managed_file, parse_ranges, run
from verify import PROBE, bounded_executable_hash


def archive(records):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w", format=tarfile.USTAR_FORMAT) as output:
        for name, kind, payload in records:
            member = tarfile.TarInfo(name)
            member.type = kind
            if kind == tarfile.REGTYPE:
                member.size = len(payload)
            else:
                member.linkname = payload.decode()
            output.addfile(member, io.BytesIO(payload) if kind == tarfile.REGTYPE else None)
    data.seek(0)
    return data


VALID = [("runsc", tarfile.REGTYPE, b"binary"),
         ("containerd-shim-runsc-v1", tarfile.REGTYPE, b"shim"),
         ("gvisor-bin/runsc-sentry", tarfile.REGTYPE, b"sentry")]


class GuardTests(unittest.TestCase):
    def test_valid_full_bundle(self):
        with tempfile.TemporaryDirectory() as temporary:
            result = extract_bounded(archive(VALID), Path(temporary), 100)
            self.assertEqual(result, {"extractedBytes": 16, "entries": 3})
            self.assertEqual((Path(temporary) / "gvisor-bin/runsc-sentry").read_bytes(), b"sentry")

    def test_archive_escape_and_unexpected_top_level(self):
        for name in ("../runsc", "/runsc", "gvisor-bin/../../etc/test", "etc/passwd", "gvisor-bin/a\nb"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                with self.assertRaises(Refusal):
                    extract_bounded(archive([(name, tarfile.REGTYPE, b"x")]), Path(temporary), 100)

    def test_no_links_or_devices(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.BLKTYPE, tarfile.FIFOTYPE):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temporary:
                with self.assertRaises(Refusal):
                    extract_bounded(archive([("runsc", kind, b"/etc/passwd")]), Path(temporary), 100)

    def test_duplicate_and_incomplete_and_budget(self):
        for records, maximum in ((VALID + [VALID[0]], 100), (VALID[:2], 100), (VALID, 15)):
            with self.subTest(records=records, maximum=maximum), tempfile.TemporaryDirectory() as temporary:
                with self.assertRaises(Refusal):
                    extract_bounded(archive(records), Path(temporary), maximum)

    def test_ranges(self):
        ranges = parse_ranges("ubuntu:100000:65536\n")
        self.assertFalse(check_ranges(ranges, "runtime", 2000000, 65536))
        self.assertTrue(check_ranges(ranges + [("runtime", 2000000, 65536)], "runtime", 2000000, 65536))
        for text in ("ubuntu:bad:5", "ubuntu:0:0", "ubuntu:4294967295:2"):
            with self.subTest(text=text), self.assertRaises(Refusal):
                parse_ranges(text)
        for entries in ([('other', 2000001, 65536)], [('runtime', 100000, 65536)],
                        [('runtime', 2000000, 65536), ('runtime', 2000000, 65536)]):
            with self.subTest(entries=entries), self.assertRaises(Refusal):
                check_ranges(entries, 'runtime', 2000000, 65536)

    def test_config_is_separate_namespace_engine_not_rootless_shortcut(self):
        profile = json.loads(PROFILE.read_text())
        config = daemon_config(profile, 991)
        self.assertEqual(config['hosts'], ['unix:///run/user/991/codebandage-runtime.sock'])
        self.assertTrue(config['data-root'].startswith('/var/lib/codebandage-sandbox/'))
        self.assertEqual(config['runtimes']['runsc-systrap']['runtimeArgs'],
                         ['--platform=systrap', '--network=sandbox', '--directfs=false'])
        self.assertNotIn('--rootless', json.dumps(config))
        self.assertEqual(config['exec-opts'], ['native.cgroupdriver=systemd'])
        self.assertFalse(config['iptables'])
        self.assertEqual(config['bridge'], 'none')
        self.assertEqual(config['runtimes']['runsc-systrap']['path'], str(PUBLIC_RUNTIME_BASE) + '/20261012.0/runsc')
        self.assertNotIn('/opt/codebandage', json.dumps(config))

    def test_private_to_public_runtime_path_recovery_requires_explicit_approval_and_exact_old_bytes(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            profile = json.loads(PROFILE.read_text()) | {'state': str(root), 'home': str(root / 'home')}
            runtime = Runtime(profile)
            runtime.user = SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
            runtime.state = {'phase': 'RUNTIME_BUNDLE_VERIFIED'}
            path = root / 'daemon.json'
            legacy = (json.dumps(daemon_config(profile, os.getuid(), legacy_private_path=True), sort_keys=True, indent=2) + '\n').encode()
            current = (json.dumps(daemon_config(profile, os.getuid()), sort_keys=True, indent=2) + '\n').encode()
            managed_file(path, legacy, owner=os.getuid(), group=os.getgid())
            with self.assertRaisesRegex(Refusal, 'RUNTIME_PATH_RECOVERY_APPROVAL_REQUIRED'):
                runtime.recover_runtime_config_path(path, current)
            self.assertEqual(path.read_bytes(), legacy)
            runtime.allow_runtime_path_recovery = True
            original = managed_file
            def own_file(target, data, mode=0o600, owner=0, group=0):
                return original(target, data, mode, os.getuid(), os.getgid())
            with patch('provision.run', return_value='inactive'), patch('provision.managed_file', side_effect=own_file), patch('provision.record') as evidence:
                runtime.recover_runtime_config_path(path, current)
                self.assertEqual(path.read_bytes(), current)
                self.assertEqual((root / 'daemon-config-before-public-runtime.json').read_bytes(), legacy)
                self.assertFalse(evidence.call_args.args[1]['productionPathsChanged'])
            runtime.recover_runtime_config_path(path, current)  # Exact repeat is a no-op.

    def test_runtime_path_recovery_refuses_unknown_config_or_active_manager(self):
        from types import SimpleNamespace
        for active, contents, expected in [('active', None, 'PATH_RECOVERY_REFUSES_ACTIVE_ENGINE'),
                                           ('inactive', b'unknown', 'UNMANAGED_RUNTIME_CONFIG')]:
            with self.subTest(active=active, contents=contents), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                profile = json.loads(PROFILE.read_text()) | {'state': str(root)}
                runtime = Runtime(profile)
                runtime.user = SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
                runtime.state = {'phase': 'RUNTIME_BUNDLE_VERIFIED'}
                runtime.allow_runtime_path_recovery = True
                path = root / 'daemon.json'
                legacy = (json.dumps(daemon_config(profile, os.getuid(), legacy_private_path=True), sort_keys=True, indent=2) + '\n').encode()
                managed_file(path, contents or legacy, owner=os.getuid(), group=os.getgid())
                with patch('provision.run', return_value=active), self.assertRaisesRegex(Refusal, expected):
                    runtime.recover_runtime_config_path(path, b'new')
                self.assertEqual(path.read_bytes(), contents or legacy)

    def test_does_not_inherit_shell_secrets_or_docker_context(self):
        class Result:
            returncode = 0
            stdout = 'safe'
        with patch.dict(os.environ, {'DATABASE_URL': 'private', 'DOCKER_HOST': 'private'}), patch('subprocess.run', return_value=Result()) as child:
            self.assertEqual(run(['/bin/true']), 'safe')
            environment = child.call_args.kwargs['env']
            self.assertNotIn('DATABASE_URL', environment)
            self.assertNotIn('DOCKER_HOST', environment)

    def test_managed_file_rerun_and_refuse_overwrite(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'owned'
            managed_file(path, b'ours', owner=os.getuid(), group=os.getgid())
            managed_file(path, b'ours', owner=os.getuid(), group=os.getgid())
            with self.assertRaises(Refusal):
                managed_file(path, b'other', owner=os.getuid(), group=os.getgid())
            self.assertEqual(path.read_bytes(), b'ours')

    def test_probe_has_valid_syntax_and_fixed_finite_write(self):
        compile(PROBE, '<reviewed-offline-probe>', 'exec')
        self.assertIn('range(65)', PROBE)
        self.assertIn('errno.ENOSPC', PROBE)
        self.assertIn("('198.51.100.1',9)", PROBE)
        self.assertNotIn('subprocess', PROBE)
        self.assertIn("all(name=='lo'", PROBE)
        self.assertIn("/proc/net/route", PROBE)

    def test_executable_hash_reads_actual_open_bytes_with_finite_limit(self):
        import hashlib
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'synthetic-executable'
            path.write_bytes(b'fixture-ELF-bytes')
            self.assertEqual(bounded_executable_hash(path, 17), hashlib.sha256(b'fixture-ELF-bytes').hexdigest())
            with self.assertRaisesRegex(Refusal, 'RUNTIME_EXECUTABLE_SIZE_INVALID'):
                bounded_executable_hash(path, 1)
            with self.assertRaisesRegex(Refusal, 'RUNTIME_EXECUTABLE_SIZE_INVALID'):
                bounded_executable_hash(path, 0)

    def test_decoder_uses_pinned_window_bound_and_classifies_failure(self):
        class Decoder:
            stdout = io.BytesIO()
            stderr = io.BytesIO(b'Frame requires too much memory; Window size larger than maximum')
            returncode = 1
            def wait(self, timeout):
                return self.returncode
            def poll(self):
                return self.returncode
        self.assertEqual(ZSTD_DECODER_MEMORY_MB, 128)
        with tempfile.TemporaryDirectory() as temporary, patch('subprocess.Popen', return_value=Decoder()) as decoder:
            with self.assertRaisesRegex(Refusal, '^RUNTIME_DECOMPRESSOR_MEMORY_BOUND$'):
                extract_zstd_bounded(Path('/fixed-archive'), Path(temporary), 100)
            self.assertIn('--memory=128MB', decoder.call_args.args[0])


if __name__ == '__main__':
    unittest.main()
