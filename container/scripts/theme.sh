#!/usr/bin/env bash
# theme.sh — let visitors re-theme the whole site, live.
#
#   theme                 fzf picker over all 463 themes, live-previewing
#                         each highlight (OSC 9996); enter persists (OSC 9995)
#   theme <name>          persist a theme by exact name (case-insensitive)
#   theme dark|light      switch to your saved/default theme for that mode
#   theme reset           back to the site defaults
#   theme list            print every theme name
#
# OSC protocol (frontend Terminal.tsx):
#   9996 <name>  — ephemeral repaint (previews, animations); empty = restore saved
#   9995 <name>  — persist as the visitor's theme for the current mode
#   9995 dark|light — switch mode;  9995 reset — clear saved choices
set -u
THEMES_FILE=/home/portfolio/scripts/themes.txt

emit_preview() { printf '\033]9996;%s\007' "$1"; }
emit_persist() { printf '\033]9995;%s\007' "$1"; }

usage() {
  cat >&2 <<'EOF'
usage:
  theme                 pick interactively (live preview)
  theme <name>          set theme by name
  theme dark | light    switch mode
  theme reset           restore site defaults
  theme list            all 463 theme names
EOF
  exit 1
}

[[ $# -gt 1 ]] && usage

cmd=${1:-}
case "$cmd" in
  dark|light)
    emit_persist "$cmd"
    echo "theme: switched to $cmd mode"
    ;;
  reset)
    emit_persist reset
    echo "theme: restored site defaults"
    ;;
  list)
    cat "$THEMES_FILE"
    ;;
  "")
    # Interactive picker: highlight repaints the terminal live; enter keeps
    # the theme, esc restores whatever you had saved. The preview hook is
    # fzf's cursor-move mechanism (a change-bind only fires on query edits,
    # so arrow-key browsing never previewed). The window is zero-height and
    # borderless — fzf skips hidden windows entirely, so it must stay
    # technically visible to execute.
    choice=$(
      fzf --reverse \
          --prompt='theme> ' \
          --header='enter: keep · esc: cancel (previews are live)' \
          --preview "printf '\033]9996;%s\007' {} > /dev/tty" \
          --preview-window=down,0,noborder \
          < "$THEMES_FILE"
    ) || { emit_preview ""; exit 0; }   # esc → restore saved
    emit_persist "$choice"
    echo "theme: set to '$choice' (persists across visits)"
    ;;
  *)
    # Exact match first, then case-insensitive.
    match=$(grep -ixF "$cmd" "$THEMES_FILE" | head -1)
    [[ -z "$match" ]] && match=$(grep -ixF "${cmd//-/ }" "$THEMES_FILE" | head -1)
    if [[ -z "$match" ]]; then
      echo "theme: no theme named '$cmd' — try 'theme list' or just 'theme'" >&2
      exit 1
    fi
    emit_persist "$match"
    echo "theme: set to '$match' (persists across visits)"
    ;;
esac
