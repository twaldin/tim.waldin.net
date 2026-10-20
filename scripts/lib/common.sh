#!/bin/bash
# Shared helpers sourced by every script under scripts/.
# Exports: VPS, VPS_USER, DEPLOY_PATH, IMAGE, colors, logging helpers,
# and a few guard functions used across the deploy/ops scripts.
#
# Usage:
#   source "$(dirname "$0")/lib/common.sh"
#   # ... now use log_info, log_err, die, require_cmd, on_vps, etc.

set -euo pipefail

# ---- Configuration -----------------------------------------------------------

# VPS target for deploy / diagnostic scripts. Override via env vars when
# running from a different shell or CI.
VPS_USER="${VPS_USER:-root}"
VPS_HOST="${VPS_HOST:-tim.waldin.net}"
VPS="${VPS:-${VPS_USER}@${VPS_HOST}}"

# Canonical deploy-user working copy on the VPS.
DEPLOY_USER="${DEPLOY_USER:-deploy}"
DEPLOY_PATH="${DEPLOY_PATH:-/home/${DEPLOY_USER}/term-site}"

# Docker image names. The session backend hard-codes the portfolio image name,
# so the build scripts must produce this exact tag or new sessions spawn the
# old image (deploy footgun 1, resolved).
IMAGE="${IMAGE:-twaldin/terminal-portfolio:latest}"
IMAGE_BACKEND="${IMAGE_BACKEND:-term-site-backend}"
IMAGE_FRONTEND="${IMAGE_FRONTEND:-term-site-frontend}"

# Repo root (scripts/lib/common.sh → repo root is two dirs up).
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# Admin-panel endpoint + credentials (sourced from env / shell keychain).
ADMIN_URL="${ADMIN_URL:-https://${VPS_HOST}/admin}"
ADMIN_EMAIL="${ADMIN_EMAIL:-timothy@waldin.net}"

# ---- Colors ------------------------------------------------------------------

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1; then
  C_RESET="$(tput sgr0)"
  C_BOLD="$(tput bold)"
  C_DIM="$(tput dim 2>/dev/null || echo '')"
  C_RED="$(tput setaf 1)"
  C_GREEN="$(tput setaf 2)"
  C_YELLOW="$(tput setaf 3)"
  C_BLUE="$(tput setaf 4)"
  C_CYAN="$(tput setaf 6)"
  C_GRAY="$(tput setaf 8 2>/dev/null || tput setaf 7)"
else
  C_RESET="" C_BOLD="" C_DIM="" C_RED="" C_GREEN=""
  C_YELLOW="" C_BLUE="" C_CYAN="" C_GRAY=""
fi

# ---- Logging -----------------------------------------------------------------

log()      { printf '%s\n' "$*"; }
log_info() { printf '%s▸%s %s\n' "${C_BLUE}" "${C_RESET}" "$*"; }
log_ok()   { printf '%s✓%s %s\n' "${C_GREEN}" "${C_RESET}" "$*"; }
log_warn() { printf '%s!%s %s\n' "${C_YELLOW}" "${C_RESET}" "$*"; }
log_err()  { printf '%s✗%s %s\n' "${C_RED}" "${C_RESET}" "$*" >&2; }
log_step() { printf '\n%s%s==> %s%s\n' "${C_BOLD}" "${C_CYAN}" "$*" "${C_RESET}"; }
log_dim()  { printf '%s%s%s\n' "${C_DIM}" "$*" "${C_RESET}"; }

die() {
  log_err "$*"
  exit 1
}

# ---- Guards ------------------------------------------------------------------

require_cmd() {
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || die "required command not found: ${cmd}"
  done
}

require_repo_root() {
  [[ -f "${REPO_ROOT}/docker-compose.yml" ]] \
    || die "expected to be running from the tim.waldin.net repo root (no docker-compose.yml at ${REPO_ROOT})"
}

require_vps_reachable() {
  ssh -o BatchMode=yes -o ConnectTimeout=5 "${VPS}" true >/dev/null 2>&1 \
    || die "cannot reach ${VPS} via ssh — check your SSH key / VPN / tailscale"
}

# ---- SSH / VPS helpers -------------------------------------------------------

# Run a remote command on the VPS and stream output. Quote the command string.
on_vps() {
  ssh -o StrictHostKeyChecking=accept-new "${VPS}" "$*"
}

# Run a remote command inside the deploy path on the VPS.
on_vps_deploy() {
  on_vps "cd ${DEPLOY_PATH} && $*"
}

# Ensure the deploy user actually owns the repo on the VPS — if root ran
# git there at some point, objects become root-owned and the deploy user's
# pulls fail (deploy footgun 2, resolved).
ensure_deploy_owned() {
  on_vps "chown -R ${DEPLOY_USER}:${DEPLOY_USER} ${DEPLOY_PATH}"
}

# ---- Misc --------------------------------------------------------------------

# Prompt for confirmation unless FORCE=1.
confirm() {
  local prompt="${1:-are you sure?}"
  [[ "${FORCE:-0}" == "1" ]] && return 0
  local answer
  read -r -p "${prompt} [y/N] " answer
  [[ "${answer:-}" =~ ^[Yy]$ ]]
}

# Format bytes as human-readable (KB/MB/GB).
human_bytes() {
  local bytes=$1
  if   (( bytes >= 1073741824 )); then printf '%.1fGB' "$(echo "scale=1; ${bytes}/1073741824" | bc)"
  elif (( bytes >= 1048576 ));    then printf '%.1fMB' "$(echo "scale=1; ${bytes}/1048576" | bc)"
  elif (( bytes >= 1024 ));       then printf '%.1fKB' "$(echo "scale=1; ${bytes}/1024" | bc)"
  else                                 printf '%dB' "${bytes}"
  fi
}
