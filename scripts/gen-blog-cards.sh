#!/bin/bash
# Dump the per-post blog share cards (/blog/<slug>/opengraph-image) as PNGs —
# for attaching to tweets/LinkedIn posts directly, or eyeballing a new post's
# card before deploy. The cards themselves are generated automatically at
# build time from each post's frontmatter (title/date) + first paragraph; this
# script only renders them out of a local Next dev server, which it starts if
# nothing is on :3000 (and only tears down a server it started).
#
# Slugs come from container/blog/posts/*.md.
#
# Usage:
#   scripts/gen-blog-cards.sh                    all posts
#   scripts/gen-blog-cards.sh <slug> [<slug>]    specific posts
#
# Env:
#   OUT_DIR=~/Downloads/blog-cards   where PNGs land
#   PORT=3000                        dev-server port to use / probe
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

require_cmd curl

OUT_DIR="${OUT_DIR:-${HOME}/Downloads/blog-cards}"
PORT="${PORT:-3000}"
BASE="http://localhost:${PORT}"
FRONTEND="${REPO_ROOT}/frontend"
POSTS_DIR="${REPO_ROOT}/container/blog/posts"

# --- resolve slugs -----------------------------------------------------------
slugs=()
if (( $# )); then
  slugs=("$@")
else
  [[ -d "${POSTS_DIR}" ]] || die "no posts dir at ${POSTS_DIR}"
  while IFS= read -r f; do slugs+=("$(basename "${f}" .md)"); done \
    < <(find "${POSTS_DIR}" -maxdepth 1 -name '*.md' | sort)
fi
(( ${#slugs[@]} )) || die "found zero posts"
log_info "posts: ${slugs[*]}"

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

probe="${BASE}/blog/${slugs[0]}/opengraph-image"
if curl -sf -m 3 -o /dev/null "${probe}" 2>/dev/null \
   || curl -s -m 3 -o /dev/null "${BASE}" 2>/dev/null; then
  log_info "reusing dev server already on :${PORT}"
else
  require_cmd pnpm
  log_info "starting Next dev server on :${PORT}..."
  ( cd "${FRONTEND}" && exec pnpm dev >/tmp/gen-blog-cards-dev.log 2>&1 ) &
  DEV_PID=$!
  started_server=1
  # Wait for the first card route to compile+respond (Turbopack is lazy).
  for _ in $(seq 1 60); do
    if curl -sf -m 5 -o /dev/null "${probe}" 2>/dev/null; then
      break
    fi
    kill -0 "${DEV_PID}" 2>/dev/null || die "dev server died — see /tmp/gen-blog-cards-dev.log"
    sleep 1
  done
  curl -sf -m 5 -o /dev/null "${probe}" 2>/dev/null \
    || die "dev server never served ${probe} — see /tmp/gen-blog-cards-dev.log"
  log_ok "dev server ready"
fi

# --- fetch every card + verify ----------------------------------------------
log_step "generating ${#slugs[@]} card(s) → ${OUT_DIR}"
ok=0
bad=0
for slug in "${slugs[@]}"; do
  out="${OUT_DIR}/${slug}.png"
  meta="$(curl -sS -m 30 -o "${out}" \
          -w '%{http_code}|%{size_download}|%{content_type}' \
          "${BASE}/blog/${slug}/opengraph-image" 2>/dev/null)" || meta='000|0|error'
  IFS='|' read -r code size ctype <<<"${meta}"
  if [[ "${code}" == 200 && "${ctype}" == image/png* && "${size}" -gt 10240 ]]; then
    log_ok "${slug}  (${size}B)"
    ok=$((ok + 1))
  else
    log_err "${slug}  code=${code} type=${ctype} size=${size}B"
    rm -f "${out}"
    bad=$((bad + 1))
  fi
done

log_step "summary"
printf '  %d ok, %d failed → %s\n' "${ok}" "${bad}" "${OUT_DIR}"
(( bad == 0 )) || exit 1
