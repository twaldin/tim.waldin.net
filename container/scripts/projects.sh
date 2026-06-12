#!/bin/bash
source "$(dirname "$0")/shared-functions.sh"
emit_url "projects"

clear
echo ""
ascii_typewriter "projects" "DOS_Rebel" "${PURPLE}"

echo ""
animated_separator "+" 60 "${PURPLE}"
echo ""
typewriter "${PURPLE}1. flt${RESET}"
typewriter "   ${WHITE}CLI tool for spawning and orchestrating AI coding agents across 6 harnesses in tmux${RESET}"
typewriter "   ${BLUE}tech stack:${RESET} TypeScript, Bun, tmux, raw ANSI TUI"
typewriter "   ${DIM}type ${BOLD}\"flt\" to view info and navigate${RESET}"
echo ""

typewriter "${PURPLE}2. agentelo${RESET}"
typewriter "   ${WHITE}pairwise Glicko-2 rating system benchmarking AI coding agents across CLI harnesses${RESET}"
typewriter "   ${BLUE}tech stack:${RESET} TypeScript, Next.js, SQLite, Bun"
typewriter "   ${DIM}type ${BOLD}\"agentelo\" to view info and navigate${RESET}"
echo ""

typewriter "${PURPLE}3. trade-up-bot${RESET}"
typewriter "   ${WHITE}full-stack market arbitrage platform for CS2 trade-up contracts${RESET}"
typewriter "   ${BLUE}tech stack:${RESET} TypeScript, React, Express, SQLite, Redis"
typewriter "   ${DIM}type ${BOLD}\"trade-up-bot\" to view info and navigate${RESET}"
echo ""

typewriter "${PURPLE}4. term site${RESET}"
typewriter "   ${WHITE}web terminal portfolio in docker containers (you are in it right now)${RESET}"
typewriter "   ${BLUE}tech stack:${RESET} next.js, node.js, socket.IO, docker, typescript"
typewriter "   ${DIM}type ${BOLD}\"term-site\" to view info and navigate${RESET}"
echo ""

typewriter "${PURPLE}5. stm32 games${RESET}"
typewriter "   ${WHITE}play the classic snake game in c on a microcontroller with lcd screen.${RESET}"
typewriter "   ${BLUE}tech stack:${RESET} C, stm32, st7789 lcd screen, libopencm3"
typewriter "   ${DIM}type ${BOLD}\"stm32-games\" to view info and navigate${RESET}"
echo ""

typewriter "${PURPLE}6. hone${RESET}"
typewriter "   ${WHITE}GEPA prompt optimizer for coding CLIs — +20pp solve-rate lift on unseen bugs${RESET}"
typewriter "   ${BLUE}tech stack:${RESET} Python, GEPA/dspy, harness, agentelo"
typewriter "   ${DIM}type ${BOLD}\"hone\" to view info and navigate${RESET}"
echo ""

typewriter "${PURPLE}7. harness${RESET}"
typewriter "   ${WHITE}unified python interface wrapping 6 AI coding CLIs behind one API${RESET}"
typewriter "   ${BLUE}tech stack:${RESET} Python, subprocess + per-CLI adapters"
typewriter "   ${DIM}type ${BOLD}\"harness\" to view info and navigate${RESET}"
echo ""

typewriter "${PURPLE}8. dotfiles${RESET}"
typewriter "   ${WHITE}development environment configuration files${RESET}"
typewriter "   ${BLUE}tools:${RESET} zsh, lazyvim, tmux, ghostty, etc"
typewriter "   ${DIM}type ${BOLD}\"dotfiles\" to view info and navigate${RESET}"

echo ""
typewriter "${RED}You are now in the projects/ directory${RESET}"
typewriter "${DIM}Use ls, cd, nvim, or your other favorite commands to explore my projects, ${RESET}"
typewriter "${DIM}or type the project name to see info and navigate to the project repo. ${RESET}"
typewriter "${DIM}or type home to go back to the home page. ${RESET}"
echo ""
