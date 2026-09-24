#!/bin/bash
# Hourly host snapshot, appended to /var/log/term-monitor.log.
# Installed to /usr/local/bin/term-monitor.sh by deploy.sh; root's crontab runs
# it at minute 7 (`7 * * * * /usr/local/bin/term-monitor.sh`).
#
# Every docker call is bounded by `timeout`. The previous version grepped
# /var/log/nginx/access.log through `docker exec`, but nginx:alpine symlinks
# that file to /dev/stdout, so the grep blocked forever; two weeks of hourly
# runs left ~350 hung docker CLIs holding ~2 GB of host RAM and filled swap.
set -u

LOG=/var/log/term-monitor.log
BOUND="timeout 30"

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# Sandbox containers, warm pool included.
SANDBOXES=$($BOUND docker ps -q --filter label=app=terminal-portfolio 2>/dev/null | wc -l)
MEM=$(free -m | awk '/^Mem:/ {printf "used=%dMB avail=%dMB", $3, $7}')
SWAP=$(free -m | awk '/^Swap:/ {printf "%dMB", $3}')
DISK=$(df -h / | awk 'NR==2 {print $5}')
LOAD=$(awk '{print $1}' /proc/loadavg)
# nginx writes its access log to container stdout; stderr carries the error log.
HITS=$($BOUND docker logs --since 1h term-nginx 2>/dev/null | wc -l)

echo "[$TS] sandboxes=$SANDBOXES load=$LOAD $MEM swap=$SWAP disk=$DISK hits_1h=$HITS" >> "$LOG"
