#!/bin/bash
source "$(dirname "$0")/shared-functions.sh"
emit_url "projects/flt"

clear
echo ""
ascii_typewriter "flt" "DOS_Rebel" "${PURPLE}"

echo ""
typewriter "${DIM}archived on github: no longer maintained${RESET}"
echo ""

create_box "Description" "CLI tool that spawns and orchestrates AI coding agents across
6 harnesses (Claude Code, Codex, Gemini CLI, Aider, OpenCode, SWE-agent)
in tmux. Agents can message each other, spawn children, and report back." "${PURPLE}"

echo ""

typewriter "${BLUE}Tech Stack:${RESET}"
animated_separator "~" 10 "${PURPLE}"
typewriter "   ${PURPLE}•${RESET} TypeScript, Bun (runtime)"
typewriter "   ${PURPLE}•${RESET} tmux (session management)"
typewriter "   ${PURPLE}•${RESET} Raw ANSI TUI with damage-tracked screen buffer"
typewriter "   ${PURPLE}•${RESET} Custom CLI adapters for 6 AI harnesses"
typewriter "   ${PURPLE}•${RESET} Git worktrees for agent isolation"

echo ""

typewriter "${BLUE}Key Features:${RESET}"
animated_separator "~" 10 "${PURPLE}"
typewriter "   ${PURPLE}•${RESET} 3-command API: spawn, send, kill"
typewriter "   ${PURPLE}•${RESET} Inter-agent messaging and inbox"
typewriter "   ${PURPLE}•${RESET} Auto-approval of permission prompts"
typewriter "   ${PURPLE}•${RESET} Spinner/idle detection per harness"
typewriter "   ${PURPLE}•${RESET} TUI with vim keybinds, themes, live logs"
typewriter "   ${PURPLE}•${RESET} Cron integration for persistent agents"

git_activity "$PURPLE"

echo ""

typewriter "${RED}You are now in the projects/flt directory${RESET}"
typewriter "${DIM}Use ls, tree, cat, nvim, or other commands to explore the actual git repository of this project,${RESET}"
typewriter "${DIM}or type home to go back to the home page ${RESET}"
echo ""
