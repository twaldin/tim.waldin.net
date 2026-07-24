#!/usr/bin/env bash
# boot.sh — session intro. Picks a random intro animation AND a random
# width-appropriate figlet font for the banner, renders the banner to a
# shared file, plays the animation (with live theme flicker for animations
# that don't depend on a stable palette), then hands off to welcome.sh with
# the banner left standing at the top of the screen.
#
#   boot             random animation + random font (viewport-sized)
#   boot <anim>      force an animation (still random font)
#
# The animation's final frame (the twaldin banner) stays on screen and in
# scrollback: scroll up and you see prompt → banner → welcome output.
set -u
SCRIPTS=/home/portfolio/scripts
ANIM_DIR="$SCRIPTS/animations"
BANNER_FILE=/tmp/boot-banner.txt
FONT_FILE=/tmp/boot-font

ANIMATIONS=(braille-fire starfield-warp braille-plasma logo-decode font-cycle)
# Animations whose colors are all 16-slot get a live theme flicker while
# they play (frontend cycles paired dark/light themes per 'next'). Fire is
# 256-color and needs a stable palette, so it's excluded.
FLICKER_OK=(starfield-warp braille-plasma logo-decode font-cycle)

source "$SCRIPTS/shared-functions.sh"

cols=${COLUMNS:-$(tput cols 2>/dev/null || echo 80)}
(( cols < 10 )) && cols=80

# --- pick the font: largest width class that fits, random within class ---
: > "$BANNER_FILE"
font_line=$(pick_font_for_width $(( cols - 2 )) || true)
if [[ -n "$font_line" ]]; then
  font_name=${font_line%%|*}
  flf=${font_line##*|}
  if render_banner twaldin "$flf" > "$BANNER_FILE" && [[ -s "$BANNER_FILE" ]]; then
    printf '%s' "$font_name" > "$FONT_FILE"
  else
    : > "$BANNER_FILE"
  fi
fi
# Fallback: incumbent font, then plain text (animations handle empty file).
if [[ ! -s "$BANNER_FILE" ]]; then
  if (( cols >= 62 )); then
    figlet -f DOS_Rebel -w 400 twaldin 2>/dev/null | trim_trailing_blank_lines > "$BANNER_FILE" || true
    echo "DOS_Rebel" > "$FONT_FILE"
  else
    echo "twaldin" > "$BANNER_FILE"
    echo "plain" > "$FONT_FILE"
  fi
fi
export BOOT_BANNER_FILE="$BANNER_FILE"

# --- pick the animation ---
pick="${1:-}"
if [[ -z "$pick" ]]; then
  pick=${ANIMATIONS[$((RANDOM % ${#ANIMATIONS[@]}))]}
fi
if [[ ! -f "$ANIM_DIR/$pick.sh" ]]; then
  echo "boot: unknown animation '$pick' (have: ${ANIMATIONS[*]})" >&2
  exit 1
fi

# --- flicker loop (background; the animation's own reads keep skip input) ---
use_flicker=0
for a in "${FLICKER_OK[@]}"; do
  [[ "$pick" == "$a" ]] && use_flicker=1 && break
done
flick_pid=""
if (( use_flicker )); then
  ( while :; do printf '\033]9996;next\007'; sleep 0.45; done ) &
  flick_pid=$!
fi

bash "$ANIM_DIR/$pick.sh"

if [[ -n "$flick_pid" ]]; then
  kill "$flick_pid" 2>/dev/null
  wait "$flick_pid" 2>/dev/null
fi
printf '\033]9996;\007'   # restore the visitor's saved theme

WELCOME_SKIP_BANNER=1 exec bash "$SCRIPTS/welcome.sh"
