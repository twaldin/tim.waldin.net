#!/bin/bash
source "$(dirname "$0")/shared-functions.sh"
emit_url "projects/dotfiles"

clear
echo ""
ascii_typewriter "dotfiles" "DOS_Rebel" "${PURPLE}"
echo ""

create_box "Description" "My dotfiles. Currently i have nvim, zsh, ghostty, and tmux in here. contact me if you are dying to know more of my configs." "${PURPLE}"
echo ""

git_activity "${PURPLE}"

echo ""

typewriter "${RED}You are now in ~/.dotfiles, linked from ~/projects/dotfiles${RESET}"
typewriter "${DIM}Use ls, tree, cat, nvim, or other commands to explore the actual git repository of this project,${RESET}"
typewriter "${DIM}or type home to go back to the home page ${RESET}"
echo ""
