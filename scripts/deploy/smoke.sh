#!/usr/bin/env bash
set -euo pipefail
origin=${1:-https://codebandage.com}
[[ "$origin" == https://* ]] || { echo 'HTTPS required.' >&2; exit 1; }
curl --fail --silent --show-error --max-time 15 "$origin/v1/health/live"
curl --fail --silent --show-error --max-time 15 "$origin/v1/health/ready"
for path in / /sign-in /customer/login /brand/favicon-32.png /brand/icon-192.png /manifest.webmanifest /opengraph-image.png; do
  curl --fail --silent --show-error --max-time 20 "$origin$path" -o /dev/null
done
headers=$(curl --fail --silent --show-error --max-time 20 -D - "$origin/sign-in" -o /dev/null)
[[ "$headers" == *"nonce-"* ]] || { echo 'Nonce CSP missing.' >&2; exit 1; }
[[ "$headers" == *"no-store"* ]] || { echo 'Private cache policy missing.' >&2; exit 1; }
[[ $(curl --silent --show-error --max-time 15 -o /dev/null -w '%{http_code}' "$origin/v1/auth/me") == 401 ]]
echo 'Unauthenticated HTTPS/assets/readiness smoke passed; authenticated and SSE tests are separate gates.'
