#!/bin/bash
source "$(dirname "$0")/shared-functions.sh"

# WELCOME_SKIP_BANNER=1 (set by boot.sh): the intro animation already left
# the big twaldin banner standing on screen — don't clear it away, just
# continue printing below it so scrollback reads: prompt → animation finale
# banner → this content.
emit_url "welcome"

print_banner() {
  # Instant figlet banner (no line-by-line animation), CENTERED like the
  # boot animations leave it. Prefers the font the boot animation used
  # (/tmp/boot-font) so a resume re-render matches what the visitor saw —
  # but re-validates the width: if the terminal got narrower since boot
  # (resize → refresh), re-pick a font that fits instead of printing a
  # wrapped/clipped banner.
  local cols=0 t
  t="$(tput cols 2>/dev/null)";                    [[ "$t" =~ ^[0-9]+$ ]] && (( t > cols )) && cols=$t
  t="$(stty size 2>/dev/null | awk '{print $2}')"; [[ "$t" =~ ^[0-9]+$ ]] && (( t > cols )) && cols=$t
  [[ "$COLUMNS" =~ ^[0-9]+$ ]]                  && (( COLUMNS > cols )) && cols=$COLUMNS
  (( cols < 10 )) && cols=80

  local flf="" line w
  if [[ -s /tmp/boot-font ]]; then
    line=$(awk -F'|' -v n="$(cat /tmp/boot-font)" '$1 == n {print; exit}' "$FONTS_MANIFEST" 2>/dev/null)
    if [[ -n "$line" ]]; then
      w=$(printf '%s' "$line" | cut -d'|' -f2)
      (( w <= cols - 2 )) && flf=$(printf '%s' "$line" | cut -d'|' -f4)
    fi
  fi
  if [[ -z "$flf" ]]; then
    line=$(pick_font_for_width $(( cols - 2 )) || true)
    [[ -n "$line" ]] && flf=$(printf '%s' "$line" | cut -d'|' -f4)
  fi

  local ascii_output=""
  [[ -n "$flf" ]] && ascii_output=$(render_banner twaldin "$flf")
  if [[ -z "$ascii_output" ]] && (( cols >= 62 )); then
    ascii_output=$(figlet -f DOS_Rebel twaldin 2>/dev/null | trim_trailing_blank_lines)
  fi
  if [[ -z "$ascii_output" ]]; then
    printf '%b\n' "${BOLD}${PURPLE}twaldin${RESET}"
    return
  fi
  printf '%s\n' "$ascii_output" | print_centered "${PURPLE}"
}

if [[ -z "${WELCOME_SKIP_BANNER:-}" ]]; then
  clear
  echo ""
  print_banner
fi

# Paced reveal: after the banner, the copy types itself out line by line.
# Line-granular (not per-char — per-char loops split ANSI escapes across
# Socket.IO flushes and render "93m" fragments). Any keypress skips to
# instant, draining the buffered burst so leftovers don't execute as
# mangled commands (same tradeoff as the animation skip in boot.sh).
# Non-tty stdin (captures/tests) hits EOF on read immediately → no stalls.
WELCOME_PACE_COPY="${WELCOME_PACE_COPY:-0.40}"
WELCOME_PACE_BOX="${WELCOME_PACE_BOX:-0.07}"
WELCOME_PACE_BLANK="${WELCOME_PACE_BLANK:-0.18}"
_wt_skip=0

_wt_pace() {
  (( _wt_skip )) && return 0
  # Read from /dev/tty, NOT stdin: the box cascade feeds stdin a herestring,
  # and a bare read would eat (then drain) the very content being printed.
  if read -rsn1 -t "$1" < /dev/tty 2>/dev/null; then
    _wt_skip=1
    while read -rsn1 -t 0.05 < /dev/tty 2>/dev/null; do :; done
  fi
}
wt() { printf '%b\n' "$1"; _wt_pace "${2:-$WELCOME_PACE_COPY}"; }
wtblank() { echo ""; _wt_pace "$WELCOME_PACE_BLANK"; }

# Links stay OUT of create_box content — the box measures width with color
# codes stripped but doesn't know OSC 8 sequences are zero-width.
wtblank

wt "${WHITE}i'm tim — i optimize production ai agents at$(hyperlink "󰖟 lindy.ai" "https://lindy.ai" "$BLUE")${WHITE} in san francisco.${RESET}"
wt "${WHITE}evals, prompt optimization, scoring real traces — the job is \"did it actually get better.\"${RESET}"

wtblank
# The box cascades faster than the prose — menu items, not copy.
box_out=$(create_box "portfolio terminal" "  about       learn about me

  contact     email + socials

  resume      view my resume

  projects    explore my projects

  blog        posts i've written

  theme       pick a color scheme (463!)

  gui         for mouse users (static page)

  help        all available commands" "${PURPLE}")
while IFS= read -r _box_line; do
  printf '%s\n' "$_box_line"
  _wt_pace "$WELCOME_PACE_BOX"
done <<< "$box_out"
wtblank

wt "${WHITE}this is a ${BOLD}real shell${RESET}${WHITE} in a real container — all yours.${RESET}"
wt "${DIM}prove it: ${RESET}${CYAN}sudo rm -rf /${RESET}${DIM} (really) · ${RESET}${CYAN}htop${RESET}${DIM} · ${RESET}${CYAN}nvim projects/hone${RESET}${DIM} — type ${RESET}${CYAN}exit${RESET}${DIM} to reset${RESET}"
wtblank
