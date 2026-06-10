#!/usr/bin/env bash
# Source-checkout installer for the chat-recall local binary (monorepo layout).
# Once the package is published, `npm i -g chat-recall && chat-recall init`
# replaces this script entirely.
set -euo pipefail

if ! command -v node &>/dev/null; then
    echo "Error: node not found (v18+ required). Install: https://nodejs.org" >&2
    exit 1
fi

cd "$(dirname "$0")"

echo "Installing dependencies..."
npm install

echo "Building (engine + cli, with the engine bundled into the cli)..."
npm run build -w @chat-recall/engine
npm run build -w chat-recall

echo "Linking the chat-recall binary globally..."
npm link -w chat-recall

echo "Running setup (index + MCP registration)..."
chat-recall init

echo "Done. Try: chat-recall search \"something you worked on\""
