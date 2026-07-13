#!/bin/bash
# Post-deploy smoke test of the live site. Fetches the public surface a deploy
# can silently break (OG/Twitter meta, sitemap, static assets, per-post blog
# pages, repo cards, the Socket.IO handshake, TLS expiry) and asserts each one.
# Prints PASS/FAIL per check and exits nonzero if anything failed — safe to run
# as the last step of deploy.sh or from CI.
#
# Usage:
#   scripts/smoke-test.sh                 # test https://tim.waldin.net
#   BASE=http://localhost:3000 scripts/smoke-test.sh
#
# Env:
#   BASE=https://tim.waldin.net   site under test (default)
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

require_cmd curl openssl

BASE="${BASE:-https://tim.waldin.net}"
BASE="${BASE%/}"                       # tolerate a trailing slash in the override
POSTS_DIR="${REPO_ROOT}/container/blog/posts"

TMPD="$(mktemp -d)"
BODY="${TMPD}/body"
trap 'rm -rf "${TMPD}"' EXIT

PASS_N=0
FAIL_N=0
ROWS=()

# Fetch a URL: body → $BODY, echo "code|bytes|content-type". curl's own -w keeps
# us from parsing headers by hand; a hard connection failure degrades to 000.
probe() {
  local out
  out="$(curl -sS -m 25 -o "${BODY}" \
         -w '%{http_code}|%{size_download}|%{content_type}' "$1" 2>/dev/null)" \
    || out='000|0|connect-error'
  printf '%s' "${out}"
}

# record STATUS NAME DETAIL — tally + log + stash for the summary table.
record() {
  local st="$1" name="$2" detail="$3"
  ROWS+=("${st}|${name}|${detail}")
  if [[ "${st}" == PASS ]]; then
    PASS_N=$((PASS_N + 1)); log_ok "${name} — ${detail}"
  else
    FAIL_N=$((FAIL_N + 1)); log_err "${name} — ${detail}"
  fi
}

log_step "smoke-testing ${BASE}"

# --- homepage: 200 + OG image + Twitter card ---------------------------------
IFS='|' read -r code _ _ <<<"$(probe "${BASE}/")"
if [[ "${code}" == 200 ]] && grep -qi 'og:image' "${BODY}" && grep -qi 'twitter:card' "${BODY}"; then
  record PASS "homepage" "200, og:image + twitter:card present"
else
  record FAIL "homepage" "code=${code}, og:image=$(grep -qi og:image "${BODY}" && echo y || echo n), twitter:card=$(grep -qi twitter:card "${BODY}" && echo y || echo n)"
fi

# --- sitemap: 200 + lists blog URLs ------------------------------------------
IFS='|' read -r code _ _ <<<"$(probe "${BASE}/sitemap.xml")"
if [[ "${code}" == 200 ]] && grep -q '/blog/' "${BODY}"; then
  record PASS "sitemap.xml" "200, $(grep -o '/blog/' "${BODY}" | wc -l | tr -d ' ') blog URL(s)"
else
  record FAIL "sitemap.xml" "code=${code}, contains /blog/=$(grep -q /blog/ "${BODY}" && echo y || echo n)"
fi

# --- opengraph-image: 200 image/png ------------------------------------------
IFS='|' read -r code size ctype <<<"$(probe "${BASE}/opengraph-image")"
if [[ "${code}" == 200 && "${ctype}" == image/png* ]]; then
  record PASS "opengraph-image" "200, ${ctype}, ${size}B"
else
  record FAIL "opengraph-image" "code=${code}, type=${ctype}"
fi

# --- resume.pdf: 200 and non-trivial size (>10KB) ----------------------------
IFS='|' read -r code size ctype <<<"$(probe "${BASE}/resume.pdf")"
if [[ "${code}" == 200 && "${size}" -gt 10240 ]]; then
  record PASS "resume.pdf" "200, ${ctype}, ${size}B"
else
  record FAIL "resume.pdf" "code=${code}, size=${size}B (want >10240)"
fi

# --- robots.txt --------------------------------------------------------------
IFS='|' read -r code _ _ <<<"$(probe "${BASE}/robots.txt")"
if [[ "${code}" == 200 ]]; then
  record PASS "robots.txt" "200"
else
  record FAIL "robots.txt" "code=${code}"
fi

# --- each blog post: 200 + og:image (drives crawler previews) ----------------
if [[ -d "${POSTS_DIR}" ]]; then
  for f in "${POSTS_DIR}"/*.md; do
    [[ -f "${f}" ]] || continue
    slug="$(basename "${f}" .md)"
    IFS='|' read -r code _ _ <<<"$(probe "${BASE}/blog/${slug}")"
    # The og:image must be the post's own card, not the generic site image.
    if [[ "${code}" == 200 ]] && grep -qi "og:image\" content=\"[^\"]*/blog/${slug}/opengraph-image" "${BODY}"; then
      record PASS "blog/${slug}" "200, per-post og:image"
    else
      record FAIL "blog/${slug}" "code=${code}, per-post og:image=$(grep -qi "/blog/${slug}/opengraph-image" "${BODY}" && echo y || echo n)"
    fi
  done
else
  record FAIL "blog posts" "posts dir not found: ${POSTS_DIR}"
fi

# --- repo card: 200 image/png ------------------------------------------------
IFS='|' read -r code size ctype <<<"$(probe "${BASE}/repo-card/hone")"
if [[ "${code}" == 200 && "${ctype}" == image/png* ]]; then
  record PASS "repo-card/hone" "200, ${ctype}, ${size}B"
else
  record FAIL "repo-card/hone" "code=${code}, type=${ctype}"
fi

# --- Socket.IO handshake: Engine.IO open packet starts with '0{' --------------
sio="$(curl -sS -m 15 "${BASE}/socket.io/?EIO=4&transport=polling" 2>/dev/null || true)"
if [[ "${sio}" == '0{'* ]]; then
  record PASS "socket.io handshake" "open packet ok (${sio:0:24}...)"
else
  record FAIL "socket.io handshake" "unexpected payload: ${sio:0:24}"
fi

# --- TLS cert: more than 14 days of validity left ----------------------------
host="${BASE#*://}"; host="${host%%/*}"
if [[ "${BASE}" == https://* ]]; then
  cert="${TMPD}/cert.pem"
  echo | openssl s_client -connect "${host}:443" -servername "${host}" 2>/dev/null \
    | openssl x509 -outform pem >"${cert}" 2>/dev/null || true
  if [[ -s "${cert}" ]]; then
    end="$(openssl x509 -in "${cert}" -noout -enddate 2>/dev/null | cut -d= -f2)"
    # -checkend does the >14d assertion portably (no date-math needed for pass/fail).
    days=""
    end_epoch="$(date -j -f '%b %e %T %Y %Z' "${end}" +%s 2>/dev/null || date -d "${end}" +%s 2>/dev/null || echo '')"
    [[ -n "${end_epoch}" ]] && days=$(( (end_epoch - $(date +%s)) / 86400 ))
    if openssl x509 -in "${cert}" -noout -checkend $((14 * 86400)) >/dev/null 2>&1; then
      record PASS "TLS cert" "${days:+${days} days left, }expires ${end}"
    else
      record FAIL "TLS cert" "expires within 14 days${days:+ (${days} left)}: ${end}"
    fi
  else
    record FAIL "TLS cert" "could not retrieve certificate from ${host}:443"
  fi
else
  record PASS "TLS cert" "skipped (BASE is not https)"
fi

# --- summary table -----------------------------------------------------------
log_step "summary"
printf '  %-4s  %s\n' "----" "--------------------------------------------"
for row in "${ROWS[@]}"; do
  IFS='|' read -r st name detail <<<"${row}"
  if [[ "${st}" == PASS ]]; then mark="${C_GREEN}PASS${C_RESET}"; else mark="${C_RED}FAIL${C_RESET}"; fi
  printf '  %b  %-20s %s\n' "${mark}" "${name}" "${detail}"
done
printf '\n  %d passed, %d failed (%d checks)\n' "${PASS_N}" "${FAIL_N}" "$((PASS_N + FAIL_N))"

(( FAIL_N == 0 )) || exit 1
