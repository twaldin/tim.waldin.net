#!/bin/bash
source "$(dirname "$0")/shared-functions.sh"
emit_url "projects/harness"

clear
echo ""
ascii_typewriter "harness" "DOS_Rebel" "${PURPLE}"

echo ""

create_box "Description" "Unified python+ts interface for invoking 13 AI coding CLIs as
subprocesses — claude-code, openclaude, opencode, codex, gemini, aider,
swe-agent, qwen, continue-cli, pi, factory-droid, kilo, crush — behind
one \`RunSpec -> RunResult\` contract. Each CLI's quirks (env setup, flag
munging, cost/token parsing) lives in exactly one adapter file." "${PURPLE}"

echo ""

typewriter "${BLUE}Tech Stack:${RESET}"
animated_separator "~" 10 "${PURPLE}"
typewriter "   ${PURPLE}•${RESET} Python (subprocess + per-CLI adapters)"
typewriter "   ${PURPLE}•${RESET} \`harness run\` CLI with --json output"
typewriter "   ${PURPLE}•${RESET} Pluggable registry — add a CLI by subclassing Adapter"
typewriter "   ${PURPLE}•${RESET} Uniform token + cost reporting across providers"

echo ""

typewriter "${BLUE}Consumers:${RESET}"
animated_separator "~" 10 "${PURPLE}"
typewriter "   ${PURPLE}•${RESET} ${PURPLE}hone${RESET} — mutator via \`harness:<cli>:<model>\` spec"
typewriter "   ${PURPLE}•${RESET} ${PURPLE}agentelo${RESET} — grader subprocess runner"
typewriter "   ${PURPLE}•${RESET} ${PURPLE}flt${RESET} — post-exit cost/token extraction (TS shell-out)"

git_activity "$PURPLE"

echo ""

typewriter "${RED}You are now in the projects/harness directory${RESET}"
typewriter "${DIM}Read README.md for the full API + integration sketches, or type home to go back${RESET}"
echo ""
