#!/usr/bin/env bash
# Memory and CPU breakdown of a loaded emulated host (run.sh --profile):
#
#   profile.sh <dind container> <dind cgroup dir> [cpu window seconds, default 30]
#
# Memory: the host cgroup's memory.stat, then memory.current per child cgroup
# (/init holds dockerd, containerd and every containerd-shim; /docker/<id> is one
# container) and Pss per process. CPU: cpu.stat deltas per cgroup over the
# window, then per-process deltas. Sessions destroyed inside the window take
# their cgroup with them, so session CPU is the host total minus the rest.
set -euo pipefail
DIND=$1 CG=$2 SECS=${3:-30}

# pid cgroup comm cpu-ticks pss-kB rss-kB, one line per process in the host.
# Processes exit mid-scan; their unreadable files are skipped.
procs() {
  docker exec "$DIND" sh -c '
    exec 2>/dev/null
    for p in /proc/[0-9]*; do
      read -r stat < "$p/stat" || continue
      read -r cg < "$p/cgroup" || continue
      comm=${stat#*\(}; comm=${comm%%\)*}
      set -- ${stat##*) }
      pss=0; rss=0
      while read -r k v _; do
        case $k in Pss:) pss=$v ;; Rss:) rss=$v ;; esac
      done < "$p/smaps_rollup"
      echo "${p#/proc/} ${cg#0::} $comm $(( ${12} + ${13} )) $pss $rss"
    done'
}

# cgroup class: init, backend, socket-proxy, session, other
classes() {
  docker exec "$DIND" docker ps -a --no-trunc --format '{{.ID}} {{.Names}} {{.Label "app"}}' |
    awk '{ c = $3 == "terminal-portfolio" ? "session" : $2 == "term-backend" ? "backend" : $2 == "term-socket-proxy" ? "socket-proxy" : "other"; print "/docker/" $1, c }'
}

cgroup_cpu() {
  echo "/ $(awk '/^usage_usec/ { print $2 }' "$CG/cpu.stat")"
  echo "/init $(awk '/^usage_usec/ { print $2 }' "$CG/init/cpu.stat")"
  for d in "$CG"/docker/*/; do
    [[ -f $d/cpu.stat ]] || continue
    echo "/docker/$(basename "$d") $(awk '/^usage_usec/ { print $2 }' "$d/cpu.stat" 2>/dev/null || echo 0)"
  done
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
classes >"$tmp/classes"
cgroup_cpu >"$tmp/cpu0"
awk '/^(user|system)_usec/ { print }' "$CG/cpu.stat" >"$tmp/us0"
procs >"$tmp/procs0"
sleep "$SECS"
classes >>"$tmp/classes"
cgroup_cpu >"$tmp/cpu1"
awk '/^(user|system)_usec/ { print }' "$CG/cpu.stat" >"$tmp/us1"
procs >"$tmp/procs1"
sort -u "$tmp/classes" -o "$tmp/classes"

MiB=1048576
echo "== host memory (cgroup $(basename "$CG")) =="
awk -v mib=$MiB '
  FILENAME ~ /memory.stat$/ { s[$1] = $2; next }
  FILENAME ~ /memory.current$/ { cur = $1; next }
  FILENAME ~ /memory.max$/ { max = $1; next }
  FILENAME ~ /memory.swap.current$/ { swap = $1; next }
  END {
    printf "memory.current %d MiB of %d MiB; swap %d MiB\n", cur / mib, max / mib, swap / mib
    printf "working set (current - inactive_file) %d MiB = %.1f%% of max\n", (cur - s["inactive_file"]) / mib, 100 * (cur - s["inactive_file"]) / max
    n = split("anon file active_file inactive_file shmem kernel kernel_stack pagetables sock slab_reclaimable slab_unreclaimable percpu", k, " ")
    for (i = 1; i <= n; i++) printf "  %-20s %6d MiB\n", k[i], s[k[i]] / mib
  }' "$CG/memory.stat" "$CG/memory.current" "$CG/memory.max" "$CG/memory.swap.current"

echo
echo "== memory by cgroup =="
{
  echo "/init $(cat "$CG/init/memory.current") $(awk '$1 == "anon" || $1 == "file" || $1 == "kernel" { printf "%s ", $2 }' "$CG/init/memory.stat")"
  for d in "$CG"/docker/*/; do
    [[ -f $d/memory.current ]] || continue
    echo "/docker/$(basename "$d") $(cat "$d/memory.current" 2>/dev/null || echo 0) $(awk '$1 == "anon" || $1 == "file" || $1 == "kernel" { printf "%s ", $2 }' "$d/memory.stat" 2>/dev/null)"
  done
} | awk -v mib=$MiB -v total="$(cat "$CG/memory.current")" '
  NR == FNR { cls[$1] = $2; next }
  { c = $1 == "/init" ? "init (dockerd, containerd, shims)" : ($1 in cls ? cls[$1] : "other");
    n[c]++; cur[c] += $2; anon[c] += $3; file[c] += $4; kern[c] += $5; sum += $2
    if (c == "session") { v[++m] = $2 } }
  END {
    printf "%-36s %5s %9s %9s %9s %9s\n", "class", "count", "currMiB", "anonMiB", "fileMiB", "kernMiB"
    for (c in n) printf "%-36s %5d %9.1f %9.1f %9.1f %9.1f\n", c, n[c], cur[c] / mib, anon[c] / mib, file[c] / mib, kern[c] / mib
    printf "%-36s %5s %9.1f\n", "not in a child cgroup (reparented)", "", (total - sum) / mib
    if (m) {
      for (i = 1; i <= m; i++) for (j = i + 1; j <= m; j++) if (v[j] < v[i]) { t = v[i]; v[i] = v[j]; v[j] = t }
      printf "session container memory.current: mean %.1f MiB, median %.1f MiB, max %.1f MiB\n", cur["session"] / m / mib, v[int((m + 1) / 2)] / mib, v[m] / mib
    }
  }' "$tmp/classes" -

echo
echo "== Pss by process (kB, summed per class and command) =="
awk 'NR == FNR { cls[$1] = $2; next }
  { c = $2 == "/init" ? "init" : ($2 in cls ? cls[$2] : "other"); key = c " " $3; n[key]++; pss[key] += $5; rss[key] += $6 }
  END { for (k in n) printf "%-40s %5d procs  Pss %8d kB  Rss %8d kB\n", k, n[k], pss[k], rss[k] }' \
  "$tmp/classes" "$tmp/procs1" | sort -k6 -n -r | head -25

echo
echo "== CPU over ${SECS}s, in cores (the host has $(awk '{ printf "%g", $1 / $2 }' "$CG/cpu.max")) =="
awk -v secs="$SECS" '
  FILENAME ~ /us0$/ { u0[$1] = $2; next }
  FILENAME ~ /us1$/ { u1[$1] = $2; next }
  END { printf "user %.2f, system %.2f\n", (u1["user_usec"] - u0["user_usec"]) / secs / 1e6, (u1["system_usec"] - u0["system_usec"]) / secs / 1e6 }' \
  "$tmp/us0" "$tmp/us1"
awk -v secs="$SECS" '
  FILENAME ~ /classes$/ { cls[$1] = $2; next }
  FILENAME ~ /cpu0$/ { a[$1] = $2; next }
  { if ($1 in a) d = $2 - a[$1]; else next
    if ($1 == "/") total = d; else if ($1 == "/init") init = d; else { c = $1 in cls ? cls[$1] : "other"; by[c] += d } }
  END {
    printf "%-48s %6.2f\n", "host total", total / secs / 1e6
    printf "%-48s %6.2f\n", "init (dockerd, containerd, shims, runc)", init / secs / 1e6
    rest = total - init
    for (c in by) if (c != "session") { printf "%-48s %6.2f\n", c, by[c] / secs / 1e6; rest -= by[c] }
    printf "%-48s %6.2f\n", "sessions incl. destroyed (total minus the rest)", rest / secs / 1e6
  }' "$tmp/classes" "$tmp/cpu0" "$tmp/cpu1"

echo
echo "== top processes by CPU over ${SECS}s (alive at both ends; cores) =="
awk -v secs="$SECS" 'FILENAME ~ /classes$/ { cls[$1] = $2; next }
  FILENAME ~ /procs0$/ { t0[$1 " " $3] = $4; next }
  { k = $1 " " $3; if (!(k in t0)) next; c = $2 == "/init" ? "init" : ($2 in cls ? cls[$2] : "other")
    key = c " " $3; d[key] += ($4 - t0[k]); n[key]++ }
  END { for (k in d) printf "%-40s %5d procs %6.3f\n", k, n[k], d[k] / 100 / secs }' \
  "$tmp/classes" "$tmp/procs0" "$tmp/procs1" | sort -k5 -n -r | head -15
