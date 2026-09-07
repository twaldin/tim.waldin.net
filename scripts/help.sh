#!/bin/bash
# List all ops scripts in scripts/ with their one-line description.
# Pulled from each script's second-line comment.
#
# Usage: scripts/help.sh

set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
require_repo_root

scripts_dir="${REPO_ROOT}/scripts"

log_step "available scripts"

# Group scripts by prefix (deploy-*, vps-*, blog-*, etc.) so related ones
# show together.
declare -A groups=(
  [deploy]="deploy-*"
  [vps]="vps-*"
  [blog]="blog-* capture-blog-snapshots.sh"
  [fonts]="fonts-*"
  [admin]="admin-*"
  [other]="deploy.sh reload-nginx.sh setup.sh check-dependencies.sh help.sh"
)

print_script() {
  local f="$1"
  local name
  name="$(basename "${f}")"
  local doc=""
  # Grab the second line (usually the one-liner). Strip leading "# ".
  doc="$(sed -n '2p' "${f}" | sed 's/^# *//')"
  printf '  %-38s %s\n' "${name}" "${doc}"
}

show_group() {
  local name="$1" pattern="$2"
  printf '\n%s%s %s%s\n' "${C_BOLD}" "${C_YELLOW}" "${name}" "${C_RESET}"
  for pat in ${pattern}; do
    for f in "${scripts_dir}"/${pat}; do
      [[ -f "${f}" ]] || continue
      print_script "${f}"
    done
  done
}

show_group "DEPLOY"         "${groups[deploy]}"
show_group "VPS OPERATIONS" "${groups[vps]}"
show_group "BLOG"           "${groups[blog]}"
show_group "FONTS"          "${groups[fonts]}"
show_group "ADMIN PANEL"    "${groups[admin]}"
show_group "OTHER"          "${groups[other]}"

printf '\n%sall scripts accept -h / --help for detailed usage.%s\n' "${C_DIM}" "${C_RESET}"
