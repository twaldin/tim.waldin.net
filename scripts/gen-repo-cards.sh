#!/bin/bash
# Regenerate the repo social-card PNGs (/repo-card/<name>) into a folder you can
# drag onto GitHub repo settings / README banners. Renders against a local Next
# dev server — starts one if nothing is already on :3000, and only tears down the
# server it started (an already-running dev server is left alone).
#
# Card names come from frontend/src/app/repo-card/cards.json (jq keys); if that
# file doesn't exist yet, names are parsed out of the [name]/route.tsx CARDS map.
#
# Usage:
#   scripts/gen-repo-cards.sh
#   OUT_DIR=/tmp/cards scripts/gen-repo-cards.sh
#
# Env:
#   OUT_DIR=~/Downloads/repo-cards   where PNGs land
#   PORT=3000                        dev-server port to use / probe
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

require_cmd curl

OUT_DIR="${OUT_DIR:-${HOME}/Downloads/repo-cards}"
PORT="${PORT:-3000}"
BASE="http://localhost:${PORT}"
FRONTEND="${REPO_ROOT}/frontend"
CARDS_JSON="${FRONTEND}/src/app/repo-card/cards.json"
ROUTE_TSX="${FRONTEND}/src/app/repo-card/[name]/route.tsx"

# --- resolve card names ------------------------------------------------------
names=()
if [[ -f "${CARDS_JSON}" ]] && command -v jq >/dev/null 2>&1; then
  log_info "reading card names from cards.json"
  while IFS= read -r n; do names+=("$n"); done < <(jq -r 'keys[]' "${CARDS_JSON}")
elif [[ -f "${ROUTE_TSX}" ]]; then
  log_info "cards.json not found — parsing names from route.tsx"
  # Card keys sit at one-space indent inside CARDS ( `"hone": {` ); the nested
  # object keys (lines/tagline/...) are indented deeper, so anchoring on the
  # single leading space + `: {` picks out exactly the repo names.
  while IFS= read -r n; do names+=("$n"); done < <(
    grep -E '^ "[^"]+": \{' "${ROUTE_TSX}" | sed -E 's/^ "([^"]+)".*/\1/'
  )
else
  die "no cards.json and no route.tsx — nothing to generate"
fi

(( ${#names[@]} )) || die "found zero card names"
log_info "cards: ${names[*]}"

mkdir -p "${OUT_DIR}"

# --- ensure a dev server is up ----------------------------------------------
started_server=0
DEV_PID=""
cleanup() {
  # Only kill what we launched; leave a pre-existing dev server running.
  if (( started_server )) && [[ -n "${DEV_PID}" ]]; then
    log_info "stopping dev server we started (pid ${DEV_PID})"
    kill "${DEV_PID}" 2>/dev/null || true
    wait "${DEV_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if curl -sf -m 3 -o /dev/null "${BASE}/repo-card/${names[0]}" 2>/dev/null \
   || curl -s -m 3 -o /dev/null "${BASE}" 2>/dev/null; then
  log_info "reusing dev server already on :${PORT}"
else
  require_cmd pnpm
  log_info "starting Next dev server on :${PORT}..."
  ( cd "${FRONTEND}" && exec pnpm dev >/tmp/gen-repo-cards-dev.log 2>&1 ) &
  DEV_PID=$!
  started_server=1
  # Wait for the first card route to compile+respond (Turbopack is lazy).
  for _ in $(seq 1 60); do
    if curl -sf -m 5 -o /dev/null "${BASE}/repo-card/${names[0]}" 2>/dev/null; then
      break
    fi
    kill -0 "${DEV_PID}" 2>/dev/null || die "dev server died — see /tmp/gen-repo-cards-dev.log"
    sleep 1
  done
  curl -sf -m 5 -o /dev/null "${BASE}/repo-card/${names[0]}" 2>/dev/null \
    || die "dev server never served ${BASE}/repo-card/${names[0]} — see /tmp/gen-repo-cards-dev.log"
  log_ok "dev server ready"
fi

# --- fetch every card + verify ----------------------------------------------
log_step "generating ${#names[@]} card(s) → ${OUT_DIR}"
ok=0
bad=0
for name in "${names[@]}"; do
  out="${OUT_DIR}/${name}.png"
  meta="$(curl -sS -m 30 -o "${out}" \
          -w '%{http_code}|%{size_download}|%{content_type}' \
          "${BASE}/repo-card/${name}" 2>/dev/null)" || meta='000|0|error'
  IFS='|' read -r code size ctype <<<"${meta}"
  if [[ "${code}" == 200 && "${ctype}" == image/png* && "${size}" -gt 10240 ]]; then
    log_ok "${name}  (${size}B)"
    ok=$((ok + 1))
  else
    log_err "${name}  code=${code} type=${ctype} size=${size}B"
    rm -f "${out}"
    bad=$((bad + 1))
  fi
done

log_step "summary"
printf '  %d ok, %d failed → %s\n' "${ok}" "${bad}" "${OUT_DIR}"
(( bad == 0 )) || exit 1
