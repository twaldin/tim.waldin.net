#!/bin/bash
# Deploy then verify the live site with the e2e suite — a true deploy gate.
# On e2e failure the live site is broken: roll back with
#   git revert -m 1 <merge-sha>   on the VPS, then redeploy.
#
# Usage: scripts/deploy-and-verify.sh
# Prereq (once): cd e2e && npm install && npx playwright install chromium
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

log_step "deploying to ${VPS}"
"$(dirname "$0")"/vps-deploy.sh

log_step "running e2e against https://${VPS_HOST}"
( cd "$(dirname "$0")/../e2e" && BASE_URL="https://${VPS_HOST}" npx playwright test )

log_ok "deploy complete and verified by e2e"
