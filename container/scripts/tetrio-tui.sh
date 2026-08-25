#!/bin/bash
source "$(dirname "$0")/shared-functions.sh"
emit_url "projects/tetrio-tui"

clear
echo ""
ascii_typewriter "tetrio-tui" "DOS_Rebel" "${PURPLE}"

echo ""

create_box "Description" "TETR.IO TUI. Custom protocol client (theorypack / Ribbon /
NetCodec, reverse-engineered) plus a TETR.IO-exact local stacker
engine. Solo modes — 40 LINES, BLITZ, ZEN, practice — run with
--offline. Live league and custom rooms need network this container
does not have." "${PURPLE}"

echo ""

typewriter "${BLUE}Tech Stack:${RESET}"
animated_separator "~" 10 "${PURPLE}"
typewriter "   ${PURPLE}•${RESET} TypeScript"
typewriter "   ${PURPLE}•${RESET} theorypack (msgpackr) · Ribbon WS · NetCodec game stream"
typewriter "   ${PURPLE}•${RESET} TETR.IO-exact engine (SRS+ kicks, Park-Miller RNG)"
typewriter "   ${PURPLE}•${RESET} truecolor TUI"

echo ""

typewriter "${BLUE}Play:${RESET}"
animated_separator "~" 10 "${PURPLE}"
typewriter "   ${PURPLE}•${RESET} --offline — no network, straight to the solo menu"
typewriter "   ${PURPLE}•${RESET} live Tetra League / custom rooms need a network"
typewriter "     this site's container does not have"
typewriter "   ${PURPLE}•${RESET} unofficial fan client — not affiliated with TETR.IO"

echo ""
typewriter "${BLUE}source:${RESET} $(hyperlink "github.com/twaldin/tetrio-tui" "https://github.com/twaldin/tetrio-tui" "$PURPLE")"
echo ""
typewriter "${RED}You are now in the projects/tetrio-tui directory${RESET}"
typewriter "${DIM}type home to go back${RESET}"
echo ""
