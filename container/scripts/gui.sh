#!/bin/bash
# Hand off to the static point-and-click page — same OSC 9997 hard-navigate
# the blog uses for its cold pages.
source "$(dirname "$0")/shared-functions.sh"

typewriter "$(printf '\033[2m')opening the point-and-click version...$(printf '\033[0m')"
emit_navigate "/gui"
