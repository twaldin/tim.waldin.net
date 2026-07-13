#!/bin/bash
source "$(dirname "$0")/shared-functions.sh"
emit_url "projects/trade-up-bot"

clear
echo ""
ascii_typewriter "trade-up-bot" "DOS_Rebel" "${PURPLE}"

echo ""

create_box "Description" "Full-stack market arbitrage platform analyzing profitable CS2
trade-up contracts across 3 marketplaces in real time." "${PURPLE}"

echo ""

typewriter "${BLUE}Tech Stack:${RESET}"
animated_separator "~" 10 "${PURPLE}"
typewriter "   ${PURPLE}•${RESET} TypeScript, React, Express"
typewriter "   ${PURPLE}•${RESET} PostgreSQL and Redis"
typewriter "   ${PURPLE}•${RESET} Steam OpenID auth, Stripe payments"
typewriter "   ${PURPLE}•${RESET} Real-time WebSocket market feeds"
typewriter "   ${PURPLE}•${RESET} Discord bot with role-based tier management"

git_activity "${PURPLE}"

echo ""

typewriter "${RED}You are now in the projects/trade-up-bot directory${RESET}"
typewriter "${DIM}Use ls, tree, cat, nvim, or other commands to explore the actual git repository of this project,${RESET}"
typewriter "${DIM}or type home to go back to the home page ${RESET}"
echo ""
