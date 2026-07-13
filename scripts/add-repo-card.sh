#!/bin/bash
# Build a repo social-card entry: renders the DOS_Rebel figlet banner, sizes the
# font to fit the 1280x640 card, and emits a ready-to-paste JSON object for
# frontend/src/app/repo-card/cards.json. Pass --write to splice it in directly.
#
# DOS_Rebel isn't a base figlet font, so it's rendered inside the portfolio
# container image (which ships it) over SSH when it's missing locally — same
# trick as capture-blog-snapshots.sh. The column width is measured with `wc -L`
# on that Linux host too, because BSD wc/awk on macOS miscount the wide block
# glyphs (they count bytes, not columns).
#
# Usage:
#   scripts/add-repo-card.sh <name> [figlet-text]     # print JSON entry
#   scripts/add-repo-card.sh <name> [figlet-text] --write   # insert into cards.json
#
# Env:
#   VPS=root@tim.waldin.net                  render host (default from lib/common.sh)
#   IMAGE=twaldin/terminal-portfolio:latest  image carrying DOS_Rebel
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

require_cmd jq

CARDS_JSON="${REPO_ROOT}/frontend/src/app/repo-card/cards.json"

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; }

# --- args --------------------------------------------------------------------
NAME="" ; TEXT="" ; WRITE=0
while (( $# )); do
  case "$1" in
    --write)   WRITE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*)        die "unknown flag: $1" ;;
    *)
      if   [[ -z "${NAME}" ]]; then NAME="$1"
      elif [[ -z "${TEXT}" ]]; then TEXT="$1"
      else die "too many positional args (name, [figlet-text])"; fi
      shift ;;
  esac
done
[[ -n "${NAME}" ]] || { usage; exit 1; }
TEXT="${TEXT:-${NAME}}"

TMPD="$(mktemp -d)"; trap 'rm -rf "${TMPD}"' EXIT
LINES_FILE="${TMPD}/lines"
COLS=""

# --- render figlet + measure columns -----------------------------------------
# Strip fully-blank lines but KEEP trailing spaces on content lines — they carry
# the horizontal centering of the banner inside the card.
if figlet -f DOS_Rebel test >/dev/null 2>&1; then
  log_info "rendering DOS_Rebel locally"
  printf '%s' "${TEXT}" | figlet -f DOS_Rebel -w 400 | grep -v '^[[:space:]]*$' >"${LINES_FILE}"
  COLS="$(wc -L <"${LINES_FILE}" | tr -d ' ')"
else
  require_cmd ssh
  log_info "DOS_Rebel not local — rendering in ${IMAGE} on ${VPS}"
  # Render AND measure on the remote Linux host; a __COLS__<n> sentinel line
  # carries the wc -L result back alongside the banner.
  remote='f=$(figlet -f DOS_Rebel -w 400 | grep -v "^[[:space:]]*$"); printf "%s\n" "$f"; printf "__COLS__%s\n" "$(printf "%s\n" "$f" | wc -L | tr -d " ")"'
  combined="$(printf '%s' "${TEXT}" | ssh "${VPS}" "docker run --rm -i ${IMAGE} sh -c '${remote}'")"
  COLS="$(printf '%s\n' "${combined}" | sed -n 's/^__COLS__//p')"
  printf '%s\n' "${combined}" | grep -v '^__COLS__' >"${LINES_FILE}"
fi

[[ -s "${LINES_FILE}" ]] || die "figlet produced no output for '${TEXT}'"
[[ "${COLS}" =~ ^[0-9]+$ && "${COLS}" -gt 0 ]] || die "could not measure column width (got '${COLS}')"

# fontSize = min(24, floor(1080 / (0.6 * cols))) — see repo-card/[name]/route.tsx.
FS="$(awk -v c="${COLS}" 'BEGIN{ v=1080/(0.6*c); if(v>24)v=24; printf "%d", v }')"
log_info "cols=${COLS} → fontSize=${FS}"

# --- assemble JSON (ASCII-escaped, matching the existing cards' style) --------
lines_json="$(jq -Rsa 'rtrimstr("\n") | split("\n")' <"${LINES_FILE}")"
entry="$(jq -na \
  --argjson lines "${lines_json}" \
  --arg     tagline "❯ TODO" \
  --argjson fontSize "${FS}" \
  --arg     bar "twaldin/${NAME} — zsh" \
  --arg     url "github.com/twaldin/${NAME}" \
  --arg     accent "primary" \
  '{lines:$lines, tagline:$tagline, fontSize:$fontSize, bar:$bar, url:$url, accent:$accent}')"

# --- write or print ----------------------------------------------------------
if (( WRITE )); then
  [[ -f "${CARDS_JSON}" ]] || die "--write needs an existing cards.json at ${CARDS_JSON}"
  if jq -e --arg n "${NAME}" 'has($n)' "${CARDS_JSON}" >/dev/null; then
    die "card '${NAME}' already exists in cards.json — refusing to clobber"
  fi
  tmp="${TMPD}/cards.json"
  # `. + {new}` appends the key at the end, leaving existing key order intact.
  jq -a --arg n "${NAME}" --argjson e "${entry}" '. + {($n): $e}' "${CARDS_JSON}" >"${tmp}"
  mv "${tmp}" "${CARDS_JSON}"
  log_ok "added '${NAME}' to ${CARDS_JSON} (edit the \"❯ TODO\" tagline + accent)"
else
  log_step "cards.json entry for '${NAME}' — paste into the CARDS map"
  printf '"%s": %s\n' "${NAME}" "${entry}"
  log_dim "tip: edit the \"❯ TODO\" tagline + pick an accent, or re-run with --write"
fi
