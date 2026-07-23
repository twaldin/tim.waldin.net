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
MANIFEST="$SCRIPTS/fonts.txt"
FONTS_DIR=/usr/share/figlet/custom
BANNER_FILE=/tmp/boot-banner.txt
FONT_FILE=/tmp/boot-font

ANIMATIONS=(braille-fire starfield-warp braille-plasma logo-decode font-cycle)
# Animations whose colors are all 16-slot get a live theme flicker while
# they play (frontend cycles paired dark/light themes per 'next'). Fire is
# 256-color and needs a stable palette, so it's excluded.
FLICKER_OK=(starfield-warp braille-plasma logo-decode font-cycle)

cols=${COLUMNS:-$(tput cols 2>/dev/null || echo 80)}
(( cols < 10 )) && cols=80

# --- pick the font: largest width class that fits, random within class ---
# manifest: Display Name|width|height|flf_filename  (width = render cols)
maxw=$(( cols - 2 ))
pick_font_line() {
  local class_floor line
  for class_floor in 67 47 21; do
    if (( maxw >= class_floor )); then
      mapfile -t pool < <(awk -F'|' -v lo="$class_floor" -v hi="$maxw" \
        '$2+0 >= lo && $2+0 <= hi {print}' "$MANIFEST" 2>/dev/null)
      if (( ${#pool[@]} > 0 )); then
        printf '%s' "${pool[$((RANDOM % ${#pool[@]}))]}"
        return 0
      fi
    fi
  done
  # anything that fits at all
  mapfile -t pool < <(awk -F'|' -v hi="$maxw" '$2+0 <= hi {print}' "$MANIFEST" 2>/dev/null)
  (( ${#pool[@]} > 0 )) && { printf '%s' "${pool[$((RANDOM % ${#pool[@]}))]}"; return 0; }
  return 1
}

trim_blanks() { # strip trailing blank lines
  awk '{l[NR]=$0} END{last=NR; while(last>0 && l[last] ~ /^[[:space:]]*$/) last--; for(i=1;i<=last;i++) print l[i]}'
}

: > "$BANNER_FILE"
font_line=$(pick_font_line || true)
if [[ -n "$font_line" ]]; then
  font_name=${font_line%%|*}
  flf=${font_line##*|}
  if figlet -f "$FONTS_DIR/$flf" -w 400 twaldin 2>/dev/null | trim_blanks > "$BANNER_FILE" && [[ -s "$BANNER_FILE" ]]; then
    printf '%s' "$font_name" > "$FONT_FILE"
  else
    : > "$BANNER_FILE"
  fi
fi
# Fallback: incumbent font, then plain text (animations handle empty file).
if [[ ! -s "$BANNER_FILE" ]]; then
  if (( cols >= 62 )); then
    figlet -f DOS_Rebel -w 400 twaldin 2>/dev/null | trim_blanks > "$BANNER_FILE" || true
    echo "DOS Rebel" > "$FONT_FILE"
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
