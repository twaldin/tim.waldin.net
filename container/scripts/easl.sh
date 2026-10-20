#!/bin/bash
source "$(dirname "$0")/shared-functions.sh"
emit_url "projects/easl"

clear
echo ""
ascii_typewriter "easl" "DOS_Rebel" "${PURPLE}"
echo ""

create_box "description" "a native mac app for coding agents on one infinite board.
real terminals beside code, call graphs, browsers and notes.
hyper-click what you mean into your agent's next prompt." "${PURPLE}"

echo ""
typewriter "${BLUE}on the board:${RESET}"
animated_separator "~" 10 "${PURPLE}"
typewriter "   ${PURPLE}•${RESET} your own claude, codex or any agent cli"
typewriter "   ${PURPLE}•${RESET} code navigation through your language server"
typewriter "   ${PURPLE}•${RESET} browser tiles agents can drive, html and drawing"
typewriter "   ${PURPLE}•${RESET} libghostty terminals in persistent zmx sessions"
echo ""
typewriter "${DIM}free and mit. macos 14+, apple silicon.${RESET}"
echo ""
printf '   %s  %s  %s\n' \
  "$(hyperlink "easl.sh" "https://easl.sh" "$PURPLE")" \
  "$(hyperlink "github" "https://github.com/twaldin/easl" "$PURPLE")" \
  "$(hyperlink "launch post" "https://tim.waldin.net/blog/2026-10-04-easl" "$PURPLE")"

git_activity "$PURPLE"
echo ""
typewriter "${RED}you're now in projects/easl${RESET}"
typewriter "${DIM}type nvim . to explore, or home to go back${RESET}"
echo ""
