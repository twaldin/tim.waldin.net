#!/bin/bash
source "$(dirname "$0")/shared-functions.sh"
emit_url "about"

echo ""
create_box "About Me" "Hi, I'm Tim. I optimize production AI agents at lindy.ai in San Francisco — evals, prompt optimization, making sure a change actually generalizes.

I also build in public when something is real enough to show. For now the interesting work is at Lindy.

fun fact: I took a leave from Purdue and moved to SF for this job.

type projects to see what I've shipped
type contact to get in touch" "$PURPLE" 80
echo ""
