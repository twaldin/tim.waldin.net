#!/bin/bash
source "$(dirname "$0")/shared-functions.sh"
emit_url "projects/tim.waldin.net"

clear
echo ""
ascii_typewriter "tim.waldin.net" "DOS_Rebel" "${PURPLE}"

echo ""

create_box "description" "this site. an xterm.js terminal connects to a docker
container where you can explore my projects." "${PURPLE}"

echo ""

typewriter "${BLUE}tech stack:${RESET}"
typewriter "   ${YELLOW}frontend:${RESET} next.js with xterm.js"
typewriter "   ${YELLOW}backend:${RESET} node.js, socket.io, docker"
typewriter "   ${YELLOW}terminal:${RESET} an ubuntu container per visitor"

echo ""
animated_separator "~" 50


git_activity "${PURPLE}"

echo ""

typewriter "${RED}you're now in projects/tim.waldin.net${RESET}"
typewriter "${DIM}type nvim . to explore, or home to go back${RESET}"

echo ""
