#!/bin/bash
# Fetch session stats from /admin/api/sessions via HTTP basic auth.
# Reads ADMIN_PASSWORD from env — never prints it.
#
# Usage:
#   ADMIN_PASSWORD=... scripts/admin-stats.sh             summary
#   ADMIN_PASSWORD=... scripts/admin-stats.sh --raw       raw JSON
#   ADMIN_PASSWORD=... scripts/admin-stats.sh --live      only still-active sessions

set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

require_cmd curl base64

[[ -n "${ADMIN_PASSWORD:-}" ]] || die "ADMIN_PASSWORD env var required"

raw=0
live_only=0
for arg in "$@"; do
  case "$arg" in
    --raw)  raw=1 ;;
    --live) live_only=1 ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) die "unknown flag: $arg" ;;
  esac
done

auth_header="$(printf '%s:%s' "${ADMIN_EMAIL}" "${ADMIN_PASSWORD}" | base64 | tr -d '\r\n')"
json="$(printf 'header = "Authorization: Basic %s"\n' "${auth_header}" \
  | curl -fsS --max-time 10 --config - "${ADMIN_URL}/api/sessions")"
unset auth_header

if (( raw )); then
  printf '%s\n' "${json}"
  exit 0
fi

require_cmd jq || die "jq required for non-raw mode (brew install jq)"

if (( live_only )); then
  json="$(printf '%s\n' "${json}" | jq '[.[] | select(.endedAt == null)]')"
fi

total="$(printf '%s' "${json}" | jq 'length')"
unique_ips="$(printf '%s' "${json}" | jq '[.[].ip] | unique | length')"
total_cmds="$(printf '%s' "${json}" | jq '[.[].commands | length] | add // 0')"

log_step "admin stats"
printf '  %-20s %s\n' "total sessions:"  "${total}"
printf '  %-20s %s\n' "unique IPs:"      "${unique_ips}"
printf '  %-20s %s\n' "commands typed:"  "${total_cmds}"

log_step "top referrers"
printf '%s' "${json}" | jq -r '.[] | .referrer // "direct"' \
  | awk '{
      # Extract hostname portion only
      sub(/^https?:\/\//, "");
      sub(/\/.*$/, "");
      sub(/^www\./, "");
      print ($0 == "" ? "direct" : $0);
    }' \
  | sort | uniq -c | sort -rn | head -10 \
  | awk '{printf "  %-5s %s\n", $1, $2}'
