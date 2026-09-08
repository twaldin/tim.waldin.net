#!/bin/bash
# Rebuild + restart only the frontend (Next.js) on the VPS.
#
# Usage: scripts/deploy-frontend.sh

set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

require_cmd ssh
require_vps_reachable

# ---- Sync terminal theme from current Ghostty config -----------------------

log_info "regenerating theme library from ghostty themes..."
"$(dirname "$0")/generate-themes-lib.py"
theme_files=("${REPO_ROOT}/frontend/src/config/themes.ts" "${REPO_ROOT}/backend/theme.js")
if ! git -C "${REPO_ROOT}" diff --quiet "${theme_files[@]}"; then
  log_info "theme library changed — committing..."
  git -C "${REPO_ROOT}" add "${theme_files[@]}"
  git -C "${REPO_ROOT}" commit -m "chore: sync theme library"
fi

# ---- Deploy ------------------------------------------------------------------

log_step "deploying frontend to ${VPS}"
ensure_deploy_owned

log_info "pulling latest..."
# Run git as the deploy user: when the SSH session is root, git refuses to
# touch a repo owned by deploy ("unsafe directory"). Keep failures visible.
on_vps_deploy "sudo -u ${DEPLOY_USER} git pull --rebase"

log_info "rebuilding frontend container (Next.js build runs here)..."
on_vps_deploy 'docker compose up -d --no-deps --build frontend 2>&1 | tail -10'

log_info "verifying..."
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if curl -fsS --max-time 3 "https://${VPS_HOST}/" -o /dev/null 2>/dev/null; then
    log_ok "frontend serving after ${i}s"
    exit 0
  fi
  sleep 1
done
die "frontend did not come up within 12s"
