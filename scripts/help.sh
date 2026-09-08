#!/bin/bash
# List all ops scripts in scripts/ with their one-line description.
# Reads source headers only; never executes the listed tools.
#
# Usage: scripts/help.sh

set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
require_repo_root

scripts_dir="${REPO_ROOT}/scripts"
listed="|"

log_step "available scripts"

print_script() {
  local f="$1"
  local name="${f#"${scripts_dir}/"}"
  local doc
  doc="$(sed -n '2p' "${f}" | sed 's/^# *//;s/^"""//')"
  printf '  %-38s %s\n' "${name}" "${doc}"
  listed="${listed}${name}|"
}

show_group() {
  local name="$1"
  shift
  printf '\n%s%s %s%s\n' "${C_BOLD}" "${C_YELLOW}" "${name}" "${C_RESET}"
  local f
  for f in "$@"; do
    [[ -f "${f}" ]] || continue
    print_script "${f}"
  done
}

show_group "DEPLOY" "${scripts_dir}"/deploy-*.sh
show_group "VPS OPERATIONS" "${scripts_dir}"/vps-*.sh
show_group "BLOG" "${scripts_dir}"/blog-*.sh "${scripts_dir}"/gen-blog-cards.sh
show_group "REPO CARDS" "${scripts_dir}"/add-repo-card.sh "${scripts_dir}"/gen-repo-cards.sh
show_group "FONTS" "${scripts_dir}"/fonts-*.sh
show_group "ADMIN PANEL" "${scripts_dir}"/admin-*.sh

show_group "OTHER"
for f in "${scripts_dir}"/*; do
  [[ -f "${f}" ]] || continue
  case "${listed}" in
    *"|${f##*/}|"*) continue ;;
  esac
  print_script "${f}"
done
show_group "SHARED LIBRARY (source, do not execute)" "${scripts_dir}"/lib/*.sh

printf '\n%sRead each script header for usage; not every tool implements --help.%s\n' "${C_DIM}" "${C_RESET}"
