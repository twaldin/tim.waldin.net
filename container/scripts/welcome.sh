#!/bin/bash
source "$(dirname "$0")/shared-functions.sh"

# WELCOME_SKIP_BANNER=1 (set by boot.sh): the intro animation already left
# the big twaldin banner standing on screen — don't clear it away, just
# continue printing below it so scrollback reads: prompt → animation finale
# banner → this content.
emit_url "welcome"

print_banner() {
  # Instant figlet banner (no line-by-line animation). Prefers the font the
  # boot animation used (recorded in /tmp/boot-font) so a resume re-render
  # matches what the visitor saw at boot; falls back to DOS_Rebel, then to
  # plain bold text on narrow terminals.
  local cols=0 t
  t="$(tput cols 2>/dev/null)";                    [[ "$t" =~ ^[0-9]+$ ]] && (( t > cols )) && cols=$t
  t="$(stty size 2>/dev/null | awk '{print $2}')"; [[ "$t" =~ ^[0-9]+$ ]] && (( t > cols )) && cols=$t
  [[ "$COLUMNS" =~ ^[0-9]+$ ]]                  && (( COLUMNS > cols )) && cols=$COLUMNS
  (( cols < 10 )) && cols=80

  local font_arg="DOS_Rebel"
  if [[ -s /tmp/boot-font ]]; then
    local font_name flf
    font_name=$(cat /tmp/boot-font)
    flf=$(awk -F'|' -v n="$font_name" '$1 == n {print $4; exit}' /home/portfolio/scripts/fonts.txt 2>/dev/null)
    [[ -n "$flf" ]] && font_arg="/usr/share/figlet/custom/$flf"
  fi

  local ascii_output max_width
  ascii_output=$(figlet -f "$font_arg" twaldin 2>/dev/null || figlet twaldin)
  max_width=$(printf '%s' "$ascii_output" | wc -L | tr -d ' ')
  [[ "$max_width" =~ ^[0-9]+$ ]] || max_width=0
  if (( max_width > cols - 2 )) || (( cols < 24 )); then
    printf '%b\n' "${BOLD}${PURPLE}twaldin${RESET}"
    return
  fi
  printf '%b%s%b\n' "${PURPLE}" "$ascii_output" "${RESET}"
}

if [[ -z "${WELCOME_SKIP_BANNER:-}" ]]; then
  clear
  echo ""
  print_banner
fi

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
proof_line="${DIM}$(hyperlink "󰊤 hone" "https://github.com/twaldin/hone" "$PURPLE")${DIM}★${hone_stars} ·"
proof_line+="$(hyperlink "󰊤 harness" "https://github.com/twaldin/harness" "$PURPLE")${DIM}★${harness_stars} ·"
proof_line+="$(hyperlink "benchmarked 155 agent combos on ~1B tokens" "https://tim.waldin.net/blog/2026-04-20-agentelo-155-combos" "$DIM")${DIM} ·"
proof_line+=" agents @$(hyperlink "󰖟 lindy.ai" "https://lindy.ai" "$DIM")${RESET}"
typewriter "$proof_line"
echo ""

typewriter "${WHITE}i'm tim — i optimize ai agents at$(hyperlink "󰖟 lindy.ai" "https://lindy.ai" "$BLUE")${WHITE} in san francisco.${RESET}"
typewriter "${WHITE}i built the coding-agent suite in the open:$(hyperlink "󰊤 harness" "https://github.com/twaldin/harness" "$PURPLE")${WHITE} ·$(hyperlink "󰊤 hone" "https://github.com/twaldin/hone" "$PURPLE")${WHITE} ·$(hyperlink "󰊤 flt" "https://github.com/twaldin/flt" "$PURPLE")${WHITE} ·$(hyperlink "󰊤 agentelo" "https://github.com/twaldin/agentelo" "$PURPLE")${WHITE}.${RESET}"
typewriter "${WHITE}and then i got a job at$(hyperlink "󰖟 lindy" "https://lindy.ai" "$BLUE")${WHITE} — i took a leave from purdue for it.${RESET}"

echo ""
create_box "portfolio terminal" "  about       learn about me

  contact     email + socials

  resume      view my resume

  projects    explore my projects

  blog        posts i've written

  theme       pick a color scheme (463!)

  gui         for mouse users (static page)

  help        all available commands" "${PURPLE}"
echo ""

typewriter "${WHITE}this is a ${BOLD}real shell${RESET}${WHITE} in a real container — all yours.${RESET}"
typewriter "${DIM}prove it: ${RESET}${CYAN}sudo rm -rf /${RESET}${DIM} (really) · ${RESET}${CYAN}htop${RESET}${DIM} · ${RESET}${CYAN}nvim projects/hone${RESET}${DIM} — type ${RESET}${CYAN}exit${RESET}${DIM} to reset${RESET}"
echo ""
