#!/bin/bash
source "$(dirname "$0")/shared-functions.sh"
emit_url "contact"

links_line="${RED}󰇮$(email_link "timothy@waldin.net" "timothy@waldin.net" "$RED")${RESET}    "
links_line+="${PURPLE}$(hyperlink "github" "https://github.com/twaldin" "$PURPLE")${RESET}    "
links_line+="${BLUE}$(hyperlink "linkedin" "https://linkedin.com/in/twaldin" "$BLUE")${RESET}    "
links_line+="${PURPLE}$(hyperlink "instagram" "https://instagram.com/timn.w" "$PURPLE")${RESET}    "
links_line+="${BLUE}$(hyperlink "twitter" "https://x.com/twaldin0" "$BLUE")${RESET}    "
links_line+="${PURPLE}$(hyperlink "website" "https://tim.waldin.net" "$PURPLE")${RESET}    "

echo ""
echo -e "$links_line${RESET}"
echo ""
