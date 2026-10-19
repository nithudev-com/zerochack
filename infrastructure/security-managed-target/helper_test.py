"""Local mocked-target and receipt-storage tests. No managed provisioning, SSH or target mutation."""
import copy
import hashlib
import hmac
import importlib.util
import pathlib
import os
import tempfile
import unittest
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
