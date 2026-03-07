#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE="${1:-$PWD}"
shift || true
node "$ROOT_DIR/cli.js" start --foreground --workspace "$WORKSPACE" --web-host 0.0.0.0 "$@"
