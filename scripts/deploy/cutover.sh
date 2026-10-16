#!/usr/bin/env bash
set -euo pipefail
[[ $(hostname) == vmi3643652 && $(id -u) == 0 ]] || exit 1
root=$(git rev-parse --show-toplevel)
python3 "$root/scripts/deploy/check-release.py" "${1:?release manifest}" "${2:?gate evidence}"
python3 -c 'import json,sys; g=json.load(open(sys.argv[1])); assert all(g.get(k)=="passed" for k in ["owner_mfa", "authenticated_smoke", "sse", "offserver_backup", "rollback_review"])' "$2"
curl --fail --silent --show-error --max-time 15 http://127.0.0.1:4000/v1/health/ready
caddy validate --config "$root/infrastructure/production/Caddyfile"
backup="/etc/caddy/Caddyfile.before-codebandage-$(date -u +%Y%m%dT%H%M%SZ)"
cp -a /etc/caddy/Caddyfile "$backup"
install -m 644 "$root/infrastructure/production/Caddyfile" /etc/caddy/Caddyfile
if ! systemctl reload caddy; then
  cp -a "$backup" /etc/caddy/Caddyfile
  systemctl reload caddy
  exit 1
fi
bash "$root/scripts/deploy/smoke.sh"
