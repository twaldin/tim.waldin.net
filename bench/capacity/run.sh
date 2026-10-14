#!/usr/bin/env bash
# Capacity harness: N*, the most concurrent visitor sessions at which every SLO
# in loadgen/loadgen.js holds on an emulated production host. Higher is better.
#
# Run on deckbox (Linux, cgroup v2, Docker) from a checkout, through the queue:
#
#   machine-ok-queue run -- bench/capacity/run.sh --lane 0 --repeat 3
#
# The emulated host is a privileged docker:dind container shaped like the prod
# VPS (3 CPUs, 3.8 GB RAM, 2 GB swap). Inside it run dockerd, the backend and
# socket-proxy from docker-compose.yml (plus compose.bench.yml) and the session
# containers built from this checkout. The load generator runs outside it and
# plays nginx by sending X-Real-IP per virtual visitor.
#
# deckbox is a Ryzen 9 7900: 12 cores, two threads each (cpu N and N+12 share a
# core), cores 0-5 and 6-11 on separate L3 caches. A lane is three whole cores
# on one L3 with their sibling threads left idle; the load generators of all
# lanes share cores 4 and 5, and core 0 is left to the OS. Three lanes can
# measure at once. Each run reports how busy the lane's cores were with work
# that was not its own.
#
#   --lane L          0: cpus 1-3, 1: cpus 6-8, 2: cpus 9-11 (default 0)
#   --repeat K        K runs, each on a fresh backend stack; prints the median N* (default 1)
#   --steps LIST      concurrency ladder; a run stops at its first failing step
#   --warm S          seconds each step settles after its ramp, before measuring (default 30)
#   --measure S       seconds measured per step (default 50)
#   --bisect K        extra steps bisecting between the last pass and the first failure (default 0)
#   --cpus C          host CPUs (default 3)
#   --memory M        host RAM, docker units (default 3.8g)
#   --swap M          host swap, docker units (default 2g)
#   --pool-size P     backend warm pool (default 5, as in production)
#   --seed S          seed of the first run's visitor stream (default 1)
#   --profile         after each run, hold its N* and record a CPU/memory profile
#   --profile-n N     profile an already-measured N rather than this run's highest pass
#
# Results land in bench/capacity/results/<run id>/ (one JSON line per step and
# a summary per run). Everything else it creates is named capbench-<run id>-*
# and removed on exit.
#
# Fixed workload and measurement choices are in loadgen.js. A step adds live
# visitors at <=4/s, settles 30 s (the zombie grace), then measures 50 s. Its
# 80 s steady hold exceeds the 64 s mean lifetime and cycles the churn once.
# The ladder is coarse, roughly 20% between rungs; N* is the highest passing
# tested rung, with an upper bound at the next failing rung. --bisect narrows it.
#
# Simplifications: nginx and Next.js are omitted, including their resident
# memory, TLS and browser/asset work. This isolates terminal-serving capacity,
# not whole-site capacity. All visitors have a 160x45 viewport, visible pages,
# new identities and unique X-Real-IP values (backend/server.js trusts exactly
# that nginx header). No refresh/resume traffic or internet RTT is simulated.
# Blog's static-route traffic is modeled as terminal 'blog'; the five commands
# without reported shares split 30% evenly. Think times/lifetimes are bounded
# lognormals; the lifetime mean is calibrated to ~64 s, not a fitted log trace.
# Four echo probes count in N; two persistent hostile sessions are extra.
# The memory hog holds ~488 MiB of its 512 MiB limit, leaving PTY/shell overhead.
# The CPU abuser forks up to PidsLimit and holds busy children at its 0.5-CPU
# quota. Their cgroup use is printed, and missing hostile work invalidates a run.
# Headroom is memory.current minus inactive_file, not raw total; active cache
# and kernel/slab still count. Raw memory/swap/pressure and Docker events are
# kept so cache subtraction cannot hide OOMs. The Docker 29.9 dind build embeds
# containerd in dockerd; CPU speed/kernel/storage and shared host swap differ
# from the VPS. These are experiment comparisons, not a promise of prod N*.
set -euo pipefail

LANE=0 REPEAT=1 STEPS=120,145,175,210,250,300,360,430,520 WARM=30 MEASURE=50 BISECT=0
CPUS=3 MEMORY=3.8g SWAP=2g POOL_SIZE=5 SEED=1 PROFILE=0 PROFILE_N=
while (($#)); do
  case "$1" in
    --lane) LANE=$2; shift 2 ;;
    --repeat) REPEAT=$2; shift 2 ;;
    --steps) STEPS=$2; shift 2 ;;
    --warm) WARM=$2; shift 2 ;;
    --measure) MEASURE=$2; shift 2 ;;
    --bisect) BISECT=$2; shift 2 ;;
    --cpus) CPUS=$2; shift 2 ;;
    --memory) MEMORY=$2; shift 2 ;;
    --swap) SWAP=$2; shift 2 ;;
    --pool-size) POOL_SIZE=$2; shift 2 ;;
    --seed) SEED=$2; shift 2 ;;
    --profile) PROFILE=1; shift ;;
    --profile-n) PROFILE=1; PROFILE_N=$2; shift 2 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
case $LANE in
  0) HOST_CPUS=1,2,3 ;;
  1) HOST_CPUS=6,7,8 ;;
  2) HOST_CPUS=9,10,11 ;;
  *) echo "--lane must be 0, 1 or 2" >&2; exit 2 ;;
esac
SIBLING_CPUS=$(tr , '\n' <<<"$HOST_CPUS" | awk '{ printf "%s%d", (NR > 1 ? "," : ""), $1 + 12 }')
LOADGEN_CPUS=4,5,16,17

DIND_IMAGE=docker:29-dind@sha256:0b6d18a4a222e71c88be6034926b4f6cde2fc33c2218643d03ccfddc65995470
NODE_IMAGE=node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
PROXY_IMAGE=tecnativa/docker-socket-proxy:v0.5.0@sha256:1f5038b54f06c3e18422902cf00ba21803d1c97805aae032e5e6673d532d3459
COMPOSE_PROJECT=capbench

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HERE=$ROOT/bench/capacity
ID=l${LANE}-$(date +%Y%m%d-%H%M%S)-$$
P=capbench-$ID
RESULTS=$HERE/results/$ID
DIND=$P-dind

to_mib() {
  awk -v v="$1" 'BEGIN { n = v + 0; u = tolower(substr(v, length(v)));
    if (u == "g") n *= 1024; else if (u == "k") n /= 1024; else if (u != "m") n /= 1048576;
    printf "%d", n }'
}
MEMORY_SWAP=$(( $(to_mib "$MEMORY") + $(to_mib "$SWAP") ))m

log() { printf '[run %s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }

LOCK=/tmp/capbench-lane-$LANE.lock
exec 9>"$LOCK"
flock -n 9 || { echo "lane $LANE is busy (another run.sh holds $LOCK)" >&2; exit 1; }
SCRATCH=$(mktemp -d "/tmp/$P.XXXXXX")

cleanup() {
  local status=$?
  if [[ -n ${EVENTS_PID:-} ]]; then kill "$EVENTS_PID" 2>/dev/null || true; fi
  if [[ -d $RESULTS ]]; then docker logs --timestamps "$DIND" >"$RESULTS/dockerd.log" 2>&1 || true; fi
  docker rm -fv "$P-loadgen" "$P-npm" "$DIND" >/dev/null 2>&1 || true
  docker volume rm "$P-var" >/dev/null 2>&1 || true
  docker network rm "$P-net" >/dev/null 2>&1 || true
  docker rmi "$P-session" "$P-backend" >/dev/null 2>&1 || true
  rm -rf "$SCRATCH" "$LOCK"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Jiffies the given cpus spent busy (user nice system irq softirq steal) and in total.
cpu_ticks() {
  awk -v cpus=",$1," '/^cpu[0-9]/ && index(cpus, "," substr($1, 4) ",") {
    busy += $2 + $3 + $4 + $7 + $8 + $9; for (i = 2; i <= NF; i++) total += $i }
    END { print busy, total }' /proc/stat
}
busy_percent() {
  local b0 t0 b1 t1
  read -r b0 t0 < <(cpu_ticks "$1")
  sleep 2
  read -r b1 t1 < <(cpu_ticks "$1")
  echo $(( 100 * (b1 - b0) / (t1 - t0 > 0 ? t1 - t0 : 1) ))
}

mkdir -p "$RESULTS"
{
  echo "id=$ID lane=$LANE cpus=$HOST_CPUS (siblings $SIBLING_CPUS idle) loadgen=$LOADGEN_CPUS"
  echo "host: --cpus $CPUS --memory $MEMORY --memory-swap $MEMORY_SWAP pool=$POOL_SIZE"
  echo "steps=$STEPS warm=$WARM measure=$MEASURE bisect=$BISECT seed=$SEED repeat=$REPEAT"
  echo "commit=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown) dirty_files=$(git -C "$ROOT" status --porcelain 2>/dev/null | wc -l)"
  echo "uptime: $(uptime)"
} >"$RESULTS/config.txt"
log "run $ID: lane $LANE (cpus $HOST_CPUS), $CPUS cpus, $MEMORY ram + $SWAP swap, pool $POOL_SIZE"

# Other tenants on the lane's cores or their sibling threads would slow the emulated host.
busy=$(busy_percent "$HOST_CPUS,$SIBLING_CPUS")
echo "lane threads busy before start: ${busy}%" | tee -a "$RESULTS/config.txt" >&2
((busy < 10)) || log "WARNING: lane $LANE threads are ${busy}% busy before start; the measurement will be noisy"

log "building session and backend images from $ROOT"
docker build -q -t "$P-session" "$ROOT/container" >/dev/null
docker build -q -f "$ROOT/backend/Dockerfile" -t "$P-backend" "$ROOT" >/dev/null
for image in "$DIND_IMAGE" "$NODE_IMAGE" "$PROXY_IMAGE"; do
  docker image inspect "$image" >/dev/null 2>&1 || docker pull -q "$image" >/dev/null
done

cp -R "$HERE/loadgen" "$SCRATCH/loadgen"
rm -rf "$SCRATCH/loadgen/node_modules"
docker run --rm --name "$P-npm" -u "$(id -u):$(id -g)" -e npm_config_cache=/tmp/npm \
  -v "$SCRATCH/loadgen:/app" -w /app "$NODE_IMAGE" npm ci --no-audit --no-fund --loglevel=error >/dev/null

log "starting emulated host $DIND"
docker network create "$P-net" >/dev/null
docker volume create "$P-var" >/dev/null
# An explicit dockerd command keeps the inner Docker API on its unix socket;
# the image's default also opens it unauthenticated on tcp/2375.
docker run -d --privileged --name "$DIND" --hostname "$DIND" --network "$P-net" \
  --cpus "$CPUS" --cpuset-cpus "$HOST_CPUS" --memory "$MEMORY" --memory-swap "$MEMORY_SWAP" \
  -e DOCKER_TLS_CERTDIR= -v "$P-var:/var/lib/docker" "$DIND_IMAGE" \
  dockerd --host=unix:///var/run/docker.sock >/dev/null
for _ in $(seq 60); do docker exec "$DIND" docker info >/dev/null 2>&1 && break; sleep 1; done
docker exec "$DIND" docker info >/dev/null
DIND_CGROUP=/sys/fs/cgroup/system.slice/docker-$(docker inspect -f '{{.Id}}' "$DIND").scope
[[ -r $DIND_CGROUP/memory.current ]] || { echo "cannot read $DIND_CGROUP (need cgroup v2 + systemd driver)" >&2; exit 1; }
docker exec "$DIND" docker events --format '{{json .}}' >"$RESULTS/docker-events.jsonl" &
EVENTS_PID=$!

docker save "$P-session" "$P-backend" "$PROXY_IMAGE" | docker exec -i "$DIND" docker load -q >/dev/null
docker exec "$DIND" docker tag "$P-session" twaldin/terminal-portfolio:latest
docker exec "$DIND" docker tag "${PROXY_IMAGE#*@}" "${PROXY_IMAGE%@*}"
docker exec "$DIND" mkdir -p /bench
docker cp -q "$ROOT/docker-compose.yml" "$DIND:/bench/docker-compose.yml"
docker cp -q "$HERE/compose.bench.yml" "$DIND:/bench/compose.bench.yml"

compose() {
  docker exec -w /bench -e ADMIN_PASSWORD="$P" -e BENCH_BACKEND_IMAGE="$P-backend" \
    -e BENCH_MAX_SESSIONS=100000 -e BENCH_POOL_SIZE="$POOL_SIZE" "$DIND" \
    docker compose -p "$COMPOSE_PROJECT" -f docker-compose.yml -f compose.bench.yml "$@"
}

start_stack() {
  compose up -d --no-build --quiet-pull backend socket-proxy >/dev/null 2>&1
  for _ in $(seq 60); do
    docker exec "$DIND" wget -qO- http://127.0.0.1:3001/health >/dev/null 2>&1 && break
    sleep 1
  done
  docker exec "$DIND" wget -qO- http://127.0.0.1:3001/health >/dev/null
  # The warm pool fills before the first visitor arrives, as on a long-running host.
  sleep 10
}

stop_stack() {
  compose logs --no-color --timestamps backend >"$1" 2>&1 || true
  compose down -v --timeout 20 >/dev/null 2>&1
  docker exec "$DIND" sh -c 'docker ps -aq --filter label=app=terminal-portfolio | xargs -r docker rm -f' >/dev/null
}

loadgen() {
  docker run --rm --name "$P-loadgen" --network "$P-net" --cpuset-cpus "$LOADGEN_CPUS" \
    -u "$(id -u):$(id -g)" -v "$SCRATCH/loadgen:/app:ro" -v "$RESULTS:/out" -v "$DIND_CGROUP:/dind-cg:ro" \
    "$NODE_IMAGE" node /app/loadgen.js --url "http://$DIND:3001" --cgroup /dind-cg \
    --events /out/docker-events.jsonl "$@"
}

# CPU time on the lane's threads that the emulated host did not use itself:
# other tenants, or interrupts handled there.
interference() {
  local b0 t0 s0 st0 u0 b1 t1 s1 st1 u1 secs
  read -r b0 t0 < <(cpu_ticks "$HOST_CPUS")
  read -r s0 st0 < <(cpu_ticks "$SIBLING_CPUS")
  u0=$(awk '/^usage_usec/ { print $2 }' "$DIND_CGROUP/cpu.stat")
  "$@"
  read -r b1 t1 < <(cpu_ticks "$HOST_CPUS")
  read -r s1 st1 < <(cpu_ticks "$SIBLING_CPUS")
  u1=$(awk '/^usage_usec/ { print $2 }' "$DIND_CGROUP/cpu.stat")
  awk -v b=$((b1 - b0)) -v t=$((t1 - t0)) -v s=$((s1 - s0)) -v st=$((st1 - st0)) -v u=$((u1 - u0)) 'BEGIN {
    printf "lane cpus: %.1f%% busy, %.1f%% of it not the emulated host; sibling threads %.1f%% busy\n",
      100 * b / t, 100 * (b / 100 - u / 1e6) / (t / 100), 100 * s / st }'
}

for run in $(seq "$REPEAT"); do
  log "run $run/$REPEAT: ladder $STEPS"
  start_stack
  interference loadgen --steps "$STEPS" --warm "$WARM" --measure "$MEASURE" --bisect "$BISECT" \
    --seed $((SEED + run - 1)) --out "/out/run-$run.jsonl" | tee "$RESULTS/run-$run.lane.txt" >&2
  docker exec "$DIND" docker inspect term-backend \
    --format "backend restarts={{.RestartCount}} oomkilled={{.State.OOMKilled}}" >"$RESULTS/run-$run.backend.txt"
  stop_stack "$RESULTS/run-$run.backend.log"

  n=$(sed -n 's/.*"type":"summary".*"nStar":\([0-9]*\).*/\1/p' "$RESULTS/run-$run.jsonl")
  n=${PROFILE_N:-$n}
  if ((PROFILE)) && [[ -n $n ]]; then
    log "profiling run $run at N=$n on a fresh stack"
    start_stack
    rm -f "$RESULTS/measuring"
    loadgen --steps "$n" --warm "$WARM" --measure 90 --seed 99 --mark /out/measuring \
      --out "/out/profile-$run.jsonl" &
    profiled=$!
    until [[ -e $RESULTS/measuring ]] || ! kill -0 "$profiled" 2>/dev/null; do sleep 1; done
    [[ -e $RESULTS/measuring ]] || { wait "$profiled"; exit 1; }
    "$HERE/profile.sh" "$DIND" "$DIND_CGROUP" 30 >"$RESULTS/profile-$run-n$n.txt"
    wait "$profiled"
    rm -f "$RESULTS/measuring"
    stop_stack "$RESULTS/profile-$run.backend.log"
  fi
done

docker run --rm --name "$P-summary" -v "$RESULTS:/out:ro" -v "$HERE/summarize.js:/summarize.js:ro" "$NODE_IMAGE" \
  node /summarize.js /out | tee "$RESULTS/summary.txt"
log "results in $RESULTS"
