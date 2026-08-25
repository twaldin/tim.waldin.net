#!/bin/bash
source "$(dirname "$0")/shared-functions.sh"
emit_url "projects/hone"

clear
echo ""
ascii_typewriter "hone" "DOS_Rebel" "${PURPLE}"

echo ""

create_box "Description" "GEPA-based prompt optimizer for AI coding CLIs. Evolves a system
prompt through pareto-style mutation + selection, scoring each variant
against real github bug-fix challenges via the agentelo grader. Lifted
claude haiku 4.5 from 6/9 to 8/9 solved on a held-out github bug set." "${PURPLE}"

echo ""

typewriter "${BLUE}Tech Stack:${RESET}"
animated_separator "~" 10 "${PURPLE}"
typewriter "   ${PURPLE}•${RESET} Python (GEPA + dspy integration)"
typewriter "   ${PURPLE}•${RESET} harness library for CLI-agnostic execution"
typewriter "   ${PURPLE}•${RESET} agentelo as the grader / challenge runner"
typewriter "   ${PURPLE}•${RESET} ~300-line coordinator glueing the three together"

echo ""

typewriter "${BLUE}Key Results:${RESET}"
animated_separator "~" 10 "${PURPLE}"
typewriter "   ${PURPLE}•${RESET} 6/9 to 8/9 holdout lift on claude haiku (see blog)"
typewriter "   ${PURPLE}•${RESET} Narrow goldilocks band — weak models can't execute the"
typewriter "     methodology, strong models already saturate"
typewriter "   ${PURPLE}•${RESET} Uses existing CLI subscription as the mutator (no API keys)"

git_activity "$PURPLE"

echo ""

typewriter "${RED}You are now in the projects/hone directory${RESET}"
typewriter "${DIM}Read writeup/ for the results, blog for the story, or type home to go back${RESET}"
echo ""
