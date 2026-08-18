#!/bin/bash
source "$(dirname "$0")/shared-functions.sh"
emit_url "about"

echo ""
create_box "About Me" "Hi, I'm Tim. I optimize AI agents at lindy.ai in San Francisco.

Outside work I build open-source tooling for coding agents — type 'hone', 'harness', 'flt', or 'agentelo'. I also play CS2 (type 'trade-up-bot').

all anyone ever needs is tmux, raw nvim on the new native vim.pack (try my cfg!), and a sprinkle of coding agent cli.

fun fact: building that suite got me the job — i took a leave from purdue and moved to sf for it.

type projects to see what I'm working on
type contact to get in touch" "$PURPLE" 80
echo ""
