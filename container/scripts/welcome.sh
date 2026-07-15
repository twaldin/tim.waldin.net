#!/bin/bash
source "$(dirname "$0")/shared-functions.sh"

emit_url "welcome"
clear
echo ""

ascii_typewriter "twaldin" "DOS_Rebel" "${PURPLE}"

echo ""
create_box "portfolio terminal" "  about       learn about me

  contact     email + socials

  resume      view my resume

  projects    explore my projects

  blog        posts i've written

  help        all available commands" "${PURPLE}"
echo ""

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

typewriter "${WHITE}this is a ${BOLD}real shell${RESET}${WHITE} in a real container — all yours.${RESET}"
typewriter "${DIM}prove it: ${RESET}${CYAN}sudo rm -rf /${RESET}${DIM} (really) · ${RESET}${CYAN}htop${RESET}${DIM} · ${RESET}${CYAN}nvim projects/hone${RESET}${DIM} — type ${RESET}${CYAN}exit${RESET}${DIM} to reset${RESET}"
typewriter "${DIM}hone ★${hone_stars} · harness ★${harness_stars} · ranked 148 coding agents on ~1B tokens · agents @ lindy.ai${RESET}"
echo ""
