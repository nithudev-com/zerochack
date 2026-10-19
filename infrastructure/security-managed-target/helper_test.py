"""Local mocks and disposable real-file/codec tests. No managed provisioning or SSH."""
import copy
import hashlib
import hmac
import importlib.util
import pathlib
import os
import tempfile
import unittest
import subprocess
from contextlib import contextmanager
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("managed_helper", pathlib.Path(__file__).with_name("helper.py"))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
IDS = [f"00000000-0000-4000-8000-{index:012d}" for index in range(1, 7)]
SCOPE = {"tenantId": IDS[0], "websiteId": IDS[1], "environment": "STAGING", "runId": IDS[2]}
SNAPSHOT = {"device": "2049", "inode": "112233", "uid": 0, "gid": 0, "mode": 0o666, "size": 12,
            "mtimeNs": "1792345678123456789", "ctimeNs": "1792345678123456799", "digest": "a" * 64}


def record():
    return {"scope": copy.deepcopy(SCOPE), "namespaceId": IDS[3], "targetId": IDS[4], "operationId": IDS[5],
            "action": "HARDEN", "planDigest": "b" * 64, "authorityDigest": "c" * 64,
            "snapshotDigest": helper.digest(helper.canonical(SNAPSHOT)), "recoveryDigest": "d" * 64,
            "targetMode": 0o664, "challenge": "e" * 64, "preparedAt": 1000}


class MemoryHelper(helper.ManagedTarget):
    """Mocked storage/FS only: exercises ordering, never the namespace guarantee."""
    def __init__(self, value, current=None, receipts=None):
        self.key = b"\x37" * 32
        self.intent_started = False
        self.receipt_started = False
        self.record = None
        self.records = {value["operationId"]: copy.deepcopy(value)}
        self.current = copy.deepcopy(value["before"] if current is None else current)
        self.receipts = copy.deepcopy(receipts or {})
        self.events = []
        self.recovery_failure = False

    @contextmanager
    def serialized(self):
        yield

    @contextmanager
    def target(self):
        yield 42

    def assert_binding(self, request):
        if request["scope"] != SCOPE:
            raise helper.Refused("MANAGED_SCOPE_MISMATCH")

    def record_for(self, operation_id):
        return helper.validate_record(copy.deepcopy(self.records[operation_id]))

    def journal(self, value):
        helper.validate_record(value)
        self.events.append(value["state"])
        self.records[value["operationId"]] = copy.deepcopy(value)

    def check_journal(self, admitting=False):
        helper.require(not any(value["state"] in ("INTENT", "OUTCOME_UNKNOWN") for value in self.records.values()), "MANAGED_UNRESOLVED_OPERATION")

    def observe(self, _fd):
        return copy.deepcopy(self.current), b""

    def verify_recovery(self, _value):
        self.events.append("RECOVERY_VERIFIED")
        helper.require(not self.recovery_failure, "MANAGED_RECOVERY_INVALID")

    def admit_reconciliation(self, reconciliation_id):
        helper.require(reconciliation_id not in self.receipts, "MANAGED_RECONCILIATION_EXISTS")
        helper.require(len(self.receipts) < helper.MAX_RECONCILIATIONS, "MANAGED_STORAGE_LIMIT")

    def append_reconciliation(self, value):
        helper.validate_reconciliation_receipt(value)
        reconciliation_id = value["observation"]["reconciliationId"]
        self.admit_reconciliation(reconciliation_id)
        self.receipt_started = True
        self.receipts[reconciliation_id] = copy.deepcopy(value)
        self.events.append("RECONCILIATION_APPENDED")

    def reconciliation_for(self, reconciliation_id):
        return helper.validate_reconciliation_receipt(copy.deepcopy(self.receipts[reconciliation_id]))


def prepared_record(action="HARDEN"):
    value = dict(record(), version=1, state="PREPARED", before=copy.deepcopy(SNAPSHOT))
    if action == "RESTORE":
        value["before"]["mode"] = 0o664
        value.update(action="RESTORE", recoveryOperationId=IDS[0], targetMode=0o666)
        value["snapshotDigest"] = helper.digest(helper.canonical(value["before"]))
    return value


def commit_request(service, value):
    payload = helper.permit_payload(value, 1100, 5100)
    return {"version": 1, "command": "COMMIT", "scope": copy.deepcopy(SCOPE), "namespaceId": IDS[3], "targetId": IDS[4],
            "operationId": value["operationId"], "permit": {"payload": payload,
            "mac": hmac.new(service.key, helper.canonical(payload), hashlib.sha256).hexdigest()}}


def inspect_request(value, reconciliation_id=IDS[0]):
    return {"version": 1, "command": "RECONCILE_OBSERVE", "scope": copy.deepcopy(SCOPE), "namespaceId": IDS[3], "targetId": IDS[4],
            "operationId": value["operationId"], "reconciliationId": reconciliation_id}


def reconciliation_request(service, observation, issued=1300, expires=5100):
    payload = helper.reconciliation_payload(observation, issued, expires)
    return {"version": 1, "command": "RECONCILE", "scope": copy.deepcopy(SCOPE), "namespaceId": IDS[3], "targetId": IDS[4],
            "operationId": observation["operationId"], "observation": copy.deepcopy(observation),
            "permit": {"payload": payload, "mac": hmac.new(service.key, helper.canonical(payload), hashlib.sha256).hexdigest()}}


def recovery_export_request(service, value, export_id=IDS[0], issued=1100, expires=5100):
    payload = helper.recovery_export_payload(value, export_id, issued, expires)
    return {"version": 1, "command": "EXPORT_RECOVERY", "scope": copy.deepcopy(value["scope"]),
            "namespaceId": value["namespaceId"], "targetId": value["targetId"], "operationId": value["operationId"],
            "exportId": export_id, "permit": {"payload": payload,
            "mac": hmac.new(service.key, helper.canonical(payload), hashlib.sha256).hexdigest()}}


class DisposableFilesystemHelper(helper.ManagedTarget):
    """Real private temp files and AES codec; does not attest mount namespace isolation."""
    def __init__(self, directory):
        self.fds = []
        self.intent_started = False
        self.receipt_started = False
        self.record = None
        self.key = b"\x37" * 32
        self.root = self.open_directory(str(pathlib.Path(directory, "root")), 0o700)
        self.site = self.open_directory("site", 0o755, self.root)
        self.state = self.open_directory(str(pathlib.Path(directory, "state")), 0o700)
        def identity(info):
            return {"device": str(info.st_dev), "inode": str(info.st_ino)}
        self.manifest = {"namespaceId": IDS[3], "targetId": IDS[4], "scope": {key: SCOPE[key] for key in ("tenantId", "websiteId", "environment")},
                         "root": identity(os.fstat(self.root)), "site": identity(os.fstat(self.site)),
                         "state": identity(os.fstat(self.state)), "target": identity(os.stat("index.html", dir_fd=self.site))}
        self.lock = os.open("lock", os.O_RDWR | helper.NOFOLLOW, dir_fd=self.state)
        self.fds.append(self.lock)

    def codec(self, mode, value):
        # Exercise the actual AES-256-GCM implementation using a synthetic in-memory
        # key; production fixed paths/mount checks and key loading remain unchanged.
        program = "const fs=require('node:fs');const {run,canonical}=require(process.argv[1]);const v=JSON.parse(fs.readFileSync(0,'utf8'));const k=Buffer.from(v.key,'hex');try{process.stdout.write(canonical(run(v.mode,v.value,k)))}finally{k.fill(0)}"
        output = subprocess.run(["node", "-e", program, str(pathlib.Path(__file__).with_name("recovery-codec.cjs"))],
                                input=helper.canonical({"mode": mode, "value": value, "key": "45" * 32}),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=10)
        helper.require(output.returncode == 0 and len(output.stdout) <= helper.MAX_RECOVERY, "MANAGED_RECOVERY_INVALID")
        return helper.load_json(output.stdout)


@unittest.skipUnless(os.getuid() == 0, "real deployment UID checks require root; no permission checks are weakened")
class RecoveryExportFilesystem(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="managed-recovery-export-")
        self.directory = pathlib.Path(self.temporary.name)
        (self.directory / "root").mkdir(mode=0o700)
        (self.directory / "root" / "site").mkdir(mode=0o755)
        (self.directory / "state").mkdir(mode=0o700)
        self.target = self.directory / "root" / "site" / "index.html"
        self.target.write_bytes(b"<!doctype html><p>disposable synthetic recovery fixture</p>" * 1000)
        self.target.chmod(0o666)
        self.lock = self.directory / "state" / "lock"
        self.lock.touch(mode=0o600)
        self.service = DisposableFilesystemHelper(self.directory)
        self.before_bytes = self.target.read_bytes()
        self.before_stat = self.target.stat()
        binding = {"scope": copy.deepcopy(SCOPE), "namespaceId": IDS[3], "targetId": IDS[4]}
        observed = self.service.handle(dict(binding, version=1, command="OBSERVE"))
        with patch.object(helper.time, "time", return_value=1.0):
            self.prepared = self.service.handle(dict(binding, version=1, command="PREPARE", operationId=IDS[5], action="HARDEN",
                                                     planDigest="b" * 64, authorityDigest="c" * 64, expectedSnapshot=observed["snapshot"]))

    def tearDown(self):
        self.service.close()
        self.temporary.cleanup()

    def assert_target_untouched(self):
        self.assertEqual(self.target.read_bytes(), self.before_bytes)
        current = self.target.stat()
        self.assertEqual((current.st_ino, current.st_mode, current.st_mtime_ns, current.st_ctime_ns),
                         (self.before_stat.st_ino, self.before_stat.st_mode, self.before_stat.st_mtime_ns, self.before_stat.st_ctime_ns))

    def test_exact_encrypted_export_decrypts_checks_hash_and_consumes_only_read_receipt(self):
        request = recovery_export_request(self.service, self.prepared)
        journal = (self.directory / "state" / (IDS[5] + ".json")).read_bytes()
        recovery = (self.directory / "state" / (IDS[5] + ".recovery")).read_bytes()
        with patch.object(helper.time, "time", return_value=1.2):
            exported = self.service.handle(request)
        self.assertEqual(exported["state"], "RECOVERY_EXPORTED")
        self.assertEqual(helper.canonical(exported["envelope"]), recovery)
        self.assertEqual(helper.digest(recovery), exported["recoveryDigest"])
        self.assertEqual(exported["before"], self.prepared["before"])
        self.assertEqual(exported["envelope"]["aad"], self.service.recovery_aad(self.prepared))
        verified = self.service.codec("verify", {"envelope": exported["envelope"],
            "expectedAad": exported["envelope"]["aad"], "expectedSnapshot": exported["before"]})
        self.assertEqual(verified["digest"], helper.digest(self.before_bytes))
        serialized = helper.canonical(exported)
        self.assertNotIn(b"disposable synthetic recovery fixture", serialized)
        self.assertLess(len(serialized), helper.MAX_RECOVERY + helper.MAX_RECORD)
        self.assertEqual((self.directory / "state" / (IDS[5] + ".json")).read_bytes(), journal)
        receipt = self.directory / "state" / (IDS[0] + ".recovery-export")
        self.assertEqual(receipt.stat().st_mode & 0o7777, 0o600)
        reopened = DisposableFilesystemHelper(self.directory)
        try:
            with patch.object(helper.time, "time", return_value=1.2), self.assertRaisesRegex(helper.Refused, "MANAGED_RECOVERY_EXPORT_REPLAY_REFUSED"):
                reopened.handle(request)
        finally:
            reopened.close()
        self.assert_target_untouched()

    def test_scope_purpose_expiry_and_record_digest_tampering_are_refused(self):
        request = recovery_export_request(self.service, self.prepared)
        for field, change in (("purpose", helper.RECONCILIATION_PURPOSE), ("recoveryDigest", "0" * 64),
                              ("operationId", IDS[1]), ("exportId", IDS[1]), ("scope", dict(SCOPE, runId=IDS[1]))):
            wrong = copy.deepcopy(request)
            wrong["permit"]["payload"][field] = change
            wrong["permit"]["mac"] = hmac.new(self.service.key, helper.canonical(wrong["permit"]["payload"]), hashlib.sha256).hexdigest()
            with self.subTest(field=field), patch.object(helper.time, "time", return_value=1.2), self.assertRaises(helper.Refused):
                self.service.handle(wrong)
        for issued, expires, now in ((900, 5100, 1200), (1300, 5100, 1200), (1100, 17000, 1200), (1100, 5100, 5100)):
            wrong = recovery_export_request(self.service, self.prepared, issued=issued, expires=expires)
            with self.subTest(issued=issued, expires=expires), patch.object(helper.time, "time", return_value=now / 1000), self.assertRaises(helper.Refused):
                self.service.handle(wrong)
        wrong = copy.deepcopy(request)
        wrong["scope"]["runId"] = IDS[1]
        with self.assertRaisesRegex(helper.Refused, "MANAGED_SCOPE_MISMATCH"):
            self.service.handle(wrong)
        self.assertFalse(any(self.directory.joinpath("state").glob("*.recovery-export")))
        self.assert_target_untouched()

    def test_tampered_or_symlinked_recovery_never_exports_or_changes_target(self):
        recovery = self.directory / "state" / (IDS[5] + ".recovery")
        original = recovery.read_bytes()
        recovery.write_bytes(original[:-1] + b" ")
        with patch.object(helper.time, "time", return_value=1.2), self.assertRaisesRegex(helper.Refused, "MANAGED_RECOVERY_INVALID"):
            self.service.handle(recovery_export_request(self.service, self.prepared))
        recovery.unlink()
        recovery.symlink_to(self.target)
        with patch.object(helper.time, "time", return_value=1.2), self.assertRaises(OSError):
            self.service.handle(recovery_export_request(self.service, self.prepared))
        self.assertFalse(any(self.directory.joinpath("state").glob("*.recovery-export")))
        self.assert_target_untouched()

    def test_partial_receipt_is_retained_and_same_read_cannot_replay(self):
        request = recovery_export_request(self.service, self.prepared)
        real_write = os.write
        def interrupted_receipt(fd, data):
            if os.readlink("/proc/self/fd/" + str(fd)).endswith(".recovery-export"):
                raise OSError("synthetic interrupted read receipt")
            return real_write(fd, data)
        with patch.object(helper.time, "time", return_value=1.2), patch.object(helper.os, "write", side_effect=interrupted_receipt):
            with self.assertRaises(OSError):
                self.service.handle(request)
        receipt = self.directory / "state" / (IDS[0] + ".recovery-export")
        self.assertTrue(receipt.exists())
        with patch.object(helper.time, "time", return_value=1.2), self.assertRaisesRegex(helper.Refused, "MANAGED_RECOVERY_EXPORT_REPLAY_REFUSED"):
            self.service.handle(request)
        self.assert_target_untouched()

    def test_expiry_during_durability_consumes_read_without_releasing_export(self):
        request = recovery_export_request(self.service, self.prepared)
        # Authorization is checked before recovery verification, before the
        # receipt write, and once more immediately before returning the envelope.
        with patch.object(helper.time, "time", side_effect=[1.2, 1.3, 5.1]), self.assertRaisesRegex(helper.Refused, "MANAGED_RECOVERY_EXPORT_AUTHORIZATION_EXPIRED"):
            self.service.handle(request)
        self.assertTrue((self.directory / "state" / (IDS[0] + ".recovery-export")).exists())
        with patch.object(helper.time, "time", return_value=1.4), self.assertRaisesRegex(helper.Refused, "MANAGED_RECOVERY_EXPORT_REPLAY_REFUSED"):
            self.service.handle(request)
        self.assert_target_untouched()


class SimulatedCrash(BaseException):
    """Escapes commit directly, like process death with only mocked durable state."""


class PureValidation(unittest.TestCase):
    def test_canonicalization_bounds_and_duplicate_keys(self):
        cyclic = {}
        cyclic["self"] = cyclic
        deep = {}
        for _index in range(13):
            deep = {"child": deep}
        for value in (cyclic, deep, {"text": "x" * 600001}, {"text": "x" * 500000, "other": "y" * 500000},
                      {"array": [0] * 65}, {"text": "\u2603"}, {f"field{index}": 1 for index in range(65)}):
            with self.assertRaises(helper.Refused):
                helper.canonical(value)
        for encoded in ('{"value":1,"value":2}', '{"value":NaN}', '{"value":1.5}'):
            with self.assertRaises(helper.Refused):
                helper.load_json(encoded)

    def test_exact_snapshot_preserves_nanoseconds_as_decimal_strings(self):
        self.assertEqual(helper.snapshot(copy.deepcopy(SNAPSHOT)), SNAPSHOT)
        for field in ("device", "inode", "mtimeNs", "ctimeNs"):
            changed = dict(SNAPSHOT, **{field: int(SNAPSHOT[field])})
            with self.assertRaises(helper.Refused):
                helper.snapshot(changed)

    def test_rejects_oversize_special_or_executable_nonroot_files(self):
        for change in ({"size": 200001}, {"mode": 0o4666}, {"mode": 0o766}, {"uid": 1000}, {"gid": 1000}, {"size": True}, {"mode": 0o444}, {"mode": 0o602}):
            with self.subTest(change=change), self.assertRaises(helper.Refused):
                helper.snapshot(dict(SNAPSHOT, **change))

    def test_no_path_command_or_production_in_request(self):
        request = {"version": 1, "command": "OBSERVE", "scope": copy.deepcopy(SCOPE), "namespaceId": IDS[3], "targetId": IDS[4]}
        helper.validate_request(request)
        for change in ({"path": "/etc/passwd"}, {"command": "SHELL"}, {"version": True}, {"namespaceId": "../../root"},
                       {"scope": dict(SCOPE, environment="PRODUCTION")}):
            with self.subTest(change=change), self.assertRaises(helper.Refused):
                helper.validate_request(dict(request, **change))

    def test_restore_requires_separate_operation_and_recovery_reference(self):
        request = {"version": 1, "command": "PREPARE", "scope": SCOPE, "namespaceId": IDS[3], "targetId": IDS[4],
                   "operationId": IDS[5], "action": "RESTORE", "planDigest": "b" * 64, "authorityDigest": "c" * 64,
                   "expectedSnapshot": SNAPSHOT}
        with self.assertRaises(helper.Refused):
            helper.validate_request(request)
        helper.validate_request(dict(request, recoveryOperationId=IDS[0]))

    def test_valid_permit_binds_exact_action_target_plan_authority_and_bytes(self):
        key = b"\x37" * 32  # Synthetic in-memory key, never persisted/printed.
        value = record()
        payload = helper.permit_payload(value, 1100, 5100)
        permit = {"payload": payload, "mac": hmac.new(key, helper.canonical(payload), hashlib.sha256).hexdigest()}
        helper.verify_permit(permit, value, key, 1200)
        for field, changed in (("action", "RESTORE"), ("targetMode", 0o666), ("operationId", IDS[0]),
                               ("planDigest", "f" * 64), ("authorityDigest", "f" * 64),
                               ("snapshotDigest", "f" * 64), ("recoveryDigest", "f" * 64), ("challenge", "f" * 64)):
            wrong = copy.deepcopy(permit)
            wrong["payload"][field] = changed
            # Even a separately signed altered claim does not match the prepared journal.
            wrong["mac"] = hmac.new(key, helper.canonical(wrong["payload"]), hashlib.sha256).hexdigest()
            with self.subTest(field=field), self.assertRaises(helper.Refused):
                helper.verify_permit(wrong, value, key, 1200)

    def test_wrong_key_expired_future_long_lived_or_preprepare_permit_fails(self):
        value = record()
        key = b"\x29" * 32
        for issued, expires, now in ((1100, 5100, 5100), (1300, 5100, 1200), (1100, 17000, 1200), (900, 5100, 1200)):
            payload = helper.permit_payload(value, issued, expires)
            permit = {"payload": payload, "mac": hmac.new(key, helper.canonical(payload), hashlib.sha256).hexdigest()}
            with self.subTest(issued=issued, expires=expires), self.assertRaises(helper.Refused):
                helper.verify_permit(permit, value, key, now)
        payload = helper.permit_payload(value, 1100, 5100)
        with self.assertRaises(helper.Refused):
            helper.verify_permit({"payload": payload, "mac": "0" * 64}, value, key, 1200)

    def test_durable_intent_precedes_one_bit_mutation_and_verified_receipt(self):
        value = prepared_record()
        service = MemoryHelper(value)
        def chmod(fd, mode):
            self.assertEqual(fd, 42)
            self.assertEqual(service.events, ["RECOVERY_VERIFIED", "INTENT"])
            self.assertEqual(mode, 0o664)
            service.events.append("FCHMOD")
            service.current.update(mode=mode, ctimeNs="1792345678123456800")
        with patch.object(helper.time, "time", return_value=1.2), patch.object(helper.os, "fchmod", side_effect=chmod) as mutation, patch.object(helper.os, "fsync"):
            result = service.handle(commit_request(service, value))
            self.assertEqual(result["state"], "VERIFIED")
            self.assertEqual(result["after"]["digest"], SNAPSHOT["digest"])
            self.assertEqual(service.events, ["RECOVERY_VERIFIED", "INTENT", "FCHMOD", "VERIFIED"])
            # The fixed SSH server starts a NEW one-shot helper process per command.
            reopened = MemoryHelper(service.records[value["operationId"]])
            reopened.current = copy.deepcopy(service.current)
            with self.assertRaisesRegex(helper.Refused, "MANAGED_REPLAY_REFUSED"):
                reopened.handle(commit_request(reopened, value))
            self.assertEqual(mutation.call_count, 1)

    def test_failed_recovery_or_drift_never_reaches_intent_or_mutation(self):
        for failure in ("recovery", "drift"):
            value = prepared_record()
            service = MemoryHelper(value)
            if failure == "recovery":
                service.recovery_failure = True
            else:
                service.current["inode"] = "998877"
            with patch.object(helper.time, "time", return_value=1.2), patch.object(helper.os, "fchmod") as mutation:
                with self.assertRaises(helper.Refused):
                    service.handle(commit_request(service, value))
                mutation.assert_not_called()
            self.assertEqual(service.records[value["operationId"]]["state"], "PREPARED")

    def test_postmutation_failure_preserves_unknown_and_blocks_replay(self):
        value = prepared_record()
        service = MemoryHelper(value)
        def chmod(_fd, mode):
            service.current.update(mode=mode, ctimeNs="1792345678123456800")
        with patch.object(helper.time, "time", return_value=1.2), patch.object(helper.os, "fchmod", side_effect=chmod) as mutation, patch.object(helper.os, "fsync", side_effect=OSError("synthetic durability failure")):
            with self.assertRaisesRegex(helper.Refused, "OUTCOME_UNKNOWN"):
                service.handle(commit_request(service, value))
            self.assertEqual(service.records[value["operationId"]]["state"], "OUTCOME_UNKNOWN")
            reopened = MemoryHelper(service.records[value["operationId"]])
            reopened.current = copy.deepcopy(service.current)
            with self.assertRaisesRegex(helper.Refused, "MANAGED_REPLAY_REFUSED"):
                reopened.handle(commit_request(reopened, value))
            self.assertEqual(mutation.call_count, 1)

    def test_restore_permit_is_distinct_and_cannot_reuse_harden_authority(self):
        value = prepared_record("RESTORE")
        service = MemoryHelper(value)
        request = commit_request(service, value)
        wrong = copy.deepcopy(request)
        wrong["permit"]["payload"]["action"] = "HARDEN"
        wrong["permit"]["mac"] = hmac.new(service.key, helper.canonical(wrong["permit"]["payload"]), hashlib.sha256).hexdigest()
        with patch.object(helper.time, "time", return_value=1.2), patch.object(helper.os, "fchmod") as mutation:
            with self.assertRaisesRegex(helper.Refused, "MANAGED_AUTHORIZATION_MISMATCH"):
                service.handle(wrong)
            mutation.assert_not_called()

    def test_corrupt_or_arbitrary_mode_journal_is_refused(self):
        value = prepared_record()
        helper.validate_record(value)
        for changes in ({"targetMode": 0o777}, {"targetMode": 0o600}, {"action": "SHELL"}, {"snapshotDigest": "f" * 64}, {"extra": "ignored?"}):
            with self.subTest(changes=changes), self.assertRaises(helper.Refused):
                helper.validate_record(dict(value, **changes))

    def test_crash_fixture_before_write_reconciles_only_exact_before(self):
        value = prepared_record()
        service = MemoryHelper(value)
        journal = service.journal
        def crash_after_intent(record):
            journal(record)
            if record["state"] == "INTENT":
                raise SimulatedCrash()
        with patch.object(helper.time, "time", return_value=1.2), patch.object(service, "journal", side_effect=crash_after_intent), patch.object(helper.os, "fchmod") as mutation:
            with self.assertRaises(SimulatedCrash):
                service.commit(commit_request(service, value))
            mutation.assert_not_called()
        reopened = MemoryHelper(service.records[value["operationId"]], service.current)
        original = helper.canonical(reopened.records[value["operationId"]])
        with patch.object(helper.time, "time", return_value=1.2):
            observation = reopened.handle(inspect_request(value))
        self.assertEqual(observation["classification"], "MATCHES_BEFORE")
        with patch.object(helper.time, "time", return_value=1.3), patch.object(helper.os, "fchmod") as mutation:
            receipt = reopened.handle(reconciliation_request(reopened, observation))
            mutation.assert_not_called()
        self.assertEqual(receipt["state"], "RECONCILED_OBSERVATION_ONLY")
        self.assertEqual(helper.canonical(reopened.records[value["operationId"]]), original)
        self.assertEqual(reopened.records[value["operationId"]]["state"], "INTENT")
        with self.assertRaisesRegex(helper.Refused, "MANAGED_UNRESOLVED_OPERATION"):
            reopened.check_journal()
        with self.assertRaisesRegex(helper.Refused, "MANAGED_REPLAY_REFUSED"):
            reopened.handle(commit_request(reopened, value))

    def test_crash_fixture_after_write_matches_postimage_without_claiming_applied(self):
        value = prepared_record()
        service = MemoryHelper(value)
        def chmod(_fd, mode):
            service.current.update(mode=mode, ctimeNs="1792345678123456800")
        with patch.object(helper.time, "time", return_value=1.2), patch.object(helper.os, "fchmod", side_effect=chmod), patch.object(helper.os, "fsync", side_effect=SimulatedCrash):
            with self.assertRaises(SimulatedCrash):
                service.commit(commit_request(service, value))
        reopened = MemoryHelper(service.records[value["operationId"]], service.current)
        original = helper.canonical(reopened.records[value["operationId"]])
        with patch.object(helper.time, "time", return_value=1.2):
            observation = reopened.handle(inspect_request(value))
        self.assertEqual(observation["classification"], "MATCHES_EXPECTED_POSTIMAGE")
        with patch.object(helper.time, "time", return_value=1.3), patch.object(helper.os, "fchmod") as mutation:
            receipt = reopened.handle(reconciliation_request(reopened, observation))
            mutation.assert_not_called()
        self.assertNotIn("applied", receipt)
        self.assertEqual(helper.canonical(reopened.records[value["operationId"]]), original)
        with self.assertRaisesRegex(helper.Refused, "MANAGED_UNRESOLVED_OPERATION"):
            reopened.check_journal()

    def test_crash_fixture_before_ack_uses_existing_verified_status(self):
        value = prepared_record()
        service = MemoryHelper(value)
        def chmod(_fd, mode):
            service.current.update(mode=mode, ctimeNs="1792345678123456800")
        journal = service.journal
        def crash_after_verified(record):
            journal(record)
            if record["state"] == "VERIFIED":
                raise SimulatedCrash()
        with patch.object(helper.time, "time", return_value=1.2), patch.object(helper.os, "fchmod", side_effect=chmod), patch.object(helper.os, "fsync"), patch.object(service, "journal", side_effect=crash_after_verified):
            with self.assertRaises(SimulatedCrash):
                service.commit(commit_request(service, value))
        reopened = MemoryHelper(service.records[value["operationId"]], service.current)
        status = reopened.handle({key: child for key, child in dict(inspect_request(value), command="STATUS").items() if key != "reconciliationId"})
        self.assertEqual(status["state"], "VERIFIED")
        with self.assertRaisesRegex(helper.Refused, "MANAGED_RECONCILIATION_NOT_APPLICABLE"):
            reopened.handle(inspect_request(value))

    def test_reconciliation_same_bits_changed_ctime_and_content_drift_stay_drift(self):
        value = dict(prepared_record(), state="OUTCOME_UNKNOWN", permitDigest="f" * 64)
        for changes in ({"ctimeNs": "1792345678123456800"}, {"digest": "0" * 64}, {"mode": 0o664, "digest": "0" * 64}):
            with self.subTest(changes=changes):
                service = MemoryHelper(value, dict(value["before"], **changes))
                with patch.object(helper.time, "time", return_value=1.2):
                    observation = service.handle(inspect_request(value))
                self.assertEqual(observation["classification"], "DRIFT")
                with patch.object(helper.time, "time", return_value=1.3), patch.object(helper.os, "fchmod") as mutation:
                    receipt = service.handle(reconciliation_request(service, observation))
                    mutation.assert_not_called()
                self.assertEqual(receipt["observation"]["classification"], "DRIFT")
                self.assertEqual(service.records[value["operationId"]], value)

    def test_reconciliation_refuses_duplicate_receipt_and_old_commit_permit(self):
        value = dict(prepared_record(), state="INTENT", permitDigest="f" * 64)
        service = MemoryHelper(value)
        with patch.object(helper.time, "time", return_value=1.2):
            observation = service.handle(inspect_request(value))
        request = reconciliation_request(service, observation)
        with patch.object(helper.time, "time", return_value=1.3), patch.object(helper.os, "fchmod") as mutation:
            wrong = copy.deepcopy(request)
            wrong["permit"] = commit_request(service, value)["permit"]
            with self.assertRaises(helper.Refused):
                service.handle(wrong)
            receipt = service.handle(request)
            with self.assertRaisesRegex(helper.Refused, "MANAGED_RECONCILIATION_EXISTS"):
                service.handle(request)
            mutation.assert_not_called()
        self.assertEqual(service.reconciliation_for(observation["reconciliationId"]), receipt)
        self.assertEqual(len(service.receipts), 1)

    def test_reconciliation_binds_fresh_scope_source_current_state_and_permit(self):
        value = dict(prepared_record(), state="OUTCOME_UNKNOWN", permitDigest="f" * 64)
        for failure in ("expired", "wrongMac", "source", "current", "scope", "signedClassification", "signedReceiptId"):
            with self.subTest(failure=failure):
                service = MemoryHelper(value)
                with patch.object(helper.time, "time", return_value=1.2):
                    observation = service.handle(inspect_request(value))
                request = reconciliation_request(service, observation)
                now = 1.3
                if failure == "expired":
                    now = 16.3
                elif failure == "wrongMac":
                    request["permit"]["mac"] = "0" * 64
                elif failure == "source":
                    service.records[value["operationId"]]["permitDigest"] = "0" * 64
                elif failure == "current":
                    service.current["ctimeNs"] = "1792345678123456800"
                elif failure == "scope":
                    request["scope"]["runId"] = IDS[0]
                elif failure == "signedClassification":
                    request["observation"]["classification"] = "MATCHES_EXPECTED_POSTIMAGE"
                else:
                    request["observation"]["reconciliationId"] = IDS[1]
                with patch.object(helper.time, "time", return_value=now), patch.object(helper.os, "fchmod") as mutation:
                    with self.assertRaises(helper.Refused):
                        service.handle(request)
                    mutation.assert_not_called()
                self.assertEqual(service.receipts, {})

    def test_reconciliation_preserves_unknown_even_with_after_metadata(self):
        value = dict(prepared_record(), state="OUTCOME_UNKNOWN", permitDigest="f" * 64, verifiedAt=1200,
                     after=dict(SNAPSHOT, mode=0o664, ctimeNs="1792345678123456800"))
        service = MemoryHelper(value, value["after"])
        with patch.object(helper.time, "time", return_value=1.2):
            observation = service.handle(inspect_request(value))
        with patch.object(helper.time, "time", return_value=1.3):
            service.handle(reconciliation_request(service, observation))
        self.assertEqual(service.records[value["operationId"]], value)
        with self.assertRaisesRegex(helper.Refused, "MANAGED_UNRESOLVED_OPERATION"):
            service.check_journal()

    def test_reconciliation_rejects_separately_signed_wrong_domain_binding_or_time(self):
        value = dict(prepared_record(), state="INTENT", permitDigest="f" * 64)
        service = MemoryHelper(value)
        with patch.object(helper.time, "time", return_value=1.2):
            observation = service.handle(inspect_request(value))
        permit = reconciliation_request(service, observation)["permit"]
        for field, changed in (("purpose", "COMMIT"), ("operationId", IDS[1]), ("reconciliationId", IDS[1]),
                               ("sourceDigest", "0" * 64), ("currentSnapshotDigest", "0" * 64), ("observationDigest", "0" * 64),
                               ("scope", dict(SCOPE, runId=IDS[1]))):
            wrong = copy.deepcopy(permit)
            wrong["payload"][field] = changed
            wrong["mac"] = hmac.new(service.key, helper.canonical(wrong["payload"]), hashlib.sha256).hexdigest()
            with self.subTest(field=field), self.assertRaisesRegex(helper.Refused, "MANAGED_RECONCILIATION_AUTHORIZATION_MISMATCH"):
                helper.verify_reconciliation_permit(wrong, observation, service.key, 1400)
        for issued, expires, now in ((1100, 5100, 1400), (1500, 5100, 1400), (1300, 16201, 1400), (1300, 5100, 5100), (16000, 17000, 16100)):
            wrong = reconciliation_request(service, observation, issued, expires)["permit"]
            with self.subTest(issued=issued, expires=expires), self.assertRaisesRegex(helper.Refused, "MANAGED_RECONCILIATION_AUTHORIZATION_EXPIRED"):
                helper.verify_reconciliation_permit(wrong, observation, service.key, now)

    def test_append_only_receipt_storage_rejects_replace_and_retains_partial_file(self):
        # Real local receipt files only. No managed namespace, SSH, chmod or target writes.
        value = dict(prepared_record(), state="INTENT", permitDigest="f" * 64)
        memory = MemoryHelper(value)
        with patch.object(helper.time, "time", return_value=1.2):
            observation = memory.handle(inspect_request(value))
        with patch.object(helper.time, "time", return_value=1.3):
            receipt = memory.handle(reconciliation_request(memory, observation))
        with tempfile.TemporaryDirectory(prefix="managed-reconciliation-test-") as directory:
            service = object.__new__(helper.ManagedTarget)
            service.state = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            service.receipt_started = False
            service.assert_binding = lambda _value: None
            # The test user owns this tempdir; root-only deployment checks are not
            # being simulated by weakening the production checked_file function.
            service.reconciliation_for = lambda identifier: helper.validate_reconciliation_receipt(
                helper.load_json(pathlib.Path(directory, identifier + ".reconciliation").read_bytes()))
            try:
                service.append_reconciliation(receipt)
                self.assertEqual(service.reconciliation_for(IDS[0]), receipt)
                path = pathlib.Path(directory, IDS[0] + ".reconciliation")
                original = path.read_bytes()
                self.assertEqual(path.stat().st_mode & 0o7777, 0o600)
                with self.assertRaisesRegex(helper.Refused, "MANAGED_RECONCILIATION_EXISTS"):
                    service.append_reconciliation(receipt)
                self.assertEqual(path.read_bytes(), original)
                partial = copy.deepcopy(receipt)
                partial["observation"]["reconciliationId"] = IDS[1]
                partial["receiptDigest"] = helper.digest(helper.canonical({key: child for key, child in partial.items() if key != "receiptDigest"}))
                with patch.object(helper.os, "write", side_effect=OSError("synthetic interrupted receipt")):
                    with self.assertRaises(OSError):
                        service.append_reconciliation(partial)
                partial_path = pathlib.Path(directory, IDS[1] + ".reconciliation")
                self.assertTrue(partial_path.exists())
                with self.assertRaises(Exception):
                    service.reconciliation_for(IDS[1])
                with self.assertRaisesRegex(helper.Refused, "MANAGED_RECONCILIATION_EXISTS"):
                    service.append_reconciliation(partial)
            finally:
                os.close(service.state)


if __name__ == "__main__":
    unittest.main()
