#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
cd "$root"
[[ -z $(git status --porcelain) ]] || { echo 'Build requires a committed clean candidate.' >&2; exit 1; }
revision=$(git rev-parse HEAD)
output=${1:?Provide a release.env path outside the repository}
case "$output" in "$root"/*) echo 'Release manifest must be outside Git.' >&2; exit 1;; esac
[[ ! -e "$output" ]] || { echo 'Manifest exists; refusing overwrite.' >&2; exit 1; }
umask 077
for target in api worker web tools; do
  docker build --pull=false --label "org.opencontainers.image.revision=$revision" \
    -f infrastructure/production/Dockerfile --target "$target" \
    --build-arg APP_URL=https://codebandage.com \
    --build-arg NEXT_PUBLIC_API_URL=https://codebandage.com/v1 \
    -t "codebandage-$target:$revision" .
done
{
  echo 'STATE_DIR=/opt/codebandage/state'
  echo "RELEASE_COMMIT=$revision"
  for target in api worker web tools; do
    identity=$(docker image inspect --format '{{.Id}}' "codebandage-$target:$revision")
    printf '%s_IMAGE=%s\n' "${target^^}" "$identity"
  done
} > "$output"
echo "Built $revision. Manifest: $output. Images still require testing and audits."
