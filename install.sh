#!/usr/bin/env sh
# Install Naru for OpenCode.
#
# Usage:
#   ./install.sh [--copy] [--project | --dir PATH] [--with-dashboard] [--configure-subagent-depth] [--migrate-orchestrator]
#
# Defaults to a global symlinked install into ~/.config/opencode. Markdown
# command/agent files are symlinked individually so a git pull keeps them
# current. Executable custom tools, helper directories, runtime plugins, and
# the optional dashboard plugin are always copy-pinned; rerun ./install.sh
# after git pull to update those executables.
set -eu

SRC_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)

MODE=symlink
TARGET="${HOME}/.config/opencode"
WITH_DASHBOARD=false
MIGRATE_ORCHESTRATOR=false
CONFIGURE_SUBAGENT_DEPTH=false
LOCATION_MODE=global

usage() {
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --copy) MODE=copy ;;
    --project) TARGET="${PWD}/.opencode"; LOCATION_MODE=project ;;
    --dir)
      if [ $# -lt 2 ]; then
        echo "install.sh: --dir requires a PATH" >&2
        exit 2
      fi
      shift
      case "$1" in
        -*) echo "install.sh: --dir requires a PATH, got $1" >&2; exit 2 ;;
      esac
      TARGET="$1"
      LOCATION_MODE=custom
      ;;
    --with-dashboard) WITH_DASHBOARD=true ;;
    --migrate-orchestrator) MIGRATE_ORCHESTRATOR=true ;;
    --configure-subagent-depth) CONFIGURE_SUBAGENT_DEPTH=true ;;
    -h|--help) usage; exit 0 ;;
    --*) echo "install.sh: unknown option $1" >&2; exit 2 ;;
    *) echo "install.sh: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done

# Resolve target to an absolute path and strip a trailing slash.
case "$TARGET" in
  /*) ;;
  *) TARGET="${PWD}/${TARGET}" ;;
esac
case "$TARGET" in
  */) TARGET="${TARGET%/}" ;;
esac

if [ -L "$TARGET" ]; then
  echo "install.sh: target directory must not be a symlink: $TARGET" >&2
  exit 1
fi
if [ -e "$TARGET" ] && [ ! -d "$TARGET" ]; then
  echo "install.sh: target exists and is not a directory: $TARGET" >&2
  exit 1
fi

canonical_path() {
  candidate="$1"
  suffix=""
  while [ ! -e "$candidate" ] && [ ! -L "$candidate" ]; do
    name=$(basename "$candidate")
    suffix="/${name}${suffix}"
    parent=$(dirname "$candidate")
    if [ "$parent" = "$candidate" ]; then
      return 1
    fi
    candidate="$parent"
  done
  resolved=$(CDPATH= cd -- "$candidate" 2>/dev/null && pwd -P) || return 1
  printf '%s%s\n' "$resolved" "$suffix"
}

TARGET=$(canonical_path "$TARGET") || {
  echo "install.sh: could not resolve target path" >&2
  exit 1
}

if [ "$LOCATION_MODE" = project ]; then
  CONFIG_ROOT=$(canonical_path "$PWD") || {
    echo "install.sh: could not resolve project config root" >&2
    exit 1
  }
else
  CONFIG_ROOT="$TARGET"
fi

# Reject any canonical overlap between source and target.
if [ "$SRC_DIR" = "$TARGET" ]; then
  echo "install.sh: source and target directories must not be the same" >&2
  exit 1
fi
case "${TARGET}/" in
  "${SRC_DIR}/"*)
    echo "install.sh: target must not be inside the source directory" >&2
    exit 1
    ;;
esac
case "${SRC_DIR}/" in
  "${TARGET}/"*)
    echo "install.sh: source must not be inside the target directory" >&2
    exit 1
    ;;
esac

for managed in commands agents tools plugins scripts .naru-backups .naru-staging; do
  if [ -L "${TARGET}/${managed}" ]; then
    echo "install.sh: refusing symlinked loader or managed directory: ${TARGET}/${managed}" >&2
    exit 1
  fi
  if [ -e "${TARGET}/${managed}" ] && [ ! -d "${TARGET}/${managed}" ]; then
    echo "install.sh: loader or managed path is not a directory: ${TARGET}/${managed}" >&2
    exit 1
  fi
done

# Transaction working files.
TX_DIR=$(mktemp -d 2>/dev/null) || TX_DIR=""
if [ -z "$TX_DIR" ] || [ ! -d "$TX_DIR" ]; then
  TX_DIR="/tmp/naru-install.$$"
  mkdir -p "$TX_DIR"
fi
PLAN="${TX_DIR}/plan"
CREATED="${TX_DIR}/created"
BACKUPS="${TX_DIR}/backups"
BACKUP_TS="$(date +%Y%m%d%H%M%S)-$$"
BACKUP_DIR="${TARGET}/.naru-backups/${BACKUP_TS}"
STAGE_DIR="${TARGET}/.naru-staging/${BACKUP_TS}"

add_plan() {
  method="$1"
  src="$2"
  rel="$3"
  printf '%s\t%s\t%s\n' "$method" "$src" "$rel" >> "$PLAN"
}

add_md() {
  add_plan "$MODE" "$1" "$2"
}

add_copy() {
  add_plan copy "$1" "$2"
}

: > "$PLAN"

# Commands (flat Markdown files).
add_md "${SRC_DIR}/commands/naru-plan.md"        "commands/naru-plan.md"
add_md "${SRC_DIR}/commands/naru-impact.md"      "commands/naru-impact.md"
add_md "${SRC_DIR}/commands/naru-triage.md"      "commands/naru-triage.md"
add_md "${SRC_DIR}/commands/naru-review.md"      "commands/naru-review.md"
add_md "${SRC_DIR}/commands/naru-review-post.md" "commands/naru-review-post.md"

# Core orchestrator agents and flattened specialists.
add_md "${SRC_DIR}/agents/naru-plan.md"                    "agents/naru-plan.md"
add_md "${SRC_DIR}/agents/naru-plan-architecture.md"       "agents/naru-plan-architecture.md"
add_md "${SRC_DIR}/agents/naru-plan-minimal-change.md"     "agents/naru-plan-minimal-change.md"
add_md "${SRC_DIR}/agents/naru-plan-risk.md"               "agents/naru-plan-risk.md"
add_md "${SRC_DIR}/agents/naru-plan-tests.md"              "agents/naru-plan-tests.md"
add_md "${SRC_DIR}/agents/naru-plan-judge.md"              "agents/naru-plan-judge.md"

add_md "${SRC_DIR}/agents/naru-impact.md"                  "agents/naru-impact.md"
add_md "${SRC_DIR}/agents/naru-impact-topology.md"         "agents/naru-impact-topology.md"
add_md "${SRC_DIR}/agents/naru-impact-contracts.md"        "agents/naru-impact-contracts.md"
add_md "${SRC_DIR}/agents/naru-impact-data.md"             "agents/naru-impact-data.md"
add_md "${SRC_DIR}/agents/naru-impact-frontend-mobile.md"  "agents/naru-impact-frontend-mobile.md"
add_md "${SRC_DIR}/agents/naru-impact-tests-ci.md"         "agents/naru-impact-tests-ci.md"
add_md "${SRC_DIR}/agents/naru-impact-judge.md"            "agents/naru-impact-judge.md"

add_md "${SRC_DIR}/agents/naru-triage.md"                  "agents/naru-triage.md"
add_md "${SRC_DIR}/agents/naru-triage-reproduction.md"     "agents/naru-triage-reproduction.md"
add_md "${SRC_DIR}/agents/naru-triage-codepath.md"         "agents/naru-triage-codepath.md"
add_md "${SRC_DIR}/agents/naru-triage-regression.md"       "agents/naru-triage-regression.md"
add_md "${SRC_DIR}/agents/naru-triage-tests.md"            "agents/naru-triage-tests.md"
add_md "${SRC_DIR}/agents/naru-triage-judge.md"            "agents/naru-triage-judge.md"

add_md "${SRC_DIR}/agents/naru-review.md"                  "agents/naru-review.md"
add_md "${SRC_DIR}/agents/naru-review-security.md"         "agents/naru-review-security.md"
add_md "${SRC_DIR}/agents/naru-review-backend.md"          "agents/naru-review-backend.md"
add_md "${SRC_DIR}/agents/naru-review-frontend-mobile.md"  "agents/naru-review-frontend-mobile.md"
add_md "${SRC_DIR}/agents/naru-review-integrations.md"     "agents/naru-review-integrations.md"
add_md "${SRC_DIR}/agents/naru-review-tests-ci.md"         "agents/naru-review-tests-ci.md"
add_md "${SRC_DIR}/agents/naru-review-judge.md"            "agents/naru-review-judge.md"

# Review-post agent.
add_md "${SRC_DIR}/agents/naru-review-post.md"   "agents/naru-review-post.md"

# Provider-neutral orchestrator and minions.
add_md "${SRC_DIR}/agents/naru-orchestrator.md"  "agents/naru-orchestrator.md"
add_md "${SRC_DIR}/agents/naru-minion-scout.md"  "agents/naru-minion-scout.md"
add_md "${SRC_DIR}/agents/naru-minion-investigate.md" "agents/naru-minion-investigate.md"
add_md "${SRC_DIR}/agents/naru-minion-architect.md"   "agents/naru-minion-architect.md"
add_md "${SRC_DIR}/agents/naru-minion-implement.md"   "agents/naru-minion-implement.md"
add_md "${SRC_DIR}/agents/naru-minion-debug.md"  "agents/naru-minion-debug.md"
add_md "${SRC_DIR}/agents/naru-minion-verify.md" "agents/naru-minion-verify.md"
add_md "${SRC_DIR}/agents/naru-minion-judge.md"  "agents/naru-minion-judge.md"

# Tools and helper library (always copy-pinned).
add_copy "${SRC_DIR}/tools/naru-git-read.js"          "tools/naru-git-read.js"
add_copy "${SRC_DIR}/tools/naru-github-read.js"       "tools/naru-github-read.js"
add_copy "${SRC_DIR}/tools/naru-github-post-review.js" "tools/naru-github-post-review.js"
add_copy "${SRC_DIR}/tools/naru-scheduler.js"         "tools/naru-scheduler.js"
add_copy "${SRC_DIR}/tools/naru-lib"                  "tools/naru-lib"

# Runtime plugins (always copy-pinned and installed by default). The scheduler
# remains inert unless naru-runtime.json explicitly selects observe or enforce.
add_copy "${SRC_DIR}/plugins/naru-delegate.js" "plugins/naru-delegate.js"
add_copy "${SRC_DIR}/plugins/naru-scheduler.js" "plugins/naru-scheduler.js"

# Runtime configuration example and bounded local evaluation assets.
add_copy "${SRC_DIR}/naru-runtime.example.json"         "naru-runtime.example.json"
add_copy "${SRC_DIR}/scripts/naru-live-eval.mjs"        "scripts/naru-live-eval.mjs"
add_copy "${SRC_DIR}/tests/fixtures/live-evals.json"    "scripts/live-evals.example.json"

# Optional dashboard plugin (always copy-pinned).
if [ "$WITH_DASHBOARD" = true ]; then
  add_copy "${SRC_DIR}/plugins/naru-minions-dashboard-state.mjs" "plugins/naru-minions-dashboard-state.mjs"
  add_copy "${SRC_DIR}/plugins/naru-minions-dashboard.tsx" "plugins/naru-minions-dashboard.tsx"
  if [ ! -f "${SRC_DIR}/scripts/merge-tui-config.mjs" ]; then
    echo "install.sh: missing source: ${SRC_DIR}/scripts/merge-tui-config.mjs" >&2
    rm -rf "$TX_DIR"
    exit 1
  fi
fi

if [ "$CONFIGURE_SUBAGENT_DEPTH" = true ] && [ ! -f "${SRC_DIR}/scripts/merge-opencode-config.mjs" ]; then
  echo "install.sh: missing source: ${SRC_DIR}/scripts/merge-opencode-config.mjs" >&2
  rm -rf "$TX_DIR"
  exit 1
fi

# Preflight every source before touching the target.
while IFS="$(printf '\t')" read -r method src rel; do
  [ -n "$src" ] || continue
  if [ ! -e "$src" ]; then
    echo "install.sh: missing source: $src" >&2
    rm -rf "$TX_DIR"
    exit 1
  fi
done < "$PLAN"

OPENCODE_CONFIG_REL=""
OPENCODE_CONFIG_INPUT=""
OPENCODE_CONFIG_PREPARED="${TX_DIR}/opencode-config"
if [ "$CONFIGURE_SUBAGENT_DEPTH" = true ]; then
  for rel in opencode.jsonc opencode.json; do
    config_path="${CONFIG_ROOT}/${rel}"
    if [ -L "$config_path" ]; then
      echo "install.sh: refusing symlinked OpenCode config: $config_path" >&2
      rm -rf "$TX_DIR"
      exit 1
    fi
    if [ -e "$config_path" ] && [ ! -f "$config_path" ]; then
      echo "install.sh: OpenCode config is not a regular file: $config_path" >&2
      rm -rf "$TX_DIR"
      exit 1
    fi
    if [ -f "$config_path" ]; then
      if [ -n "$OPENCODE_CONFIG_REL" ]; then
        echo "install.sh: refusing ambiguous OpenCode config: both opencode.jsonc and opencode.json exist in ${CONFIG_ROOT}" >&2
        rm -rf "$TX_DIR"
        exit 1
      fi
      OPENCODE_CONFIG_REL="$rel"
      OPENCODE_CONFIG_INPUT="$config_path"
    fi
  done
  if [ -z "$OPENCODE_CONFIG_REL" ]; then
    OPENCODE_CONFIG_REL="opencode.json"
    OPENCODE_CONFIG_INPUT="-"
  fi
  if command -v node >/dev/null 2>&1; then
    opencode_config_runtime=node
  elif command -v bun >/dev/null 2>&1; then
    opencode_config_runtime=bun
  else
    echo "install.sh: --configure-subagent-depth requires node or bun to merge OpenCode config safely" >&2
    rm -rf "$TX_DIR"
    exit 1
  fi
  if ! "$opencode_config_runtime" "${SRC_DIR}/scripts/merge-opencode-config.mjs" "$OPENCODE_CONFIG_INPUT" "$OPENCODE_CONFIG_PREPARED"; then
    rm -rf "$TX_DIR"
    exit 1
  fi
fi

TUI_CONFIG_RELS=""
TUI_REGISTER_REL=""
if [ "$WITH_DASHBOARD" = true ]; then
  for rel in tui.json tui.jsonc; do
    if [ -L "${TARGET}/${rel}" ]; then
      echo "install.sh: refusing symlinked TUI config: ${TARGET}/${rel}" >&2
      exit 1
    fi
    if [ -e "${TARGET}/${rel}" ] && [ ! -f "${TARGET}/${rel}" ]; then
      echo "install.sh: TUI config is not a regular file: ${TARGET}/${rel}" >&2
      exit 1
    fi
    if [ -f "${TARGET}/${rel}" ]; then
      TUI_CONFIG_RELS="${TUI_CONFIG_RELS}${TUI_CONFIG_RELS:+ }${rel}"
    fi
  done
  if [ -f "${TARGET}/tui.jsonc" ]; then
    TUI_REGISTER_REL="tui.jsonc"
  elif [ -f "${TARGET}/tui.json" ]; then
    TUI_REGISTER_REL="tui.json"
  else
    TUI_REGISTER_REL="tui.json"
    TUI_CONFIG_RELS="tui.json"
  fi
fi

mkdir -p "$TARGET"
BACKUP_DIR_CREATED=false
if [ ! -e "$BACKUP_DIR" ] && [ ! -L "$BACKUP_DIR" ]; then
  mkdir -p "$BACKUP_DIR"
  BACKUP_DIR_CREATED=true
fi

LAST_BACKUP_REL=""

backup_if_present() {
  rel="$1"
  abs="${TARGET}/${rel}"
  backup_path_if_present "$abs" "$rel" "$rel"
}

backup_path_if_present() {
  abs="$1"
  backup_name="$2"
  display="$3"
  LAST_BACKUP_REL=""
  if [ -e "$abs" ] || [ -L "$abs" ]; then
    backup_rel=".naru-backups/${BACKUP_TS}/${backup_name}"
    backup_abs="${TARGET}/${backup_rel}"
    mkdir -p "$(dirname "$backup_abs")"
    mv "$abs" "$backup_abs"
    printf '%s\t%s\n' "$abs" "$backup_rel" >> "$BACKUPS"
    LAST_BACKUP_REL="$backup_rel"
    echo "  backed up ${display}"
  fi
}

migrate_path() {
  LAST_BACKUP_REL=""
  backup_if_present "$1"
  if [ -n "$LAST_BACKUP_REL" ]; then
    echo "  migrated $1"
  fi
}

rollback() {
  echo "install.sh: transaction failed; rolling back..." >&2
  if [ -f "$CREATED" ]; then
    while IFS= read -r installed; do
      [ -n "$installed" ] || continue
      if [ -e "$installed" ] || [ -L "$installed" ]; then
        rm -rf "$installed"
      fi
    done < "$CREATED"
  fi
  if [ -f "$BACKUPS" ]; then
    while IFS="$(printf '\t')" read -r dst backup_rel; do
      [ -n "$dst" ] || continue
      src="${TARGET}/${backup_rel}"
      if [ -e "$src" ] || [ -L "$src" ]; then
        mkdir -p "$(dirname "$dst")"
        rm -rf "$dst"
        mv "$src" "$dst"
      fi
    done < "$BACKUPS"
  fi
  echo "install.sh: rollback complete" >&2
}

cleanup() {
  rc=$?
  trap - 0 1 2 15
  if [ $rc -ne 0 ]; then
    rollback
  fi
  if [ -e "$STAGE_DIR" ] || [ -L "$STAGE_DIR" ]; then
    rm -rf "$STAGE_DIR"
  fi
  if [ $rc -ne 0 ] && [ "$BACKUP_DIR_CREATED" = true ]; then
    rmdir "$BACKUP_DIR" 2>/dev/null || true
  fi
  rmdir "${TARGET}/.naru-staging" 2>/dev/null || true
  rm -rf "$TX_DIR"
  exit "$rc"
}
trap 'cleanup' 0
trap 'exit 130' 1 2 15

: > "$CREATED"
: > "$BACKUPS"

# Build the complete release under the target filesystem before touching any
# existing loader path. This catches copy/link failures before migration.
mkdir -p "$STAGE_DIR"
while IFS="$(printf '\t')" read -r method src rel; do
  [ -n "$src" ] || continue
  staged="${STAGE_DIR}/${rel}"
  mkdir -p "$(dirname "$staged")"
  if [ "$method" = copy ]; then
    cp -R "$src" "$staged"
  else
    ln -s "$src" "$staged"
  fi
done < "$PLAN"

if [ "$CONFIGURE_SUBAGENT_DEPTH" = true ]; then
  mkdir -p "${STAGE_DIR}/.naru-config"
  mv "$OPENCODE_CONFIG_PREPARED" "${STAGE_DIR}/.naru-config/${OPENCODE_CONFIG_REL}"
fi

# Prepare the TUI config before any destination is changed. The dependency-free
# helper validates JSON/JSONC and rewrites only the top-level plugin array.
if [ "$WITH_DASHBOARD" = true ]; then
  if command -v node >/dev/null 2>&1; then
    tui_runtime=node
  elif command -v bun >/dev/null 2>&1; then
    tui_runtime=bun
  else
    echo "install.sh: --with-dashboard requires node or bun to merge TUI config safely" >&2
    exit 1
  fi
  for rel in $TUI_CONFIG_RELS; do
    tui_input="${TARGET}/${rel}"
    [ -f "$tui_input" ] || tui_input="-"
    operation=remove
    [ "$rel" = "$TUI_REGISTER_REL" ] && operation=register
    "$tui_runtime" "${SRC_DIR}/scripts/merge-tui-config.mjs" "$tui_input" "${STAGE_DIR}/${rel}" "./plugins/naru-minions-dashboard.tsx" "$operation"
  done
fi

if [ "$CONFIGURE_SUBAGENT_DEPTH" = true ]; then
  config_dst="${CONFIG_ROOT}/${OPENCODE_CONFIG_REL}"
  if [ "$CONFIG_ROOT" = "$TARGET" ]; then
    backup_if_present "$OPENCODE_CONFIG_REL"
  else
    backup_path_if_present "$config_dst" "opencode-config/${OPENCODE_CONFIG_REL}" "$config_dst"
  fi
  mv "${STAGE_DIR}/.naru-config/${OPENCODE_CONFIG_REL}" "$config_dst"
  printf '%s\n' "$config_dst" >> "$CREATED"
  echo "  configured ${config_dst} with subagent_depth >= 2"
fi

# Migrate old Core loader paths out of scanned directories.
migrate_path "commands/naru"
migrate_path "agents/naru"
for f in "$TARGET"/commands/naru.bak.*; do
  [ -e "$f" ] || continue
  migrate_path "commands/$(basename "$f")"
done
for f in "$TARGET"/agents/naru.bak.*; do
  [ -e "$f" ] || continue
  migrate_path "agents/$(basename "$f")"
done

# Optional legacy orchestrator migration. Without this flag these paths are
# never touched.
if [ "$MIGRATE_ORCHESTRATOR" = true ]; then
  migrate_path "agents/orchestrator.md"
  migrate_path "agents/minion"
  migrate_path "plugins/orchestrator-dashboard.js"
fi

if [ "$WITH_DASHBOARD" = true ]; then
  migrate_path "plugins/naru-minions-dashboard.js"
fi

# Execute the install plan.
while IFS="$(printf '\t')" read -r method src rel; do
  [ -n "$src" ] || continue
  dst="${TARGET}/${rel}"
  staged="${STAGE_DIR}/${rel}"
  mkdir -p "$(dirname "$dst")"
  backup_if_present "$rel"
  mv "$staged" "$dst"
  printf '%s\n' "$dst" >> "$CREATED"
  echo "  installed ${rel}"
done < "$PLAN"

if [ "$WITH_DASHBOARD" = true ]; then
  for rel in $TUI_CONFIG_RELS; do
    backup_if_present "$rel"
    mv "${STAGE_DIR}/${rel}" "${TARGET}/${rel}"
    printf '%s\n' "${TARGET}/${rel}" >> "$CREATED"
    if [ "$rel" = "$TUI_REGISTER_REL" ]; then
      echo "  registered dashboard in ${rel}"
    else
      echo "  removed legacy dashboard registrations from ${rel}"
    fi
  done
fi

echo "Installed Naru into ${TARGET} (${MODE})"
echo "Backups kept at ${BACKUP_DIR}"
if [ "$MODE" = symlink ]; then
  echo "Markdown files are symlinked; rerun ./install.sh after git pull to update copy-pinned runtime and evaluation assets."
fi
