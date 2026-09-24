#!/bin/bash
# Show top 10 IPs by session count, from the admin events log.
# Handy for spotting heavy-hitters (your own IP) and filtering signal.
#
# Usage:
#   ADMIN_PASSWORD=... scripts/admin-top-ips.sh             top 10
#   ADMIN_PASSWORD=... scripts/admin-top-ips.sh 25          top 25

set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

require_cmd curl jq base64

[[ -n "${ADMIN_PASSWORD:-}" ]] || die "ADMIN_PASSWORD env var required"

n="${1:-10}"
[[ "${n}" =~ ^[0-9]+$ ]] || die "expected a number, got: ${n}"

auth_header="$(printf '%s:%s' "${ADMIN_EMAIL}" "${ADMIN_PASSWORD}" | base64 | tr -d '\r\n')"
json="$(printf 'header = "Authorization: Basic %s"\n' "${auth_header}" \
  | curl -fsS --max-time 10 --config - "${ADMIN_URL}/api/sessions")"
unset auth_header

log_step "top ${n} IPs"
printf '  %-5s %-20s %-8s %-8s %s\n' "#" "IP" "SESSIONS" "CMDS" "LAST"
printf '  %-5s %-20s %-8s %-8s %s\n' "-" "--" "--------" "----" "----"

printf '%s' "${json}" | jq -r '
  group_by(.ip)
  | map({
      ip: .[0].ip,
      sessions: length,
      cmds: (map(.commands | length) | add // 0),
      last: (map(.at) | max)
    })
  | sort_by(-.sessions)[]
  | "\(.sessions)\t\(.cmds)\t\(.last)\t\(.ip)"
' | head -n "${n}" | awk -F'\t' '
    {
      n += 1
      ts = strftime("%Y-%m-%d %H:%M UTC", $3/1000)
      printf "  %-5d %-20s %-8d %-8d %s\n", n, $4, $1, $2, ts
    }
  '
