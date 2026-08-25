#!/bin/bash
source "$(dirname "$0")/shared-functions.sh"
emit_url "projects/hone-a-drone"

clear
echo ""
ascii_typewriter "hone-a-drone" "DOS_Rebel" "${PURPLE}"

echo ""

create_box "Description" "Autonomous drone racing controller evolved by hone (GEPA +
Claude Code mutator) against the utiasDSL lsy_drone_racing sim.
The trajectory planner is the primary hone target; perception
and state estimation are ground-truth pass-through until DCL sim." "${PURPLE}"

echo ""

typewriter "${BLUE}Tech Stack:${RESET}"
animated_separator "~" 10 "${PURPLE}"
typewriter "   ${PURPLE}•${RESET} Python 3.11, uv"
typewriter "   ${PURPLE}•${RESET} hone as the mutator loop"
typewriter "   ${PURPLE}•${RESET} minimum-snap + TOPP-RA planner"
typewriter "   ${PURPLE}•${RESET} lsy_drone_racing sim"

echo ""
typewriter "${BLUE}source:${RESET} $(hyperlink "github.com/twaldin/hone-a-drone" "https://github.com/twaldin/hone-a-drone" "$PURPLE")"
echo ""
typewriter "${RED}You are now in the projects/hone-a-drone directory${RESET}"
typewriter "${DIM}type home to go back${RESET}"
echo ""
