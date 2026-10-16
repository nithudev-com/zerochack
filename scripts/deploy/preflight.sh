#!/usr/bin/env bash
set -euo pipefail
[[ $(hostname) == vmi3643652 ]] || { echo 'Wrong host; administration refused.' >&2; exit 1; }
date -u
git -C /opt/codebandage/source status --short --branch
git -C /opt/codebandage/source rev-parse HEAD
docker version --format '{{.Server.Version}}'
docker compose version
docker ps --format '{{.Names}} {{.Image}} {{.Status}} {{.Ports}}'
docker volume ls
ss -lntup
df -h /
free -h
ufw status
systemctl is-active caddy
caddy validate --config /etc/caddy/Caddyfile
openssl x509 -in /opt/codebandage/state/trust/ca.crt -noout -dates 2>/dev/null || true
[[ ! -f /var/run/reboot-required ]] || echo 'Restart pending: needs an approved maintenance window.'
