#!/usr/bin/env python3
"""Guarded VPS-only rootless engine provisioning. Not a broker or activation switch.

No commands run merely by importing this module. See the adjacent operations note
before the explicit --maintenance-approved operation. Failures preserve evidence.
"""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import grp
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import time
import urllib.request

REPO = Path(__file__).resolve().parents[2]
PROFILE = REPO / "infrastructure/security-runtime/profile.json"
MARKER = "codebandage-rootless-security-runtime/v1"
COMMENT = "CodeBandage isolated security runtime v1"
UNIT = "codebandage-runtime.service"
PRODUCTION = ("api", "worker", "web", "postgres", "redis")
BASE_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"}
# The checksum-pinned 20261012.0 archive declares a 128-MiB zstd window.
ZSTD_DECODER_MEMORY_MB = 128
PUBLIC_RUNTIME_BASE = Path('/usr/local/lib/codebandage-security-runtime')


class Refusal(RuntimeError):
    pass


def require(condition: bool, code: str) -> None:
    if not condition:
        raise Refusal(code)


def run(args: list[str], *, timeout: int = 30, check: bool = True,
        extra_env: dict[str, str] | None = None) -> str:
    # Never inherit application secrets, Docker contexts or shell configuration.
    result = subprocess.run(args, env=BASE_ENV | (extra_env or {}), text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout, check=False)
    if check and result.returncode:
        raise Refusal("COMMAND_FAILED:" + Path(args[0]).name)
    return result.stdout


def regular(path: Path, owner: int = 0) -> None:
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == owner,
            "UNSAFE_FILE:" + str(path))


def no_symlink_parents(path: Path) -> None:
    for parent in reversed(path.parents):
        require(not parent.is_symlink(), "SYMLINK_ANCESTOR")
        require(parent.is_dir(), "MISSING_PARENT")


def directory(path: Path, mode: int, owner: int = 0, group: int = 0) -> None:
    no_symlink_parents(path)
    if not path.exists():
        path.mkdir(mode=mode)
        os.chown(path, owner, group)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == owner and
            info.st_gid == group and stat.S_IMODE(info.st_mode) == mode,
            "UNMANAGED_DIRECTORY:" + str(path))


def managed_file(path: Path, data: bytes, mode: int = 0o600,
                 owner: int = 0, group: int = 0) -> None:
    no_symlink_parents(path)
    if path.exists() or path.is_symlink():
        regular(path, owner)
        info = path.stat()
        require(info.st_gid == group and stat.S_IMODE(info.st_mode) == mode and
                path.read_bytes() == data, "UNMANAGED_FILE:" + str(path))
        return
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "wb") as stream:
        os.fchown(stream.fileno(), owner, group)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def record(path: Path, value: dict) -> None:
    if path.exists():
        regular(path)
        require(stat.S_IMODE(path.stat().st_mode) == 0o600, "UNSAFE_RECORD")
    data = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()
    next_path = path.with_name(path.name + ".next")
    managed_file(next_path, data)
    os.replace(next_path, path)


def timestamp() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def process_real_uid(proc: Path) -> int:
    for line in (proc / "status").read_text().splitlines():
        if line.startswith("Uid:"):
            values = [int(value) for value in line.split()[1:]]
            require(len(values) == 4 and len(set(values)) == 1, "MIXED_PROCESS_UIDS")
            return values[0]
    raise Refusal("PROCESS_UID_UNAVAILABLE")


def parse_ranges(text: str) -> list[tuple[str, int, int]]:
    result = []
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        fields = line.split(":")
        require(len(fields) == 3 and fields[0] and fields[1].isdigit() and
                fields[2].isdigit(), "MALFORMED_SUBORDINATE_ID_FILE")
        start, count = int(fields[1]), int(fields[2])
        require(start > 0 and count > 0 and start + count < 2**32,
                "INVALID_SUBORDINATE_ID_RANGE")
        result.append((fields[0], start, count))
    return result


def check_ranges(ranges: list[tuple[str, int, int]], account: str,
                 start: int, count: int) -> bool:
    own = []
    for who, other_start, other_count in ranges:
        if who == account:
            own.append((other_start, other_count))
        else:
            require(start + count <= other_start or other_start + other_count <= start,
                    "SUBORDINATE_ID_COLLISION")
    require(not own or own == [(start, count)], "UNEXPECTED_ACCOUNT_SUBORDINATE_IDS")
    return bool(own)


def extract_bounded(stream: io.BufferedIOBase, destination: Path, maximum: int) -> dict:
    """Extract only regular binaries/directories; never trust tar path/link modes."""
    total, entries = 0, 0
    seen: set[str] = set()
    with tarfile.open(fileobj=stream, mode="r|") as archive:
        for member in archive:
            entries += 1
            name = member.name
            parsed = PurePosixPath(name)
            require(entries <= 128 and name and not parsed.is_absolute() and
                    ".." not in parsed.parts and
                    bool(re.fullmatch(r"[A-Za-z0-9_./-]+", name)), "UNSAFE_ARCHIVE_PATH")
            normalized = str(parsed)
            require(normalized not in seen, "DUPLICATE_ARCHIVE_PATH")
            seen.add(normalized)
            allowed = normalized in ("runsc", "containerd-shim-runsc-v1", "gvisor-bin") or normalized.startswith("gvisor-bin/")
            require(allowed and (member.isdir() or member.isreg()), "UNSAFE_ARCHIVE_TYPE")
            require(not member.pax_headers and member.size >= 0,
                    "UNEXPECTED_ARCHIVE_METADATA")
            total += member.size
            require(total <= maximum, "ARCHIVE_EXTRACTION_BUDGET_EXCEEDED")
            target = destination / parsed
            if member.isdir():
                target.mkdir(mode=0o755, parents=True, exist_ok=True)
                continue
            target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            source = archive.extractfile(member)
            require(source is not None, "MISSING_ARCHIVE_PAYLOAD")
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o755)
            with os.fdopen(fd, "wb") as output:
                remaining = member.size
                while remaining:
                    chunk = source.read(min(1024 * 1024, remaining))
                    require(bool(chunk), "TRUNCATED_ARCHIVE_PAYLOAD")
                    output.write(chunk)
                    remaining -= len(chunk)
    require({"runsc", "containerd-shim-runsc-v1"}.issubset(seen) and
            any(name.startswith("gvisor-bin/") for name in seen), "INCOMPLETE_RUNTIME_BUNDLE")
    return {"extractedBytes": total, "entries": entries}


def extract_zstd_bounded(archive: Path, destination: Path, maximum: int) -> dict:
    process = subprocess.Popen(["zstd", "--decompress", "--stdout",
                                f"--memory={ZSTD_DECODER_MEMORY_MB}MB", str(archive)],
                               env=BASE_ENV, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        require(process.stdout is not None, "DECOMPRESSOR_UNAVAILABLE")
        try:
            result = extract_bounded(process.stdout, destination, maximum)
        except (tarfile.TarError, EOFError) as error:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            diagnostic = process.stderr.read(4096) if process.stderr is not None else b""
            if b"Window size larger than maximum" in diagnostic or b"too much memory" in diagnostic:
                raise Refusal("RUNTIME_DECOMPRESSOR_MEMORY_BOUND") from None
            if process.returncode:
                raise Refusal("RUNTIME_DECOMPRESSION_FAILED") from None
            raise Refusal("RUNTIME_ARCHIVE_FORMAT_INVALID") from error
        require(process.wait(timeout=10) == 0, "RUNTIME_DECOMPRESSION_FAILED")
        return result
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        if process.stdout is not None:
            process.stdout.close()
        if process.stderr is not None:
            process.stderr.close()


def daemon_config(profile: dict, uid: int, *, legacy_private_path: bool = False) -> dict:
    root = (profile["state"] + "/gvisor/" if legacy_private_path else str(PUBLIC_RUNTIME_BASE) + "/") + profile["gvisor"]["version"]
    return {
        "data-root": profile["home"] + "/docker",
        "hosts": [f"unix:///run/user/{uid}/codebandage-runtime.sock"],
        "default-runtime": "runsc-systrap",
        "runtimes": {"runsc-systrap": {"path": root + "/runsc", "runtimeArgs": [
            "--platform=systrap", "--network=sandbox", "--directfs=false"]}},
        "exec-opts": ["native.cgroupdriver=systemd"],
        "features": {"containerd-snapshotter": False},
        "storage-driver": "overlay2",
        "bridge": "none", "iptables": False, "ip6tables": False,
        "ip-forward": False, "ip-masq": False,
        "log-driver": "json-file", "log-opts": {"max-size": "1m", "max-file": "2"},
        "max-concurrent-downloads": 1, "max-concurrent-uploads": 1,
        "live-restore": False
    }


class Runtime:
    def __init__(self, profile: dict):
        self.p = profile
        self.root = Path(profile["state"])
        self.home = Path(profile["home"])
        self.state_file = self.root / "provision.json"
        self.state: dict = {}
        self.account = profile["account"]
        self.user = None
        self.may_stop_engine = False
        self.allow_runtime_path_recovery = False

    def operation_lock(self) -> int:
        info = self.root.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and
                stat.S_IMODE(info.st_mode) == 0o755, "UNSAFE_RUNTIME_STATE_DIRECTORY")
        fd = os.open(self.root / "provision.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and
                    stat.S_IMODE(info.st_mode) == 0o600, "UNSAFE_OPERATION_LOCK")
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fd
        except Exception:
            os.close(fd)
            raise

    def budget(self) -> int:
        available = shutil.disk_usage("/").free
        require(available >= self.p["minimumFreeBytes"], "FREE_DISK_RESERVE_NOT_MET")
        baseline = self.state.get("initialAvailableBytes", available)
        require(baseline - available <= self.p["maximumIncrementBytes"], "INCREMENTAL_DISK_BUDGET_EXCEEDED")
        return available

    def host_guard(self, *, emergency: bool = False) -> None:
        require(os.geteuid() == 0 and socket.gethostname() == self.p["host"], "WRONG_HOST_OR_USER")
        if emergency:
            return
        require(os.uname().machine == "x86_64", "UNREVIEWED_ARCHITECTURE")
        require('ID=ubuntu\n' in Path("/etc/os-release").read_text() and
                'VERSION_ID="24.04"' in Path("/etc/os-release").read_text(), "UNREVIEWED_OS")
        require(Path("/sys/fs/cgroup/cgroup.controllers").exists(), "CGROUP_V2_REQUIRED")
        require({"cpu", "memory", "pids"}.issubset(set(Path("/sys/fs/cgroup/cgroup.controllers").read_text().split())), "MISSING_CGROUP_CONTROLLERS")
        for command in ("docker", "dockerd", "dockerd-rootless.sh", "rootlesskit", "runuser", "systemctl", "loginctl", "zstd", "useradd", "usermod", "curl"):
            require(shutil.which(command) is not None, "MISSING_COMMAND:" + command)
        require(re.search(r"Docker version " + re.escape(self.p["dockerVersion"]) + r"(?:,|\s|$)", run(["dockerd", "--version"])) is not None,
                "UNREVIEWED_DOCKER_VERSION")
        self.budget()

    def load(self, *, emergency: bool = False) -> None:
        regular(self.state_file)
        self.state = json.loads(self.state_file.read_text())
        require(self.state.get("schema") == MARKER and self.state.get("account") == self.account and
                self.state.get("home") == str(self.home), "UNMANAGED_PROVISIONING_STATE")
        require(emergency or self.state.get("profileSha256") == hashlib.sha256(PROFILE.read_bytes()).hexdigest(),
                "PROVISIONING_PROFILE_CHANGED")

    def save(self, phase: str) -> None:
        self.state.update(phase=phase, updatedAt=timestamp())
        record(self.state_file, self.state)

    def production_health(self) -> dict:
        result = {"at": timestamp(), "containers": {}, "services": {}, "configHashes": {}}
        for role in PRODUCTION:
            # Purpose-built projection only: never capture Docker environments.
            raw = run(["docker", "--host", "unix:///var/run/docker.sock", "inspect", "--format",
                       '{{json .Id}} {{json .Image}} {{json .State.Status}} {{if .State.Health}}{{json .State.Health.Status}}{{end}}',
                       "codebandage-" + role + "-1"])
            parts = raw.strip().split()
            require(len(parts) == 4 and parts[2] == '"running"' and parts[3] == '"healthy"', "PRODUCTION_NOT_HEALTHY")
            result["containers"][role] = {"id": json.loads(parts[0]), "image": json.loads(parts[1]), "state": "running", "health": "healthy"}
        for service in ("docker.service", "caddy.service"):
            require(run(["systemctl", "is-active", service]).strip() == "active", "PRODUCTION_SERVICE_NOT_ACTIVE")
            result["services"][service] = run(["systemctl", "show", service, "-p", "MainPID", "--value"]).strip()
        for filename in ("/etc/caddy/Caddyfile", "/etc/docker/daemon.json"):
            path = Path(filename)
            result["configHashes"][filename] = hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
        for endpoint in ("live", "ready"):
            code = run(["curl", "--silent", "--show-error", "--max-time", "5", "--output", "/dev/null", "--write-out", "%{http_code}",
                        "http://127.0.0.1:4000/v1/health/" + endpoint]).strip()
            require(code == "200", "PRODUCTION_API_NOT_READY")
        return result

    def health_evidence(self) -> dict:
        try:
            return self.production_health()
        except Exception as error:
            return {"at": timestamp(), "result": "UNHEALTHY_OR_UNAVAILABLE", "errorType": type(error).__name__}

    def compare_health(self, before: dict) -> dict:
        after = self.production_health()
        require(all(before[key] == after[key] for key in ("containers", "services", "configHashes")), "PRODUCTION_CHANGED_DURING_PROVISIONING")
        return after

    def packages(self) -> None:
        specifications = [name + "=" + version for name, version in self.p["packages"].items()]
        for name, version in self.p["packages"].items():
            status = run(["dpkg-query", "-W", "-f=${db:Status-Status} ${Version}", name], check=False).strip()
            require(not status or status.startswith("not-installed") or status == "installed " + version, "PACKAGE_VERSION_CONFLICT:" + name)
        command = ["apt-get", "--no-install-recommends", "--no-upgrade", "--no-remove", "install", *specifications]
        simulation = run(["apt-get", "--simulate", *command[1:]], timeout=60)
        require("Remv " not in simulation, "PACKAGE_REMOVAL_REFUSED")
        for line in simulation.splitlines():
            if line.startswith("Inst "):
                match = re.fullmatch(r"Inst ([A-Za-z0-9.+-]+) \(([^ ]+) .*", line)
                require(match is not None and self.p["packages"].get(match[1]) == match[2], "UNREVIEWED_PACKAGE_TRANSACTION")
        self.budget()
        run([*command[:1], "-y", *command[1:]], timeout=180,
            extra_env={"DEBIAN_FRONTEND": "noninteractive", "NEEDRESTART_MODE": "l"})
        for name, version in self.p["packages"].items():
            require(run(["dpkg-query", "-W", "-f=${Version}", name]).strip() == version, "PACKAGE_INSTALL_NOT_VERIFIED")

    def identity(self) -> None:
        start, count = self.p["subordinateIdStart"], self.p["subordinateIdCount"]
        for path in (Path("/etc/subuid"), Path("/etc/subgid")):
            regular(path)
            check_ranges(parse_ranges(path.read_text()), self.account, start, count)
        require(not any(start <= item.pw_uid < start + count for item in pwd.getpwall()), "SUBUID_REAL_ACCOUNT_COLLISION")
        require(not any(start <= item.gr_gid < start + count for item in grp.getgrall()), "SUBGID_REAL_GROUP_COLLISION")
        try:
            user = pwd.getpwnam(self.account)
        except KeyError:
            require("uid" not in self.state, "MANAGED_ACCOUNT_DISAPPEARED")
            try:
                grp.getgrnam(self.account)
                raise Refusal("ACCOUNT_GROUP_ALREADY_EXISTS")
            except KeyError:
                pass
            run(["useradd", "--system", "--user-group", "--no-create-home", "--home-dir", str(self.home),
                 "--shell", "/bin/bash", "--comment", COMMENT, self.account])
            user = pwd.getpwnam(self.account)
        require(user.pw_uid != 0 and user.pw_dir == str(self.home) and user.pw_shell == "/bin/bash" and
                user.pw_gecos == COMMENT and self.state.get("uid", user.pw_uid) == user.pw_uid, "ACCOUNT_IDENTITY_MISMATCH")
        require(run(["id", "-G", self.account]).split() == [str(user.pw_gid)], "ACCOUNT_HAS_EXTRA_GROUPS")
        require(run(["passwd", "-S", self.account]).split()[1] == "L", "ACCOUNT_PASSWORD_NOT_LOCKED")
        self.user = user
        self.state.update(uid=user.pw_uid, gid=user.pw_gid)
        self.save("IDENTITY_CREATED")
        for path, flag in ((Path("/etc/subuid"), "--add-subuids"), (Path("/etc/subgid"), "--add-subgids")):
            if not check_ranges(parse_ranges(path.read_text()), self.account, start, count):
                run(["usermod", flag, f"{start}-{start + count - 1}", self.account])
            require(check_ranges(parse_ranges(path.read_text()), self.account, start, count), "SUBORDINATE_IDS_NOT_VERIFIED")
        directory(self.home, 0o700, user.pw_uid, user.pw_gid)

    def bundle(self) -> None:
        settings = self.p["gvisor"]
        directory(self.root / "gvisor", 0o755)
        destination = self.root / "gvisor" / settings["version"]
        receipt = self.root / "bundle.json"
        if destination.exists():
            regular(receipt)
            saved = json.loads(receipt.read_text())
            require(saved.get("sha256") == settings["sha256"], "BUNDLE_IDENTITY_MISMATCH")
            require(saved.get("version") == settings["version"] and
                    set(saved["files"]) == {str(path.relative_to(destination)) for path in destination.rglob("*") if path.is_file()},
                    "BUNDLE_FILE_SET_CHANGED")
            for relative, digest in saved["files"].items():
                path = destination / relative
                regular(path)
                require(stat.S_IMODE(path.stat().st_mode) == 0o755 and hashlib.sha256(path.read_bytes()).hexdigest() == digest, "BUNDLE_FILE_CHANGED")
            return
        archive = self.root / "gvisor" / (settings["version"] + ".tar.zstd")
        if not archive.exists():
            self.budget()
            require(shutil.disk_usage("/").free - settings["archiveBytes"] - settings["maximumExtractedBytes"] >= self.p["minimumFreeBytes"], "BUNDLE_WOULD_BREACH_RESERVE")
            request = urllib.request.Request(settings["url"], headers={"User-Agent": "CodeBandage-reviewed-runtime-provisioner/1"})
            deadline = time.monotonic() + 120
            fd = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "wb") as output, urllib.request.urlopen(request, timeout=20) as response:
                require(response.geturl().startswith("https://"), "NON_HTTPS_RUNTIME_DOWNLOAD")
                remaining = settings["archiveBytes"]
                while remaining:
                    require(time.monotonic() < deadline, "RUNTIME_DOWNLOAD_DEADLINE_EXCEEDED")
                    chunk = response.read(min(1024 * 1024, remaining))
                    require(bool(chunk), "TRUNCATED_RUNTIME_DOWNLOAD")
                    output.write(chunk)
                    remaining -= len(chunk)
                    self.budget()
                require(not response.read(1), "OVERSIZED_RUNTIME_DOWNLOAD")
        regular(archive)
        require(archive.stat().st_size == settings["archiveBytes"] and
                hashlib.sha256(archive.read_bytes()).hexdigest() == settings["sha256"], "RUNTIME_ARCHIVE_HASH_MISMATCH")
        stage = destination.with_name(destination.name + ".staging")
        require(not stage.exists(), "PARTIAL_BUNDLE_REQUIRES_REVIEW")
        directory(stage, 0o755)
        extraction = extract_zstd_bounded(archive, stage, settings["maximumExtractedBytes"])
        self.budget()
        os.rename(stage, destination)
        files = {str(path.relative_to(destination)): hashlib.sha256(path.read_bytes()).hexdigest()
                 for path in destination.rglob("*") if path.is_file()}
        record(receipt, {"sha256": settings["sha256"], "version": settings["version"], **extraction, "files": files})
        require(settings["version"] in run([str(destination / "runsc"), "--version"]), "RUNTIME_VERSION_MISMATCH")

    def user_command(self, args: list[str], **kwargs) -> str:
        require(self.user is not None, "ACCOUNT_NOT_LOADED")
        uid = self.user.pw_uid
        return run(["runuser", "--user", self.account, "--", "env", f"XDG_RUNTIME_DIR=/run/user/{uid}",
                    f"DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{uid}/bus", *args], **kwargs)

    def public_bundle(self) -> None:
        """Publish only checksum-verified executable bytes, never private state.

        /opt/codebandage is intentionally private. Do not grant runtime identities
        traversal into it or copy application configuration/credentials out of it.
        """
        settings = self.p['gvisor']
        source = self.root / 'gvisor' / settings['version']
        receipt = self.root / 'bundle.json'
        regular(receipt)
        saved = json.loads(receipt.read_text())
        require(saved.get('sha256') == settings['sha256'] and saved.get('version') == settings['version'], 'BUNDLE_IDENTITY_MISMATCH')
        expected = saved['files']
        require(set(expected) == {str(path.relative_to(source)) for path in source.rglob('*') if path.is_file()}, 'BUNDLE_FILE_SET_CHANGED')
        directory(PUBLIC_RUNTIME_BASE, 0o755)
        destination = PUBLIC_RUNTIME_BASE / settings['version']
        directory(destination, 0o755)
        allowed_directories = {str(parent) for relative in expected for parent in PurePosixPath(relative).parents if str(parent) != '.'}
        require(all(not path.is_symlink() and (not path.is_dir() or str(path.relative_to(destination)) in allowed_directories)
                    for path in destination.rglob('*')), 'UNMANAGED_PUBLIC_RUNTIME_DIRECTORY')
        present = {str(path.relative_to(destination)) for path in destination.rglob('*') if not path.is_dir()}
        require(present.issubset(set(expected)), 'UNMANAGED_PUBLIC_RUNTIME_FILE')
        self.budget()
        for relative, checksum in sorted(expected.items()):
            parsed = PurePosixPath(relative)
            require(not parsed.is_absolute() and '..' not in parsed.parts and
                    bool(re.fullmatch(r'[A-Za-z0-9_./-]+', relative)), 'UNSAFE_ARCHIVE_PATH')
            origin = source / relative
            regular(origin)
            require(origin.stat().st_gid == 0 and stat.S_IMODE(origin.stat().st_mode) == 0o755 and
                    origin.stat().st_size <= settings['maximumExtractedBytes'], 'BUNDLE_FILE_CHANGED')
            payload = origin.read_bytes()
            require(hashlib.sha256(payload).hexdigest() == checksum, 'BUNDLE_FILE_CHANGED')
            target = destination / relative
            if not target.exists():
                require(shutil.disk_usage('/').free - len(payload) >= self.p['minimumFreeBytes'],
                        'PUBLIC_BUNDLE_WOULD_BREACH_RESERVE')
            for parent in reversed(target.relative_to(destination).parents):
                if str(parent) != '.':
                    directory(destination / parent, 0o755)
            managed_file(target, payload, 0o755)
            self.budget()
        require(set(expected) == {str(path.relative_to(destination)) for path in destination.rglob('*') if path.is_file()}, 'PUBLIC_BUNDLE_FILE_SET_CHANGED')
        require(settings['version'] in self.user_command([str(destination / 'runsc'), '--version']), 'RUNTIME_NOT_EXECUTABLE_BY_DEDICATED_USER')
        record(self.root / 'public-bundle.json', {'at': timestamp(), 'directory': str(destination),
               'archiveSha256': settings['sha256'], 'files': expected, 'applicationDirectoryPermissionsChanged': False})

    def recover_runtime_config_path(self, config_path: Path, current: bytes) -> None:
        if not config_path.exists() or config_path.read_bytes() == current:
            return
        require(self.allow_runtime_path_recovery and self.state.get('phase') == 'RUNTIME_BUNDLE_VERIFIED',
                'RUNTIME_PATH_RECOVERY_APPROVAL_REQUIRED')
        user = self.user
        require(user is not None, 'ACCOUNT_NOT_LOADED')
        legacy = (json.dumps(daemon_config(self.p, user.pw_uid, legacy_private_path=True), sort_keys=True, indent=2) + '\n').encode()
        regular(config_path, user.pw_uid)
        metadata = config_path.lstat()
        require(metadata.st_gid == user.pw_gid and stat.S_IMODE(metadata.st_mode) == 0o600 and
                metadata.st_nlink == 1 and config_path.read_bytes() == legacy, 'UNMANAGED_RUNTIME_CONFIG')
        require(run(['systemctl', 'is-active', f'user@{user.pw_uid}.service'], check=False).strip() in ('inactive', 'failed') and
                not Path(f'/run/user/{user.pw_uid}/codebandage-runtime.sock').exists(), 'PATH_RECOVERY_REFUSES_ACTIVE_ENGINE')
        backup = self.root / 'daemon-config-before-public-runtime.json'
        managed_file(backup, legacy)
        pending = config_path.with_name(config_path.name + '.public-runtime.next')
        managed_file(pending, current, owner=user.pw_uid, group=user.pw_gid)
        os.replace(pending, config_path)
        parent = os.open(config_path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
        record(self.root / 'runtime-path-recovery.json', {'at': timestamp(), 'backup': str(backup),
               'beforeSha256': hashlib.sha256(legacy).hexdigest(), 'afterSha256': hashlib.sha256(current).hexdigest(),
               'productionPathsChanged': False})

    def docker(self, args: list[str], **kwargs) -> str:
        return self.user_command(["docker", "--host", f"unix:///run/user/{self.user.pw_uid}/codebandage-runtime.sock", *args], **kwargs)

    def configure(self) -> None:
        user = self.user
        require(user is not None, "ACCOUNT_NOT_LOADED")
        if Path(f"/run/user/{user.pw_uid}/codebandage-runtime.sock").exists():
            require(not self.docker(["ps", "--quiet"]).strip(), "EXISTING_RUNTIME_JOB_REFUSED")
        for suffix in (".config", ".config/docker", ".config/systemd", ".config/systemd/user"):
            directory(self.home / suffix, 0o700, user.pw_uid, user.pw_gid)
        config = json.dumps(daemon_config(self.p, user.pw_uid), sort_keys=True, indent=2) + "\n"
        self.recover_runtime_config_path(self.home / '.config/docker/daemon.json', config.encode())
        managed_file(self.home / ".config/docker/daemon.json", config.encode(), owner=user.pw_uid, group=user.pw_gid)
        unit = f"""[Unit]
Description=CodeBandage isolated Docker engine (rootless, unverified until explicit fixture check)
Documentation=https://docs.docker.com/engine/security/rootless/
Requires=dbus.socket
After=dbus.socket
[Service]
Environment=PATH=/usr/sbin:/usr/bin:/sbin:/bin
Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_NET=slirp4netns
Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=true
Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_DETACH_NETNS=false
Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_SLIRP4NETNS_SANDBOX=true
Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_SLIRP4NETNS_SECCOMP=true
ExecStart=/usr/bin/dockerd-rootless.sh --config-file={self.home}/.config/docker/daemon.json
TimeoutStartSec=90
TimeoutStopSec=20
Restart=no
LimitNOFILE=4096
LimitCORE=0
TasksMax={self.p['aggregatePids']}
Delegate=yes
Type=notify
NotifyAccess=all
KillMode=mixed
UMask=0077
[Install]
WantedBy=default.target
"""
        managed_file(self.home / ".config/systemd/user" / UNIT, unit.encode(), owner=user.pw_uid, group=user.pw_gid)
        # Scope delegation and outer limits to this NEW identity, never all users.
        for path in (Path(f"/etc/systemd/system/user@{user.pw_uid}.service.d"),
                     Path(f"/etc/systemd/system/user-{user.pw_uid}.slice.d")):
            directory(path, 0o755)
        managed_file(Path(f"/etc/systemd/system/user@{user.pw_uid}.service.d/50-codebandage-runtime.conf"),
                     b"[Service]\nDelegate=cpu cpuset io memory pids\n", 0o644)
        slice_data = (f"[Slice]\nCPUQuota={self.p['aggregateCpuQuota']}\nMemoryMax={self.p['aggregateMemoryBytes']}\n"
                      f"MemorySwapMax=0\nTasksMax={self.p['aggregatePids']}\n")
        managed_file(Path(f"/etc/systemd/system/user-{user.pw_uid}.slice.d/50-codebandage-runtime.conf"), slice_data.encode(), 0o644)
        run(["systemctl", "daemon-reload"])
        self.may_stop_engine = True
        run(["loginctl", "enable-linger", self.account])
        run(["systemctl", "start", f"user@{user.pw_uid}.service"], timeout=45)
        # No --force, no rootful Docker install/reload, no global CLI context changes.
        self.user_command(["timeout", "10", "rootlesskit", "--net=none", "/bin/true"])
        self.user_command(["systemctl", "--user", "daemon-reload"])
        self.user_command(["systemctl", "--user", "enable", UNIT])
        self.user_command(["systemctl", "--user", "start", UNIT], timeout=100)
        self.budget()

    def engine_checks(self) -> dict:
        user = self.user
        require(user is not None, "ACCOUNT_NOT_LOADED")
        info = json.loads(self.docker(["info", "--format", "{{json .}}"], timeout=15))
        require(info["CgroupDriver"] == "systemd" and str(info["CgroupVersion"]) == "2" and
                "name=rootless" in info["SecurityOptions"] and info["DockerRootDir"] == str(self.home / "docker") and
                info["DefaultRuntime"] == "runsc-systrap", "ROOTLESS_ENGINE_BOUNDARY_NOT_VERIFIED")
        socket_path = Path(f"/run/user/{user.pw_uid}/codebandage-runtime.sock")
        require(stat.S_ISSOCK(socket_path.stat().st_mode) and socket_path.stat().st_uid == user.pw_uid and
                stat.S_IMODE(Path(f"/run/user/{user.pw_uid}").stat().st_mode) == 0o700, "ENGINE_SOCKET_NOT_PRIVATE")
        slice_path = Path(f"/sys/fs/cgroup/user.slice/user-{user.pw_uid}.slice")
        quota, period = map(int, (slice_path / "cpu.max").read_text().split())
        require(quota > 0 and period > 0 and quota / period <= 0.25 and
                int((slice_path / "memory.max").read_text()) == self.p["aggregateMemoryBytes"] and
                int((slice_path / "memory.swap.max").read_text()) == 0 and
                int((slice_path / "pids.max").read_text()) <= self.p["aggregatePids"], "AGGREGATE_LIMITS_NOT_ENFORCED")
        manager = slice_path / f"user@{user.pw_uid}.service"
        require({"cpu", "memory", "pids"}.issubset(set((manager / "cgroup.controllers").read_text().split())), "CONTROLLERS_NOT_DELEGATED")
        dockerd = []
        for proc_file in manager.rglob("cgroup.procs"):
            for pid in proc_file.read_text().split():
                proc = Path("/proc") / pid
                try:
                    if (proc / "comm").read_text().strip() == "dockerd":
                        require(process_real_uid(proc) == user.pw_uid, "ENGINE_PROCESS_IS_PRIVILEGED")
                        dockerd.append(proc)
                except FileNotFoundError:
                    continue
        require(len(dockerd) == 1, "AMBIGUOUS_ENGINE_PROCESS")
        for namespace in ("user", "net"):
            require(os.readlink(dockerd[0] / "ns" / namespace) != os.readlink(Path("/proc/1/ns") / namespace), "ENGINE_NAMESPACE_NOT_ISOLATED")
        return {"rootless": True, "enginePid": int(dockerd[0].name), "cgroupDriver": "systemd", "cgroupVersion": 2,
                "aggregateCpu": quota / period, "aggregateMemoryBytes": self.p["aggregateMemoryBytes"],
                "jobVerification": "NOT_RUN", "applicationActivation": False}

    def provision(self) -> None:
        self.host_guard()
        initial_health = self.production_health()
        existed = self.root.exists()
        directory(self.root, 0o755)
        # Serialize only our own provisioning; never acquire or bypass production locks.
        lock = self.operation_lock()
        try:
            if self.state_file.exists():
                self.load()
            else:
                require(not existed or {path.name for path in self.root.iterdir()} == {"provision.lock"}, "UNMANAGED_RUNTIME_STATE_DIRECTORY")
                require(not self.home.exists(), "EXISTING_RUNTIME_HOME_REFUSED")
                try:
                    pwd.getpwnam(self.account)
                    raise Refusal("EXISTING_ACCOUNT_REFUSED")
                except KeyError:
                    pass
                self.state = {"schema": MARKER, "profileSha256": hashlib.sha256(PROFILE.read_bytes()).hexdigest(),
                              "account": self.account, "home": str(self.home),
                              "createdAt": timestamp(), "initialAvailableBytes": self.budget(), "applicationActivation": False}
                self.save("PREFLIGHT_RECORDED")
            record(self.root / "health-before.json", initial_health)
            self.packages()
            self.save("PREREQUISITES_VERIFIED")
            self.identity()
            self.bundle()
            self.public_bundle()
            self.save("RUNTIME_BUNDLE_VERIFIED")
            self.configure()
            observed = self.engine_checks()
            record(self.root / "engine-observed.json", observed)
            record(self.root / "health-after.json", self.compare_health(initial_health))
            self.save("ROOTLESS_ENGINE_PROVISIONED_UNVERIFIED")
            print(json.dumps({"result": "ROOTLESS_ENGINE_PROVISIONED_UNVERIFIED", "applicationActivation": False,
                              "next": "Explicit reviewed-image job verification; no broker/application is connected"}))
        except Exception:
            if self.user is not None and self.may_stop_engine:
                # Fail closed if namespacing/limits are not actually observed.
                # This identity is ours alone; no production daemon is stopped.
                try:
                    run(["systemctl", "stop", f"user@{self.user.pw_uid}.service"], timeout=30, check=False)
                    run(["loginctl", "disable-linger", self.account], check=False)
                except Exception:
                    pass
            raise
        finally:
            if self.state:
                record(self.root / "health-finally.json", self.health_evidence())
            os.close(lock)

    def disable(self) -> None:
        # Emergency stop must still work when disk or production health is bad.
        self.host_guard(emergency=True)
        lock = self.operation_lock()
        try:
            self.disable_locked()
        finally:
            os.close(lock)

    def recover_empty_stage(self) -> None:
        self.host_guard()
        lock = self.operation_lock()
        try:
            self.load()
            require(self.state.get("phase") == "FAILED_REVIEW_REQUIRED", "RECOVERY_REQUIRES_REVIEWED_FAILED_SETUP")
            user = pwd.getpwnam(self.account)
            require(user.pw_uid == self.state.get("uid") and user.pw_dir == str(self.home) and
                    user.pw_gecos == COMMENT, "ACCOUNT_IDENTITY_MISMATCH")
            require(run(["systemctl", "is-active", f"user@{user.pw_uid}.service"], check=False).strip() in ("inactive", "failed") and
                    not Path(f"/run/user/{user.pw_uid}/codebandage-runtime.sock").exists(), "RECOVERY_REFUSES_ACTIVE_ENGINE")
            before = self.production_health()
            settings = self.p["gvisor"]
            destination = self.root / "gvisor" / settings["version"]
            archive = self.root / "gvisor" / (settings["version"] + ".tar.zstd")
            stage = destination.with_name(destination.name + ".staging")
            regular(archive)
            require(archive.stat().st_size == settings["archiveBytes"] and
                    hashlib.sha256(archive.read_bytes()).hexdigest() == settings["sha256"], "RECOVERY_ARCHIVE_IDENTITY_MISMATCH")
            require(not destination.exists() and not (self.root / "bundle.json").exists(), "RECOVERY_REFUSES_COMPLETED_BUNDLE")
            metadata = stage.lstat()
            require(stat.S_ISDIR(metadata.st_mode) and metadata.st_uid == 0 and metadata.st_gid == 0 and
                    stat.S_IMODE(metadata.st_mode) == 0o755 and next(stage.iterdir(), None) is None,
                    "RECOVERY_REFUSES_NONEMPTY_OR_UNOWNED_STAGE")
            preserved = stage.with_name(stage.name + ".preserved-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ"))
            require(not preserved.exists(), "RECOVERY_NAME_COLLISION")
            os.rename(stage, preserved)
            evidence = {"at": timestamp(), "action": "RENAMED_VERIFIED_EMPTY_STAGE", "preservedPath": str(preserved),
                        "archiveSha256": settings["sha256"], "deleted": False,
                        "healthBefore": before, "healthAfter": self.compare_health(before)}
            record(self.root / "empty-stage-recovery.json", evidence)
            self.save("EMPTY_STAGE_PRESERVED_RERUN_REQUIRES_APPROVAL")
            print(json.dumps({"result": "EMPTY_STAGE_PRESERVED", "preservedPath": str(preserved),
                              "deleted": False, "provisioningRerun": "NOT_EXECUTED"}))
        finally:
            os.close(lock)

    def disable_locked(self) -> None:
        self.load(emergency=True)
        self.user = pwd.getpwnam(self.account)
        require(self.user.pw_uid == self.state["uid"] and self.user.pw_dir == str(self.home) and
                self.user.pw_gecos == COMMENT, "ACCOUNT_IDENTITY_MISMATCH")
        before = self.health_evidence()
        # Only this dedicated identity is stopped. Keep its images/data/evidence.
        user_bus_unavailable = False
        try:
            self.user_command(["systemctl", "--user", "disable", "--now", UNIT], timeout=10, check=False)
        except (Refusal, subprocess.TimeoutExpired, OSError):
            # The root manager stop must not depend on a responsive user bus.
            user_bus_unavailable = True
        run(["systemctl", "stop", f"user@{self.user.pw_uid}.service"], timeout=30)
        run(["loginctl", "disable-linger", self.account])
        require(run(["systemctl", "is-active", f"user@{self.user.pw_uid}.service"], check=False).strip() == "inactive", "RUNTIME_MANAGER_DID_NOT_STOP")
        # The safety action is complete before any disk-dependent record write.
        evidence_saved = False
        try:
            record(self.root / "health-before-disable.json", before)
            record(self.root / "health-after-disable.json", self.health_evidence())
            self.save("DISABLED_DATA_PRESERVED")
            evidence_saved = True
        except OSError:
            # A full disk must not prevent the already verified emergency stop.
            pass
        print(json.dumps({"result": "DISABLED_DATA_PRESERVED", "runtimeStopped": True,
                          "userBusUnavailable": user_bus_unavailable,
                          "evidenceSaved": evidence_saved, "deleted": False, "applicationActivation": False}))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("plan", "provision", "disable", "recover-empty-stage"))
    parser.add_argument("--maintenance-approved", action="store_true")
    parser.add_argument("--empty-stage-recovery-approved", action="store_true")
    parser.add_argument("--runtime-path-recovery-approved", action="store_true")
    args = parser.parse_args()
    profile = json.loads(PROFILE.read_text())
    require(profile["schema"] == MARKER, "UNRECOGNIZED_PROFILE")
    if args.operation == "plan":
        print(json.dumps({"status": "NOT_EXECUTED", "profile": profile, "requiresExplicitToolApproval": True}, indent=2))
        return 0
    require(args.maintenance_approved, "MAINTENANCE_APPROVAL_REQUIRED")
    runtime = Runtime(profile)
    runtime.allow_runtime_path_recovery = args.runtime_path_recovery_approved
    try:
        if args.operation == "recover-empty-stage":
            require(args.empty_stage_recovery_approved, "EXPLICIT_EMPTY_STAGE_RECOVERY_APPROVAL_REQUIRED")
            runtime.recover_empty_stage()
        else:
            getattr(runtime, args.operation)()
    except Exception:
        if runtime.state:
            runtime.save("FAILED_REVIEW_REQUIRED")
        # Never print subprocess stderr, environment, full inspect or authentication.
        raise
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (Refusal, subprocess.TimeoutExpired, OSError, ValueError, KeyError, tarfile.TarError, EOFError) as error:
        detail = str(error) if isinstance(error, Refusal) else type(error).__name__
        print(json.dumps({"result": "REFUSED", "reason": detail, "applicationActivation": False}), file=sys.stderr)
        raise SystemExit(1)
