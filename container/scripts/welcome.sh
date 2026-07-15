#!/bin/bash
source "$(dirname "$0")/shared-functions.sh"

emit_url "welcome"
clear
echo ""

ascii_typewriter "twaldin" "DOS_Rebel" "${PURPLE}"

# Star counts are snapshotted at image build time (the runtime container has
# NetworkMode: none) — see the .stars layer in container/Dockerfile. Fall back
# to a hardcoded count when the file is missing or the fetch failed.
hone_stars=44
harness_stars=18
if [[ -s "$HOME/.stars" ]]; then
  stars=$(sed -n 's/^hone=\([0-9][0-9]*\)$/\1/p' "$HOME/.stars")
  [[ -n "$stars" ]] && hone_stars=$stars
  stars=$(sed -n 's/^harness=\([0-9][0-9]*\)$/\1/p' "$HOME/.stars")
  [[ -n "$stars" ]] && harness_stars=$stars
fi

# Social proof up top, everything clickable (OSC 8). Links stay OUT of
# create_box content — the box measures width with color codes stripped but
# doesn't know OSC 8 sequences are zero-width.
echo ""
proof_line="${DIM}$(hyperlink "hone" "https://github.com/twaldin/hone" "$PURPLE")${DIM}★${hone_stars} ·"
proof_line+="$(hyperlink "harness" "https://github.com/twaldin/harness" "$PURPLE")${DIM}★${harness_stars} ·"
proof_line+="$(hyperlink "ranked 148 coding agents on ~1B tokens" "https://tim.waldin.net/blog/2026-04-20-agentelo-155-combos" "$DIM")${DIM} ·"
proof_line+=" agents @$(hyperlink "lindy.ai" "https://lindy.ai" "$DIM")${RESET}"
typewriter "$proof_line"
echo ""

typewriter "${WHITE}i'm tim — i optimize ai agents at$(hyperlink "lindy.ai" "https://lindy.ai" "$BLUE")${WHITE} in san francisco.${RESET}"
typewriter "${WHITE}i built the coding-agent suite in the open:$(hyperlink "harness" "https://github.com/twaldin/harness" "$PURPLE")${WHITE} ·$(hyperlink "hone" "https://github.com/twaldin/hone" "$PURPLE")${WHITE} ·$(hyperlink "flt" "https://github.com/twaldin/flt" "$PURPLE")${WHITE} ·$(hyperlink "agentelo" "https://github.com/twaldin/agentelo" "$PURPLE")${WHITE}.${RESET}"
typewriter "${WHITE}$(hyperlink "one tweet" "https://x.com/twaldin/status/2046018469028565439" "$BLUE")${WHITE} about hone got retweeted by the creator of$(hyperlink "GEPA" "https://github.com/gepa-ai/gepa" "$BLUE")${WHITE}, went viral,${RESET}"
typewriter "${WHITE}and lindy's ceo cold-emailed me a job — i took a leave from purdue for it.${RESET}"

echo ""
create_box "portfolio terminal" "  about       learn about me

  contact     email + socials

  resume      view my resume

  projects    explore my projects

  blog        posts i've written

  gui         for mouse users (static page)

  help        all available commands" "${PURPLE}"
echo ""

typewriter "${WHITE}this is a ${BOLD}real shell${RESET}${WHITE} in a real container — all yours.${RESET}"
typewriter "${DIM}prove it: ${RESET}${CYAN}sudo rm -rf /${RESET}${DIM} (really) · ${RESET}${CYAN}htop${RESET}${DIM} · ${RESET}${CYAN}nvim projects/hone${RESET}${DIM} — type ${RESET}${CYAN}exit${RESET}${DIM} to reset${RESET}"
echo ""
