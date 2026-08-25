#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/shared-functions.sh"

# Shared one-liner dump — sourced by projects.sh so the list lives once.
print_also_list() {
  typewriter "${BLUE}hackathon / thin${RESET}"
  animated_separator "~" 10 "${PURPLE}"
  typewriter "   ${PURPLE}•${RESET} $(hyperlink "blast-radius" "https://github.com/twaldin/blast-radius" "$PURPLE")  ${WHITE}jachacks${RESET}"
  typewriter "   ${PURPLE}•${RESET} $(hyperlink "blast-radius-nextjs" "https://github.com/twaldin/blast-radius-nextjs" "$PURPLE")  ${WHITE}next.js app${RESET}"
  typewriter "   ${PURPLE}•${RESET} $(hyperlink "electron-to-tauri" "https://github.com/twaldin/electron-to-tauri" "$PURPLE")  ${WHITE}thin tauri wrappers around electron-style web apps${RESET}"
  typewriter "   ${PURPLE}•${RESET} $(hyperlink "pareto-viz" "https://github.com/twaldin/pareto-viz" "$PURPLE")  ${WHITE}analyze and visualize n-dimensional pareto candidate sets${RESET}"

  echo ""
  typewriter "${BLUE}archived predecessors — READMEs point at flt${RESET}"
  animated_separator "~" 10 "${PURPLE}"
  typewriter "   ${PURPLE}•${RESET} $(hyperlink "claudecord" "https://github.com/twaldin/claudecord" "$PURPLE")  ${WHITE}discord channels for agent teams${RESET}"
  typewriter "   ${PURPLE}•${RESET} $(hyperlink "tmux-orchestrator" "https://github.com/twaldin/tmux-orchestrator" "$PURPLE")  ${WHITE}multi-agent teams in tmux, just bash${RESET}"
  typewriter "   ${PURPLE}•${RESET} $(hyperlink "openfleet" "https://github.com/twaldin/openfleet" "$PURPLE")  ${WHITE}harness-agnostic fleet control plane${RESET}"

  echo ""
  typewriter "${BLUE}profile${RESET}"
  animated_separator "~" 10 "${PURPLE}"
  typewriter "   ${PURPLE}•${RESET} $(hyperlink "twaldin" "https://github.com/twaldin/twaldin" "$PURPLE")  ${WHITE}github profile readme${RESET}"

  echo ""
  typewriter "${BLUE}forks${RESET}"
  animated_separator "~" 10 "${PURPLE}"
  typewriter "   ${PURPLE}•${RESET} $(hyperlink "firstmate" "https://github.com/twaldin/firstmate" "$PURPLE")  ${WHITE}21 commits ahead of kunchenguid/firstmate, 242 behind${RESET}"
  typewriter "   ${PURPLE}•${RESET} $(hyperlink "chrome-devtools-axi" "https://github.com/twaldin/chrome-devtools-axi" "$PURPLE")  ${WHITE}vanilla fork of kunchenguid/chrome-devtools-axi${RESET}"
  typewriter "   ${PURPLE}•${RESET} $(hyperlink "codex-acp" "https://github.com/twaldin/codex-acp" "$PURPLE")  ${WHITE}vanilla fork of zed-industries/codex-acp${RESET}"
  typewriter "   ${PURPLE}•${RESET} $(hyperlink "oh-my-pi" "https://github.com/twaldin/oh-my-pi" "$PURPLE")  ${WHITE}vanilla fork of can1357/oh-my-pi${RESET}"
  typewriter "   ${PURPLE}•${RESET} $(hyperlink "openai-oauth" "https://github.com/twaldin/openai-oauth" "$PURPLE")  ${WHITE}vanilla fork of EvanZhouDev/openai-oauth${RESET}"
  typewriter "   ${PURPLE}•${RESET} $(hyperlink "pokersolver" "https://github.com/twaldin/pokersolver" "$PURPLE")  ${WHITE}vanilla fork of davidvayn/pokersolver${RESET}"
  typewriter "   ${PURPLE}•${RESET} $(hyperlink "prime-agent" "https://github.com/twaldin/prime-agent" "$PURPLE")  ${WHITE}vanilla fork of PrimeIntellect-ai/prime-agent${RESET}"
}

# Sourced by projects.sh for the bottom dump — don't render the full page.
[[ "${BASH_SOURCE[0]}" != "${0}" ]] && return 0

emit_url "projects/also"

clear
echo ""
ascii_typewriter "also" "DOS_Rebel" "${PURPLE}"
echo ""
typewriter "${DIM}the rest of github.com/twaldin — one line each.${RESET}"
echo ""
print_also_list
echo ""
typewriter "${DIM}type a project name, or home to go back${RESET}"
echo ""
emit_scroll_top
