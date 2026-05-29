#!/bin/bash
CYAN='\033[96m'    # colour14 (bright cyan)
GREEN='\033[92m'   # colour10 (bright green)
WHITE='\033[97m'   # colour15 (bright white / foreground)
YELLOW='\033[93m'  # colour11 (bright yellow)
BLUE='\033[34m'    # colour4  (blue)
RED='\033[31m'     # colour1  (red)
MAGENTA='\033[35m' # colour5  (magenta)
PURPLE='\033[32m'  # colour2  (primary accent; legacy alias)
ORANGE='\033[93m'  # colour11 (bright yellow, closest ANSI slot to orange)
GRAY='\033[90m'    # colour8  (bright black / dark gray)
BG='\033[40m'      # colour0  background
FG='\033[39m'      # default foreground
RESET='\033[0m'
BOLD='\033[1m'
DIM='\033[2m'

# emit_url <path>
# Emits OSC 9999 — frontend Terminal.tsx intercepts via
# xterm.parser.registerOscHandler(9999), strips the sequence, and calls
# history.pushState so the browser URL tracks the active command.
# Usage:
#   emit_url "blog/2026-04-19-hone-haiku-20pp"
#   emit_url ""           # map to "/" — the home page
emit_url() {
  printf '\033]9999;%s\033\\' "${1-}"
}

# emit_scroll_top
# Emits OSC 9998 — frontend handler calls xterm.scrollToTop() so the viewport
# parks at the first line of the most recent output. Use after long renders
# (blog posts, help pages) where the default xterm auto-scroll-to-cursor
# leaves the user staring at the bottom.
emit_scroll_top() {
  printf '\033]9998;\033\\'
}

# emit_navigate <path>
# Emits OSC 9997 — frontend handler calls window.location.assign(path),
# triggering a full page navigation. Use when the shell wants to hand off
# to an HTML page (e.g. `blog <slug>` opens /blog/<slug>). Contrast with
# emit_url (OSC 9999) which only updates the URL bar via pushState.
emit_navigate() {
  printf '\033]9997;%s\033\\' "${1-}"
}

typewriter() {
  # Print the line atomically so multi-byte ANSI escapes don't get split
  # across terminal flushes (which shows up as literal "93m" / "0m"
  # fragments on slow network paths like Socket.IO).
  printf '%b\n' "$1"
}

animated_separator() {
  local char="$1"
  local width="$2"
  local color="${3:-$CYAN}"

  # Print the whole line atomically — the per-char loop with sleeps was
  # producing visible rendering artifacts (prompt interleaving, lost lines)
  # when Socket.IO flushed mid-sequence.
  local line=""
  local i
  for ((i = 0; i < width; i++)); do line+="$char"; done
  printf '%b%s%b\n' "${color}" "$line" "${RESET}"
}

# print_text <text> [color] [indent]
# Word-wraps text to the terminal width, optionally colored and indented.
# Use instead of hardcoded newlines in script content — this flows nicely
# regardless of font size or viewport.
print_text() {
  local text="$1"
  local color="${2:-}"
  local indent="${3:-0}"

  local cols
  cols=$(tput cols 2>/dev/null || echo 80)
  (( cols < 20 )) && cols=80

  local prefix
  prefix=$(printf '%*s' "$indent" '')
  local wrap_width=$((cols - indent))
  (( wrap_width < 20 )) && wrap_width=20

  printf '%s' "$text" | fold -s -w "$wrap_width" | while IFS= read -r line; do
    printf '%b%s%s%b\n' "${color}" "$prefix" "$line" "${RESET}"
  done
}

ascii_typewriter() {
  local text="$1"
  local font="${2:-DOS_Rebel}"
  local color="${3:-${BOLD}${CYAN}}"

  # Detect terminal width before running figlet — avoids spawning figlet
  # on mobile where the output will always overflow.
  local cols=0 t
  t="$(tput cols 2>/dev/null)";                    [[ "$t" =~ ^[0-9]+$ ]] && (( t > cols )) && cols=$t
  t="$(stty size 2>/dev/null | awk '{print $2}')"; [[ "$t" =~ ^[0-9]+$ ]] && (( t > cols )) && cols=$t
  [[ "$COLUMNS" =~ ^[0-9]+$ ]]                  && (( COLUMNS > cols )) && cols=$COLUMNS
  (( cols < 10 )) && cols=80

  # Mobile-width terminals can't render any figlet art without ugly wrap.
  if (( cols < 60 )); then
    typewriter "${BOLD}${color}${text}${RESET}"
    return
  fi

  # Let figlet render at its natural width — passing `-w $cols` was forcing
  # mid-word breaks on single-word text. Check afterwards that the actual
  # rendered width fits, with a small overflow tolerance (xterm.js handles
  # a few chars of soft-wrap gracefully; a huge overflow is what looks bad).
  local ascii_output
  ascii_output=$(figlet -f "$font" "$text" 2>/dev/null || figlet "$text")

  # wc -L counts display columns (handles multibyte UTF-8 block chars that
  # DOS_Rebel uses — awk's `length` would return bytes and massively
  # overestimate the width, causing a spurious fallback to plain text).
  local max_width
  max_width=$(printf '%s' "$ascii_output" | wc -L | tr -d ' ')
  [[ "$max_width" =~ ^[0-9]+$ ]] || max_width=0

  if (( max_width > cols )); then
    typewriter "${BOLD}${color}${text}${RESET}"
    return
  fi

  # Strip trailing blank lines using a safer method
  ascii_output=$(echo "$ascii_output" | awk '/^[[:space:]]*$/ {emptylines=emptylines"\n"; next} {if(emptylines) printf "%s",emptylines; emptylines=""; print}')

  # Line-by-line animation - preserves UTF-8 box-drawing characters
  while IFS= read -r line; do
    # Print entire colored line at once to avoid breaking UTF-8 sequences
    printf '%b%s%b\n' "${color}" "$line" "${RESET}"
    sleep 0.02  # Small delay between lines for animation effect
  done <<< "$ascii_output"
}

# Special typewriter for git output that preserves ANSI colors
git_typewriter() {
  local line="$1"
  # Display git output immediately to preserve ANSI color sequences
  printf '%s\n' "$line"
  sleep 0.02  # Small delay for animation effect
}

create_box() {
  local title="$1"
  local content="$2"
  local color="${3:-$CYAN}"
  local box_width="${4:-auto}"

  # Live PTY width via tput first (query TIOCGWINSZ — doesn't get stale in
  # subshells). Fall back to stty, then $COLUMNS, then 80.
  local term_width
  term_width="$(tput cols 2>/dev/null)"
  [[ -z "$term_width" ]] && term_width="$(stty size 2>/dev/null | awk '{print $2}')"
  [[ -z "$term_width" ]] && term_width="${COLUMNS:-80}"

  if [[ "$box_width" == "auto" ]]; then
    # Size to content width (longest line + borders/padding), capped at
    # terminal width. Avoids a 70-char box wrapping on mobile when content
    # is only ~35 chars wide.
    local max_line=0
    if [ -n "$content" ]; then
      while IFS= read -r line; do
        local line_clean=$(echo "$line" | sed 's/\x1b\[[0-9;]*m//g')
        local len=${#line_clean}
        (( len > max_line )) && max_line=$len
      done <<< "$content"
    fi
    local title_len=${#title_clean}
    local content_based=$(( (max_line > title_len ? max_line : title_len) + 8 ))
    local term_max=$((term_width - 2))
    box_width=$(( content_based < term_max ? content_based : term_max ))
  elif [ "$term_width" -lt "$box_width" ]; then
    box_width=$((term_width - 2))
  fi
  (( box_width < 40 )) && box_width=40

  local title_clean=$(echo "$title" | sed 's/\x1b\[[0-9;]*m//g')
  local title_length=${#title_clean}

  local dash_count=$((box_width - title_length - 5))  # ┌(1) ─(1) ' '(1) title ' '(1) ┐(1) = 5 fixed
  if [ $dash_count -lt 1 ]; then
    dash_count=1
  fi

  local top_border="${color}┌─ ${BOLD}${title}${RESET}${color} "
  for ((i=0; i<dash_count; i++)); do
    top_border+="─"
  done
  top_border+="┐${RESET}"

  echo -e "$top_border"

  if [ -z "$content" ]; then
    local content_width=$((box_width - 4))
    local spaces=""
    for ((i=0; i<content_width; i++)); do
      spaces+=" "
    done
    echo -e "${color}│${RESET} ${spaces} ${color}│${RESET}"
  else
    local content_width=$((box_width - 4))
    while IFS= read -r line; do
      local line_clean=$(echo "$line" | sed 's/\x1b\[[0-9;]*m//g')
      # Word-wrap at word boundaries so we never split mid-word.
      local wrapped
      wrapped=$(printf '%s' "$line_clean" | fold -s -w "$content_width")
      while IFS= read -r chunk; do
        local chunk_length=${#chunk}
        local padding=$((content_width - chunk_length))
        local spaces
        spaces=$(printf '%*s' "$padding" '')
        echo -e "${color}│${RESET} ${WHITE}${chunk}${RESET}${spaces} ${color}│${RESET}"
      done <<< "$wrapped"
    done <<< "$content"
  fi

  local bottom_border="${color}└"
  for ((i=0; i<box_width-2; i++)); do
    bottom_border+="─"
  done
  bottom_border+="┘${RESET}"

  echo -e "$bottom_border"
}

hyperlink() {
  local text="$1"
  local url="$2"
  local color="${3:-$CYAN}"

  echo -en "${color}\033]8;;${url}\033\\ ${text}\033]8;;\033\\${RESET}"
}

email_link() {
  local text="$1"
  local email="$2"
  local color="${3:-$CYAN}"

  echo -en "${color}\033]8;;mailto:${email}\033\\ ${text}\033]8;;\033\\${RESET}"
}

git_activity() {
  local color="${1:-$BLUE}"
  echo ""
  typewriter "${color}Recent Git Activity:${RESET}"
  if [ -d ".git" ]; then
    local branch
    branch=$(git branch --show-current 2>/dev/null || echo "main")
    typewriter "   ${BLUE}Branch:${RESET} ${YELLOW}${branch}${RESET}"
    typewriter "   ${BLUE}Recent commits:${RESET}"
    git log --oneline --decorate --color=always | head -5 | while IFS= read -r line; do
      git_typewriter "     $line"
    done
    if git status --porcelain | grep -q .; then
      typewriter "   ${YELLOW}Status:${RESET} ${RED}Modified files present${RESET}"
    else
      typewriter "   ${YELLOW}Status:${RESET} ${GREEN}Clean working directory${RESET}"
    fi
  else
    typewriter "   ${DIM}Not a git repository${RESET}"
  fi
}
