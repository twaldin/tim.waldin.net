#!/bin/bash
# blog — list posts and hand off to the HTML page for reading
#
# Usage:
#   blog              list all posts (newest first)
#   blog <slug>       open /blog/<slug> via OSC 9997 navigate
#   blog <N>          same as above, N = 1 newest, 2 second newest, ...
#   blog <fuzzy>      substring match of any slug (single-match required)
#   blog latest       open newest post
#   blog --raw <slug> emit raw markdown (pipeable; no navigation)

source "$(dirname "$0")/shared-functions.sh"

BLOG_DIR="/home/portfolio/blog/posts"
[[ -d "$BLOG_DIR" ]] || BLOG_DIR="$(dirname "$0")/../blog/posts"   # dev fallback

# frontmatter_get <file> <key>  — reads "key: value" from the YAML frontmatter block
frontmatter_get() {
  awk -v k="$2:" 'NR==1 && /^---$/ {inside=1; next}
                  inside && /^---$/ {exit}
                  inside && index($0,k)==1 {sub(/^[^:]+: */,""); print; exit}' "$1"
}

# body_after_frontmatter <file>
body_after_frontmatter() {
  awk 'NR==1 && /^---$/ {inside=1; next}
       inside && /^---$/ {inside=0; next}
       !inside' "$1"
}

list_posts() {
  clear
  echo ""
  typewriter "${PURPLE}blog${RESET}"
  animated_separator "-" 10 "$PURPLE"
  echo ""

  shopt -s nullglob
  local posts=("$BLOG_DIR"/*.md)
  shopt -u nullglob

  if (( ${#posts[@]} == 0 )); then
    typewriter "${DIM}no posts yet.${RESET}"
    echo ""
    return
  fi

  # Sort by date (from frontmatter), newest first
  local rows=()
  for f in "${posts[@]}"; do
    local slug date title
    slug="$(basename "$f" .md)"
    date="$(frontmatter_get "$f" date)"
    title="$(frontmatter_get "$f" title)"
    [[ -z "$date" ]] && date="0000-00-00"
    [[ -z "$title" ]] && title="$slug"
    rows+=("${date}|${slug}|${title}")
  done

  # OSC 8 hyperlinks so the slug is clickable — xterm.js + WebLinksAddon
  # renders the visible text as a link that navigates to the blog page.
  #
  # We can't route this line through typewriter()'s `echo -e` pass: the OSC 8
  # terminator (ESC \) ends with a literal `\` byte, and when it's immediately
  # followed by ${RESET}="\033[0m" in the string, `echo -e` collapses the two
  # backslashes into one and strips the leading \ off the reset sequence —
  # which then renders as literal "033[0m" text next to the slug.
  # Solution: resolve all escapes up-front with $'...' (so the string holds
  # real ESC/`\` bytes) and write with `echo` (no `-e` reinterpretation).
  local esc_reset=$'\033[0m'
  local esc_dim=$'\033[2m'
  local esc_gray=$'\033[90m'    # colour8  — date
  local esc_yellow=$'\033[95m'  # colour13 — slug (matches PURPLE accent)
  local esc_white=$'\033[97m'   # colour15 — title
  local osc_open=$'\033]8;;'
  local osc_close=$'\033\\'

  # Truncate titles so a row never exceeds the terminal width — xterm would
  # otherwise hard-wrap mid-word at the right edge ("leaderboa / rd").
  local cols
  cols=$(tput cols 2>/dev/null || echo 80)

  local idx=1
  printf '%s\n' "${rows[@]}" | sort -r | while IFS='|' read -r d s t; do
    # plain-text prefix: 2 spaces + idx + 2 + date(10) + 2 + slug + 2
    local avail=$(( cols - 2 - ${#idx} - 2 - 10 - 2 - ${#s} - 2 ))
    if (( avail > 4 )) && (( ${#t} > avail )); then
      t="${t:0:avail-1}…"
    fi
    echo "  ${esc_dim}${idx}${esc_reset}  ${esc_gray}${d}${esc_reset}  ${esc_yellow}${osc_open}https://tim.waldin.net/blog/${s}${osc_close}${s}${osc_open}${osc_close}${esc_reset}  ${esc_white}${t}${esc_reset}"
    idx=$((idx + 1))
  done

  echo ""
  typewriter "${DIM}read:  ${CYAN}blog <N>${RESET}${DIM}  ${CYAN}blog <slug>${RESET}${DIM}  ${CYAN}blog latest${RESET}${DIM}   (fuzzy match: ${CYAN}blog haiku${RESET}${DIM} works too)${RESET}"
  echo ""
  emit_scroll_top
}

render_post() {
  local slug="$1"
  local file="$BLOG_DIR/${slug}.md"

  # Numeric shortcut: `blog 1` → newest, `blog 2` → second newest, ...
  if [[ ! -f "$file" ]] && [[ "$slug" =~ ^[0-9]+$ ]]; then
    local idx="$slug"
    local sorted=()
    shopt -s nullglob
    local pf
    for pf in "$BLOG_DIR"/*.md; do
      local s d
      s="$(basename "$pf" .md)"
      d="$(frontmatter_get "$pf" date)"
      [[ -z "$d" ]] && d="0000-00-00"
      sorted+=("${d}|${s}")
    done
    shopt -u nullglob
    # shellcheck disable=SC2207
    sorted=($(printf '%s\n' "${sorted[@]}" | sort -r | cut -d'|' -f2))
    if (( idx >= 1 )) && (( idx <= ${#sorted[@]} )); then
      slug="${sorted[$((idx - 1))]}"
      file="$BLOG_DIR/${slug}.md"
    fi
  fi

  # Fuzzy match: any substring of a slug matches
  if [[ ! -f "$file" ]]; then
    local matches=()
    shopt -s nullglob
    local pf
    for pf in "$BLOG_DIR"/*.md; do
      local s
      s="$(basename "$pf" .md)"
      # case-insensitive substring match
      if [[ "${s,,}" == *"${slug,,}"* ]]; then
        matches+=("$s")
      fi
    done
    shopt -u nullglob
    if (( ${#matches[@]} == 1 )); then
      slug="${matches[0]}"
      file="$BLOG_DIR/${slug}.md"
    elif (( ${#matches[@]} > 1 )); then
      typewriter "${YELLOW}multiple matches for '${slug}':${RESET}"
      local m
      for m in "${matches[@]}"; do
        typewriter "  ${CYAN}${m}${RESET}"
      done
      echo ""
      typewriter "${DIM}be more specific, or use ${CYAN}blog <N>${RESET}"
      return 1
    fi
  fi

  if [[ ! -f "$file" ]]; then
    typewriter "${RED}no post matching '${slug}'${RESET}"
    echo ""
    typewriter "${DIM}list all:  ${CYAN}blog${RESET}"
    return 1
  fi

  # Hand off to the HTML blog page — the static Gruvbox render is prettier
  # than mdcat-in-PTY and serves from the CDN edge.
  emit_navigate "/blog/${slug}"
}

latest_post() {
  shopt -s nullglob
  local posts=("$BLOG_DIR"/*.md)
  shopt -u nullglob
  if (( ${#posts[@]} == 0 )); then
    typewriter "${DIM}no posts yet.${RESET}"
    return
  fi
  local latest_slug=""
  local latest_date="0000-00-00"
  for f in "${posts[@]}"; do
    local d
    d="$(frontmatter_get "$f" date)"
    [[ -z "$d" ]] && d="0000-00-00"
    if [[ "$d" > "$latest_date" ]]; then
      latest_date="$d"
      latest_slug="$(basename "$f" .md)"
    fi
  done
  render_post "$latest_slug"
}

case "${1:-}" in
  "" | "list")     list_posts ;;
  "latest")        latest_post ;;
  "--raw")
    shift
    # Reject slugs containing path traversal chars — only allow filename-safe chars
    if [[ ! "${1:-}" =~ ^[A-Za-z0-9._-]+$ ]]; then
      echo "invalid slug" >&2; exit 1
    fi
    body_after_frontmatter "$BLOG_DIR/${1}.md"
    ;;
  *)               render_post "$1" ;;
esac
