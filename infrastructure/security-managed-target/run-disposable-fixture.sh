#!/usr/bin/env bash
# Operator-reviewed disposable fixture ONLY. Never deploys/execs a customer application.
set -euo pipefail
umask 077
[[ $# == 1 && $1 =~ ^[a-f0-9]{64}$ ]] || { printf '%s\n' 'Supply the independently reviewed source-manifest SHA256.' >&2; exit 2; }
[[ ${MANAGED_TARGET_DISPOSABLE_FIXTURE_APPROVED:-} == 1 ]] || { printf '%s\n' 'Fixture execution has not been approved.' >&2; exit 2; }
[[ $(id -u) == 0 && $(hostname) == vmi3643652 ]] || { printf '%s\n' 'Refusing a workstation or unexpected host.' >&2; exit 2; }
fixture_source=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
[[ $fixture_source == /opt/codebandage/audit-managed-target-20261018/source ]] || { printf '%s\n' 'Unexpected fixture source directory.' >&2; exit 2; }
[[ $(stat -c '%u:%g:%a' "$fixture_source") == 0:0:755 ]] || { printf '%s\n' 'Secret-free source must be root-owned0755 for the non-root publisher.' >&2; exit 2; }
source_files=(broker.cjs broker.d.cts broker.test.cjs codec.test.cjs fixture-client.integration.cjs fixture-provision.cjs fixture-publisher.cjs fixture-server.cjs helper.py helper_test.py recovery-codec.cjs run-disposable-fixture.sh README.md)
for fixture_file in "${source_files[@]}"; do
  [[ -f $fixture_source/$fixture_file && ! -L $fixture_source/$fixture_file ]] || exit 2
  [[ $(stat -c '%u:%g:%a' "$fixture_source/$fixture_file") == 0:0:644 ]] || { printf '%s\n' 'Secret-free source files must be root-owned0644.' >&2; exit 2; }
done
source_digest=$(cd "$fixture_source" && sha256sum -- "${source_files[@]}" | sha256sum | cut -d ' ' -f 1)
[[ $source_digest == "$1" ]] || { printf '%s\n' 'Source differs from the reviewed manifest.' >&2; exit 2; }
audit=/opt/codebandage/audit-managed-target-20261018
[[ -d $audit && ! -L $audit && $(stat -c '%u:%g:%a' "$audit") == 0:0:700 ]] || exit 2
[[ $(df -B1 --output=avail "$audit" | tail -n 1 | tr -d ' ') -ge 5368709120 ]] || { printf '%s\n' 'Less than 5GiB free; no fixture started.' >&2; exit 2; }
image=sha256:da28bd93be2abb9ab8ebfb9d2d9226d1fce32acf022144be618c03aefe45d4e2
[[ $(docker image inspect "$image" --format '{{.Id}}') == "$image" ]] || exit 2
[[ -f /usr/bin/python3.12 && -d /usr/lib/python3.12 && -f /lib/x86_64-linux-gnu/libexpat.so.1 ]] || exit 2
runtime_mounts=(--mount type=bind,src=/usr/bin/python3.12,dst=/usr/bin/python3,readonly --mount type=bind,src=/usr/lib/python3.12,dst=/usr/lib/python3.12,readonly --mount type=bind,src=/lib/x86_64-linux-gnu/libexpat.so.1,dst=/usr/lib/x86_64-linux-gnu/libexpat.so.1,readonly)
common=(--read-only --cap-drop ALL --security-opt no-new-privileges --memory 512m --memory-swap 512m --cpus 0.125 --pids-limit 96 --log-driver local --log-opt max-size=1m --log-opt max-file=2 --label com.codebandage.fixture=managed-target-v1 --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m --env MANAGED_TARGET_DISPOSABLE_FIXTURE=1 --env NODE_PATH=/workspace/node_modules --mount "type=bind,src=$fixture_source,dst=/opt/managed-target,readonly,bind-recursive=disabled")
run_root=$(mktemp -d "$audit/fixture-XXXXXXXX")
chmod 700 "$run_root"
[[ -d $run_root && ! -L $run_root && $(stat -c '%u:%g:%a' "$run_root") == 0:0:700 ]] || exit 2
exec 9>"$run_root/fixture.lock"
flock -n 9 || exit 2
printf '%s\n' "$source_digest" >"$run_root/source-manifest.sha256"
printf '%s\n' "$image" >"$run_root/image-id.txt"
active_containers=()
stop_fixtures() {
  local current
  for current in "${active_containers[@]}"; do timeout --signal=TERM --kill-after=2s 15s docker stop --timeout 3 "$current" >/dev/null 2>&1 || true; done
}
trap stop_fixtures EXIT INT TERM
# Verify the explicitly declared host Python runtime inside this immutable tools image.
docker run --name "cb-mt-python-${run_root##*-}" --network none --user 0:0 "${common[@]}" "${runtime_mounts[@]}" --entrypoint /usr/bin/ldd "$image" /usr/bin/python3 >"$run_root/python-ldd.log" 2>&1
! grep -q 'not found' "$run_root/python-ldd.log" || exit 2
for variant in normal lost-ack; do
  variant_root="$run_root/$variant"
  mkdir -m 700 "$variant_root"
  variant_data="$variant_root/private"
  mkdir -m 700 "$variant_data"
  suffix="${run_root##*-}-$variant"
  network="cb-managed-target-$suffix"
  docker network create --internal --driver bridge --label com.codebandage.fixture=managed-target-v1 "$network" >"$variant_root/network.id"
  [[ $(docker network inspect "$network" --format '{{.Internal}}') == true ]] || exit 2
  docker run --name "cb-mt-provision-$suffix" --network none --user 0:0 "${common[@]}" --mount "type=bind,src=$variant_data,dst=/fixture-private,bind-recursive=disabled" --entrypoint /usr/local/bin/node "$image" /opt/managed-target/fixture-provision.cjs >"$variant_root/provision.log" 2>&1
  helper="cb-mt-helper-$suffix"
  publisher="cb-mt-publisher-$suffix"
  client="cb-mt-client-$suffix"
  fault=0
  [[ $variant != lost-ack ]] || fault=1
  docker run -d --name "$helper" --network "$network" --network-alias managed-target-helper --user 0:0 "${common[@]}" "${runtime_mounts[@]}" \
    --env "MANAGED_TARGET_FIXTURE_DROP_COMMIT_ACK=$fault" \
    --mount "type=bind,src=$variant_data/backing,dst=/managed,bind-recursive=disabled" \
    --mount "type=bind,src=$variant_data/state,dst=/managed-state,bind-recursive=disabled" \
    --mount "type=bind,src=$variant_data/config,dst=/run/managed-target,readonly,bind-recursive=disabled" \
    --mount "type=bind,src=$variant_data/ssh,dst=/run/managed-target-fixture,readonly,bind-recursive=disabled" \
    --entrypoint /usr/local/bin/node "$image" /opt/managed-target/fixture-server.cjs >"$variant_root/helper.id"
  active_containers+=("$helper")
  docker run -d --name "$publisher" --network "$network" --network-alias managed-target-publisher --user 65532:65532 "${common[@]}" \
    --mount "type=bind,src=$variant_data/backing/site,dst=/published,readonly,bind-recursive=disabled" \
    --entrypoint /usr/local/bin/node "$image" /opt/managed-target/fixture-publisher.cjs >"$variant_root/publisher.id"
  active_containers+=("$publisher")
  # Do not dump inspect environments. Inventory only immutable IDs and relevant boundaries.
  for current in "$helper" "$publisher"; do
    docker inspect "$current" --format '{{.Id}} {{.Image}} user={{.Config.User}} readonly={{.HostConfig.ReadonlyRootfs}} capdrop={{json .HostConfig.CapDrop}} security={{json .HostConfig.SecurityOpt}} pid={{.HostConfig.PidMode}} ports={{json .NetworkSettings.Ports}} mounts={{range .Mounts}}{{.Destination}}:{{.RW}}:{{.Propagation}};{{end}}' >>"$variant_root/inventory.log"
    [[ $(docker inspect "$current" --format '{{.HostConfig.ReadonlyRootfs}}') == true ]] || exit 2
    [[ $(docker inspect "$current" --format '{{json .HostConfig.PortBindings}}') == '{}' ]] || exit 2
    [[ -z $(docker inspect "$current" --format '{{.HostConfig.PidMode}}') ]] || exit 2
    [[ $(docker inspect "$current" --format '{{json .HostConfig.CapDrop}}') == '["ALL"]' ]] || exit 2
  done
  [[ $(docker inspect "$publisher" --format '{{range .Mounts}}{{if eq .Destination "/published"}}{{.RW}}:{{.Propagation}}{{end}}{{end}}') == false:rprivate ]] || exit 2
  # Bounded startup wait; no provider/public network calls.
  ready=0
  for attempt in {1..20}; do
    if docker logs "$helper" 2>&1 | grep -q '^MANAGED_TARGET_DISPOSABLE_FIXTURE_READY$' && docker logs "$publisher" 2>&1 | grep -q '^MANAGED_STATIC_READONLY_PUBLICATION_READY$'; then ready=1; break; fi
    sleep 0.2
  done
  [[ $ready == 1 ]] || { docker logs "$helper" >"$variant_root/helper.log" 2>&1; docker logs "$publisher" >"$variant_root/publisher.log" 2>&1; exit 1; }
  # Track the newly created immutable identity before attach/start. A timed-out
  # Docker client cannot leave an untracked fixture running after the trap.
  client_id=$(docker create --name "$client" --network "$network" --user 0:0 "${common[@]}" --env "MANAGED_TARGET_FIXTURE_DROP_COMMIT_ACK=$fault" \
    --mount "type=bind,src=$variant_data/control,dst=/fixture-control,readonly,bind-recursive=disabled" \
    --entrypoint /usr/local/bin/node "$image" /opt/managed-target/fixture-client.integration.cjs)
  [[ $client_id =~ ^[a-f0-9]{64}$ ]] || exit 2
  printf '%s\n' "$client_id" >"$variant_root/client.id"
  active_containers+=("$client_id")
  set +e
  timeout --signal=TERM --kill-after=5s 180s docker start --attach "$client_id" >"$variant_root/client.log" 2>&1
  result=$?
  set -e
  docker logs "$helper" >"$variant_root/helper.log" 2>&1
  docker logs "$publisher" >"$variant_root/publisher.log" 2>&1
  docker inspect "$client" --format 'exit={{.State.ExitCode}} oom={{.State.OOMKilled}} image={{.Image}}' >"$variant_root/client-state.log"
  [[ $result == 0 ]] || { printf '%s\n' "Fixture failed. Private evidence retained: $variant_root" >&2; exit "$result"; }
  [[ $(docker inspect "$client_id" --format '{{.State.ExitCode}}:{{.State.Running}}:{{.State.OOMKilled}}') == 0:false:false ]] || { printf '%s\n' 'Fixture client did not exit successfully; evidence retained.' >&2; exit 1; }
  docker stop --time 3 "$helper" "$publisher" >"$variant_root/stopped.log"
done
printf '%s\n' "DISPOSABLE MANAGED-STATIC FIXTURE PASS. Private evidence: $run_root"
# Retain all exact fixture containers, private key/state files and networks for review.
# A separate approved cleanup may remove these explicit recorded IDs/paths; never broad prune.
