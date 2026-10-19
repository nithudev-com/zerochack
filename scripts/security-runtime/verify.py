#!/usr/bin/env python3
"""Explicit, bounded benign offline-fixture proof; never activates application jobs."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys
import time
import uuid

from provision import COMMENT, PROFILE, PUBLIC_RUNTIME_BASE, Refusal, Runtime, daemon_config, record, regular, require, timestamp

MAX_PROCESS_METADATA_BYTES = 65536
MAX_ID_MAP_ENTRIES = 340
MAX_LINUX_ID = 2**32 - 1  # The all-ones sentinel is deliberately never mapped.


def bounded_executable_hash(path: Path, maximum: int) -> str:
    require(type(maximum) is int and 0 < maximum <= 536870912, 'RUNTIME_EXECUTABLE_SIZE_INVALID')
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= maximum, 'RUNTIME_EXECUTABLE_SIZE_INVALID')
        count = 0
        while True:
            block = stream.read(min(1048576, maximum + 1 - count))
            if not block:
                break
            count += len(block)
            require(count <= maximum, 'RUNTIME_EXECUTABLE_SIZE_INVALID')
            hasher.update(block)
        after = os.fstat(stream.fileno())
        require(before.st_dev == after.st_dev and before.st_ino == after.st_ino and
                before.st_size == count == after.st_size and before.st_mtime_ns == after.st_mtime_ns and
                before.st_ctime_ns == after.st_ctime_ns, 'RUNTIME_EXECUTABLE_CHANGED')
    return hasher.hexdigest()


def validate_process_identity(status: str, uid_map: str, gid_map: str, *,
                              dedicated_uid: int, dedicated_gid: int,
                              subordinate_start: int, subordinate_count: int) -> dict:
    """Validate host-observed sandbox credentials, not the guest Python UID.

    Read from the initial host user namespace: uid_map/gid_map field two is
    therefore a host ID, including for gVisor's nested nobody namespace. Every
    mapping must remain within this dedicated identity's allocated IDs.
    """
    require(all(type(value) is int for value in (dedicated_uid, dedicated_gid, subordinate_start, subordinate_count)) and
            0 < dedicated_uid < MAX_LINUX_ID and 0 < dedicated_gid < MAX_LINUX_ID and
            0 < subordinate_start < MAX_LINUX_ID and 0 < subordinate_count and
            subordinate_start + subordinate_count <= MAX_LINUX_ID and
            not subordinate_start <= dedicated_uid < subordinate_start + subordinate_count and
            not subordinate_start <= dedicated_gid < subordinate_start + subordinate_count,
            "INVALID_DEDICATED_ID_ALLOCATION")
    require(all(isinstance(value, str) and 0 < len(value) <= MAX_PROCESS_METADATA_BYTES and value.isascii()
                for value in (status, uid_map, gid_map)), "INVALID_PROCESS_IDENTITY_METADATA")

    def allowed(start: int, count: int, dedicated: int) -> bool:
        return (start == dedicated and count == 1) or (
            subordinate_start <= start and start + count <= subordinate_start + subordinate_count)

    def mappings(text: str, dedicated: int) -> list[dict]:
        rows = text.splitlines()
        require(0 < len(rows) <= MAX_ID_MAP_ENTRIES, "INVALID_PROCESS_ID_MAP")
        result = []
        for row in rows:
            fields = row.split()
            require(len(fields) == 3 and all(re.fullmatch(r"[0-9]{1,10}", field) for field in fields),
                    "INVALID_PROCESS_ID_MAP")
            inside, host, count = map(int, fields)
            require(count > 0 and inside + count <= MAX_LINUX_ID and host > 0 and host + count <= MAX_LINUX_ID and
                    allowed(host, count, dedicated), "PROCESS_ID_MAP_OUTSIDE_DEDICATED_ALLOCATION")
            for previous in result:
                require((inside + count <= previous["inside"] or previous["inside"] + previous["count"] <= inside) and
                        (host + count <= previous["host"] or previous["host"] + previous["count"] <= host),
                        "OVERLAPPING_PROCESS_ID_MAP")
            result.append({"inside": inside, "host": host, "count": count})
        return result

    maps = {"Uid": mappings(uid_map, dedicated_uid), "Gid": mappings(gid_map, dedicated_gid)}
    credentials = {}
    for kind, dedicated in (("Uid", dedicated_uid), ("Gid", dedicated_gid)):
        rows = [line for line in status.splitlines() if line.startswith(kind + ":")]
        require(len(rows) == 1, "PROCESS_CREDENTIALS_UNAVAILABLE")
        fields = rows[0].split()[1:]
        require(len(fields) == 4 and all(re.fullmatch(r"[0-9]{1,10}", field) for field in fields),
                "INVALID_PROCESS_CREDENTIALS")
        values = [int(field) for field in fields]
        require(len(set(values)) == 1 and all(0 < value < MAX_LINUX_ID and allowed(value, 1, dedicated) and
                any(row["host"] <= value < row["host"] + row["count"] for row in maps[kind]) for value in values),
                "PROCESS_CREDENTIALS_OUTSIDE_VERIFIED_MAP")
        credentials[kind.lower() + "s"] = dict(zip(("real", "effective", "saved", "filesystem"), values))
    return {"processRole": "sandbox-runtime-process-not-guest-python", **credentials,
            "uidMap": maps["Uid"], "gidMap": maps["Gid"]}


def process_identity(proc: Path, *, dedicated_uid: int, dedicated_gid: int,
                     subordinate_start: int, subordinate_count: int) -> dict:
    def bounded(name: str) -> str:
        with (proc / name).open("rb") as stream:
            content = stream.read(MAX_PROCESS_METADATA_BYTES + 1)
        require(0 < len(content) <= MAX_PROCESS_METADATA_BYTES, "PROCESS_IDENTITY_METADATA_LIMIT")
        try:
            return content.decode("ascii")
        except UnicodeDecodeError:
            raise Refusal("INVALID_PROCESS_IDENTITY_METADATA") from None
    return validate_process_identity(bounded("status"), bounded("uid_map"), bounded("gid_map"),
                                     dedicated_uid=dedicated_uid, dedicated_gid=dedicated_gid,
                                     subordinate_start=subordinate_start, subordinate_count=subordinate_count)

PROBE = r'''
import errno,json,os,socket
assert os.getuid()==65532
interfaces=socket.if_nameindex()
assert interfaces and all(name=='lo' for _index,name in interfaces)
with open('/proc/net/route','r',encoding='ascii') as source:
    routes=source.read(8193)
assert len(routes)<=8192
assert all(line.split()[0]=='lo' for line in routes.splitlines()[1:] if line.strip())
assert not os.path.exists('/var/run/docker.sock')
assert not os.path.exists('/opt/codebandage/state')
for path in ['/forbidden-root-write','/tmp/forbidden-write','/dev/shm/forbidden-write']:
    try:
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    except OSError as error:
        assert error.errno in (errno.EROFS,errno.ENOENT,errno.EACCES)
    else:
        os.close(fd)
        raise AssertionError('unexpected writable path')
full=False
try:
    with open('/work/bounded-probe','wb',buffering=0) as output:
        block=b'\0'*(1024*1024)
        for _ in range(65): output.write(block)
except OSError as error:
    assert error.errno==errno.ENOSPC
    full=True
assert full
usage=os.statvfs('/work')
assert usage.f_blocks*usage.f_frsize <= 67108864
os.unlink('/work/bounded-probe')
for target in [('127.0.0.1',22),('198.51.100.1',9)]:
    client=socket.socket()
    client.settimeout(1)
    try:
        client.connect(target)
    except OSError:
        pass
    else:
        raise AssertionError('network-none isolation failed')
    finally:
        client.close()
print(json.dumps({'probe':'offline-runtime-v1','result':'PASS','uid':65532,'rootReadOnly':True,'writableBytes':67108864,'enospcObserved':True,'interfaces':[name for _index,name in interfaces],'nonLoopbackRoutes':0,'networkConnectionsSucceeded':0}))
'''


def verify(runtime: Runtime, image_id: str) -> dict:
    runtime.host_guard()
    runtime.load()
    runtime.user = pwd.getpwnam(runtime.account)
    user = runtime.user
    require(user.pw_uid == runtime.state["uid"] and user.pw_gid == runtime.state["gid"] and user.pw_gecos == COMMENT and
            user.pw_dir == str(runtime.home), "ACCOUNT_IDENTITY_MISMATCH")
    require(re.fullmatch(r"sha256:[a-f0-9]{64}", image_id) is not None, "IMMUTABLE_LOCAL_IMAGE_ID_REQUIRED")
    require(runtime.state["phase"] in ("ROOTLESS_ENGINE_PROVISIONED_UNVERIFIED", "OFFLINE_FIXTURE_VERIFIED_NO_ACTIVATION"), "ENGINE_NOT_PROVISIONED")
    initial_health = runtime.production_health()
    engine = runtime.engine_checks()
    config_path = runtime.home / '.config/docker/daemon.json'
    regular(config_path, user.pw_uid)
    require(json.loads(config_path.read_text()) == daemon_config(runtime.p, user.pw_uid), 'RUNTIME_CONFIGURATION_DRIFT')
    bundle_receipt = runtime.root / 'public-bundle.json'
    regular(bundle_receipt)
    trusted_bundle = json.loads(bundle_receipt.read_text())
    bundle_path = PUBLIC_RUNTIME_BASE / runtime.p['gvisor']['version']
    require(trusted_bundle.get('directory') == str(bundle_path) and
            trusted_bundle.get('archiveSha256') == runtime.p['gvisor']['sha256'], 'RUNTIME_BINARY_PROVENANCE_INVALID')
    require(not runtime.docker(["ps", "--quiet"]).strip(), "RUNTIME_ALREADY_HAS_A_JOB")
    images = set(runtime.docker(["image", "ls", "--quiet", "--no-trunc"]).split())
    require(images == {image_id}, "ONLY_ONE_REVIEWED_LOCAL_IMAGE_ALLOWED")
    image = json.loads(runtime.docker(["image", "inspect", image_id]))[0]
    require(image["Id"] == image_id and 0 < image["Size"] <= runtime.p["maximumLocalRunnerBytes"] and
            image["Config"].get("Labels", {}).get("io.codebandage.offline-runtime-profile") == "python3-stdlib-v1" and
            not image["Config"].get("Volumes"), "IMAGE_PROFILE_OR_SIZE_NOT_REVIEWED")
    runtime.budget()
    name = "codebandage-isolation-proof-" + uuid.uuid4().hex[:12]
    container_id = None
    started = time.monotonic()
    try:
        container_id = runtime.docker([
            "run", "--detach", "--name", name, "--pull=never", "--runtime=runsc-systrap",
            "--label", "io.codebandage.fixture=offline-runtime-proof-v1", "--network=none", "--ipc=none",
            "--read-only", "--user", "65532:65532", "--cap-drop=ALL", "--security-opt=no-new-privileges",
            "--memory", str(runtime.p["jobMemoryBytes"]), "--memory-swap", str(runtime.p["jobMemoryBytes"]),
            "--cpus", runtime.p["jobCpu"], "--pids-limit", str(runtime.p["jobPids"]),
            "--ulimit", "nofile=128:128", "--log-opt", "max-size=1m", "--log-opt", "max-file=2",
            "--tmpfs", "/work:rw,nosuid,nodev,noexec,size=67108864,mode=0700,uid=65532,gid=65532",
            "--env", "TMPDIR=/work", "--entrypoint", "python3", image_id,
            "-c", "import time; time.sleep(120)"], timeout=45).strip()
        require(re.fullmatch(r"[a-f0-9]{64}", container_id) is not None, "INVALID_CREATED_CONTAINER_ID")
        data = json.loads(runtime.docker(["inspect", container_id]))[0]
        host = data["HostConfig"]
        require(data["State"]["Running"] and data["Image"] == image_id and host["Runtime"] == "runsc-systrap" and
                host["ReadonlyRootfs"] and not host["Privileged"] and not host.get("Binds") and
                not host.get("Devices") and not host.get("PortBindings") and host["NetworkMode"] == "none" and
                host["IpcMode"] == "none" and set(host["Tmpfs"]) == {"/work"} and
                all(mount.get("Type") == "tmpfs" and mount.get("Destination") == "/work" for mount in data["Mounts"]),
                "JOB_PROFILE_WAS_NOT_APPLIED")
        pid = int(data["State"]["Pid"])
        require(1 < pid < 2**31, "INVALID_SANDBOX_RUNTIME_PID")
        proc = Path("/proc") / str(pid)
        identity = process_identity(proc, dedicated_uid=user.pw_uid, dedicated_gid=user.pw_gid,
                                    subordinate_start=runtime.p["subordinateIdStart"], subordinate_count=runtime.p["subordinateIdCount"])
        for namespace in ("user", "net"):
            require(os.readlink(proc / "ns" / namespace) != os.readlink(Path("/proc/1/ns") / namespace), "JOB_NAMESPACE_NOT_ISOLATED")
        require(os.readlink(proc / 'ns/net') != os.readlink(Path('/proc') / str(engine['enginePid']) / 'ns/net'),
                'JOB_SHARES_ENGINE_NETWORK_NAMESPACE')
        relative_executable = 'gvisor-bin/gvisor_sentry'
        executable = bundle_path / relative_executable
        regular(executable)
        require(relative_executable in trusted_bundle['files'] and
                executable.stat().st_gid == 0 and stat.S_IMODE(executable.stat().st_mode) == 0o755 and
                bounded_executable_hash(executable, runtime.p['gvisor']['maximumExtractedBytes']) == trusted_bundle['files'][relative_executable] and
                bounded_executable_hash(proc / 'exe', executable.stat().st_size) == trusted_bundle['files'][relative_executable],
                'JOB_RUNTIME_BINARY_CHANGED')
        relative = (proc / "cgroup").read_text().strip()
        require(relative.startswith("0::/user.slice/user-" + str(user.pw_uid) + ".slice/") and
                container_id in relative and ".." not in relative, "JOB_CGROUP_BINDING_NOT_VERIFIED")
        cgroup = Path("/sys/fs/cgroup") / relative.split("::", 1)[1].lstrip("/")
        quota, period = map(int, (cgroup / "cpu.max").read_text().split())
        require(quota > 0 and period > 0 and quota / period <= float(runtime.p["jobCpu"]) and
                int((cgroup / "memory.max").read_text()) == runtime.p["jobMemoryBytes"] and
                int((cgroup / "memory.swap.max").read_text()) == 0 and
                int((cgroup / "pids.max").read_text()) <= runtime.p["jobPids"], "JOB_CGROUP_LIMITS_NOT_ENFORCED")
        output = runtime.docker(["exec", container_id, "python3", "-c", PROBE], timeout=40)
        probe = json.loads(output)
        require(probe.get("result") == "PASS" and probe.get("enospcObserved") is True,
                "JOB_FILESYSTEM_OR_NETWORK_PROBE_FAILED")
        runtime.budget()
        after_health = runtime.compare_health(initial_health)
        engine["jobVerification"] = "PASS"
        result = {"schema": "codebandage-offline-runtime-proof/v1", "at": timestamp(), "result": "PASS",
                  "imageId": image_id, "containerId": container_id, "engine": engine,
                  "hostObservedJobIdentity": {"pid": pid, **identity},
                  "runtimeExecutable": {'relativePath': relative_executable, 'sha256': trusted_bundle['files'][relative_executable]},
                  "hostObservedJobLimits": {"cpu": quota / period, "memoryBytes": runtime.p["jobMemoryBytes"],
                                            "swapBytes": 0, "pids": runtime.p["jobPids"]},
                  "jobProbe": probe, "elapsedSeconds": round(time.monotonic() - started, 3),
                  "healthBefore": initial_health, "healthAfter": after_health,
                  "applicationActivation": False, "liveCustomerWork": "NOT_TESTED",
                  "remainingGates": ["Trusted broker with global concurrency one and bounded admission",
                                     "Host-network, device, mount and arbitrary-image API denials",
                                     "Crash/timeout/restart recovery and tenant isolation adversarial tests",
                                     "Release audits, approved fixture repair and restoration verification"]}
        return result
    finally:
        try:
            if container_id is None:
                # Resolve only our unique name, exact image and fixed fixture label.
                raw = runtime.docker(["inspect", "--format", '{{json .Id}} {{json .Image}} {{index .Config.Labels "io.codebandage.fixture"}}', name], timeout=10, check=False).strip().split()
                if len(raw) == 3 and raw[2] == "offline-runtime-proof-v1" and json.loads(raw[1]) == image_id:
                    resolved = json.loads(raw[0])
                    require(re.fullmatch(r"[a-f0-9]{64}", resolved) is not None, "AMBIGUOUS_PARTIAL_PROBE")
                    container_id = resolved
            if container_id is not None:
                # Only this invocation's exact job; no mutation replay or deletion.
                try:
                    runtime.docker(["stop", "--time", "5", container_id], timeout=15)
                except (Refusal, subprocess.TimeoutExpired, OSError):
                    runtime.docker(['kill', container_id], timeout=10, check=False)
                require(runtime.docker(["inspect", "--format", "{{.State.Running}}", container_id], timeout=10).strip() == "false", "PROBE_DID_NOT_STOP")
        finally:
            record(runtime.root / "health-after-verification.json", runtime.health_evidence())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image-id", required=True)
    parser.add_argument("--benign-fixture-approved", action="store_true")
    args = parser.parse_args()
    require(args.benign_fixture_approved, "EXPLICIT_BENIGN_FIXTURE_APPROVAL_REQUIRED")
    runtime = Runtime(json.loads(PROFILE.read_text()))
    runtime.host_guard()
    lock = runtime.operation_lock()
    try:
        result = verify(runtime, args.image_id)
        record(runtime.root / "offline-verification.json", result)
        runtime.save("OFFLINE_FIXTURE_VERIFIED_NO_ACTIVATION")
        print(json.dumps({"result": "OFFLINE_FIXTURE_VERIFIED_NO_ACTIVATION", "imageId": args.image_id, "applicationActivation": False}))
    except Exception:
        if runtime.state:
            record(runtime.root / "offline-verification-failure.json", {"at": timestamp(), "result": "FAILED", "applicationActivation": False})
            runtime.save("VERIFICATION_FAILED_REVIEW_REQUIRED")
        raise
    finally:
        os.close(lock)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (Refusal, subprocess.TimeoutExpired, OSError, ValueError, KeyError) as error:
        detail = str(error) if isinstance(error, Refusal) else type(error).__name__
        print(json.dumps({"result": "REFUSED", "reason": detail, "applicationActivation": False}), file=sys.stderr)
        raise SystemExit(1)
