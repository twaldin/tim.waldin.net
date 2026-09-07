#!/bin/bash
# First-time setup check for a fresh local clone. Verifies required tools
# and helps install anything missing.
#
# Usage: scripts/setup.sh

set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
require_repo_root

log_step "tool check"

missing=()
check_tool() {
  local cmd="$1" hint="$2"
  if command -v "${cmd}" >/dev/null 2>&1; then
    log_ok "${cmd} found  ($(command -v "${cmd}"))"
  else
    log_err "${cmd} missing  — ${hint}"
    missing+=("${cmd}")
  fi
}

check_tool docker   "install Docker Desktop or docker engine"
check_tool git      "should be installed"
check_tool ssh      "usually pre-installed on macOS / linux"
check_tool curl     "install via brew / apt"
check_tool node     "install via nvm (https://nvm.sh) — v18+ needed"
check_tool npm      "ships with node"
check_tool python3  "required for fonts-ttf-to-woff2.sh"

# jq is optional but admin-stats.sh needs it
if command -v jq >/dev/null 2>&1; then
  log_ok "jq found (optional)"
else
  log_warn "jq not found — admin-stats.sh and admin-top-ips.sh won't work"
fi

if (( ${#missing[@]} > 0 )); then
  log_err "${#missing[@]} required tool(s) missing"
  exit 1
fi

log_step "frontend deps"
if [[ -d "${REPO_ROOT}/frontend/node_modules" ]]; then
  log_ok "frontend/node_modules exists"
else
  log_info "installing frontend/node_modules..."
  (cd "${REPO_ROOT}/frontend" && npm ci)
fi

log_step "backend deps"
if [[ -d "${REPO_ROOT}/backend/node_modules" ]]; then
  log_ok "backend/node_modules exists"
else
  log_info "installing backend/node_modules..."
  (cd "${REPO_ROOT}/backend" && npm ci)
fi

log_step "SSH to VPS"
if ssh -o BatchMode=yes -o ConnectTimeout=3 "${VPS}" true >/dev/null 2>&1; then
  log_ok "can reach ${VPS}"
else
  log_warn "cannot reach ${VPS} — deploy scripts won't work until SSH is set up"
  log_dim "    add your key to the VPS with: ssh-copy-id ${VPS}"
fi

log_step "fonts"
bash "$(dirname "$0")/fonts-check.sh" 2>&1 | tail -20 || true

log_step "blog posts"
bash "$(dirname "$0")/blog-list.sh" 2>&1 | tail -20 || true

log_step "next steps"
log_dim "  host:       scripts/vps-ssh.sh (production working copy; see README.md)"
log_dim "  preview:    scripts/blog-preview.sh"
log_dim "  deploy:     scripts/vps-deploy.sh"
log_dim "  status:     scripts/vps-status.sh"
