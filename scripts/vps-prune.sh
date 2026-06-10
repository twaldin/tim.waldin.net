#!/bin/bash
# Reclaim Docker disk on the VPS: dangling images + all build cache.
# Does NOT touch volumes (backend_data audit log) or running containers.
#
# Usage:
#   scripts/vps-prune.sh            show reclaimable, then prune
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

require_cmd ssh
require_vps_reachable

log_step "Disk usage before prune"
on_vps "docker system df"

log_step "Pruning dangling images + build cache (volumes untouched)"
on_vps "docker image prune -f && docker builder prune -f"

log_step "Disk usage after prune"
on_vps "docker system df && df -h / | tail -1"
log_ok "Prune complete"
