#!/bin/bash
source "$(dirname "$0")/shared-functions.sh"
source "$(dirname "$0")/also.sh"
emit_url "projects"

clear
echo ""
ascii_typewriter "projects" "DOS_Rebel" "${PURPLE}"
echo ""

# One entry per project: command|display name|description|stack.
# Copy stays grid-cell short (≤ ~60 cols) so the wide layout never wraps.
ENTRIES=(
  'easl|easl|a native mac app for coding agents on one infinite board|swift, libghostty, webkit, zmx'
  'hone|hone|improves code; fixed objective, optimizer never grades itself|TypeScript, sandboxed evaluators, hone-capsules'
  'trade-up-bot|trade-up-bot|CS2 trade-up arbitrage — live at tradeupbot.app|TypeScript, React, PostgreSQL, Redis'
  'tim.waldin.net|tim.waldin.net|this site, with a docker container for every visitor|next.js, node.js, socket.io, docker'
  'harness|harness|(archived) one python+ts interface to 26 coding-agent CLIs|Python, TypeScript, per-CLI adapters'
  'flt|flt|(archived) orchestrate coding-agent fleets in tmux|TypeScript, Bun, raw ANSI TUI'
  'studyspot|studyspot|(archived) co-founded AI study platform — RAG + Claude|Next.js, Cloudflare Workers, pgvector'
  'stm32-games|stm32 games|complete snake in bare-metal C on an stm32 blue pill + lcd|C, st7789 lcd, libopencm3'
  'tetrio-tui|tetrio-tui|TETR.IO TUI client — not installed in this container|TypeScript, truecolor TUI'
  'gepa-ts|gepa-ts|1-1 TS port of gepa.optimize_anything — zero deps|TypeScript, published @twaldin/gepa-ts'
  'dotfiles|dotfiles|development environment configs|raw nvim (native vim.pack), zsh, tmux, ghostty'
  'also|also|the rest of github.com/twaldin|hackathons, archived predecessors, forks'
)

# Same width detection as ascii_typewriter — COLUMNS is what xterm forwards.
cols=0
t="$(tput cols 2>/dev/null)";                    [[ "$t" =~ ^[0-9]+$ ]] && (( t > cols )) && cols=$t
t="$(stty size 2>/dev/null | awk '{print $2}')"; [[ "$t" =~ ^[0-9]+$ ]] && (( t > cols )) && cols=$t
[[ "$COLUMNS" =~ ^[0-9]+$ ]]                  && (( COLUMNS > cols )) && cols=$COLUMNS
(( cols < 10 )) && cols=80

GUTTER=4
CELL_W=$(( (cols - GUTTER) / 2 ))
(( CELL_W > 64 )) && CELL_W=64

trunc() {
  local s="$1" w="$2"
  if (( ${#s} > w )); then printf '%s…' "${s:0:w-1}"; else printf '%s' "$s"; fi
}

# cell_line <entry-index> <field 1..4> — sets CELL_PLAIN (for width math) and
# CELL_COLOR (what actually prints). Fields: 1=title 2=desc 3=stack 4=hint.
cell_line() {
  local cmd name desc stack
  IFS='|' read -r cmd name desc stack <<<"${ENTRIES[$1]}"
  local n=$(( $1 + 1 ))
  case "$2" in
    1) CELL_PLAIN="$n. $name"
       CELL_COLOR="${BOLD}${PURPLE}${CELL_PLAIN}${RESET}" ;;
    2) CELL_PLAIN="$(trunc "$desc" "$CELL_W")"
       CELL_COLOR="${WHITE}${CELL_PLAIN}${RESET}" ;;
    3) CELL_PLAIN="$(trunc "$stack" "$CELL_W")"
       CELL_COLOR="${BLUE}${CELL_PLAIN}${RESET}" ;;
    4) CELL_PLAIN="type \"$cmd\""
       CELL_COLOR="${DIM}type ${BOLD}\"$cmd\"${RESET}" ;;
  esac
}

# grid_row <left-index> [right-index] — two cards side by side, padded on the
# plain-text width so ANSI escapes don't skew alignment.
grid_row() {
  local f pad lp lc
  for f in 1 2 3 4; do
    cell_line "$1" "$f"
    lp="$CELL_PLAIN" lc="$CELL_COLOR"
    if [[ -n "${2:-}" ]]; then
      cell_line "$2" "$f"
      pad=$(( CELL_W + GUTTER - ${#lp} ))
      (( pad < 1 )) && pad=1
      printf '%b%*s%b\n' "$lc" "$pad" "" "$CELL_COLOR"
    else
      printf '%b\n' "$lc"
    fi
  done
  echo ""
}

single_card() {
  local f
  for f in 1 2 3 4; do
    cell_line "$1" "$f"
    printf '%b\n' "$CELL_COLOR"
  done
  echo ""
}

if (( CELL_W >= 46 )); then
  # Wide terminal: 2-up grid of shipped projects, no suite pipeline framing.
  grid_row 0 1
  grid_row 2 3
  grid_row 4 5
  grid_row 6 7
  grid_row 8 9
  grid_row 10 11
else
  CELL_W=$(( cols - 2 ))
  for i in "${!ENTRIES[@]}"; do
    single_card "$i"
  done
fi

echo ""
print_also_list
echo ""

typewriter "${RED}You are now in the projects/ directory${RESET}"
typewriter "${DIM}Use ls, cd, nvim, or your other favorite commands to explore my projects,${RESET}"
typewriter "${DIM}or type a project name to see info and navigate. type home to go back.${RESET}"
echo ""

# Land the reader at the figlet, not the footer — the full list is taller than
# one screen on short viewports and xterm otherwise auto-scrolls to the cursor.
emit_scroll_top
