#!/usr/bin/env bash
set -euo pipefail

if ! command -v node &>/dev/null; then
    echo "Error: node not found (v18+ required). Install: https://nodejs.org" >&2
    exit 1
fi

echo "Installing dependencies..."
npm install

echo "Building..."
npm run build

if command -v claude &>/dev/null; then
    claude mcp add chat-recall -- node "$(pwd)/dist/mcp.js"
    echo "Registered with Claude Code"
else
    echo "Claude Code not found — register manually:"
    echo "  claude mcp add chat-recall -- node $(pwd)/dist/mcp.js"
fi

echo "Done. Run 'chat-recall index' to build the search index."
