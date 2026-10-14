#!/usr/bin/env bash
# Run on deckbox through machine-ok-queue run -- bench/capacity/inotify-edge.sh.
# Reproduce shared root inotify accounting and compare Docker OOM events with
# memory.events at low container count and after exhausting the instance quota.
# This does not change sysctls. All containers, images and scratch are owned.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HERE=$ROOT/bench/capacity
P=capbench-inotify-$(date +%Y%m%d-%H%M%S)-$$
DIND=$P-dind
SCRATCH=$(mktemp -d "/tmp/$P.XXXXXX")
RESULTS=$HERE/results/$P
mkdir -p "$RESULTS"
# A stable directory inode avoids an unlink/recreate race between lock waiters.
exec 9</tmp
flock -n 9 || { echo 'another capacity run holds the shared inotify lock' >&2; rmdir "$SCRATCH"; exit 1; }
cleanup() {
  local status=$?
  [[ -z ${EVENTS_PID:-} ]] || kill "$EVENTS_PID" 2>/dev/null || true
  [[ -z ${HOLDER_PID:-} ]] || kill "$HOLDER_PID" 2>/dev/null || true
  docker logs --timestamps "$DIND" >"$RESULTS/dockerd.log" 2>&1 || true
  docker rm -fv "$DIND" >/dev/null 2>&1 || true
  docker rmi "$P-daemon" >/dev/null 2>&1 || true
  rm -rf "$SCRATCH"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
cc -O2 -static "$HERE/inotify-probe.c" -o "$SCRATCH/probe"
docker build -q -f "$HERE/Dockerfile.dind" -t "$P-daemon" "$HERE" >"$RESULTS/image.txt"
sudo -n "$SCRATCH/probe" quota | tee "$RESULTS/host-before.json"
docker run -d --privileged --name "$DIND" --network none --cpus 3 --cpuset-cpus 1,2,3 \
  --memory 3.8g --memory-swap 5.8g -e DOCKER_TLS_CERTDIR= "$P-daemon" \
  dockerd --host=unix:///var/run/docker.sock >/dev/null
for _ in $(seq 60); do docker exec "$DIND" docker info >/dev/null 2>&1 && break; sleep 1; done
docker exec "$DIND" docker info >"$RESULTS/docker-info.txt"
CG=/sys/fs/cgroup/system.slice/docker-$(docker inspect -f '{{.Id}}' "$DIND").scope
awk '/^oom_kill / { print $2 }' "$CG/memory.events" >"$RESULTS/host-oom-before.txt"
docker exec "$DIND" sh -c 'dockerd --version; containerd --version; runc --version; cat /proc/self/uid_map; cat /proc/sys/fs/inotify/max_user_instances; cat /proc/sys/fs/inotify/max_user_watches' >"$RESULTS/versions.txt"
docker cp -q "$SCRATCH/probe" "$DIND:/probe"
docker exec "$DIND" /probe quota | tee "$RESULTS/dind-before.json"
sudo -n "$SCRATCH/probe" quota | tee "$RESULTS/host-dind-running.json"
docker exec "$DIND" /probe hold >"$RESULTS/holder.txt" &
HOLDER_PID=$!
sleep 1
sudo -n "$SCRATCH/probe" quota | tee "$RESULTS/host-eight-held.json"
docker exec "$DIND" /probe quota | tee "$RESULTS/dind-eight-held.json"
wait "$HOLDER_PID"
unset HOLDER_PID
tar -C "$SCRATCH" -cf - probe | docker exec -i "$DIND" docker import - "$P-probe" >/dev/null
docker exec "$DIND" docker events --format '{{json .}}' >"$RESULTS/events.jsonl" &
EVENTS_PID=$!
for phase in low high; do
  if [[ $phase == high ]]; then
    for i in $(seq 180); do
      if ! docker exec "$DIND" docker run -d --name "$P-idle-$i" --network none \
        --user 1000:1000 --memory 16m --memory-swap 16m --pids-limit 100 --cap-drop ALL \
        "$P-probe" /probe idle >"$RESULTS/start-$i.txt" 2>&1; then
        echo "failed_start=$i" | tee -a "$RESULTS/edge.txt"
      fi
      if ((i % 20 == 0 || (i >= 108 && i <= 116))); then
        printf 'idle_started=%s ' "$i" | tee -a "$RESULTS/edge.txt"
        docker exec "$DIND" /probe quota | tee -a "$RESULTS/edge.txt"
      fi
    done
  fi
  name=$P-oom-$phase
  id=$(docker exec "$DIND" docker run -d --name "$name" --network none --user 1000:1000 \
    --memory 16m --memory-swap 16m --pids-limit 100 --cap-drop ALL "$P-probe" /probe oom)
  docker exec "$DIND" docker wait "$id" >"$RESULTS/oom-$phase.exit"
  docker exec "$DIND" docker logs "$id" | tee "$RESULTS/oom-$phase.memory-events"
  docker exec "$DIND" docker inspect --format '{{json .State}}' "$id" | tee "$RESULTS/oom-$phase.state.json"
  awk '/^oom_kill / { print $2 }' "$CG/memory.events" >"$RESULTS/host-oom-after-$phase.txt"
  printf '%s %s\n' "$phase" "$id" >>"$RESULTS/oom-ids.txt"
done
docker exec "$DIND" docker ps --format '{{.ID}} {{.Names}}' >"$RESULTS/containers.txt"
for phase in low high; do
  id=$(awk -v phase="$phase" '$1 == phase { print $2 }' "$RESULTS/oom-ids.txt")
  events=$(jq -s --arg id "$id" '[.[] | select(.Action == "oom" and .Actor.ID == $id)] | length' "$RESULTS/events.jsonl")
  printf '%s docker_oom_events=%s host_oom_kill=%s\n' "$phase" "$events" "$(cat "$RESULTS/host-oom-after-$phase.txt")" | tee -a "$RESULTS/edge.txt"
done
echo "results=$RESULTS"
