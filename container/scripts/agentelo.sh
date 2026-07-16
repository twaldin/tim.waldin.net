#!/bin/bash
source "$(dirname "$0")/shared-functions.sh"
emit_url "projects/agentelo"

clear
echo ""
ascii_typewriter "agentelo" "DOS_Rebel" "${PURPLE}"

echo ""

create_box "Description" "Local benchmarking tool for AI coding agents. Bundles a frozen
snapshot of 148 agents across 6 CLI harnesses, scored on real
GitHub bug-fix PRs with Bradley-Terry MLE. CLI runs every step
locally — register, run, score, rank vs. the baseline. No
hosted submissions, no API keys for AgentElo itself.

Read-only snapshot: tim.waldin.net/agentelo" "${PURPLE}"

echo ""

typewriter "${BLUE}Tech Stack:${RESET}"
animated_separator "~" 10 "${PURPLE}"
typewriter "   ${PURPLE}•${RESET} TypeScript, Node.js"
typewriter "   ${PURPLE}•${RESET} Next.js (frontend), better-sqlite3 (snapshot DB)"
typewriter "   ${PURPLE}•${RESET} @twaldin/harness-ts (multi-CLI adapter layer)"
typewriter "   ${PURPLE}•${RESET} 6 harness adapters: claude-code, codex, opencode, gemini, aider, swe-agent"

echo ""

typewriter "${BLUE}Key Features:${RESET}"
animated_separator "~" 10 "${PURPLE}"
typewriter "   ${PURPLE}•${RESET} Bradley-Terry MLE rankings from ~3.5K verified runs"
typewriter "   ${PURPLE}•${RESET} 42 challenges mined from real merged PRs (click, fastify, flask, jinja, koa, marshmallow, qs, requests)"
typewriter "   ${PURPLE}•${RESET} Local agent runs sandboxed in tmpdir; tests re-run by the CLI"
typewriter "   ${PURPLE}•${RESET} Inferred ELO + which baselines you beat after a few runs"
typewriter "   ${PURPLE}•${RESET} Bundled SQLite snapshot ships with the npm package"

git_activity "$PURPLE"

echo ""

typewriter "${RED}You are now in the projects/agentelo directory${RESET}"
typewriter "${DIM}Use ls, tree, cat, nvim, or other commands to explore the actual git repository of this project,${RESET}"
typewriter "${DIM}or type home to go back to the home page ${RESET}"
echo ""
