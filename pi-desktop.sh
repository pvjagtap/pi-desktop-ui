#!/usr/bin/env bash
set -e

# Resolve script directory so it works on double-click
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Source profile so `pi` is on PATH (nvm, fnm, etc.)
if [ -f "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc" 2>/dev/null
elif [ -f "$HOME/.zshrc" ]; then
  . "$HOME/.zshrc" 2>/dev/null
elif [ -f "$HOME/.profile" ]; then
  . "$HOME/.profile" 2>/dev/null
fi

export PI_DESKTOP=1

if ! command -v pi >/dev/null 2>&1; then
  echo "Error: 'pi' command not found in PATH."
  echo "Make sure pi is installed and available."
  echo ""
  echo "Press Enter to close..."
  read -r _
  exit 1
fi

pi --desktop "$@"
