#!/bin/bash
source "$(dirname "$0")/shared-functions.sh"
emit_url "projects/hone"

clear
echo ""
ascii_typewriter "hone" "DOS_Rebel" "${PURPLE}"

echo ""

create_box "Description" "an experimental engine for improving code against a fixed objective.
a task has a baseline, an evaluator and a budget. a model-backed
optimizer proposes changes in a sandbox; separate trusted code
scores each candidate and keeps only real improvements.
the optimizer never grades its own work. this is research code,
not a packaged tool yet." "${PURPLE}"

echo ""

typewriter "${BLUE}Tech Stack:${RESET}"
animated_separator "~" 10 "${PURPLE}"
typewriter "   ${PURPLE}•${RESET} TypeScript, sandboxed evaluators, hone-capsules"

echo ""

typewriter "${BLUE}tasks:${RESET} $(hyperlink "github.com/twaldin/hone-capsules" "https://github.com/twaldin/hone-capsules" "$PURPLE")"
echo ""
typewriter "first result (april, v1): claude haiku 4.5 from 0.65 to 0.85 mean score on 9 unseen bugs — see blog"

git_activity "$PURPLE"

echo ""

typewriter "${RED}You are now in the projects/hone directory${RESET}"
typewriter "${DIM}Read README.md and docs/ for the engine, blog for the first result, or type home to go back${RESET}"
echo ""
