#!/usr/bin/env bash
set -euo pipefail
[[ $(hostname) == vmi3643652 && $(id -u) == 0 ]] || { echo 'Wrong deployment host/identity.' >&2; exit 1; }
root=$(git rev-parse --show-toplevel)
cd "$root"
[[ -z $(git status --porcelain) ]] || { echo 'Preserve local edits before deployment.' >&2; exit 1; }
manifest=${1:?Provide tested release.env}
gates=${2:?Provide reviewed release-gates.json}
exec 9>/opt/codebandage/deployment.lock
flock -n 9 || { echo 'Another deployment is active.' >&2; exit 1; }
python3 "$root/scripts/deploy/check-release.py" "$manifest" "$gates"
compose=(docker compose --env-file "$manifest" -f "$root/infrastructure/production/compose.yml")
"${compose[@]}" config --quiet
"${compose[@]}" up -d --wait postgres redis
# Existing data requires a completed backup/restore gate before check-release permits this step.
"${compose[@]}" run --rm tools npm run db:migrate:deploy
"${compose[@]}" up -d --wait --wait-timeout 180 api worker web
curl --fail --silent --show-error --max-time 15 http://127.0.0.1:4000/v1/health/ready
echo 'Application started privately. Public cutover requires verified Owner/MFA and HTTPS browser checks.'
echo 'Caddy was not changed. Run cutover.sh only after reviewing those results.'
