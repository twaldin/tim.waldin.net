#!/bin/bash
# List local blog posts with date, slug, and title.
# Handy when deciding what to preview.
#
# Usage:
#   scripts/blog-list.sh    all posts

set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
require_repo_root

posts_dir="${REPO_ROOT}/container/blog/posts"

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) die "unknown arg: $arg" ;;
  esac
done

[[ -d "${posts_dir}" ]] || die "no posts dir at ${posts_dir}"

# Read each post's frontmatter to get title + date.
rows=()
shopt -s nullglob
for f in "${posts_dir}"/*.md; do
  slug="$(basename "${f}" .md)"
  date="$(awk '/^date:/ {sub(/^date: */, ""); print; exit}' "${f}")"
  title="$(awk '/^title:/ {sub(/^title: */, ""); print; exit}' "${f}")"
  [[ -z "${date}" ]] && date="0000-00-00"
  [[ -z "${title}" ]] && title="${slug}"

  rows+=("${date}|${slug}|${title}")
done
shopt -u nullglob

if (( ${#rows[@]} == 0 )); then
  log_warn "no posts found in ${posts_dir}"
  exit 0
fi

printf '%s\n' "${rows[@]}" | sort -r | {
  printf '  %-10s  %-50s  %s\n' "DATE" "SLUG" "TITLE"
  printf '  %-10s  %-50s  %s\n' "----" "----" "-----"
  while IFS='|' read -r d s t; do
    printf '  %-10s  %-50s  %s\n' "${d}" "${s}" "${t}"
  done
}
