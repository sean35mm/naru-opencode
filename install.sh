#!/usr/bin/env sh
# Install the Naru for OpenCode commands and agents.
#
# By default this symlinks `commands/naru` and `agents/naru` into your global
# OpenCode config (~/.config/opencode) so a `git pull` keeps them current.
#
# Usage:
#   ./install.sh                 Symlink into ~/.config/opencode
#   ./install.sh --copy          Copy instead of symlink
#   ./install.sh --project       Install into ./.opencode (current repo)
#   ./install.sh --dir <path>    Install into a custom OpenCode config dir
set -eu

# Resolve the directory this script lives in (the repo root).
SRC_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

MODE="symlink"
TARGET="${HOME}/.config/opencode"

while [ $# -gt 0 ]; do
  case "$1" in
    --copy) MODE="copy" ;;
    --project) TARGET="$(pwd)/.opencode" ;;
    --dir) shift; TARGET="${1:?--dir requires a path}" ;;
    -h|--help)
      sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

install_one() {
  # $1 = subtree name under commands/ or agents/ (e.g. "commands", "agents")
  kind="$1"
  src="${SRC_DIR}/${kind}/naru"
  dest_parent="${TARGET}/${kind}"
  dest="${dest_parent}/naru"

  [ -d "$src" ] || { echo "missing source: $src" >&2; exit 1; }
  mkdir -p "$dest_parent"

  # Back up anything already at the destination so we never clobber silently.
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    backup="${dest}.bak.$(date +%Y%m%d%H%M%S)"
    echo "  existing ${kind}/naru → backed up to $(basename "$backup")"
    mv "$dest" "$backup"
  fi

  if [ "$MODE" = "copy" ]; then
    cp -R "$src" "$dest"
    echo "  copied   ${kind}/naru → ${dest}"
  else
    ln -s "$src" "$dest"
    echo "  linked   ${kind}/naru → ${dest}"
  fi
}

echo "Installing Naru for OpenCode (${MODE}) into ${TARGET}"
install_one commands
install_one agents
echo "Done. Start a new OpenCode session to pick up /naru/plan, /naru/impact, /naru/triage, /naru/review."
