"""Broker protocol/transport tests; no Docker, runsc, VPS or customer code.

Real child processes below execute ONLY literal benign fixture strings. They test
pipe/deadline/process-group behavior, not gVisor isolation or the guest harness.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from broker import (BROKER_GATES, HARNESS, MAX_OUTPUT, PROFILE_ID, Refusal, bounded_process,
                    canonical, consume_admission, create_args, digest, execute, parse,
                    JobUnconfirmed, persist_result, read_request, read_status, trusted_json, validate_proof, validate_request)
from provision import PROFILE

IMAGE = "sha256:" + "a" * 64
PROOF_DIGEST = "b" * 64
CID = "c" * 64
PROFILE_DATA = json.loads(PROFILE.read_text())


def request():
    result = {"version": 1, "profile": PROFILE_ID,
              "scope": {"tenantId": "00000000-0000-4000-8000-000000000001", "websiteId": "00000000-0000-4000-8000-000000000002",
                        "runId": "00000000-0000-4000-8000-000000000003", "environment": "STAGING"},
              "jobId": "00000000-0000-4000-8000-000000000004",
              "files": [{"path": "test_value.py", "content": "import unittest\nclass TestValue(unittest.TestCase):\n def test_ok(self): self.assertEqual(1+1,2)\n"}]}
    result["inputDigest"] = digest(result)
    return result


def redigest(value):
    value["inputDigest"] = digest({key: item for key, item in value.items() if key != "inputDigest"})
    return value


class Transport:
    def __init__(self, *, lost_create=False, fail_boundary=False, fail_exec=False, dirty_stop=False):
        self.calls = []
        self.lost_create, self.fail_boundary, self.fail_exec, self.dirty_stop = lost_create, fail_boundary, fail_exec, dirty_stop
        self.checked = False

    def command(self, args, **kwargs):
        self.calls.append((args, kwargs))
        if args[0] == "create":
            if self.lost_create:
                raise Refusal("BROKER_PROCESS_TIMEOUT")
            return CID.encode() + b"\n"
        if args[0] == "inspect" and args[-1].startswith("codebandage-candidate-"):
            return f'"{CID}" "{IMAGE}" {request()["jobId"]}\n'.encode()
        if args[0] == "inspect":
            return b"true\n" if self.dirty_stop else b"false\n"
        if args[0] == "exec":
            if not self.checked:
                raise AssertionError("untrusted source sent before boundary validation")
            if self.fail_exec:
                raise Refusal("BROKER_PROCESS_TIMEOUT")
            result = canonical({"version": 1, "checks": {"syntax": "PASS", "unittest": "PASS", "exitCode": 0}})
            self.last_evidence = {"stdoutDigest": hashlib.sha256(result).hexdigest(), "stderrDigest": hashlib.sha256(b"mocked test log").hexdigest(),
                                  "stdoutBytes": len(result), "stderrBytes": len(b"mocked test log")}
            return result
        return b""

    def inspect_boundary(self, container, image, job):
        self.calls.append((["BOUNDARY", container], {}))
        if self.fail_boundary:
            raise Refusal("BROKER_JOB_BOUNDARY_INVALID")
        self.checked = True


class ProtocolTests(unittest.TestCase):
    def test_canonical_digest_and_detached_request(self):
        value = request()
        validated = validate_request(value)
        self.assertEqual(validated, value)
        validated["files"][0]["content"] = "changed"
        self.assertNotEqual(validated, value)
        self.assertEqual(digest({"z": 1, "a": "\u0ba4"}), hashlib.sha256(b'{"a":"\\u0ba4","z":1}').hexdigest())

    def test_no_argv_image_mount_network_or_environment_input(self):
        for key in ("command", "imageId", "mount", "env", "socket", "timeout"):
            with self.subTest(key=key), self.assertRaises(Refusal):
                validate_request(redigest(request() | {key: "untrusted"}))

    def test_file_scope_and_digest_limits(self):
        cases = []
        for name in ("../escape.py", "/tmp/test.py", "folder/test.py", "test.sh", "sitecustomize.py", "usercustomize.py", "a\n.py"):
            value = request(); value["files"][0]["path"] = name; cases.append(redigest(value))
        value = request(); value["scope"]["environment"] = "PRODUCTION"; cases.append(redigest(value))
        value = request(); value["files"] *= 2; cases.append(redigest(value))
        value = request(); value["files"][0]["content"] = "x" * 262145; cases.append(redigest(value))
        value = request(); value["files"][0]["path"] = "value.py"; cases.append(redigest(value))
        value = request(); value["inputDigest"] = "a" * 64; cases.append(value)
        for value in cases:
            with self.subTest(value=str(value)[:100]), self.assertRaises(Refusal):
                validate_request(value)

    def test_duplicate_json_and_nan_refused(self):
        for raw in (b'{"a":1,"a":2}', b'{"number":NaN}', b'not json'):
            with self.subTest(raw=raw), self.assertRaises(Refusal):
                parse(raw)

    def test_docker_profile_is_fixed_and_offline(self):
        args = create_args(PROFILE_DATA, IMAGE, request()["jobId"])
        for required in ("--pull=never", "--runtime=runsc-systrap", "--network=none", "--ipc=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges"):
            self.assertIn(required, args)
        for absent in ("--privileged", "--volume", "--mount", "--device", "--ignore-cgroups", "--rootless", "--rm"):
            self.assertNotIn(absent, args)
        self.assertEqual(args[args.index("--entrypoint") + 1], "python3")
        self.assertIn(IMAGE, args)

    def test_actual_failed_and_historical_basic_proofs_cannot_activate(self):
        for proof in ({"result": "FAILED"}, {"schema": "codebandage-offline-runtime-proof/v1", "result": "PASS", "imageId": IMAGE, "applicationActivation": False}):
            with self.assertRaisesRegex(Refusal, "BROKER_RUNTIME_UNAVAILABLE"):
                validate_proof(proof, PROFILE_DATA, IMAGE, 1000000)

    def test_future_fixture_proof_must_have_every_gate_fresh_and_same_profile(self):
        proof = {"schema": "codebandage-offline-runtime-proof/v1", "result": "PASS", "imageId": IMAGE, "applicationActivation": False,
                 "candidateBroker": {"profileDigest": digest(PROFILE_DATA), "verifiedAtMs": 1000000, "checks": {key: "PASS" for key in BROKER_GATES}}}
        validate_proof(proof, PROFILE_DATA, IMAGE, 1000000)
        for mutate in (lambda p: p["candidateBroker"].update(verifiedAtMs=1000001),
                       lambda p: p["candidateBroker"].update(verifiedAtMs=1),
                       lambda p: p["candidateBroker"]["checks"].update(tenantIsolation="NOT_TESTED"),
                       lambda p: p["candidateBroker"].update(profileDigest="a" * 64),
                       lambda p: p.update(applicationActivation=True)):
            invalid = copy.deepcopy(proof); mutate(invalid)
            with self.assertRaises(Refusal):
                validate_proof(invalid, PROFILE_DATA, IMAGE, 1000000)


class ExecutionTests(unittest.TestCase):
    def invoke(self, transport, **kwargs):
        return execute(request(), profile=PROFILE_DATA, image_id=IMAGE, proof_digest=PROOF_DIGEST, transport=transport, **kwargs)

    def test_receipt_binds_scope_input_proof_and_real_cleanup(self):
        transport = Transport()
        result = self.invoke(transport)
        self.assertEqual(result["result"], "PASS")
        self.assertEqual(result["checks"]["containerStopped"], "PASS")
        self.assertEqual(result["scope"], request()["scope"])
        self.assertEqual(result["inputDigest"], request()["inputDigest"])
        self.assertEqual(result["runtimeProofDigest"], PROOF_DIGEST)
        self.assertEqual(result["resultDigest"], digest({key: value for key, value in result.items() if key != "resultDigest"}))
        self.assertFalse(result["liveCustomerRepairVerified"])
        self.assertEqual([args[0] for args, _kwargs in transport.calls], ["create", "start", "BOUNDARY", "exec", "stop", "inspect"])
        self.assertEqual(json.loads(transport.calls[3][1]["data"]), {"files": request()["files"]})

    def test_bad_boundary_never_receives_candidate_and_is_stopped(self):
        transport = Transport(fail_boundary=True)
        with self.assertRaisesRegex(Refusal, "BROKER_JOB_BOUNDARY_INVALID"):
            self.invoke(transport)
        self.assertNotIn("exec", [args[0] for args, _kwargs in transport.calls])
        self.assertEqual(transport.calls[-2][0], ["stop", "--time", "2", CID])

    def test_timeout_stops_exact_container_without_retry_or_delete(self):
        transport = Transport(fail_exec=True)
        with self.assertRaisesRegex(Refusal, "BROKER_PROCESS_TIMEOUT"):
            self.invoke(transport)
        operations = [args[0] for args, _kwargs in transport.calls]
        self.assertEqual(operations.count("exec"), 1)
        self.assertIn("stop", operations)
        self.assertNotIn("rm", operations)

    def test_lost_create_ack_resolves_only_exact_label_image_and_job(self):
        transport = Transport(lost_create=True)
        with self.assertRaisesRegex(Refusal, "BROKER_PROCESS_TIMEOUT"):
            self.invoke(transport)
        self.assertEqual(transport.calls[-2][0], ["stop", "--time", "2", CID])
        self.assertEqual(transport.calls[1][0][-1], "codebandage-candidate-" + request()["jobId"])

    def test_no_success_when_stop_is_unconfirmed(self):
        transport = Transport(dirty_stop=True)
        with self.assertRaisesRegex(Refusal, "BROKER_CLEANUP_UNCONFIRMED"):
            self.invoke(transport)
        self.assertIn(["kill", CID], [args for args, _kwargs in transport.calls])


class RealProcessTests(unittest.TestCase):
    def test_both_pipes_and_large_stdin_are_drained_without_deadlock(self):
        code, out, err = bounded_process([sys_executable(), "-I", "-c", "import sys;sys.stderr.write('e'*20000);data=sys.stdin.buffer.read();sys.stdout.buffer.write(data)"],
                                         input_bytes=b"a" * 30000, timeout=3)
        self.assertEqual((code, out, err), (0, b"a" * 30000, b"e" * 20000))

    def test_no_parent_secret_environment_is_inherited(self):
        with patch.dict(os.environ, {"BROKER_TEST_SECRET": "never-in-child", "DOCKER_HOST": "private"}):
            code, out, _err = bounded_process([sys_executable(), "-I", "-c", "import os;print('BROKER_TEST_SECRET' in os.environ or 'DOCKER_HOST' in os.environ)"])
        self.assertEqual((code, out), (0, b"False\n"))

    def test_output_limit_and_deadline_kill_real_child(self):
        for script, timeout, message in (("import os;os.write(1,b'x'*100000)", 3, "BROKER_OUTPUT_LIMIT"),
                                         ("import time;time.sleep(5)", .1, "BROKER_PROCESS_TIMEOUT")):
            before = time.monotonic()
            with self.assertRaisesRegex(Refusal, message):
                bounded_process([sys_executable(), "-I", "-c", script], timeout=timeout)
            self.assertLess(time.monotonic() - before, 3)

    def test_cancellation_kills_a_real_waiting_child(self):
        event = threading.Event()
        timer = threading.Timer(.1, event.set); timer.start()
        try:
            with self.assertRaisesRegex(Refusal, "BROKER_CANCELLED"):
                bounded_process([sys_executable(), "-I", "-c", "import time;time.sleep(5)"], timeout=3, cancelled=event.is_set)
        finally:
            timer.cancel()

    def test_cancellation_after_closed_output_pipes_is_not_delayed(self):
        event = threading.Event()
        timer = threading.Timer(.1, event.set); timer.start()
        before = time.monotonic()
        try:
            with self.assertRaisesRegex(Refusal, "BROKER_CANCELLED"):
                bounded_process([sys_executable(), "-I", "-c", "import os,time;os.close(1);os.close(2);time.sleep(5)"], timeout=3, cancelled=event.is_set)
            self.assertLess(time.monotonic() - before, 1)
        finally:
            timer.cancel()

    def test_pipe_input_has_a_deadline_even_with_no_eof(self):
        reader, writer = os.pipe()
        try:
            with os.fdopen(reader, "rb", buffering=0) as stream:
                os.write(writer, b"one request")
                with self.assertRaisesRegex(Refusal, "BROKER_INPUT_TIMEOUT"):
                    read_request(stream, timeout=.05)
        finally:
            os.close(writer)

    def test_pipe_input_returns_exact_bytes_after_eof(self):
        reader, writer = os.pipe()
        os.write(writer, b'{"bounded":"input"}')
        os.close(writer)
        with os.fdopen(reader, "rb", buffering=0) as stream:
            self.assertEqual(read_request(stream), b'{"bounded":"input"}')

    def test_regular_file_stdin_is_bounded_without_epoll(self):
        with tempfile.TemporaryFile() as stream:
            stream.write(b'{"file":"input"}'); stream.seek(0)
            self.assertEqual(read_request(stream), b'{"file":"input"}')

    def test_actual_cli_refuses_this_non_vps_host_without_runtime_commands(self):
        if socket.gethostname() == PROFILE_DATA["host"]:
            self.skipTest("Never invoke the runtime CLI on the actual VPS from local tests")
        code, out, err = bounded_process([sys_executable(), "-I", "-B", str(Path(__file__).with_name("broker.py"))],
                                         input_bytes=canonical(request()), timeout=3)
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(out), {"version": 1, "result": "UNAVAILABLE", "code": "WRONG_HOST_OR_USER", "liveCustomerRepairVerified": False})
        self.assertEqual(err, b"")

    def test_fixed_guest_harness_parses_without_executing(self):
        compile(HARNESS, "fixed-guest-harness", "exec")

    def test_exited_group_leader_does_not_leave_a_running_pipe_holder(self):
        with tempfile.TemporaryDirectory() as temporary:
            pid_file = Path(temporary) / "fixture-child.pid"
            literal = "import os,pathlib,subprocess,sys;child=subprocess.Popen([sys.executable,'-I','-c','import time;time.sleep(10)']);pathlib.Path(sys.argv[1]).write_text(str(child.pid));os._exit(0)"
            try:
                with self.assertRaisesRegex(Refusal, "BROKER_PROCESS_TIMEOUT"):
                    bounded_process([sys_executable(), "-I", "-c", literal, str(pid_file)], timeout=.2)
                pid = int(pid_file.read_text())
                for _ in range(50):
                    metadata = Path("/proc") / str(pid) / "stat"
                    if not metadata.exists() or metadata.read_text().split(")", 1)[1].strip().startswith("Z"):
                        break
                    time.sleep(.01)
                else:
                    self.fail("literal fixture descendant is still running")
            finally:
                if pid_file.exists():
                    try:
                        os.kill(int(pid_file.read_text()), 9)
                    except ProcessLookupError:
                        pass


class AdmissionStorageTests(unittest.TestCase):
    """Real temp storage/fsync, synthetic authority. No managed namespaces/targets.

    The root trust check is exercised separately. Patch only owner expectations so
    ordinary non-root CI can test storage durability/order without sudo.
    """
    def fixture(self, root, value=None):
        value = request() if value is None else value
        folder = root / "candidate-admissions"
        folder.mkdir(mode=0o700, exist_ok=True)
        authority = {key: value[key] for key in ("version", "scope", "jobId", "profile", "inputDigest")}
        authority.update(imageId=IMAGE, runtimeProofDigest=PROOF_DIGEST, issuedAtMs=1000, expiresAtMs=16000)
        target = folder / (value["jobId"] + ".json")
        target.write_bytes(canonical(authority)); target.chmod(0o600)
        return folder, authority

    def test_consumption_is_one_shot_and_unconfirmed_intent_blocks_next_job(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); folder, _authority = self.fixture(root)
            original = trusted_json
            with patch("broker.root_private_directory"), patch("broker.trusted_json", side_effect=lambda path, **kw: original(path, owner=os.getuid(), group=os.getgid(), **kw)):
                consumed = consume_admission(root, request(), PROOF_DIGEST, IMAGE, 1001)
                self.assertEqual(json.loads(consumed.read_bytes())["state"], "INTENT")
                self.assertEqual(consumed.stat().st_mode & 0o777, 0o600)
                with self.assertRaisesRegex(Refusal, "BROKER_PREVIOUS_OUTCOME_UNCONFIRMED"):
                    consume_admission(root, request(), PROOF_DIGEST, IMAGE, 1002)
                with self.assertRaisesRegex(JobUnconfirmed, "BROKER_EXECUTION_UNCONFIRMED"):
                    read_status(root, request())
                self.assertTrue(consumed.exists())

    def test_completed_receipt_is_persisted_read_back_and_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); self.fixture(root)
            original = trusted_json
            with patch("broker.root_private_directory"), patch("broker.trusted_json", side_effect=lambda path, **kw: original(path, owner=os.getuid(), group=os.getgid(), **kw)):
                consumed = consume_admission(root, request(), PROOF_DIGEST, IMAGE, 1001)
                result = execute(request(), profile=PROFILE_DATA, image_id=IMAGE, proof_digest=PROOF_DIGEST, transport=Transport())
                persist_result(consumed, result)
                saved = consumed.with_name(request()["jobId"] + ".result.json")
                self.assertEqual(json.loads(saved.read_bytes()), result)
                self.assertEqual(read_status(root, request()), result)
                with self.assertRaises(FileExistsError):
                    persist_result(consumed, result)
                with self.assertRaisesRegex(Refusal, "BROKER_ADMISSION_CONSUMED"):
                    consume_admission(root, request(), PROOF_DIGEST, IMAGE, 1002)

    def test_status_never_returns_other_tenant_or_changed_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); self.fixture(root)
            original = trusted_json
            with patch("broker.root_private_directory"), patch("broker.trusted_json", side_effect=lambda path, **kw: original(path, owner=os.getuid(), group=os.getgid(), **kw)):
                consumed = consume_admission(root, request(), PROOF_DIGEST, IMAGE, 1001)
                value = request(); value["scope"]["websiteId"] = "00000000-0000-4000-8000-000000000099"; value = redigest(value)
                with self.assertRaisesRegex(Refusal, "BROKER_STATUS_BINDING_MISMATCH"):
                    read_status(root, value)
                result = execute(request(), profile=PROFILE_DATA, image_id=IMAGE, proof_digest=PROOF_DIGEST, transport=Transport())
                persist_result(consumed, result)
                saved = consumed.with_name(request()["jobId"] + ".result.json")
                invalid = result | {"resultDigest": "f" * 64}; saved.write_bytes(canonical(invalid))
                with self.assertRaisesRegex(Refusal, "BROKER_STATUS_RECEIPT_INVALID"):
                    read_status(root, request())

    def test_bad_scope_proof_digest_and_expiry_never_create_intent(self):
        for kind in ("scope", "runtimeProofDigest", "expiresAtMs"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary); folder, authority = self.fixture(root)
                if kind == "scope":
                    authority[kind] = authority[kind] | {"environment": "PRODUCTION"}
                elif kind == "expiresAtMs":
                    authority[kind] = 1001
                else:
                    authority[kind] = "f" * 64
                (folder / (request()["jobId"] + ".json")).write_bytes(canonical(authority))
                original = trusted_json
                with patch("broker.root_private_directory"), patch("broker.trusted_json", side_effect=lambda path, **kw: original(path, owner=os.getuid(), group=os.getgid(), **kw)):
                    with self.assertRaisesRegex(Refusal, "BROKER_ADMISSION_INVALID"):
                        consume_admission(root, request(), PROOF_DIGEST, IMAGE, 1001)
                self.assertFalse((folder / (request()["jobId"] + ".consumed")).exists())

    def test_real_metadata_rejects_readable_or_symlink_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "evidence.json"
            path.write_bytes(b'{"scope":"synthetic"}'); path.chmod(0o600)
            self.assertEqual(trusted_json(path, owner=os.getuid(), group=os.getgid())[0], {"scope": "synthetic"})
            path.chmod(0o644)
            with self.assertRaisesRegex(Refusal, "BROKER_UNTRUSTED_EVIDENCE"):
                trusted_json(path, owner=os.getuid(), group=os.getgid())
            link = Path(temporary) / "link.json"; link.symlink_to(path)
            with self.assertRaises(OSError):
                trusted_json(link, owner=os.getuid(), group=os.getgid())


def sys_executable():
    import sys
    return sys.executable


if __name__ == "__main__":
    unittest.main()
