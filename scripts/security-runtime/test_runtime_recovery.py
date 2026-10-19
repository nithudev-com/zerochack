"""Recovery/disable tests use temporary fixtures and mocks, never host services."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from provision import COMMENT, PROFILE, Refusal, Runtime


class RecoveryTests(unittest.TestCase):
    def fixture(self, temporary):
        profile = json.loads(PROFILE.read_text())
        profile['state'] = str(Path(temporary) / 'state')
        profile['home'] = str(Path(temporary) / 'home')
        payload = b'checksum-pinned-local-unit-fixture'
        profile['gvisor']['archiveBytes'] = len(payload)
        profile['gvisor']['sha256'] = hashlib.sha256(payload).hexdigest()
        runtime = Runtime(profile)
        runtime.root.mkdir()
        runtime.home.mkdir()
        runtime.state = {'schema': profile['schema'], 'phase': 'FAILED_REVIEW_REQUIRED', 'uid': 997}
        runtime.host_guard = Mock()
        runtime.load = Mock()
        runtime.save = Mock()
        runtime.operation_lock = Mock(side_effect=lambda: os.open(Path(temporary) / 'lock', os.O_CREAT | os.O_RDWR, 0o600))
        runtime.production_health = Mock(return_value={'test': 'healthy'})
        runtime.compare_health = Mock(return_value={'test': 'healthy'})
        (runtime.root / 'gvisor').mkdir()
        archive = runtime.root / 'gvisor' / (profile['gvisor']['version'] + '.tar.zstd')
        archive.write_bytes(payload)
        stage = runtime.root / 'gvisor' / (profile['gvisor']['version'] + '.staging')
        stage.mkdir()
        user = SimpleNamespace(pw_uid=997, pw_dir=str(runtime.home), pw_gecos=COMMENT)
        metadata = SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0, st_gid=0)
        return runtime, archive, stage, user, metadata

    @contextlib.contextmanager
    def isolated(self, runtime, stage, user, metadata, *, active='inactive\n', archive_owner=0, socket_present=False):
        original_lstat = Path.lstat
        original_exists = Path.exists
        def exists(path):
            if path == Path(f'/run/user/{user.pw_uid}/codebandage-runtime.sock'):
                return socket_present
            return original_exists(path)
        def lstat(path):
            if path == stage:
                return metadata
            if path.name.endswith('.tar.zstd'):
                return SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=archive_owner)
            return original_lstat(path)
        with patch('provision.pwd.getpwnam', return_value=user), \
             patch('provision.run', return_value=active) as commands, patch.object(Path, 'lstat', lstat), patch.object(Path, 'exists', exists), \
             patch('provision.record') as receipts, contextlib.redirect_stdout(io.StringIO()) as output:
            yield commands, receipts, output

    def test_owned_empty_stage_is_renamed_with_evidence_never_deleted(self):
        with tempfile.TemporaryDirectory() as temporary:
            runtime, archive, stage, user, metadata = self.fixture(temporary)
            original_inode = stage.stat().st_ino
            with self.isolated(runtime, stage, user, metadata) as (_, receipts, output), \
                 patch('provision.os.unlink', side_effect=AssertionError('deletion forbidden')):
                runtime.recover_empty_stage()
                report = json.loads(output.getvalue())
                preserved = Path(report['preservedPath'])
                self.assertFalse(stage.exists())
                self.assertEqual(preserved.stat().st_ino, original_inode)
                self.assertEqual(archive.read_bytes(), b'checksum-pinned-local-unit-fixture')
                self.assertFalse(report['deleted'])
                self.assertEqual(report['provisioningRerun'], 'NOT_EXECUTED')
                self.assertEqual(receipts.call_args.args[1]['action'], 'RENAMED_VERIFIED_EMPTY_STAGE')
                self.assertFalse(receipts.call_args.args[1]['deleted'])
                runtime.save.assert_called_once_with('EMPTY_STAGE_PRESERVED_RERUN_REQUIRES_APPROVAL')

    def test_nonempty_stage_is_preserved_and_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            runtime, _, stage, user, metadata = self.fixture(temporary)
            (stage / 'unexpected').write_bytes(b'preserve')
            with self.isolated(runtime, stage, user, metadata) as (_, receipts, _), self.assertRaisesRegex(Refusal, 'NONEMPTY_OR_UNOWNED'):
                runtime.recover_empty_stage()
            self.assertEqual((stage / 'unexpected').read_bytes(), b'preserve')
            receipts.assert_not_called()
            runtime.save.assert_not_called()

    def test_wrong_phase_account_active_engine_and_changed_archive_fail_closed(self):
        for case in ('phase', 'account', 'active-engine', 'active-socket', 'archive-hash', 'archive-size', 'completed-bundle'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temporary:
                runtime, archive, stage, user, metadata = self.fixture(temporary)
                if case == 'phase': runtime.state['phase'] = 'ROOTLESS_ENGINE_PROVISIONED_UNVERIFIED'
                if case == 'account': user.pw_uid = 998
                if case == 'archive-hash': archive.write_bytes(b'x' * archive.stat().st_size)
                if case == 'archive-size': archive.write_bytes(b'x')
                if case == 'completed-bundle': (runtime.root / 'bundle.json').write_text('{}')
                with self.isolated(runtime, stage, user, metadata, active='active\n' if case == 'active-engine' else 'inactive\n',
                                   socket_present=case == 'active-socket') as (_, receipts, _), self.assertRaises(Refusal):
                    runtime.recover_empty_stage()
                self.assertTrue(stage.exists())
                receipts.assert_not_called()
                runtime.save.assert_not_called()

    def test_unowned_archive_refused_without_stage_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            runtime, _, stage, user, metadata = self.fixture(temporary)
            with self.isolated(runtime, stage, user, metadata, archive_owner=1000) as (_, receipts, _), \
                 self.assertRaisesRegex(Refusal, 'UNSAFE_FILE'):
                runtime.recover_empty_stage()
            self.assertTrue(stage.exists())
            receipts.assert_not_called()
            runtime.save.assert_not_called()

    def test_unowned_world_writable_or_symlink_stage_refused(self):
        for field, value in (('st_uid', 1000), ('st_gid', 1000), ('st_mode', stat.S_IFDIR | 0o777),
                             ('st_mode', stat.S_IFLNK | 0o755)):
            with self.subTest(field=field, value=value), tempfile.TemporaryDirectory() as temporary:
                runtime, _, stage, user, metadata = self.fixture(temporary)
                setattr(metadata, field, value)
                with self.isolated(runtime, stage, user, metadata) as (_, receipts, _), self.assertRaisesRegex(Refusal, 'NONEMPTY_OR_UNOWNED'):
                    runtime.recover_empty_stage()
                receipts.assert_not_called()


class EmergencyDisableTests(unittest.TestCase):
    def test_stop_survives_unavailable_user_bus_full_disk_and_unhealthy_production(self):
        with tempfile.TemporaryDirectory() as temporary:
            runtime, _, _, user, _ = RecoveryTests().fixture(temporary)
            runtime.budget = Mock(side_effect=AssertionError('emergency must not use disk admission guard'))
            runtime.health_evidence = Mock(return_value={'result': 'UNHEALTHY_OR_UNAVAILABLE'})
            runtime.user_command = Mock(side_effect=subprocess.TimeoutExpired('user-bus', 10))
            calls = []
            def command(args, **kwargs):
                calls.append(args)
                return 'inactive\n' if args[1] == 'is-active' else ''
            with patch('provision.pwd.getpwnam', return_value=user), patch('provision.run', side_effect=command), \
                 patch('provision.record', side_effect=OSError('full disk')), contextlib.redirect_stdout(io.StringIO()) as output:
                runtime.disable()
            runtime.host_guard.assert_called_once_with(emergency=True)
            runtime.load.assert_called_once_with(emergency=True)
            runtime.budget.assert_not_called()
            self.assertIn(['systemctl', 'stop', 'user@997.service'], calls)
            self.assertIn(['loginctl', 'disable-linger', runtime.account], calls)
            self.assertFalse(any('docker.service' in part or 'user@0.service' in part for args in calls for part in args))
            report = json.loads(output.getvalue())
            self.assertTrue(report['runtimeStopped'])
            self.assertTrue(report['userBusUnavailable'])
            self.assertFalse(report['evidenceSaved'])
            self.assertFalse(report['deleted'])

    def test_wrong_managed_account_never_stops_any_manager(self):
        with tempfile.TemporaryDirectory() as temporary:
            runtime, _, _, user, _ = RecoveryTests().fixture(temporary)
            user.pw_uid = 0
            with patch('provision.pwd.getpwnam', return_value=user), patch('provision.run') as commands, \
                 self.assertRaisesRegex(Refusal, 'ACCOUNT_IDENTITY_MISMATCH'):
                runtime.disable()
            commands.assert_not_called()


if __name__ == '__main__':
    unittest.main()
