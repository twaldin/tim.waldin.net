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

(( $# <= 1 )) || die "expected no arguments or -h/--help"
case "${1:-}" in
  -h|--help) sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") (( $# == 0 )) || die "unexpected empty argument" ;;
  *) die "unknown argument: $1" ;;
esac

require_cmd ssh
require_vps_reachable

log_step "deploying (git pull --ff-only && ./deploy.sh) in ${DEPLOY_PATH}"
# -t so build/compose output streams live instead of buffering until exit.
ssh -t "${VPS}" "cd ${DEPLOY_PATH} && git pull --ff-only && ./deploy.sh"
log_ok "deploy finished"
