#!/bin/zsh
# Double-click this file on macOS to open SlashTasks.
cd -- "$(dirname -- "$0")" || exit 1
runtime_node="$(command -v node)"
if [[ -z "$runtime_node" ]]; then
  runtime_node="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
fi
if [[ ! -x "$runtime_node" ]]; then
  print "SlashTasks needs Node.js 18 or newer. Install it, then double-click this file again."
  read "?Press Return to close."
  exit 1
fi
"$runtime_node" server.js --open
read "?Press Return to close."
