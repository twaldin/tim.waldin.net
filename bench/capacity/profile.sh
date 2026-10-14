#!/usr/bin/env bash
# Memory and CPU breakdown of a loaded emulated host (run.sh --profile):
#
#   profile.sh <dind container> <dind cgroup dir> [window seconds, default 30] [live visitors]
#
# Memory: the host cgroup's memory.stat, then memory.current per child cgroup
# (/init holds dockerd, containerd and every containerd-shim; /docker/<id> is one
# container) and Pss per process. CPU: cpu.stat deltas per cgroup over the
# window, then per-process deltas. Sessions destroyed inside the window take
# their cgroup with them, so session CPU is the host total minus the rest.
# With a visitor count, CPU is also core-seconds per session-minute and cgroup
# working sets are MiB per live session. Fixed hostiles, zombies and spares are
# included. Pss splits the daemon's user-space processes; kernel charges cannot
# be assigned to an individual daemon/shim from these counters.
set -euo pipefail
DIND=$1 CG=$2 SECS=${3:-30} VISITORS=${4:-0}

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
start=$(awk '{print $1}' /proc/uptime)
awk '/^(user|system)_usec/ { print }' "$CG/cpu.stat" >"$tmp/us0"
cgroup_cpu >"$tmp/cpu0"
procs >"$tmp/procs0"
sleep "$SECS"
classes >>"$tmp/classes"
end=$(awk '{print $1}' /proc/uptime)
awk '/^(user|system)_usec/ { print }' "$CG/cpu.stat" >"$tmp/us1"
cgroup_cpu >"$tmp/cpu1"
procs >"$tmp/procs1"
SPAN=$(awk -v start="$start" -v end="$end" 'BEGIN { print end - start }')
sort -u "$tmp/classes" -o "$tmp/classes"

MiB=1048576
echo "== host memory (cgroup $(basename "$CG")) =="
awk -v mib=$MiB -v visitors="$VISITORS" '
  FILENAME ~ /memory.stat$/ { s[$1] = $2; next }
  FILENAME ~ /memory.current$/ { cur = $1; next }
  FILENAME ~ /memory.max$/ { max = $1; next }
  FILENAME ~ /memory.swap.current$/ { swap = $1; next }
  END {
    printf "memory.current %d MiB of %d MiB; swap %d MiB\n", cur / mib, max / mib, swap / mib
    printf "working set (current - inactive_file) %d MiB = %.1f%% of max\n", (cur - s["inactive_file"]) / mib, 100 * (cur - s["inactive_file"]) / max
    if (visitors > 0) printf "fixed N=%d: working set %.4f MiB/session\n", visitors, (cur - s["inactive_file"]) / mib / visitors
    n = split("anon file active_file inactive_file shmem kernel kernel_stack pagetables sock slab_reclaimable slab_unreclaimable percpu", k, " ")
    for (i = 1; i <= n; i++) printf "  %-20s %6d MiB\n", k[i], s[k[i]] / mib
  }' "$CG/memory.stat" "$CG/memory.current" "$CG/memory.max" "$CG/memory.swap.current"

echo
echo "== memory by cgroup =="
{
  echo "/init $(cat "$CG/init/memory.current") $(awk '$1 == "anon" || $1 == "file" || $1 == "kernel" || $1 == "inactive_file" { printf "%s ", $2 }' "$CG/init/memory.stat")"
  for d in "$CG"/docker/*/; do
    [[ -f $d/memory.current ]] || continue
    echo "/docker/$(basename "$d") $(cat "$d/memory.current" 2>/dev/null || echo 0) $(awk '$1 == "anon" || $1 == "file" || $1 == "kernel" || $1 == "inactive_file" { printf "%s ", $2 }' "$d/memory.stat" 2>/dev/null)"
  done
} | awk -v mib=$MiB -v total="$(cat "$CG/memory.current")" -v visitors="$VISITORS" '
  NR == FNR { cls[$1] = $2; next }
  { c = $1 == "/init" ? "init (dockerd, containerd, shims)" : ($1 in cls ? cls[$1] : "other");
    n[c]++; cur[c] += $2; anon[c] += $3; file[c] += $4; kern[c] += $5; ws[c] += $2 - $6; sum += $2
    if (c == "session") { v[++m] = $2 } }
  END {
    printf "%-36s %5s %9s %9s %9s %9s %9s %14s\n", "class", "count", "currMiB", "anonMiB", "fileMiB", "kernMiB", "wsMiB", "wsMiB/session"
    for (c in n) printf "%-36s %5d %9.1f %9.1f %9.1f %9.1f %9.1f %14s\n", c, n[c], cur[c] / mib, anon[c] / mib, file[c] / mib, kern[c] / mib, ws[c] / mib, (visitors > 0 ? sprintf("%.4f", ws[c] / mib / visitors) : "-")
    printf "%-36s %5s %9.1f\n", "not in a child cgroup (reparented)", "", (total - sum) / mib
    if (m) {
      for (i = 1; i <= m; i++) for (j = i + 1; j <= m; j++) if (v[j] < v[i]) { t = v[i]; v[i] = v[j]; v[j] = t }
      printf "session container memory.current: mean %.1f MiB, median %.1f MiB, max %.1f MiB\n", cur["session"] / m / mib, v[int((m + 1) / 2)] / mib, v[m] / mib
    }
  }' "$tmp/classes" -

echo
echo "== Pss by process (kB, summed per class and command) =="
awk -v visitors="$VISITORS" 'NR == FNR { cls[$1] = $2; next }
  { c = $2 == "/init" ? "init" : ($2 in cls ? cls[$2] : "other"); key = c " " $3; n[key]++; pss[key] += $5; rss[key] += $6 }
  END { for (k in n) printf "%-40s %5d procs  Pss %8d kB  Rss %8d kB  PssMiB/session %s\n", k, n[k], pss[k], rss[k], (visitors > 0 ? sprintf("%.4f", pss[k] / 1024 / visitors) : "-") }' \
  "$tmp/classes" "$tmp/procs1" | sort -k6 -n -r | head -25

echo
# Enumerating hundreds of processes takes time too; use the actual interval,
# not just sleep's requested duration, or CPU use can appear to exceed the cap.
echo "== CPU over ${SPAN}s, in cores (the host has $(awk '{ printf "%g", $1 / $2 }' "$CG/cpu.max")) =="
echo "sample uptime $start..$end; requested sleep ${SECS}s"
awk -v secs="$SPAN" '
  FILENAME ~ /us0$/ { u0[$1] = $2; next }
  FILENAME ~ /us1$/ { u1[$1] = $2; next }
  END { printf "user %.2f, system %.2f\n", (u1["user_usec"] - u0["user_usec"]) / secs / 1e6, (u1["system_usec"] - u0["system_usec"]) / secs / 1e6 }' \
  "$tmp/us0" "$tmp/us1"
awk -v secs="$SPAN" -v visitors="$VISITORS" '
  function row(label, cores) {
    printf "%-48s %6.3f", label, cores
    if (visitors > 0) printf "  %7.4f CPU-s/session-min", cores * 60 / visitors
    printf "\n"
  }
  FILENAME ~ /classes$/ { cls[$1] = $2; next }
  FILENAME ~ /cpu0$/ { a[$1] = $2; next }
  { if ($1 in a) d = $2 - a[$1]; else next
    if ($1 == "/") total = d; else if ($1 == "/init") init = d; else { c = $1 in cls ? cls[$1] : "other"; by[c] += d } }
  END {
    row("host total", total / secs / 1e6)
    row("init (dockerd, containerd, shims, runc)", init / secs / 1e6)
    rest = total - init
    for (c in by) if (c != "session") { row(c, by[c] / secs / 1e6); rest -= by[c] }
    row("sessions incl. destroyed (total minus the rest)", rest / secs / 1e6)
  }' "$tmp/classes" "$tmp/cpu0" "$tmp/cpu1"

echo
echo "== top processes by CPU over ${SPAN}s (alive at both ends; cores) =="
awk -v secs="$SPAN" -v visitors="$VISITORS" 'FILENAME ~ /classes$/ { cls[$1] = $2; next }
  FILENAME ~ /procs0$/ { t0[$1 " " $3] = $4; next }
  { k = $1 " " $3; if (!(k in t0)) next; c = $2 == "/init" ? "init" : ($2 in cls ? cls[$2] : "other")
    key = c " " $3; d[key] += ($4 - t0[k]); n[key]++ }
  END { for (k in d) printf "%-40s %5d procs %6.3f  CPU-s/session-min %s\n", k, n[k], d[k] / 100 / secs, (visitors > 0 ? sprintf("%.4f", d[k] / 100 / secs * 60 / visitors) : "-") }' \
  "$tmp/classes" "$tmp/procs0" "$tmp/procs1" | sort -k5 -n -r | head -15
awk -v secs="$SPAN" -v visitors="$VISITORS" '
  FILENAME ~ /cpu0$/ { if ($1 == "/init") i0 = $2; next }
  FILENAME ~ /cpu1$/ { if ($1 == "/init") i1 = $2; next }
  FILENAME ~ /procs0$/ { t0[$1 " " $3] = $4; next }
  $2 == "/init" && ($1 " " $3) in t0 { alive += $4 - t0[$1 " " $3] }
  END {
    short = (i1 - i0) / 1e6 / secs - alive / 100 / secs
    printf "init: %.3f cores in processes alive throughout the window, %.3f in processes that started or exited inside it (runc, shims of destroyed containers)\n", alive / 100 / secs, short
    if (visitors > 0) printf "init started/exited: %.4f CPU-s/session-min\n", short * 60 / visitors
  }' \
  "$tmp/cpu0" "$tmp/cpu1" "$tmp/procs0" "$tmp/procs1"
