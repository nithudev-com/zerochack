#!/usr/bin/python3
"""Unregistered managed-static fixture helper. No shell, model path, or SFTP mutation.

Only a trusted provisioner may create the fresh namespace described in README.md.
Mount/UID checks constrain that deployment; they cannot attest a hostile host root.
"""
import base64
import fcntl
import hashlib
import hmac
import json
import os
import re
import secrets
import signal
import stat
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager

MAX_FILE = 200000
MAX_REQUEST = 32768
MAX_RECORD = 32768
MAX_RECOVERY = 524288
MAX_OPERATIONS = 16
MAX_RECONCILIATIONS = 16
ADAPTER = "MANAGED_STATIC_PERMISSION_V1"
RECONCILIATION_PURPOSE = "OBSERVATION_RECONCILIATION_V1"
PROFILE_DIGEST = hashlib.sha256(b"codebandage/managed-static-v1/fresh-root0700/site0755/index.html/root-owner/readonly-publisher/one-helper/no-docker-socket").hexdigest()
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
HEX = re.compile(r"^[0-9a-f]{64}$")
DECIMAL = re.compile(r"^(0|[1-9][0-9]{0,23})$")
BASE = {"version", "command", "scope", "namespaceId", "targetId"}
NOFOLLOW = os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
CODEC = ("/usr/local/bin/node", "--max-old-space-size=64", "/opt/managed-target/recovery-codec.cjs")


class Refused(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def require(condition, code="MANAGED_TARGET_INVALID"):
    if not condition:
        raise Refused(code)


def canonical(value):
    nodes = 0
    ancestors = set()
    def bounded(item, depth):
        nonlocal nodes
        nodes += 1
        require(nodes <= 512 and depth <= 12)
        if item is None or type(item) is bool:
            return
        if type(item) is int:
            require(abs(item) <= 9007199254740991)
            return
        if isinstance(item, str):
            require(len(item) <= 600000 and all(0x20 <= ord(char) <= 0x7e for char in item))
            return
        require(type(item) in (dict, list) and id(item) not in ancestors)
        ancestors.add(id(item))
        require(len(item) <= 64)
        if isinstance(item, dict):
            for key, child in item.items():
                require(isinstance(key, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9]{0,63}", key))
                bounded(child, depth + 1)
        else:
            for child in item:
                bounded(child, depth + 1)
        ancestors.remove(id(item))
    bounded(value, 0)
    encoded = json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("ascii")
    require(len(encoded) <= 786432)
    return encoded


def load_json(encoded):
    def pairs(values):
        result = {}
        for key, value in values:
            require(key not in result)
            result[key] = value
        return result
    def invalid_number(_value):
        raise Refused("MANAGED_TARGET_INVALID")
    result = json.loads(encoded, object_pairs_hook=pairs, parse_float=invalid_number, parse_constant=invalid_number)
    canonical(result)
    return result


def digest(value):
    return hashlib.sha256(value).hexdigest()


def exact_keys(value, keys):
    require(isinstance(value, dict) and set(value) == set(keys))


def uuid(value):
    require(isinstance(value, str) and UUID.fullmatch(value))


def hex_digest(value):
    require(isinstance(value, str) and HEX.fullmatch(value))


def scope(value):
    exact_keys(value, ("tenantId", "websiteId", "environment", "runId"))
    for key in ("tenantId", "websiteId", "runId"):
        uuid(value[key])
    require(value["environment"] == "STAGING", "UNREGISTERED_SECURITY_EXECUTOR")
    return value


def snapshot(value):
    exact_keys(value, ("device", "inode", "uid", "gid", "mode", "size", "mtimeNs", "ctimeNs", "digest"))
    for key in ("device", "inode", "mtimeNs", "ctimeNs"):
        require(isinstance(value[key], str) and DECIMAL.fullmatch(value[key]))
    for key in ("uid", "gid", "mode", "size"):
        require(type(value[key]) is int and 0 <= value[key] <= 9007199254740991)
    require(value["uid"] == 0 and value["gid"] == 0 and value["size"] <= MAX_FILE)
    require(value["mode"] & ~0o666 == 0 and value["mode"] & 0o604 == 0o604)
    hex_digest(value["digest"])
    return value


def validate_request(request):
    require(isinstance(request, dict))
    command = request.get("command")
    extras = {
        "OBSERVE": set(), "STATUS": {"operationId"},
        "PREPARE": {"operationId", "action", "planDigest", "authorityDigest", "expectedSnapshot"},
        "COMMIT": {"operationId", "permit"},
        "RECONCILE_OBSERVE": {"operationId", "reconciliationId"},
        "RECONCILE": {"operationId", "observation", "permit"},
        "RECONCILIATION_STATUS": {"operationId", "reconciliationId"},
    }
    require(command in extras)
    expected = BASE | extras[command]
    if command == "PREPARE" and request.get("action") == "RESTORE":
        expected |= {"recoveryOperationId"}
        uuid(request.get("recoveryOperationId"))
    exact_keys(request, expected)
    require(type(request["version"]) is int and request["version"] == 1)
    scope(request["scope"])
    uuid(request["namespaceId"])
    uuid(request["targetId"])
    if command != "OBSERVE":
        uuid(request["operationId"])
    if command == "PREPARE":
        require(request["action"] in ("HARDEN", "RESTORE"))
        hex_digest(request["planDigest"])
        hex_digest(request["authorityDigest"])
        snapshot(request["expectedSnapshot"])
    if command in ("RECONCILE_OBSERVE", "RECONCILIATION_STATUS"):
        uuid(request["reconciliationId"])
        require(request["reconciliationId"] != request["operationId"])
    if command == "RECONCILE":
        validate_reconciliation_observation(request["observation"])
    return request


def permit_payload(record, issued_at, expires_at):
    return {"version": 1, "adapter": ADAPTER, "scope": record["scope"], "namespaceId": record["namespaceId"],
            "targetId": record["targetId"], "operationId": record["operationId"], "action": record["action"],
            "planDigest": record["planDigest"], "authorityDigest": record["authorityDigest"],
            "snapshotDigest": record["snapshotDigest"], "recoveryDigest": record["recoveryDigest"],
            "targetMode": record["targetMode"], "challenge": record["challenge"], "issuedAt": issued_at, "expiresAt": expires_at}


def verify_permit(permit, record, key, now_ms):
    exact_keys(permit, ("payload", "mac"))
    payload = permit["payload"]
    require(isinstance(payload, dict))
    issued = payload.get("issuedAt")
    expires = payload.get("expiresAt")
    require(type(issued) is int and type(expires) is int and issued <= now_ms < expires and 0 < expires - issued <= 15000,
            "MANAGED_AUTHORIZATION_EXPIRED")
    require(issued >= record["preparedAt"] and canonical(payload) == canonical(permit_payload(record, issued, expires)),
            "MANAGED_AUTHORIZATION_MISMATCH")
    hex_digest(permit["mac"])
    require(hmac.compare_digest(hmac.new(key, canonical(payload), hashlib.sha256).hexdigest(), permit["mac"]),
            "MANAGED_AUTHORIZATION_MISMATCH")


def validate_record(value):
    require(isinstance(value, dict), "MANAGED_JOURNAL_INVALID")
    state = value.get("state")
    require(state in ("PREPARED", "INTENT", "VERIFIED", "OUTCOME_UNKNOWN"), "MANAGED_JOURNAL_INVALID")
    fields = {"version", "state", "operationId", "scope", "namespaceId", "targetId", "action", "planDigest", "authorityDigest",
              "before", "snapshotDigest", "targetMode", "challenge", "preparedAt", "recoveryDigest"}
    if value.get("action") == "RESTORE":
        fields.add("recoveryOperationId")
        uuid(value.get("recoveryOperationId"))
    if state != "PREPARED":
        fields.add("permitDigest")
        hex_digest(value.get("permitDigest"))
    if state == "VERIFIED" or (state == "OUTCOME_UNKNOWN" and "after" in value):
        fields |= {"after", "verifiedAt"}
        snapshot(value.get("after"))
        require(type(value.get("verifiedAt")) is int and 0 <= value["verifiedAt"] <= 9007199254740991, "MANAGED_JOURNAL_INVALID")
        require(value["after"] == dict(value["before"], mode=value["targetMode"], ctimeNs=value["after"]["ctimeNs"]),
                "MANAGED_JOURNAL_INVALID")
    exact_keys(value, fields)
    require(type(value["version"]) is int and value["version"] == 1, "MANAGED_JOURNAL_INVALID")
    scope(value["scope"])
    for key in ("operationId", "namespaceId", "targetId"):
        uuid(value[key])
    for key in ("planDigest", "authorityDigest", "snapshotDigest", "recoveryDigest", "challenge"):
        hex_digest(value[key])
    snapshot(value["before"])
    require(value["snapshotDigest"] == digest(canonical(value["before"])) and
            type(value["preparedAt"]) is int and 0 <= value["preparedAt"] <= 9007199254740991,
            "MANAGED_JOURNAL_INVALID")
    require(value["action"] in ("HARDEN", "RESTORE") and type(value["targetMode"]) is int, "MANAGED_JOURNAL_INVALID")
    expected_mode = value["before"]["mode"] & ~0o002 if value["action"] == "HARDEN" else value["before"]["mode"] | 0o002
    require(value["targetMode"] == expected_mode and value["targetMode"] != value["before"]["mode"], "MANAGED_JOURNAL_INVALID")
    return value


def classify_observation(before, target_mode, current):
    # These are snapshot relationships, never claims about whether fchmod ran.
    if current == before:
        return "MATCHES_BEFORE"
    if current == dict(before, mode=target_mode, ctimeNs=current["ctimeNs"]):
        return "MATCHES_EXPECTED_POSTIMAGE"
    return "DRIFT"


def validate_reconciliation_observation(value):
    exact_keys(value, ("version", "adapter", "state", "scope", "namespaceId", "targetId", "operationId", "reconciliationId",
                       "sourceState", "sourceDigest", "sourceSnapshotDigest", "recoveryDigest", "action", "targetMode", "before",
                       "current", "currentSnapshotDigest", "classification", "observedAt", "challenge"))
    require(type(value["version"]) is int and value["version"] == 1 and value["adapter"] == ADAPTER and
            value["state"] == "RECONCILIATION_OBSERVED", "MANAGED_RECONCILIATION_INVALID")
    scope(value["scope"])
    for field in ("namespaceId", "targetId", "operationId", "reconciliationId"):
        uuid(value[field])
    require(value["reconciliationId"] != value["operationId"] and value["sourceState"] in ("INTENT", "OUTCOME_UNKNOWN"),
            "MANAGED_RECONCILIATION_INVALID")
    for field in ("sourceDigest", "sourceSnapshotDigest", "recoveryDigest", "currentSnapshotDigest", "challenge"):
        hex_digest(value[field])
    snapshot(value["before"])
    snapshot(value["current"])
    require(value["action"] in ("HARDEN", "RESTORE") and type(value["targetMode"]) is int,
            "MANAGED_RECONCILIATION_INVALID")
    target_mode = value["before"]["mode"] & ~0o002 if value["action"] == "HARDEN" else value["before"]["mode"] | 0o002
    require(value["targetMode"] == target_mode and target_mode != value["before"]["mode"] and
            value["sourceSnapshotDigest"] == digest(canonical(value["before"])) and
            value["currentSnapshotDigest"] == digest(canonical(value["current"])) and
            value["classification"] == classify_observation(value["before"], target_mode, value["current"]) and
            type(value["observedAt"]) is int and 0 <= value["observedAt"] <= 9007199254740991,
            "MANAGED_RECONCILIATION_INVALID")
    return value


def reconciliation_payload(observation, issued_at, expires_at):
    return {"version": 1, "adapter": ADAPTER, "purpose": RECONCILIATION_PURPOSE, "scope": observation["scope"],
            "namespaceId": observation["namespaceId"], "targetId": observation["targetId"], "operationId": observation["operationId"],
            "reconciliationId": observation["reconciliationId"], "observationDigest": digest(canonical(observation)),
            "sourceDigest": observation["sourceDigest"], "currentSnapshotDigest": observation["currentSnapshotDigest"],
            "issuedAt": issued_at, "expiresAt": expires_at}


def verify_reconciliation_permit(permit, observation, key, now_ms):
    exact_keys(permit, ("payload", "mac"))
    require(isinstance(permit["payload"], dict), "MANAGED_RECONCILIATION_AUTHORIZATION_MISMATCH")
    issued = permit["payload"].get("issuedAt")
    expires = permit["payload"].get("expiresAt")
    require(type(issued) is int and type(expires) is int and
            observation["observedAt"] <= issued <= now_ms < expires <= observation["observedAt"] + 15000,
            "MANAGED_RECONCILIATION_AUTHORIZATION_EXPIRED")
    require(canonical(permit["payload"]) == canonical(reconciliation_payload(observation, issued, expires)),
            "MANAGED_RECONCILIATION_AUTHORIZATION_MISMATCH")
    hex_digest(permit["mac"])
    require(hmac.compare_digest(hmac.new(key, canonical(permit["payload"]), hashlib.sha256).hexdigest(), permit["mac"]),
            "MANAGED_RECONCILIATION_AUTHORIZATION_MISMATCH")


def validate_reconciliation_receipt(value):
    exact_keys(value, ("version", "adapter", "state", "observation", "permitDigest", "recordedAt", "receiptDigest"))
    require(type(value["version"]) is int and value["version"] == 1 and value["adapter"] == ADAPTER and
            value["state"] == "RECONCILED_OBSERVATION_ONLY", "MANAGED_RECONCILIATION_INVALID")
    validate_reconciliation_observation(value["observation"])
    hex_digest(value["permitDigest"])
    hex_digest(value["receiptDigest"])
    require(type(value["recordedAt"]) is int and value["observation"]["observedAt"] <= value["recordedAt"] <= 9007199254740991 and
            value["receiptDigest"] == digest(canonical({key: child for key, child in value.items() if key != "receiptDigest"})),
            "MANAGED_RECONCILIATION_INVALID")
    return value


def read_fd(fd, limit):
    before = os.fstat(fd)
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= limit,
            "MANAGED_STORAGE_INVALID")
    os.lseek(fd, 0, os.SEEK_SET)
    chunks = []
    count = 0
    while count <= limit:
        block = os.read(fd, min(65536, limit + 1 - count))
        if not block:
            break
        count += len(block)
        chunks.append(block)
    require(count <= limit, "MANAGED_STORAGE_LIMIT")
    after = os.fstat(fd)
    require((before.st_dev, before.st_ino, before.st_nlink, before.st_mode, before.st_uid, before.st_gid,
             before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
            (after.st_dev, after.st_ino, after.st_nlink, after.st_mode, after.st_uid, after.st_gid,
             after.st_size, after.st_mtime_ns, after.st_ctime_ns), "MANAGED_TARGET_DRIFT")
    return b"".join(chunks), after


def checked_file(directory, name, limit, mode=0o600):
    fd = os.open(name, os.O_RDONLY | NOFOLLOW, dir_fd=directory)
    try:
        info = os.fstat(fd)
        require(info.st_uid == 0 and info.st_gid == 0 and stat.S_IMODE(info.st_mode) == mode,
                "MANAGED_STORAGE_INVALID")
        return read_fd(fd, limit)[0]
    finally:
        os.close(fd)


def same_identity(info, expected, mode):
    return (stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and info.st_gid == 0 and
            stat.S_IMODE(info.st_mode) == mode and str(info.st_dev) == expected["device"] and
            str(info.st_ino) == expected["inode"])


def check_mounts():
    # Exact mount points, not an arbitrary path guessed to be inside a protected mount.
    with open("/proc/self/mountinfo", "r", encoding="ascii") as source:
        lines = source.read(131073)
    require(len(lines) <= 131072, "MANAGED_PROFILE_INVALID")
    mounts = {}
    for line in lines.splitlines():
        left, separator, right = line.partition(" - ")
        fields = left.split()
        if separator and len(fields) >= 6:
            mounts[fields[4]] = (set(fields[5].split(",")), fields[6:], right.split())
    for path, access in (("/managed", "rw"), ("/managed-state", "rw"), ("/run/managed-target", "ro")):
        require(path in mounts and access in mounts[path][0], "MANAGED_PROFILE_INVALID")
        require(not any(field.startswith(("shared:", "master:", "propagate_from:")) for field in mounts[path][1]),
                "MANAGED_PROFILE_INVALID")
        # Nested mounts could publish a different inode or hide an unaccounted writer.
        require(not any(key.startswith(path + "/") for key in mounts), "MANAGED_PROFILE_INVALID")
        if path in ("/managed", "/managed-state"):
            require(mounts[path][2] and mounts[path][2][0] in ("ext4", "xfs"), "MANAGED_PROFILE_INVALID")
    with open("/proc/self/status", "r", encoding="ascii") as source:
        status = source.read(16384)
    require(re.search(r"^CapEff:\s+0+$", status, re.M) and re.search(r"^NoNewPrivs:\s+1$", status, re.M),
            "MANAGED_PROFILE_INVALID")


class ManagedTarget:
    def __init__(self):
        require(os.getuid() == 0 and os.geteuid() == 0, "MANAGED_PROFILE_INVALID")
        check_mounts()
        self.fds = []
        self.intent_started = False
        self.receipt_started = False
        self.record = None
        try:
            self.config = self.open_directory("/run/managed-target", 0o700)
            self.manifest = load_json(checked_file(self.config, "manifest.json", 16384, 0o400))
            exact_keys(self.manifest, ("version", "adapter", "namespaceId", "targetId", "scope", "profileDigest",
                                       "root", "site", "state", "target"))
            require(self.manifest["version"] == 1 and self.manifest["adapter"] == ADAPTER and
                    self.manifest["profileDigest"] == PROFILE_DIGEST, "MANAGED_PROFILE_INVALID")
            for key in ("namespaceId", "targetId"):
                uuid(self.manifest[key])
            exact_keys(self.manifest["scope"], ("tenantId", "websiteId", "environment"))
            require(self.manifest["scope"]["environment"] == "STAGING", "UNREGISTERED_SECURITY_EXECUTOR")
            uuid(self.manifest["scope"]["tenantId"])
            uuid(self.manifest["scope"]["websiteId"])
            for key in ("root", "site", "state", "target"):
                exact_keys(self.manifest[key], ("device", "inode"))
                require(all(isinstance(value, str) and DECIMAL.fullmatch(value) for value in self.manifest[key].values()))
            self.root = self.open_directory("/managed", 0o700)
            self.state = self.open_directory("/managed-state", 0o700)
            self.site = self.open_directory("site", 0o755, self.root)
            require(same_identity(os.fstat(self.root), self.manifest["root"], 0o700) and
                    same_identity(os.fstat(self.state), self.manifest["state"], 0o700) and
                    same_identity(os.fstat(self.site), self.manifest["site"], 0o755), "MANAGED_PROFILE_INVALID")
            require(os.fstat(self.root).st_dev == os.fstat(self.site).st_dev, "MANAGED_PROFILE_INVALID")
            self.key = checked_file(self.config, "permit.key", 32, 0o400)
            recovery_key = checked_file(self.config, "recovery.key", 32, 0o400)
            require(len(self.key) == 32 and len(recovery_key) == 32 and not hmac.compare_digest(self.key, recovery_key),
                    "MANAGED_PROFILE_INVALID")
            self.lock = os.open("lock", os.O_RDWR | NOFOLLOW, dir_fd=self.state)
            self.fds.append(self.lock)
            info = os.fstat(self.lock)
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size == 0 and
                    info.st_uid == 0 and info.st_gid == 0 and stat.S_IMODE(info.st_mode) == 0o600,
                    "MANAGED_STORAGE_INVALID")
        except BaseException:
            self.close()
            raise

    def open_directory(self, path, mode, parent=None):
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=parent)
        self.fds.append(fd)
        info = os.fstat(fd)
        require(info.st_uid == 0 and info.st_gid == 0 and stat.S_IMODE(info.st_mode) == mode,
                "MANAGED_PROFILE_INVALID")
        return fd

    def close(self):
        for fd in reversed(self.fds):
            os.close(fd)
        self.fds.clear()

    @contextmanager
    def serialized(self):
        deadline = time.monotonic() + 0.25
        while True:
            try:
                fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                require(time.monotonic() < deadline, "MANAGED_BUSY")
                time.sleep(0.01)
        try:
            yield
        finally:
            fcntl.flock(self.lock, fcntl.LOCK_UN)

    def assert_binding(self, request):
        require(request["namespaceId"] == self.manifest["namespaceId"] and request["targetId"] == self.manifest["targetId"] and
                all(request["scope"][key] == value for key, value in self.manifest["scope"].items()), "MANAGED_SCOPE_MISMATCH")
        require(same_identity(os.fstat(self.root), self.manifest["root"], 0o700) and
                same_identity(os.fstat(self.state), self.manifest["state"], 0o700) and
                same_identity(os.fstat(self.site), self.manifest["site"], 0o755), "MANAGED_PROFILE_INVALID")
        info = os.stat("site", dir_fd=self.root, follow_symlinks=False)
        require(same_identity(info, self.manifest["site"], 0o755), "MANAGED_PROFILE_INVALID")

    @contextmanager
    def target(self):
        fd = os.open("index.html", os.O_RDONLY | NOFOLLOW, dir_fd=self.site)
        try:
            yield fd
        finally:
            os.close(fd)

    def observe(self, fd):
        initial = os.fstat(fd)
        require(stat.S_ISREG(initial.st_mode) and initial.st_nlink == 1 and initial.st_uid == 0 and initial.st_gid == 0 and
                initial.st_dev == os.fstat(self.root).st_dev and str(initial.st_dev) == self.manifest["target"]["device"] and
                str(initial.st_ino) == self.manifest["target"]["inode"], "MANAGED_TARGET_DRIFT")
        data, info = read_fd(fd, MAX_FILE)
        named = os.stat("index.html", dir_fd=self.site, follow_symlinks=False)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 0 and info.st_gid == 0 and
                str(info.st_dev) == self.manifest["target"]["device"] and str(info.st_ino) == self.manifest["target"]["inode"] and
                named.st_dev == info.st_dev and named.st_ino == info.st_ino and named.st_nlink == 1 and
                not stat.S_ISLNK(named.st_mode), "MANAGED_TARGET_DRIFT")
        value = {"device": str(info.st_dev), "inode": str(info.st_ino), "uid": info.st_uid, "gid": info.st_gid,
                 "mode": stat.S_IMODE(info.st_mode), "size": info.st_size, "mtimeNs": str(info.st_mtime_ns),
                 "ctimeNs": str(info.st_ctime_ns), "digest": digest(data)}
        snapshot(value)
        return value, data

    def atomic_write(self, name, data):
        require(len(data) <= MAX_RECOVERY and re.fullmatch(r"[0-9a-f-]{36}\.(json|recovery)", name), "MANAGED_STORAGE_INVALID")
        temporary = ".pending-" + secrets.token_hex(16)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600, dir_fd=self.state)
        try:
            offset = 0
            while offset < len(data):
                written = os.write(fd, data[offset:])
                require(written > 0, "MANAGED_STORAGE_INVALID")
                offset += written
            os.fsync(fd)
            os.close(fd)
            fd = None
            os.replace(temporary, name, src_dir_fd=self.state, dst_dir_fd=self.state)
            os.fsync(self.state)
        finally:
            if fd is not None:
                os.close(fd)
            try:
                os.unlink(temporary, dir_fd=self.state)
            except FileNotFoundError:
                pass

    def record_for(self, operation_id):
        uuid(operation_id)
        value = load_json(checked_file(self.state, operation_id + ".json", MAX_RECORD))
        validate_record(value)
        require(value["operationId"] == operation_id,
                "MANAGED_JOURNAL_INVALID")
        self.assert_binding(value)
        return value

    def journal(self, record):
        validate_record(record)
        data = canonical(record)
        require(len(data) <= MAX_RECORD, "MANAGED_STORAGE_LIMIT")
        self.atomic_write(record["operationId"] + ".json", data)

    def check_journal(self, admitting=False):
        names = os.listdir(self.state)
        self.check_storage_names(names)
        records = [self.record_for(name[:-5]) for name in names if name.endswith(".json")]
        require(not any(record.get("state") in ("INTENT", "OUTCOME_UNKNOWN") for record in records), "MANAGED_UNRESOLVED_OPERATION")
        require(len(records) <= MAX_OPERATIONS and (not admitting or len(records) < MAX_OPERATIONS), "MANAGED_STORAGE_LIMIT")

    def check_storage_names(self, names):
        require(len(names) <= MAX_OPERATIONS * 2 + MAX_RECONCILIATIONS + 1 and
                all(name == "lock" or re.fullmatch(r"[0-9a-f-]{36}\.(json|recovery|reconciliation)", name) for name in names) and
                sum(name.endswith(".reconciliation") for name in names) <= MAX_RECONCILIATIONS,
                "MANAGED_STORAGE_LIMIT")

    def admit_reconciliation(self, reconciliation_id):
        names = os.listdir(self.state)
        self.check_storage_names(names)
        require(reconciliation_id + ".reconciliation" not in names, "MANAGED_RECONCILIATION_EXISTS")
        require(sum(name.endswith(".reconciliation") for name in names) < MAX_RECONCILIATIONS, "MANAGED_STORAGE_LIMIT")

    def append_reconciliation(self, receipt):
        validate_reconciliation_receipt(receipt)
        encoded = canonical(receipt)
        require(len(encoded) <= MAX_RECORD, "MANAGED_STORAGE_LIMIT")
        name = receipt["observation"]["reconciliationId"] + ".reconciliation"
        # Never replace or reset an existing receipt. An interrupted partial receipt is
        # retained and refused by STATUS; only separately reviewed recovery may address it.
        self.receipt_started = True
        try:
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600, dir_fd=self.state)
        except FileExistsError:
            raise Refused("MANAGED_RECONCILIATION_EXISTS") from None
        try:
            offset = 0
            while offset < len(encoded):
                written = os.write(fd, encoded[offset:])
                require(written > 0, "MANAGED_STORAGE_INVALID")
                offset += written
            os.fsync(fd)
            os.fsync(self.state)
        finally:
            os.close(fd)

    def reconciliation_for(self, reconciliation_id):
        uuid(reconciliation_id)
        receipt = validate_reconciliation_receipt(load_json(checked_file(self.state, reconciliation_id + ".reconciliation", MAX_RECORD)))
        observation = receipt["observation"]
        require(observation["reconciliationId"] == reconciliation_id, "MANAGED_RECONCILIATION_INVALID")
        self.assert_binding(observation)
        return receipt

    def reconciliation_observation(self, record, current, reconciliation_id, observed_at=None, challenge=None):
        require(record["state"] in ("INTENT", "OUTCOME_UNKNOWN"), "MANAGED_RECONCILIATION_NOT_APPLICABLE")
        result = {"version": 1, "adapter": ADAPTER, "state": "RECONCILIATION_OBSERVED", "scope": record["scope"],
                  "namespaceId": record["namespaceId"], "targetId": record["targetId"], "operationId": record["operationId"],
                  "reconciliationId": reconciliation_id, "sourceState": record["state"], "sourceDigest": digest(canonical(record)),
                  "sourceSnapshotDigest": record["snapshotDigest"], "recoveryDigest": record["recoveryDigest"], "action": record["action"],
                  "targetMode": record["targetMode"], "before": record["before"], "current": current,
                  "currentSnapshotDigest": digest(canonical(current)),
                  "classification": classify_observation(record["before"], record["targetMode"], current),
                  "observedAt": int(time.time() * 1000) if observed_at is None else observed_at,
                  "challenge": secrets.token_hex(32) if challenge is None else challenge}
        return validate_reconciliation_observation(result)

    def inspect_reconciliation(self, request):
        self.admit_reconciliation(request["reconciliationId"])
        record = self.record_for(request["operationId"])
        require(record["scope"] == request["scope"], "MANAGED_SCOPE_MISMATCH")
        require(record["state"] in ("INTENT", "OUTCOME_UNKNOWN"), "MANAGED_RECONCILIATION_NOT_APPLICABLE")
        self.verify_recovery(record)
        with self.target() as fd:
            current, _data = self.observe(fd)
            return self.reconciliation_observation(record, current, request["reconciliationId"])

    def reconcile(self, request):
        observation = request["observation"]
        require(observation["scope"] == request["scope"] and observation["operationId"] == request["operationId"] and
                observation["namespaceId"] == request["namespaceId"] and observation["targetId"] == request["targetId"],
                "MANAGED_SCOPE_MISMATCH")
        self.admit_reconciliation(observation["reconciliationId"])
        record = self.record_for(request["operationId"])
        require(record["scope"] == request["scope"], "MANAGED_SCOPE_MISMATCH")
        verify_reconciliation_permit(request["permit"], observation, self.key, int(time.time() * 1000))
        self.verify_recovery(record)
        with self.target() as fd:
            current, _data = self.observe(fd)
            expected = self.reconciliation_observation(record, current, observation["reconciliationId"],
                                                       observation["observedAt"], observation["challenge"])
            require(expected == observation, "MANAGED_RECONCILIATION_STALE")
            self.assert_binding(request)
            # Current state must still match immediately before recording observation.
            require(self.observe(fd)[0] == current, "MANAGED_RECONCILIATION_STALE")
            now_ms = int(time.time() * 1000)
            verify_reconciliation_permit(request["permit"], observation, self.key, now_ms)
            receipt = {"version": 1, "adapter": ADAPTER, "state": "RECONCILED_OBSERVATION_ONLY", "observation": observation,
                       "permitDigest": digest(canonical(request["permit"])), "recordedAt": now_ms}
            receipt["receiptDigest"] = digest(canonical(receipt))
            self.append_reconciliation(receipt)
            require(self.reconciliation_for(observation["reconciliationId"]) == receipt, "MANAGED_RECONCILIATION_INVALID")
            # No journal rewrite, mutation, replay admission or recovery admission.
            return receipt

    def codec(self, mode, value):
        require(mode in ("seal", "verify"))
        data = canonical(value)
        require(len(data) <= 786432, "MANAGED_RECOVERY_INVALID")
        # Output goes to bounded private regular files, not an unbounded PIPE buffer.
        with tempfile.TemporaryFile(dir="/managed-state") as output, tempfile.TemporaryFile(dir="/managed-state") as errors:
            def child_limits():
                import resource
                resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_RECOVERY, MAX_RECOVERY))
                resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
            child = subprocess.Popen(CODEC + (mode,), stdin=subprocess.PIPE, stdout=output, stderr=errors,
                                     shell=False, close_fds=True, start_new_session=True, preexec_fn=child_limits,
                                     env={"PATH": "/usr/local/bin:/usr/bin", "NODE_OPTIONS": ""})
            try:
                child.communicate(data, timeout=9)
                require(child.returncode == 0, "MANAGED_RECOVERY_INVALID")
                output.seek(0)
                encoded = output.read(MAX_RECOVERY + 1)
                require(len(encoded) <= MAX_RECOVERY, "MANAGED_RECOVERY_INVALID")
                return load_json(encoded)
            finally:
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=2)

    def recovery_aad(self, record):
        return {"protocol": 1, "namespaceId": record["namespaceId"], "targetId": record["targetId"],
                "operationId": record["operationId"], "scope": record["scope"], "snapshotDigest": record["snapshotDigest"]}

    def verify_recovery(self, record):
        encoded = checked_file(self.state, record["operationId"] + ".recovery", MAX_RECOVERY)
        require(digest(encoded) == record["recoveryDigest"], "MANAGED_RECOVERY_INVALID")
        result = self.codec("verify", {"envelope": load_json(encoded), "expectedAad": self.recovery_aad(record),
                                       "expectedSnapshot": record["before"]})
        require(result == {"verified": True, "snapshotDigest": record["snapshotDigest"], "digest": record["before"]["digest"]},
                "MANAGED_RECOVERY_INVALID")

    def prepare(self, request):
        self.check_journal(admitting=True)
        operation_id = request["operationId"]
        require(not any(name in os.listdir(self.state) for name in (operation_id + ".json", operation_id + ".recovery")),
                "MANAGED_OPERATION_EXISTS")
        with self.target() as fd:
            before, data = self.observe(fd)
            require(before == request["expectedSnapshot"], "MANAGED_TARGET_DRIFT")
            if request["action"] == "HARDEN":
                require(before["mode"] & 0o002, "MANAGED_NOT_APPLICABLE")
                target_mode = before["mode"] & ~0o002
            else:
                original = self.record_for(request["recoveryOperationId"])
                require(original["state"] == "VERIFIED" and original["action"] == "HARDEN" and original["scope"] == request["scope"] and
                        original["after"] == before, "MANAGED_RESTORE_MISMATCH")
                self.verify_recovery(original)
                target_mode = original["before"]["mode"]
                require(target_mode == before["mode"] | 0o002, "MANAGED_RESTORE_MISMATCH")
            record = {"version": 1, "state": "PREPARED", "operationId": operation_id, "scope": request["scope"],
                      "namespaceId": request["namespaceId"], "targetId": request["targetId"], "action": request["action"],
                      "planDigest": request["planDigest"], "authorityDigest": request["authorityDigest"], "before": before,
                      "snapshotDigest": digest(canonical(before)), "targetMode": target_mode, "challenge": secrets.token_hex(32),
                      "preparedAt": int(time.time() * 1000)}
            if request["action"] == "RESTORE":
                record["recoveryOperationId"] = request["recoveryOperationId"]
            envelope = self.codec("seal", {"aad": self.recovery_aad(record), "snapshot": before,
                                            "bytes": base64.b64encode(data).decode("ascii")})
            encoded = canonical(envelope)
            self.atomic_write(operation_id + ".recovery", encoded)
            record["recoveryDigest"] = digest(encoded)
            self.verify_recovery(record)
            require(self.observe(fd)[0] == before, "MANAGED_TARGET_DRIFT")
            self.journal(record)
            return self.public_record(record)

    def commit(self, request):
        record = self.record_for(request["operationId"])
        require(record["scope"] == request["scope"], "MANAGED_SCOPE_MISMATCH")
        require(record["state"] == "PREPARED", "MANAGED_REPLAY_REFUSED")
        # No mutation may start while another operation has an uncertain result.
        self.check_journal()
        verify_permit(request["permit"], record, self.key, int(time.time() * 1000))
        self.verify_recovery(record)
        with self.target() as fd:
            require(self.observe(fd)[0] == record["before"], "MANAGED_TARGET_DRIFT")
            self.assert_binding(request)
            # Re-check immediately before consuming the one-shot permit. TTL bounds, but does
            # not erase, the documented remote-revocation gap between issuance and execution.
            verify_permit(request["permit"], record, self.key, int(time.time() * 1000))
            record["state"] = "INTENT"
            record["permitDigest"] = digest(canonical(request["permit"]))
            self.journal(record)  # Both file and state directory fsynced BEFORE fchmod.
            self.record = record
            self.intent_started = True
            os.fchmod(fd, record["targetMode"])
            os.fsync(fd)
            after, _data = self.observe(fd)
            expected = dict(record["before"], mode=record["targetMode"], ctimeNs=after["ctimeNs"])
            require(after == expected, "MANAGED_TARGET_DRIFT")
            record["state"] = "VERIFIED"
            record["after"] = after
            record["verifiedAt"] = int(time.time() * 1000)
            self.journal(record)
            return self.public_record(record)

    def public_record(self, record):
        fields = ("operationId", "scope", "namespaceId", "targetId", "action", "planDigest", "authorityDigest",
                  "snapshotDigest", "recoveryDigest", "challenge", "preparedAt", "before", "targetMode", "after", "verifiedAt")
        result = {key: record[key] for key in fields if key in record}
        result["state"] = "OUTCOME_UNKNOWN" if record["state"] == "INTENT" else record["state"]
        result["adapter"] = ADAPTER
        return result

    def handle(self, request):
        validate_request(request)
        self.assert_binding(request)
        with self.serialized():
            if request["command"] == "RECONCILE_OBSERVE":
                return self.inspect_reconciliation(request)
            if request["command"] == "RECONCILE":
                return self.reconcile(request)
            if request["command"] == "RECONCILIATION_STATUS":
                receipt = self.reconciliation_for(request["reconciliationId"])
                require(receipt["observation"]["scope"] == request["scope"] and
                        receipt["observation"]["operationId"] == request["operationId"], "MANAGED_SCOPE_MISMATCH")
                return receipt
            if request["command"] == "OBSERVE":
                with self.target() as fd:
                    observed, _data = self.observe(fd)
                    return {"adapter": ADAPTER, "state": "OBSERVED", "snapshot": observed, "snapshotDigest": digest(canonical(observed))}
            if request["command"] == "PREPARE":
                return self.prepare(request)
            if request["command"] == "COMMIT":
                try:
                    return self.commit(request)
                except BaseException:
                    if self.intent_started:
                        self.record["state"] = "OUTCOME_UNKNOWN"
                        try:
                            self.journal(self.record)
                        except BaseException:
                            pass  # Durable INTENT still prevents automatic replay after a crash.
                        raise Refused("OUTCOME_UNKNOWN") from None
                    raise
            record = self.record_for(request["operationId"])
            require(record["scope"] == request["scope"], "MANAGED_SCOPE_MISMATCH")
            return self.public_record(record)  # STATUS never changes the target/journal.


def main():
    os.umask(0o077)
    service = None
    def expired(_signal, _frame):
        raise Refused("MANAGED_DEADLINE")
    signal.signal(signal.SIGALRM, expired)
    signal.alarm(25)
    try:
        require(len(sys.argv) == 1, "MANAGED_COMMAND_REFUSED")
        encoded = sys.stdin.buffer.read(MAX_REQUEST + 1)
        require(len(encoded) <= MAX_REQUEST)
        request = load_json(encoded)
        service = ManagedTarget()
        result = service.handle(request)
        sys.stdout.buffer.write(canonical({"ok": True, "result": result}) + b"\n")
        sys.stdout.buffer.flush()
    except BaseException as error:
        code = error.code if isinstance(error, Refused) else "MANAGED_OPERATION_REFUSED"
        if service and service.intent_started:
            code = "OUTCOME_UNKNOWN"
        elif service and service.receipt_started and code != "MANAGED_RECONCILIATION_EXISTS":
            code = "MANAGED_RECONCILIATION_RECEIPT_UNKNOWN"
        sys.stdout.buffer.write(canonical({"ok": False, "errorCode": code}) + b"\n")
        sys.stdout.buffer.flush()
        return 2
    finally:
        signal.alarm(0)
        if service:
            service.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
