#!/usr/bin/env bash
# Compatibility entry point; npm run build uses the cross-platform Node script.
set -euo pipefail
node "$(cd "$(dirname "$0")" && pwd)/build.mjs" "$@"
