#!/bin/bash
# Scaffold a new blog post with frontmatter. Generates a dated slug from
# the title and creates container/blog/posts/<slug>.md ready for editing.
#
# Usage:
#   scripts/blog-new.sh "how i built the pool"
#   scripts/blog-new.sh "post title"  --edit     open in $EDITOR after creating
#   scripts/blog-new.sh --from-clipboard          use clipboard as initial body

set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
require_repo_root

posts_dir="${REPO_ROOT}/container/blog/posts"
mkdir -p "${posts_dir}"

# ---- Args --------------------------------------------------------------------

title=""
open_editor=0
from_clip=0
for arg in "$@"; do
  case "$arg" in
    --edit)             open_editor=1 ;;
    --from-clipboard)   from_clip=1 ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      if [[ -z "${title}" ]]; then title="$arg"
      else die "unknown arg: $arg"
      fi ;;
  esac
done

[[ -n "${title}" ]] || die "title is required  (scripts/blog-new.sh \"your title\")"

# ---- Compute slug ------------------------------------------------------------

date="$(date +%Y-%m-%d)"
# lowercase, spaces → dashes, strip anything that isn't [a-z0-9-]
body_slug="$(
  printf '%s' "${title}" \
    | tr '[:upper:]' '[:lower:]' \
    | tr ' ' '-' \
    | tr -cd 'a-z0-9-' \
    | sed 's/-\+/-/g;s/^-//;s/-$//'
)"
slug="${date}-${body_slug}"
file="${posts_dir}/${slug}.md"

if [[ -e "${file}" ]]; then
  die "post already exists: ${file}"
fi

# ---- Body --------------------------------------------------------------------

body=""
if (( from_clip )); then
  if command -v pbpaste >/dev/null 2>&1; then
    body="$(pbpaste)"
  elif command -v xclip >/dev/null 2>&1; then
    body="$(xclip -selection clipboard -o)"
  else
    log_warn "no clipboard tool found — starting with empty body"
  fi
fi

# ---- Write file --------------------------------------------------------------

{
  printf -- '---\n'
  printf 'title: %s\n' "${title}"
  printf 'date: %s\n' "${date}"
  printf 'slug: %s\n' "${slug}"
  printf -- '---\n\n'
  if [[ -n "${body}" ]]; then
    printf '%s\n' "${body}"
  else
    printf '%s\n' "(your post goes here — write some markdown)"
  fi
} > "${file}"

log_ok "created ${file}"
log_dim "    preview locally:  scripts/blog-preview.sh ${slug}"
log_dim "    after commit:     scripts/vps-deploy.sh"

if (( open_editor )); then
  "${EDITOR:-vi}" "${file}"
fi
