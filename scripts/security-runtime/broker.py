#!/usr/bin/env python3
"""One-shot offline candidate broker. Importing this file performs no host action.

This is NOT a sandbox fallback. The production transport requires the existing
VPS runtime and a fresh complete proof; the current failed gVisor runtime is
unavailable. No admission issuer or privileged service is installed by this CLI.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import selectors
import signal
import stat
import subprocess
import sys
import threading
import time
from typing import Callable

# Support an isolated-interpreter CLI without consulting cwd/PYTHONPATH. This is
# the broker's own installed source directory, not a request-provided path.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from provision import BASE_ENV, COMMENT, PROFILE, PUBLIC_RUNTIME_BASE, Refusal, Runtime, daemon_config, require
from verify import bounded_executable_hash, process_identity

VERSION = 1
PROFILE_ID = "PYTHON_UNITTEST_V1"
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
SHA = re.compile(r"[0-9a-f]{64}")
MAX_INPUT = 1048576
MAX_FILES = 32
MAX_SOURCE_BYTES = 262144
MAX_OUTPUT = 65536
MAX_JOB_SECONDS = 45
PROOF_TTL_MS = 300000
BROKER_GATES = ("allHelperCgroups", "resourceExhaustion", "networkDenial", "crashCancellationCleanup", "tenantIsolation")


class JobUnconfirmed(Refusal):
    def __init__(self, code: str, request: dict):
        super().__init__(code)
        self.request = request


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("ascii")


def digest(value: object) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def exact(value: object, keys: set[str]) -> None:
    require(type(value) is dict and set(value) == keys, "BROKER_INVALID_REQUEST")


def no_duplicates(pairs: list[tuple[str, object]]) -> dict:
    value = {}
    for key, item in pairs:
        require(key not in value, "BROKER_DUPLICATE_JSON_KEY")
        value[key] = item
    return value


def parse(data: bytes) -> object:
    require(type(data) is bytes and 0 < len(data) <= MAX_INPUT, "BROKER_INPUT_LIMIT")
    try:
        return json.loads(data, object_pairs_hook=no_duplicates, parse_constant=lambda _value: (_ for _ in ()).throw(Refusal("BROKER_INVALID_JSON")))
    except (ValueError, RecursionError, UnicodeError):
        raise Refusal("BROKER_INVALID_JSON") from None


def read_request(stream, *, timeout: float = 5) -> bytes:
    """Fixed-length/deadline pipe input; no file path or request-controlled timeout."""
    if stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
        data = os.read(stream.fileno(), MAX_INPUT + 1)
        require(len(data) <= MAX_INPUT, "BROKER_INPUT_LIMIT")
        return data
    data = bytearray()
    deadline = time.monotonic() + timeout
    selector = selectors.DefaultSelector()
    try:
        selector.register(stream, selectors.EVENT_READ)
        while True:
            require(time.monotonic() < deadline, "BROKER_INPUT_TIMEOUT")
            if not selector.select(min(.05, max(0, deadline - time.monotonic()))):
                continue
            block = os.read(stream.fileno(), 8192)
            if not block:
                return bytes(data)
            data.extend(block)
            require(len(data) <= MAX_INPUT, "BROKER_INPUT_LIMIT")
    finally:
        selector.close()


def validate_request(value: object) -> dict:
    exact(value, {"version", "profile", "scope", "jobId", "files", "inputDigest"})
    require(type(value["version"]) is int and value["version"] == VERSION and value["profile"] == PROFILE_ID,
            "BROKER_UNSUPPORTED_PROFILE")
    scope = value["scope"]
    exact(scope, {"tenantId", "websiteId", "runId", "environment"})
    require(scope["environment"] == "STAGING", "BROKER_STAGING_ONLY")
    for field in ("tenantId", "websiteId", "runId"):
        require(type(scope[field]) is str and UUID.fullmatch(scope[field]), "BROKER_INVALID_SCOPE")
    require(type(value["jobId"]) is str and UUID.fullmatch(value["jobId"]), "BROKER_INVALID_JOB_ID")
    files = value["files"]
    require(type(files) is list and 1 <= len(files) <= MAX_FILES, "BROKER_FILE_LIMIT")
    seen = set()
    total = 0
    for item in files:
        exact(item, {"path", "content"})
        name, content = item["path"], item["content"]
        require(type(name) is str and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}\.py", name) and
                name not in ("sitecustomize.py", "usercustomize.py") and name not in seen, "BROKER_INVALID_FILE_PATH")
        require(type(content) is str and "\0" not in content, "BROKER_INVALID_SOURCE")
        try:
            total += len(content.encode("utf-8"))
        except UnicodeError:
            raise Refusal("BROKER_INVALID_SOURCE") from None
        seen.add(name)
    require(total <= MAX_SOURCE_BYTES, "BROKER_SOURCE_LIMIT")
    require(any(name.startswith("test_") for name in seen), "BROKER_TEST_REQUIRED")
    require(type(value["inputDigest"]) is str and SHA.fullmatch(value["inputDigest"]) and
            digest({key: item for key, item in value.items() if key != "inputDigest"}) == value["inputDigest"], "BROKER_INPUT_DIGEST_MISMATCH")
    # Detach caller-owned mutable objects before any deadline/admission work.
    return json.loads(canonical(value))


def bounded_process(argv: list[str], *, input_bytes: bytes = b"", timeout: float = 10,
                    maximum: int = MAX_OUTPUT, cancelled: Callable[[], bool] = lambda: False) -> tuple[int, bytes, bytes]:
    """Bound ALL pipes while concurrently sending stdin. No shell or inherited secrets.

    Process-group kill bounds a failed CLI. A separate exact container stop is still
    required: killing a Docker client does not prove that its guest stopped.
    """
    require(0 < timeout <= 60 and 0 < maximum <= MAX_INPUT and len(input_bytes) <= MAX_INPUT, "BROKER_PROCESS_LIMIT")
    require(not cancelled(), "BROKER_CANCELLED")
    process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               env=BASE_ENV, close_fds=True, start_new_session=True, shell=False)
    output = [bytearray(), bytearray()]
    deadline = time.monotonic() + timeout
    selector = selectors.DefaultSelector()
    sent = 0
    try:
        for index, stream in enumerate((process.stdout, process.stderr)):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, index)
        if input_bytes:
            os.set_blocking(process.stdin.fileno(), False)
            selector.register(process.stdin, selectors.EVENT_WRITE, 2)
        else:
            process.stdin.close()
        while selector.get_map():
            require(not cancelled(), "BROKER_CANCELLED")
            require(time.monotonic() < deadline, "BROKER_PROCESS_TIMEOUT")
            for key, _mask in selector.select(min(0.05, max(0, deadline - time.monotonic()))):
                if key.data == 2:
                    try:
                        count = os.write(key.fileobj.fileno(), input_bytes[sent:sent + 8192])
                    except BlockingIOError:
                        continue
                    except BrokenPipeError:
                        count = 0
                    if count:
                        sent += count
                    if not count or sent == len(input_bytes):
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
                else:
                    try:
                        block = os.read(key.fileobj.fileno(), 8192)
                    except BlockingIOError:
                        continue
                    if not block:
                        selector.unregister(key.fileobj)
                    else:
                        output[key.data].extend(block)
                        require(sum(map(len, output)) <= maximum, "BROKER_OUTPUT_LIMIT")
        require(not cancelled(), "BROKER_CANCELLED")
        while process.poll() is None:
            require(not cancelled(), "BROKER_CANCELLED")
            remaining = deadline - time.monotonic()
            require(remaining > 0, "BROKER_PROCESS_TIMEOUT")
            try:
                process.wait(timeout=min(.05, remaining))
            except subprocess.TimeoutExpired:
                pass
        code = process.returncode
        return code, bytes(output[0]), bytes(output[1])
    finally:
        # The group leader may exit while descendants still hold its pipes.
        # Kill this invocation's group even when the leader has already exited.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=5)
        selector.close()
        for stream in (process.stdin, process.stdout, process.stderr):
            if not stream.closed:
                stream.close()


def trusted_json(path: Path, *, maximum: int = MAX_INPUT, owner: int = 0, group: int = 0) -> tuple[dict, str]:
    """Only root-private, single-link regular evidence; never follow a final symlink."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == owner and before.st_gid == group and
                before.st_nlink == 1 and stat.S_IMODE(before.st_mode) in (0o400, 0o600) and
                0 < before.st_size <= maximum, "BROKER_UNTRUSTED_EVIDENCE")
        data = os.read(fd, maximum + 1)
        after = os.fstat(fd)
        require(len(data) == before.st_size and before.st_size == after.st_size and before.st_mtime_ns == after.st_mtime_ns and
                before.st_ctime_ns == after.st_ctime_ns, "BROKER_EVIDENCE_CHANGED")
        value = parse(data)
        require(type(value) is dict, "BROKER_UNTRUSTED_EVIDENCE")
        return value, hashlib.sha256(data).hexdigest()
    finally:
        os.close(fd)


def validate_proof(proof: dict, profile: dict, image_id: str, now_ms: int) -> None:
    require(proof.get("schema") == "codebandage-offline-runtime-proof/v1" and proof.get("result") == "PASS" and
            proof.get("imageId") == image_id and proof.get("applicationActivation") is False, "BROKER_RUNTIME_UNAVAILABLE")
    # The historical basic probe is insufficient for candidate admission. These
    # actual separately reviewed fault/containment results have not yet passed.
    gate = proof.get("candidateBroker")
    require(type(gate) is dict and set(gate) == {"profileDigest", "verifiedAtMs", "checks"} and
            gate["profileDigest"] == digest(profile) and type(gate["verifiedAtMs"]) is int and
            0 <= now_ms - gate["verifiedAtMs"] <= PROOF_TTL_MS and
            gate["checks"] == {name: "PASS" for name in BROKER_GATES}, "BROKER_RUNTIME_UNAVAILABLE")


# Written only INSIDE the verified sandbox. Parent supplies no host path/argv/env.
HARNESS = r'''
import contextlib,hashlib,io,json,os,subprocess,sys
request=json.loads(sys.stdin.buffer.read(1048577))
files=request['files']
os.chdir('/work')
for item in files:
    fd=os.open(item['path'],os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w',encoding='utf-8',newline='') as output: output.write(item['content'])
compiled=True
for item in files:
    try: compile(item['content'],item['path'],'exec')
    except (SyntaxError,ValueError): compiled=False
result={'syntax':'PASS' if compiled else 'FAIL','unittest':'NOT_RUN','exitCode':None}
if compiled:
    # Fixed interpreter/stdlib invocation. Test code stays entirely in the guest.
    runner="import sys,unittest;suite=unittest.defaultTestLoader.discover('/work',pattern='test_*.py',top_level_dir='/work');count=suite.countTestCases();result=unittest.TextTestRunner(verbosity=2).run(suite);sys.exit(0 if count>0 and result.wasSuccessful() else 5)"
    child=subprocess.Popen([sys.executable,'-I','-B','-c',runner],
        stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,env={'PATH':'/usr/local/bin:/usr/bin','PYTHONDONTWRITEBYTECODE':'1'},start_new_session=True)
    # Broker bounds the combined output and kills this entire container on timeout.
    while True:
        block=child.stdout.read(4096)
        if not block: break
        sys.stderr.buffer.write(block); sys.stderr.buffer.flush()
    code=child.wait()
    result.update(unittest='PASS' if code==0 else 'FAIL',exitCode=code)
print(json.dumps({'version':1,'checks':result},sort_keys=True,separators=(',',':')))
'''


def create_args(profile: dict, image_id: str, job_id: str) -> list[str]:
    require(re.fullmatch(r"sha256:[a-f0-9]{64}", image_id) is not None and UUID.fullmatch(job_id), "BROKER_INVALID_ADMISSION")
    return ["create", "--name", "codebandage-candidate-" + job_id, "--pull=never", "--runtime=runsc-systrap",
            "--label", "io.codebandage.candidate-profile=" + PROFILE_ID, "--label", "io.codebandage.job=" + job_id,
            "--network=none", "--ipc=none", "--read-only", "--user", "65532:65532", "--cap-drop=ALL",
            "--security-opt=no-new-privileges", "--memory", str(profile["jobMemoryBytes"]),
            "--memory-swap", str(profile["jobMemoryBytes"]), "--cpus", profile["jobCpu"], "--pids-limit", str(profile["jobPids"]),
            "--ulimit", "nofile=128:128", "--log-opt", "max-size=1m", "--log-opt", "max-file=2",
            "--tmpfs", "/work:rw,nosuid,nodev,noexec,size=67108864,mode=0700,uid=65532,gid=65532",
            "--env", "TMPDIR=/work", "--entrypoint", "python3", image_id, "-I", "-B", "-c", "import time;time.sleep(120)"]


class ProductionTransport:
    def __init__(self, runtime: Runtime, cancelled: Callable[[], bool]):
        self.runtime, self.cancelled = runtime, cancelled

    def command(self, args: list[str], *, data: bytes = b"", timeout: float = 10, allow_failure: bool = False,
                cleanup: bool = False) -> bytes:
        uid = self.runtime.user.pw_uid
        argv = ["runuser", "--user", self.runtime.account, "--", "env", f"XDG_RUNTIME_DIR=/run/user/{uid}",
                f"DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{uid}/bus", "docker", "--host",
                f"unix:///run/user/{uid}/codebandage-runtime.sock", *args]
        code, output, error = bounded_process(argv, input_bytes=data, timeout=timeout,
                                             cancelled=(lambda: False) if cleanup else self.cancelled)
        self.last_evidence = {"stdoutDigest": hashlib.sha256(output).hexdigest(), "stderrDigest": hashlib.sha256(error).hexdigest(),
                              "stdoutBytes": len(output), "stderrBytes": len(error)}
        require(allow_failure or code == 0, "BROKER_ENGINE_COMMAND_FAILED")
        return output

    def inspect_boundary(self, container_id: str, image_id: str, job_id: str) -> None:
        raw = json.loads(self.command(["inspect", container_id]))
        require(type(raw) is list and len(raw) == 1, "BROKER_JOB_BOUNDARY_INVALID")
        container = raw[0]
        host = container["HostConfig"]
        config = container["Config"]
        p = self.runtime.p
        require(container["Id"] == container_id and container["Image"] == image_id and container["State"]["Running"] and
                config["User"] == "65532:65532" and config["Labels"]["io.codebandage.job"] == job_id and
                host["Runtime"] == "runsc-systrap" and host["ReadonlyRootfs"] and not host["Privileged"] and
                not host.get("Binds") and not host.get("Devices") and not host.get("PortBindings") and
                host["NetworkMode"] == "none" and host["IpcMode"] == "none" and host["CapDrop"] == ["ALL"] and
                host["SecurityOpt"] == ["no-new-privileges"] and
                host["Memory"] == p["jobMemoryBytes"] and host["MemorySwap"] == p["jobMemoryBytes"] and
                host["PidsLimit"] == p["jobPids"] and 0 < host["NanoCpus"] <= int(float(p["jobCpu"]) * 1000000000) and
                host["Tmpfs"] == {"/work": "rw,nosuid,nodev,noexec,size=67108864,mode=0700,uid=65532,gid=65532"} and
                all(mount.get("Type") == "tmpfs" and mount.get("Destination") == "/work"
                                                       for mount in container["Mounts"]), "BROKER_JOB_BOUNDARY_INVALID")
        pid = container["State"]["Pid"]
        require(type(pid) is int and 1 < pid < 2**31, "BROKER_JOB_BOUNDARY_INVALID")
        proc = Path("/proc") / str(pid)
        user = self.runtime.user
        process_identity(proc, dedicated_uid=user.pw_uid, dedicated_gid=user.pw_gid,
                         subordinate_start=p["subordinateIdStart"], subordinate_count=p["subordinateIdCount"])
        for kind in ("user", "net"):
            require(os.readlink(proc / "ns" / kind) != os.readlink(Path("/proc/1/ns") / kind), "BROKER_JOB_NAMESPACE_INVALID")
        relative = (proc / "cgroup").read_text().strip()
        require(relative.startswith(f"0::/user.slice/user-{user.pw_uid}.slice/") and container_id in relative and ".." not in relative,
                "BROKER_JOB_CGROUP_INVALID")
        cgroup = Path("/sys/fs/cgroup") / relative.split("::", 1)[1].lstrip("/")
        quota, period = map(int, (cgroup / "cpu.max").read_text().split())
        require(quota > 0 and period > 0 and quota / period <= float(p["jobCpu"]) and
                int((cgroup / "memory.max").read_text()) == p["jobMemoryBytes"] and
                int((cgroup / "memory.swap.max").read_text()) == 0 and
                int((cgroup / "pids.max").read_text()) <= p["jobPids"], "BROKER_JOB_LIMITS_INVALID")


def execute(request: dict, *, profile: dict, image_id: str, proof_digest: str, transport,
            cancelled: Callable[[], bool] = lambda: False) -> dict:
    """Trusted caller has consumed admission durably. No retry, pull, delete or fallback."""
    request = validate_request(request)
    require(SHA.fullmatch(proof_digest) is not None, "BROKER_INVALID_PROOF_DIGEST")
    name = "codebandage-candidate-" + request["jobId"]
    container_id = None
    result = None
    started = time.monotonic()
    try:
        require(not cancelled(), "BROKER_CANCELLED")
        created = transport.command(create_args(profile, image_id, request["jobId"])).decode("ascii").strip()
        require(re.fullmatch(r"[a-f0-9]{64}", created) is not None, "BROKER_CREATED_ID_UNKNOWN")
        container_id = created
        transport.command(["start", container_id])
        transport.inspect_boundary(container_id, image_id, request["jobId"])
        require(not cancelled(), "BROKER_CANCELLED")
        output = transport.command(["exec", "-i", container_id, "python3", "-I", "-B", "-c", HARNESS],
                                   data=canonical({"files": request["files"]}), timeout=MAX_JOB_SECONDS)
        evidence = dict(transport.last_evidence)
        require(evidence["stdoutDigest"] == hashlib.sha256(output).hexdigest() and
                type(evidence["stdoutBytes"]) is int and evidence["stdoutBytes"] == len(output) and
                type(evidence["stderrBytes"]) is int and evidence["stderrBytes"] >= 0 and
                evidence["stdoutBytes"] + evidence["stderrBytes"] <= MAX_OUTPUT and
                SHA.fullmatch(evidence["stderrDigest"]), "BROKER_OUTPUT_EVIDENCE_INVALID")
        guest = parse(output)
        exact(guest, {"version", "checks"})
        exact(guest["checks"], {"syntax", "unittest", "exitCode"})
        checks = guest["checks"]
        require(type(guest["version"]) is int and guest["version"] == 1 and checks["syntax"] in ("PASS", "FAIL") and checks["unittest"] in ("PASS", "FAIL", "NOT_RUN") and
                (checks["exitCode"] is None or type(checks["exitCode"]) is int and -255 <= checks["exitCode"] <= 255), "BROKER_INVALID_GUEST_RESULT")
        result = {"version": 1, "profile": PROFILE_ID, "scope": request["scope"], "jobId": request["jobId"],
                  "inputDigest": request["inputDigest"], "imageId": image_id, "runtimeProofDigest": proof_digest,
                  "checks": checks, "result": "PASS" if checks == {"syntax": "PASS", "unittest": "PASS", "exitCode": 0} else "FAIL",
                  "elapsedMs": int((time.monotonic() - started) * 1000), "outputEvidence": evidence,
                  "liveCustomerRepairVerified": False}
    finally:
        # If create loses its acknowledgement, resolve only this unique job name;
        # never enumerate/stop arbitrary or production containers.
        if container_id is None:
            raw = transport.command(["inspect", "--format", '{{json .Id}} {{json .Image}} {{index .Config.Labels "io.codebandage.job"}}', name],
                                    allow_failure=True, cleanup=True).decode("ascii").strip().split()
            if len(raw) == 3 and raw[2] == request["jobId"] and json.loads(raw[1]) == image_id:
                candidate = json.loads(raw[0])
                require(re.fullmatch(r"[a-f0-9]{64}", candidate) is not None, "BROKER_CREATED_ID_UNKNOWN")
                container_id = candidate
        if container_id is not None:
            transport.command(["stop", "--time", "2", container_id], allow_failure=True, cleanup=True)
            status = transport.command(["inspect", "--format", "{{.State.Running}}", container_id], cleanup=True).strip()
            if status != b"false":
                transport.command(["kill", container_id], allow_failure=True, cleanup=True)
                status = transport.command(["inspect", "--format", "{{.State.Running}}", container_id], cleanup=True).strip()
            require(status == b"false", "BROKER_CLEANUP_UNCONFIRMED")
    result["checks"]["containerStopped"] = "PASS"
    result["resultDigest"] = digest(result)
    return result


def root_private_directory(path: Path) -> None:
    for entry in (path, *path.parents):
        info = entry.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not stat.S_IMODE(info.st_mode) & 0o022,
                "BROKER_UNTRUSTED_DIRECTORY")
    require(stat.S_IMODE(path.stat().st_mode) == 0o700, "BROKER_UNTRUSTED_DIRECTORY")


def consume_admission(root: Path, request: dict, proof_digest: str, image_id: str, now_ms: int) -> Path:
    """Issuer is deliberately separate: never treat submitted JSON as authority."""
    folder = root / "candidate-admissions"
    root_private_directory(folder)
    names = os.listdir(folder)
    require(len(names) <= 3000 and all(re.fullmatch(r"[0-9a-f-]{36}\.(json|consumed|result\.json)", name) for name in names),
            "BROKER_ADMISSION_STORAGE_LIMIT")
    for name in names:
        if name.endswith(".consumed"):
            intent, _intent_hash = trusted_json(folder / name, maximum=8192)
            previous_id = name[:-len(".consumed")]
            result_path = folder / (previous_id + ".result.json")
            require(result_path.name in names, "BROKER_PREVIOUS_OUTCOME_UNCONFIRMED")
            previous, _previous_hash = trusted_json(result_path, maximum=8192)
            require(previous.get("jobId") == intent.get("jobId") == previous_id and previous.get("scope") == intent.get("scope") and
                    previous.get("inputDigest") == intent.get("inputDigest") and previous.get("result") in ("PASS", "FAIL") and
                    previous.get("checks", {}).get("containerStopped") == "PASS" and previous.get("resultDigest") ==
                    digest({key: item for key, item in previous.items() if key != "resultDigest"}), "BROKER_PREVIOUS_OUTCOME_UNCONFIRMED")
    authority, _hash = trusted_json(folder / (request["jobId"] + ".json"), maximum=8192)
    exact(authority, {"version", "scope", "jobId", "profile", "inputDigest", "runtimeProofDigest", "imageId", "issuedAtMs", "expiresAtMs"})
    require(all(authority[key] == request[key] for key in ("version", "scope", "jobId", "profile", "inputDigest")) and
            authority["runtimeProofDigest"] == proof_digest and authority["imageId"] == image_id and
            type(authority["issuedAtMs"]) is int and type(authority["expiresAtMs"]) is int and
            0 <= authority["issuedAtMs"] <= now_ms < authority["expiresAtMs"] <= authority["issuedAtMs"] + 15000,
            "BROKER_ADMISSION_INVALID")
    consumed = folder / (request["jobId"] + ".consumed")
    try:
        fd = os.open(consumed, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        raise Refusal("BROKER_ADMISSION_CONSUMED") from None
    try:
        record = canonical({"state": "INTENT", "scope": request["scope"], "jobId": request["jobId"], "inputDigest": request["inputDigest"],
                            "admissionDigest": digest(authority), "atMs": now_ms})
        require(os.write(fd, record) == len(record), "BROKER_ADMISSION_WRITE_FAILED")
        os.fsync(fd)
        directory_fd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        os.close(fd)
    return consumed


def persist_result(consumed: Path, result: dict) -> None:
    """Append once AFTER exact stop verification; preserve incomplete writes on failure."""
    data = canonical(result)
    require(len(data) <= 8192 and consumed.name == result["jobId"] + ".consumed", "BROKER_RESULT_INVALID")
    target = consumed.with_name(result["jobId"] + ".result.json")
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        require(os.write(fd, data) == len(data), "BROKER_RESULT_WRITE_FAILED")
        os.fsync(fd)
        directory_fd = os.open(consumed.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        os.close(fd)
    saved, _saved_digest = trusted_json(target, maximum=8192)
    require(saved == result, "BROKER_RESULT_WRITE_FAILED")


def read_status(root: Path, request: dict) -> dict:
    """No engine commands, proof refresh, retry or compensation on status reads."""
    folder = root / "candidate-admissions"
    root_private_directory(folder)
    intent, _intent_digest = trusted_json(folder / (request["jobId"] + ".consumed"), maximum=8192)
    require(intent.get("state") == "INTENT" and all(intent.get(key) == request[key] for key in ("scope", "jobId", "inputDigest")),
            "BROKER_STATUS_BINDING_MISMATCH")
    target = folder / (request["jobId"] + ".result.json")
    if target.exists():
        result, _result_digest = trusted_json(target, maximum=8192)
        require(all(result.get(key) == request[key] for key in ("version", "profile", "scope", "jobId", "inputDigest")) and
                result.get("result") in ("PASS", "FAIL") and result.get("checks", {}).get("containerStopped") == "PASS" and
                result.get("resultDigest") == digest({key: value for key, value in result.items() if key != "resultDigest"}),
                "BROKER_STATUS_RECEIPT_INVALID")
        return result
    raise JobUnconfirmed("BROKER_EXECUTION_UNCONFIRMED", request)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--status", action="store_true", help="Read exact admitted job receipt only; never run or retry")
    args = parser.parse_args()
    request = validate_request(parse(read_request(sys.stdin.buffer)))
    profile = json.loads(PROFILE.read_text())
    runtime = Runtime(profile)
    if args.status:
        runtime.host_guard(emergency=True)
        print(canonical(read_status(runtime.root, request)).decode("ascii"))
        return 0
    runtime.host_guard()  # No packages, service start, provisioning or repairs.
    runtime.load()
    require(runtime.state.get("phase") == "OFFLINE_FIXTURE_VERIFIED_NO_ACTIVATION", "BROKER_RUNTIME_UNAVAILABLE")
    runtime.user = pwd.getpwnam(runtime.account)
    require(runtime.user.pw_uid == runtime.state["uid"] and runtime.user.pw_gid == runtime.state["gid"] and
            runtime.user.pw_gecos == COMMENT and runtime.user.pw_dir == str(runtime.home), "BROKER_RUNTIME_IDENTITY_CHANGED")
    proof, proof_digest = trusted_json(runtime.root / "offline-verification.json")
    image_id = proof.get("imageId")
    require(type(image_id) is str, "BROKER_RUNTIME_UNAVAILABLE")
    validate_proof(proof, profile, image_id, int(time.time() * 1000))
    lock = runtime.operation_lock()
    cancelled = threading.Event()
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda _signum, _frame: cancelled.set())
    try:
        before_health = runtime.production_health()
        runtime.engine_checks()
        config, _config_digest = trusted_json(runtime.home / ".config/docker/daemon.json", owner=runtime.user.pw_uid, group=runtime.user.pw_gid)
        require(config == daemon_config(profile, runtime.user.pw_uid), "BROKER_RUNTIME_CONFIG_CHANGED")
        bundle, _bundle_digest = trusted_json(runtime.root / "public-bundle.json")
        require(bundle.get("archiveSha256") == profile["gvisor"]["sha256"], "BROKER_RUNTIME_BINARY_CHANGED")
        base = PUBLIC_RUNTIME_BASE / profile["gvisor"]["version"]
        for relative, expected in bundle["files"].items():
            require(type(relative) is str and ".." not in Path(relative).parts and not Path(relative).is_absolute(), "BROKER_RUNTIME_BINARY_CHANGED")
            path = base / relative
            info = path.lstat()
            require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_gid == 0 and not info.st_mode & 0o022 and
                    bounded_executable_hash(path, profile["gvisor"]["maximumExtractedBytes"]) == expected, "BROKER_RUNTIME_BINARY_CHANGED")
        transport = ProductionTransport(runtime, cancelled.is_set)
        require(not transport.command(["ps", "--quiet"]).strip(), "BROKER_RUNTIME_BUSY")
        image = json.loads(transport.command(["image", "inspect", image_id]))[0]
        require(image["Id"] == image_id and not image["Config"].get("Volumes") and
                image["Config"].get("Labels", {}).get("io.codebandage.offline-runtime-profile") == "python3-stdlib-v1" and
                0 < image["Size"] <= profile["maximumLocalRunnerBytes"], "BROKER_IMAGE_NOT_REVIEWED")
        consumed = consume_admission(runtime.root, request, proof_digest, image_id, int(time.time() * 1000))
        try:
            result = execute(request, profile=profile, image_id=image_id, proof_digest=proof_digest,
                             transport=transport, cancelled=cancelled.is_set)
            runtime.compare_health(before_health)
            persist_result(consumed, result)
        except (Refusal, OSError, ValueError, KeyError, TypeError) as error:
            code = str(error) if isinstance(error, Refusal) else "BROKER_EXECUTION_UNCONFIRMED"
            raise JobUnconfirmed(code, request) from None
        print(canonical(result).decode("ascii"))
        return 0
    finally:
        os.close(lock)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (Refusal, OSError, ValueError, KeyError, TypeError) as error:
        code = str(error) if isinstance(error, Refusal) and re.fullmatch(r"[A-Z][A-Z0-9_:.-]{1,100}", str(error)) else "BROKER_REFUSED"
        result = {"version": 1, "result": "UNCONFIRMED" if isinstance(error, JobUnconfirmed) else "UNAVAILABLE", "code": code, "liveCustomerRepairVerified": False}
        if isinstance(error, JobUnconfirmed):
            result.update({key: error.request[key] for key in ("profile", "scope", "jobId", "inputDigest")})
            result["resultDigest"] = digest(result)
        print(json.dumps(result), flush=True)
        raise SystemExit(1)
