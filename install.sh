#!/usr/bin/env sh
# Install Naru into OpenCode v2.
#
# Usage:
#   ./install.sh [--dry-run] [--dir PATH] [--opencode PATH]
#
# Applies by default; --dry-run prints the plan only (--apply and --preview are
# accepted for compatibility). This script is a thin launcher for the compiled
# native installer (tools/naru-native.mjs).
set -eu

SRC_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)

# A checkout is a build workspace, not an installable runtime tree. Release
# archives do not contain tsconfig.json and continue directly without npm.
if [ -f "${SRC_DIR}/tsconfig.json" ]; then
  BUILT_INSTALLER="${SRC_DIR}/.naru-build/install.sh"
  if [ ! -f "$BUILT_INSTALLER" ]; then
    echo "install.sh: source checkout is not built; run 'npm ci && npm run build' first" >&2
    exit 1
  fi
  exec sh "$BUILT_INSTALLER" "$@"
fi

for arg in "$@"; do
  if [ "$arg" = --legacy ]; then
    echo "install.sh: --legacy was removed; Naru now supports only OpenCode v2 (last v1 release: 0.9.0)" >&2
    exit 2
  fi
done

command -v node >/dev/null 2>&1 || { echo "install.sh: node is required for native installation" >&2; exit 1; }
exec node "${SRC_DIR}/tools/naru-native.mjs" install "$@"
