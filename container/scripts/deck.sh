#!/bin/bash
source "$(dirname "$0")/shared-functions.sh"
emit_url "projects/deck"

clear
echo ""
ascii_typewriter "deck" "DOS_Rebel" "${PURPLE}"

echo ""

create_box "Description" "Local, operator-attended software factory used from a pinned
Prime Agent conversation. Durable delivery work runs in Smithers
when the conversation calls ship or adopt. Not a hosted product,
not an autonomous supervisor, not an unattended merge service —
the operator stays responsible for credentials, policy, and any
explicit merge authorization." "${PURPLE}"

echo ""

typewriter "${BLUE}Tech Stack:${RESET}"
animated_separator "~" 10 "${PURPLE}"
typewriter "   ${PURPLE}•${RESET} TypeScript, Bun"
typewriter "   ${PURPLE}•${RESET} reviewed Prime Agent 0.7.0 artifact"
typewriter "   ${PURPLE}•${RESET} Smithers PR pipeline (implement → review → CI → merge)"
typewriter "   ${PURPLE}•${RESET} deck-questions / deck-ship / deck-recall"

echo ""
typewriter "${BLUE}source:${RESET} $(hyperlink "github.com/twaldin/deck" "https://github.com/twaldin/deck" "$PURPLE")"
echo ""
typewriter "${RED}You are now in the projects/deck directory${RESET}"
typewriter "${DIM}type home to go back${RESET}"
echo ""
