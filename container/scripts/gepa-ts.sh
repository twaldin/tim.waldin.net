#!/bin/bash
source "$(dirname "$0")/shared-functions.sh"
emit_url "projects/gepa-ts"

clear
echo ""
ascii_typewriter "gepa-ts" "DOS_Rebel" "${PURPLE}"

echo ""

create_box "Description" "1-1 TypeScript port of gepa.optimize_anything — Genetic-Pareto
reflective text evolution. Zero runtime deps, bring your own LLM
adapter. Published as @twaldin/gepa-ts. Acceptance gate is the
upstream pytest suite running unmodified against this implementation." "${PURPLE}"

echo ""

typewriter "${BLUE}Tech Stack:${RESET}"
animated_separator "~" 10 "${PURPLE}"
typewriter "   ${PURPLE}•${RESET} TypeScript (Node ≥20, Bun, Deno)"
typewriter "   ${PURPLE}•${RESET} snake_case API, behavior-equivalent with Python gepa"
typewriter "   ${PURPLE}•${RESET} zero SDK deps — reflection LM is (prompt) => Promise<string>"
typewriter "   ${PURPLE}•${RESET} published @twaldin/gepa-ts"

echo ""
typewriter "${BLUE}source:${RESET} $(hyperlink "github.com/twaldin/gepa-ts" "https://github.com/twaldin/gepa-ts" "$PURPLE")"
echo ""
typewriter "${RED}You are now in the projects/gepa-ts directory${RESET}"
typewriter "${DIM}type home to go back${RESET}"
echo ""
