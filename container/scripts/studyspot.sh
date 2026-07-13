#!/bin/bash
source "$(dirname "$0")/shared-functions.sh"
emit_url "projects/studyspot"

clear
echo ""
ascii_typewriter "studyspot" "DOS_Rebel" "${PURPLE}"

echo ""

create_box "Description" "Co-founded AI study platform (studyspot.us). RAG pipeline + Claude
answering questions from uploaded course materials — pgvector semantic
search over your notes and slides, streaming responses, auto-generated
flashcards and quizzes." "${PURPLE}"

echo ""

typewriter "${BLUE}Tech Stack:${RESET}"
animated_separator "~" 10 "${PURPLE}"
typewriter "   ${PURPLE}•${RESET} Next.js (frontend)"
typewriter "   ${PURPLE}•${RESET} Cloudflare Workers"
typewriter "   ${PURPLE}•${RESET} pgvector semantic search"
typewriter "   ${PURPLE}•${RESET} Claude API with streaming responses"

echo ""

typewriter "${BLUE}Why It Matters To Me:${RESET}"
animated_separator "~" 10 "${PURPLE}"
typewriter "   ${PURPLE}•${RESET} Where I started agentic coding — began with Cursor,"
typewriter "     switched to claude-code the week it released"
typewriter "   ${PURPLE}•${RESET} Built all summer 2025"

git_activity "$PURPLE"

echo ""

typewriter "${RED}You are now in the projects/studyspot directory${RESET}"
typewriter "${DIM}Use ls, tree, cat, nvim, or other commands to explore the actual git repository of this project,${RESET}"
typewriter "${DIM}or type home to go back to the home page ${RESET}"
echo ""
