#!/bin/bash
source "$(dirname "$0")/shared-functions.sh"
emit_url "about"

echo ""
create_box "About Me" "Hi, I'm Tim. I work on agent reliability at lindy.ai in San Francisco: production evals and prompt optimization.

I also build tools for coding agents in public — the newest is easl.

type projects to see what I've shipped
type contact to get in touch" "$PURPLE" 80
echo ""
