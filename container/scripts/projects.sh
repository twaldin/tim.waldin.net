#!/bin/bash
source "$(dirname "$0")/shared-functions.sh"
emit_url "projects"

clear
echo ""
ascii_typewriter "projects" "DOS_Rebel" "${PURPLE}"
echo ""

# One entry per project: command|display name|description|stack.
# Copy stays grid-cell short (≤ ~60 cols) so the wide layout never wraps.
# Entries 1-4 are the coding-agent suite and render as their own group.
ENTRIES=(
  'harness|harness|one python+ts interface to 13 coding-agent CLIs|Python, TypeScript, per-CLI adapters'
  'hone|hone|GEPA prompt optimizer — +20pp solve rate on unseen bugs|Python, GEPA/dspy, harness'
  'flt|flt|spawn + orchestrate fleets of coding agents in tmux|TypeScript, Bun, raw ANSI TUI'
  'agentelo|agentelo|Bradley-Terry leaderboard for coding agents (148-agent baseline)|TypeScript, Next.js, SQLite, Bun'
  'term-site|term site|this site — every visitor gets their own docker container|next.js, node.js, socket.IO, docker'
  'trade-up-bot|trade-up-bot|CS2 trade-up arbitrage — live at tradeupbot.app|TypeScript, React, PostgreSQL, Redis'
  'studyspot|studyspot|co-founded AI study platform — RAG + Claude over course docs|Next.js, Cloudflare Workers, pgvector'
  'stm32-games|stm32 games|complete snake in bare-metal C on an stm32 blue pill + lcd|C, st7789 lcd, libopencm3'
  'dotfiles|dotfiles|development environment configs|raw nvim (native vim.pack), zsh, tmux, ghostty'
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

typewriter "${BOLD}${PURPLE}the coding-agent suite${RESET}"
typewriter "${DIM}harness (substrate) -> hone (optimizer) -> flt (orchestrator) -> agentelo (leaderboard)${RESET}"
echo ""

if (( CELL_W >= 46 )); then
  # Wide terminal: 2-up grid — suite on rows 1-2, everything else below.
  grid_row 0 1
  grid_row 2 3
  animated_separator "+" $(( CELL_W * 2 + GUTTER )) "${PURPLE}"
  echo ""
  grid_row 4 5
  grid_row 6 7
  grid_row 8
else
  CELL_W=$(( cols - 2 ))
  single_card 0; single_card 1; single_card 2; single_card 3
  animated_separator "+" $(( cols > 60 ? 60 : cols - 2 )) "${PURPLE}"
  echo ""
  single_card 4; single_card 5; single_card 6; single_card 7; single_card 8
fi

typewriter "${RED}You are now in the projects/ directory${RESET}"
typewriter "${DIM}Use ls, cd, nvim, or your other favorite commands to explore my projects,${RESET}"
typewriter "${DIM}or type a project name to see info and navigate. type home to go back.${RESET}"
echo ""

# Land the reader at the figlet, not the footer — the full list is taller than
# one screen on short viewports and xterm otherwise auto-scrolls to the cursor.
emit_scroll_top
