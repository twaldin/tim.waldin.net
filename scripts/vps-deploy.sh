#!/bin/bash
# Full production deploy from your machine: git pull --ff-only + ./deploy.sh
# in the compose dir on the VPS. Complements the partial deploys
# (deploy-frontend.sh / deploy-backend.sh / deploy-container.sh) when the
# change spans layers or touches deploy.sh itself.
#
# Usage:
#   scripts/vps-deploy.sh
#
# Env (via lib/common.sh):
#   VPS=root@tim.waldin.net            override target
#   DEPLOY_PATH=/home/deploy/term-site override compose dir
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

require_cmd ssh
require_vps_reachable

log_step "deploying (git pull --ff-only && ./deploy.sh) in ${DEPLOY_PATH}"
# -t so build/compose output streams live instead of buffering until exit.
ssh -t "${VPS}" "cd ${DEPLOY_PATH} && git pull --ff-only && ./deploy.sh"
log_ok "deploy finished"
