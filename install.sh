#!/usr/bin/env sh
# Install Naru for OpenCode.
#
# Usage:
#   ./install.sh [--preview | --apply] [--replace-conflicts] [--copy] [--project | --dir PATH] [--with-dashboard] [--configure-subagent-depth] [--migrate-orchestrator]
#   ./install.sh --rollback BACKUP_ID [--preview | --apply --confirm-rollback TOKEN] [--replace-conflicts] [--project | --dir PATH]
#   ./install.sh --uninstall [--preview | --apply --confirm-uninstall TOKEN] [--replace-conflicts] [--project | --dir PATH]
#
# Defaults to a global symlinked install into ~/.config/opencode. Markdown
# skill/agent files are symlinked individually so a git pull keeps them
# current. Executable custom tools, helper directories, runtime plugins, and
# the optional dashboard plugin are always copy-pinned. Runs preview by
# default; pass --apply after reviewing the bounded change summary.
set -eu

SRC_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)

MODE=symlink
TARGET="${HOME}/.config/opencode"
WITH_DASHBOARD=false
MIGRATE_ORCHESTRATOR=false
CONFIGURE_SUBAGENT_DEPTH=false
LOCATION_MODE=global
APPLY=false
REPLACE_CONFLICTS=false
LIFECYCLE_ACTION=install
ROLLBACK_ID=""
CONFIRM_ROLLBACK=""
CONFIRM_UNINSTALL=""
COPY_REQUESTED=false
INSTALL_OPTION_REQUESTED=false

usage() {
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --preview) APPLY=false ;;
    --apply) APPLY=true ;;
    --replace-conflicts) REPLACE_CONFLICTS=true ;;
    --copy) MODE=copy; COPY_REQUESTED=true ;;
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
    --with-dashboard) WITH_DASHBOARD=true; INSTALL_OPTION_REQUESTED=true ;;
    --migrate-orchestrator) MIGRATE_ORCHESTRATOR=true; INSTALL_OPTION_REQUESTED=true ;;
    --configure-subagent-depth) CONFIGURE_SUBAGENT_DEPTH=true; INSTALL_OPTION_REQUESTED=true ;;
    --rollback)
      if [ $# -lt 2 ]; then
        echo "install.sh: --rollback requires a BACKUP_ID" >&2
        exit 2
      fi
      shift
      case "$1" in
        -*) echo "install.sh: --rollback requires a BACKUP_ID, got $1" >&2; exit 2 ;;
      esac
      if [ "$LIFECYCLE_ACTION" != install ]; then
        echo "install.sh: choose exactly one lifecycle action" >&2
        exit 2
      fi
      LIFECYCLE_ACTION=rollback
      ROLLBACK_ID="$1"
      ;;
    --uninstall)
      if [ "$LIFECYCLE_ACTION" != install ]; then
        echo "install.sh: choose exactly one lifecycle action" >&2
        exit 2
      fi
      LIFECYCLE_ACTION=uninstall
      ;;
    --confirm-rollback)
      if [ $# -lt 2 ]; then
        echo "install.sh: --confirm-rollback requires a TOKEN" >&2
        exit 2
      fi
      shift
      CONFIRM_ROLLBACK="$1"
      ;;
    --confirm-uninstall)
      if [ $# -lt 2 ]; then
        echo "install.sh: --confirm-uninstall requires a TOKEN" >&2
        exit 2
      fi
      shift
      CONFIRM_UNINSTALL="$1"
      ;;
    -h|--help) usage; exit 0 ;;
    --*) echo "install.sh: unknown option $1" >&2; exit 2 ;;
    *) echo "install.sh: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done

if [ "$LIFECYCLE_ACTION" = install ]; then
  if [ -n "$CONFIRM_ROLLBACK" ] || [ -n "$CONFIRM_UNINSTALL" ]; then
    echo "install.sh: lifecycle confirmation requires --rollback or --uninstall" >&2
    exit 2
  fi
else
  if [ "$COPY_REQUESTED" = true ] || [ "$INSTALL_OPTION_REQUESTED" = true ]; then
    echo "install.sh: --copy, --with-dashboard, --configure-subagent-depth, and --migrate-orchestrator are install-only" >&2
    exit 2
  fi
  if [ "$LIFECYCLE_ACTION" = rollback ] && [ -n "$CONFIRM_UNINSTALL" ]; then
    echo "install.sh: --confirm-uninstall cannot be used with --rollback" >&2
    exit 2
  fi
  if [ "$LIFECYCLE_ACTION" = uninstall ] && [ -n "$CONFIRM_ROLLBACK" ]; then
    echo "install.sh: --confirm-rollback cannot be used with --uninstall" >&2
    exit 2
  fi
fi

# Resolve target to an absolute path and strip a trailing slash.
case "$TARGET" in
  /*) ;;
  *) TARGET="${PWD}/${TARGET}" ;;
esac
case "$TARGET" in
  /) ;;
  */) TARGET="${TARGET%/}" ;;
esac

if [ "$TARGET" = / ]; then
  echo "install.sh: target directory must not be filesystem root: /" >&2
  exit 1
fi

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

if [ "$TARGET" = / ]; then
  echo "install.sh: target directory must not be filesystem root: /" >&2
  exit 1
fi

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

for managed in commands skills agents tools plugins scripts .naru-backups .naru-staging; do
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
OPERATIONS="${TX_DIR}/operations"
MIGRATIONS="${TX_DIR}/migrations"
TUI_OPERATIONS="${TX_DIR}/tui-operations"
DESIRED_MANIFEST="${TX_DIR}/naru-install.json"
TRANSACTION_RECEIPT="${TX_DIR}/naru-transaction.json"
LIFECYCLE_OPERATIONS="${TX_DIR}/lifecycle-operations"
LIFECYCLE_TOKEN_FILE="${TX_DIR}/lifecycle-token"
BACKUP_TS="$(date +%Y%m%d%H%M%S)-$$"
BACKUP_DIR="${TARGET}/.naru-backups/${BACKUP_TS}"
STAGE_DIR="${TARGET}/.naru-staging/${BACKUP_TS}"

MANIFEST_HELPER="${SRC_DIR}/tools/naru-lib/install-manifest.mjs"
if [ ! -f "$MANIFEST_HELPER" ]; then
  echo "install.sh: missing source: $MANIFEST_HELPER" >&2
  rm -rf "$TX_DIR"
  exit 1
fi
if command -v node >/dev/null 2>&1; then
  manifest_runtime=node
elif command -v bun >/dev/null 2>&1; then
  manifest_runtime=bun
else
  echo "install.sh: node or bun is required for safe install lifecycle metadata" >&2
  rm -rf "$TX_DIR"
  exit 1
fi

BACKUP_DIR_CREATED=false
TARGET_STAGE_CREATED=false
TRANSACTION_STARTED=false

ensure_backup_dir() {
  if [ "$BACKUP_DIR_CREATED" = false ]; then
    mkdir -p "${TARGET}/.naru-backups"
    if [ -e "$BACKUP_DIR" ] || [ -L "$BACKUP_DIR" ]; then
      echo "install.sh: transaction backup path already exists: $BACKUP_DIR" >&2
      exit 1
    fi
    mkdir "$BACKUP_DIR"
    BACKUP_DIR_CREATED=true
  fi
}

create_stage_dir() {
  mkdir -p "${TARGET}/.naru-staging"
  if [ -e "$STAGE_DIR" ] || [ -L "$STAGE_DIR" ]; then
    echo "install.sh: transaction staging path already exists: $STAGE_DIR" >&2
    exit 1
  fi
  mkdir "$STAGE_DIR"
  TARGET_STAGE_CREATED=true
}

backup_if_present() {
  rel="$1"
  abs="${TARGET}/${rel}"
  backup_path_if_present "$abs" "$rel"
}

backup_path_if_present() {
  abs="$1"
  backup_name="$2"
  if [ -e "$abs" ] || [ -L "$abs" ]; then
    ensure_backup_dir
    backup_rel=".naru-backups/${BACKUP_TS}/${backup_name}"
    backup_abs="${TARGET}/${backup_rel}"
    mkdir -p "$(dirname "$backup_abs")"
    mv "$abs" "$backup_abs"
    printf '%s\t%s\n' "$abs" "$backup_rel" >> "$BACKUPS"
  fi
}

migrate_path() {
  backup_if_present "$1"
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
  if [ $rc -ne 0 ] && [ "$TRANSACTION_STARTED" = true ]; then
    rollback
  fi
  if [ "$TARGET_STAGE_CREATED" = true ] && { [ -e "$STAGE_DIR" ] || [ -L "$STAGE_DIR" ]; }; then
    rm -rf "$STAGE_DIR"
  fi
  if [ $rc -ne 0 ] && [ "$BACKUP_DIR_CREATED" = true ]; then
    rmdir "$BACKUP_DIR" 2>/dev/null || true
  fi
  if [ "$TARGET_STAGE_CREATED" = true ]; then
    rmdir "${TARGET}/.naru-staging" 2>/dev/null || true
  fi
  rm -rf "$TX_DIR"
  exit "$rc"
}
trap 'cleanup' 0
trap 'exit 130' 1 2 15

: > "$CREATED"
: > "$BACKUPS"
: > "$MIGRATIONS"
: > "$TUI_OPERATIONS"

persist_transaction_receipt() {
  [ -s "$TRANSACTION_RECEIPT" ] || return 0
  ensure_backup_dir
  receipt_dst="${BACKUP_DIR}/.naru-transaction.json"
  mv "$TRANSACTION_RECEIPT" "$receipt_dst"
  printf '%s\n' "$receipt_dst" >> "$CREATED"
}

if [ "$LIFECYCLE_ACTION" != install ]; then
  lifecycle_backup_id="-"
  [ "$LIFECYCLE_ACTION" = rollback ] && lifecycle_backup_id="$ROLLBACK_ID"
  "$manifest_runtime" "$MANIFEST_HELPER" lifecycle \
    --action "$LIFECYCLE_ACTION" \
    --target "$TARGET" \
    --backup-id "$lifecycle_backup_id" \
    --operations-output "$LIFECYCLE_OPERATIONS" \
    --receipt-output "$TRANSACTION_RECEIPT" \
    --token-output "$LIFECYCLE_TOKEN_FILE" \
    --transaction-id "$BACKUP_TS" \
    --replace-conflicts "$REPLACE_CONFLICTS"

  LIFECYCLE_REMOVE=0
  LIFECYCLE_RESTORE=0
  LIFECYCLE_UNCHANGED=0
  LIFECYCLE_MISSING=0
  LIFECYCLE_CONFLICT=0
  LIFECYCLE_PRESERVED=0
  LIFECYCLE_DASHBOARD_PROTECTED=0
  LIFECYCLE_MANIFEST_PRESERVED=0
  while IFS="$(printf '\t')" read -r action rel source reason current_status; do
    [ -n "$action" ] || continue
    case "$action" in
      remove) LIFECYCLE_REMOVE=$((LIFECYCLE_REMOVE + 1)) ;;
      restore) LIFECYCLE_RESTORE=$((LIFECYCLE_RESTORE + 1)) ;;
      unchanged) LIFECYCLE_UNCHANGED=$((LIFECYCLE_UNCHANGED + 1)) ;;
      missing) LIFECYCLE_MISSING=$((LIFECYCLE_MISSING + 1)) ;;
      conflict-modified) LIFECYCLE_CONFLICT=$((LIFECYCLE_CONFLICT + 1)) ;;
      preserve-modified) LIFECYCLE_PRESERVED=$((LIFECYCLE_PRESERVED + 1)) ;;
      preserve-dashboard) LIFECYCLE_DASHBOARD_PROTECTED=$((LIFECYCLE_DASHBOARD_PROTECTED + 1)) ;;
      preserve-manifest) LIFECYCLE_MANIFEST_PRESERVED=$((LIFECYCLE_MANIFEST_PRESERVED + 1)) ;;
      *) echo "install.sh: unsupported lifecycle action: $action" >&2; exit 1 ;;
    esac
  done < "$LIFECYCLE_OPERATIONS"

  LIFECYCLE_TOKEN=""
  IFS= read -r LIFECYCLE_TOKEN < "$LIFECYCLE_TOKEN_FILE"
  echo "Naru ${LIFECYCLE_ACTION} preview"
  echo "  target: ${TARGET}"
  if [ "$LIFECYCLE_ACTION" = rollback ]; then
    echo "  selected backup: ${ROLLBACK_ID}"
  fi
  echo "  managed changes: ${LIFECYCLE_RESTORE} restore, ${LIFECYCLE_REMOVE} remove, ${LIFECYCLE_UNCHANGED} unchanged, ${LIFECYCLE_MISSING} already missing"
  echo "  modified conflicts: ${LIFECYCLE_CONFLICT} block rollback, ${LIFECYCLE_PRESERVED} preserved by uninstall"
  echo "  dashboard runtime protected: ${LIFECYCLE_DASHBOARD_PROTECTED} preserved while TUI registration remains unmanaged"
  if [ "$LIFECYCLE_MANIFEST_PRESERVED" -gt 0 ]; then
    echo "  ownership manifest: preserved because modified managed paths remain"
  elif [ "$LIFECYCLE_ACTION" = uninstall ]; then
    echo "  ownership manifest: remove"
  else
    echo "  ownership manifest: restore selected state"
  fi
  if [ "$LIFECYCLE_CONFLICT" -gt 0 ] || [ "$LIFECYCLE_PRESERVED" -gt 0 ]; then
    echo "  conflicting paths (up to 10):"
    shown=0
    while IFS="$(printf '\t')" read -r action rel source reason current_status; do
      case "$action" in
        conflict-modified|preserve-modified)
          if [ "$shown" -lt 10 ]; then
            echo "    ${action}: ${rel}"
            shown=$((shown + 1))
          fi
          ;;
      esac
    done < "$LIFECYCLE_OPERATIONS"
  fi
  if [ "$LIFECYCLE_DASHBOARD_PROTECTED" -gt 0 ]; then
    echo "  protected dashboard paths:"
    while IFS="$(printf '\t')" read -r action rel source reason current_status; do
      [ "$action" = preserve-dashboard ] || continue
      echo "    preserve-dashboard: ${rel}"
    done < "$LIFECYCLE_OPERATIONS"
  fi
  echo "  scope limit: manifest-owned assets and .naru-install.json only; OpenCode/TUI config and legacy migrations are unchanged"

  if [ "$APPLY" = false ]; then
    echo "Preview only; no files changed."
    if [ "$LIFECYCLE_ACTION" = rollback ] && [ "$LIFECYCLE_CONFLICT" -gt 0 ]; then
      echo "Rollback is blocked. Review the paths, then preview again with --replace-conflicts for an exact replacement choice."
    else
      echo "  confirmation token: ${LIFECYCLE_TOKEN}"
      echo "Rerun with --apply, the same target/conflict options, and --confirm-${LIFECYCLE_ACTION} ${LIFECYCLE_TOKEN}."
    fi
    if [ "$LIFECYCLE_ACTION" = uninstall ] && [ "$LIFECYCLE_PRESERVED" -gt 0 ]; then
      echo "This preview is partial: modified managed paths and the ownership manifest remain unless a new preview includes --replace-conflicts."
    fi
    if [ "$LIFECYCLE_ACTION" = uninstall ] && [ "$LIFECYCLE_DASHBOARD_PROTECTED" -gt 0 ]; then
      echo "This preview is partial: dashboard runtime dependencies and the ownership manifest remain to avoid a dangling TUI registration. Remove the exact registration first, then preview --replace-conflicts."
    fi
    exit 0
  fi

  if [ "$LIFECYCLE_ACTION" = rollback ] && [ "$LIFECYCLE_CONFLICT" -gt 0 ]; then
    echo "install.sh: refusing rollback while ${LIFECYCLE_CONFLICT} managed path(s) differ from the selected transaction" >&2
    exit 3
  fi
  if [ "$LIFECYCLE_ACTION" = rollback ]; then
    provided_confirmation="$CONFIRM_ROLLBACK"
  else
    provided_confirmation="$CONFIRM_UNINSTALL"
  fi
  if [ -z "$provided_confirmation" ] || [ "$provided_confirmation" != "$LIFECYCLE_TOKEN" ]; then
    echo "install.sh: --confirm-${LIFECYCLE_ACTION} must exactly match the current preview token" >&2
    exit 4
  fi

  LIFECYCLE_CHANGE_COUNT=$((LIFECYCLE_REMOVE + LIFECYCLE_RESTORE))
  if [ "$LIFECYCLE_CHANGE_COUNT" -gt 0 ]; then
    create_stage_dir
  fi
  while IFS="$(printf '\t')" read -r action rel source reason current_status; do
    [ "$action" = restore ] || continue
    restore_src="${TARGET}/${source}"
    staged="${STAGE_DIR}/${rel}"
    mkdir -p "$(dirname "$staged")"
    cp -pRP "$restore_src" "$staged"
  done < "$LIFECYCLE_OPERATIONS"

  TRANSACTION_STARTED=true
  while IFS="$(printf '\t')" read -r action rel source reason current_status; do
    case "$action" in
      remove|restore)
        dst="${TARGET}/${rel}"
        if [ "$current_status" = present ]; then
          if [ ! -e "$dst" ] && [ ! -L "$dst" ]; then
            echo "install.sh: lifecycle state changed after preview planning: ${rel}" >&2
            exit 5
          fi
          backup_if_present "$rel"
        elif [ -e "$dst" ] || [ -L "$dst" ]; then
          echo "install.sh: lifecycle state changed after preview planning: ${rel}" >&2
          exit 5
        fi
        if [ "$action" = restore ]; then
          mkdir -p "$(dirname "$dst")"
          mv "${STAGE_DIR}/${rel}" "$dst"
          printf '%s\n' "$dst" >> "$CREATED"
        fi
        ;;
    esac
  done < "$LIFECYCLE_OPERATIONS"
  if [ "$LIFECYCLE_CHANGE_COUNT" -gt 0 ]; then
    persist_transaction_receipt
  fi

  if [ "$LIFECYCLE_CHANGE_COUNT" -eq 0 ]; then
    echo "No lifecycle changes were applicable in ${TARGET}."
  else
    echo "Applied Naru ${LIFECYCLE_ACTION} to ${TARGET}."
    echo "Removed or replaced paths were retained at ${BACKUP_DIR}; backups are never pruned automatically."
  fi
  if [ "$LIFECYCLE_ACTION" = uninstall ] && [ "$LIFECYCLE_PRESERVED" -gt 0 ]; then
    echo "Partial uninstall: ${LIFECYCLE_PRESERVED} modified managed path(s) and .naru-install.json remain."
  fi
  if [ "$LIFECYCLE_ACTION" = uninstall ] && [ "$LIFECYCLE_DASHBOARD_PROTECTED" -gt 0 ]; then
    echo "Partial uninstall: ${LIFECYCLE_DASHBOARD_PROTECTED} dashboard runtime path(s) and .naru-install.json remain until TUI registration is removed."
  fi
  exit 0
fi

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

# Native OpenCode skills.
add_md "${SRC_DIR}/skills/naru-plan/SKILL.md"     "skills/naru-plan/SKILL.md"
add_md "${SRC_DIR}/skills/naru-impact/SKILL.md"   "skills/naru-impact/SKILL.md"
add_md "${SRC_DIR}/skills/naru-triage/SKILL.md"   "skills/naru-triage/SKILL.md"
add_md "${SRC_DIR}/skills/naru-review/SKILL.md"   "skills/naru-review/SKILL.md"

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
add_copy "${SRC_DIR}/tools/naru-doctor.js"            "tools/naru-doctor.js"
add_copy "${SRC_DIR}/tools/naru-scheduler.js"         "tools/naru-scheduler.js"
add_copy "${SRC_DIR}/tools/naru-worktree.js"          "tools/naru-worktree.js"
add_copy "${SRC_DIR}/tools/package.json"               "tools/package.json"
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

# Preflight every source before touching the target.
while IFS="$(printf '\t')" read -r method src rel; do
  [ -n "$src" ] || continue
  if [ ! -e "$src" ]; then
    echo "install.sh: missing source: $src" >&2
    rm -rf "$TX_DIR"
    exit 1
  fi
done < "$PLAN"

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

if [ "$WITH_DASHBOARD" = true ]; then
  TUI_PREPARED_DIR="${TX_DIR}/tui"
  mkdir -p "$TUI_PREPARED_DIR"
  for rel in $TUI_CONFIG_RELS; do
    tui_input="${TARGET}/${rel}"
    [ -f "$tui_input" ] || tui_input="-"
    tui_operation=remove
    [ "$rel" = "$TUI_REGISTER_REL" ] && tui_operation=register
    "$manifest_runtime" "${SRC_DIR}/scripts/merge-tui-config.mjs" "$tui_input" "${TUI_PREPARED_DIR}/${rel}" "./plugins/naru-minions-dashboard.tsx" "$tui_operation"
    tui_action=configure
    if [ -f "${TARGET}/${rel}" ] && cmp -s "${TUI_PREPARED_DIR}/${rel}" "${TARGET}/${rel}"; then
      tui_action=unchanged
    fi
    printf '%s\t%s\t%s\n' "$tui_action" "$rel" "$tui_operation" >> "$TUI_OPERATIONS"
  done
fi

"$manifest_runtime" "$MANIFEST_HELPER" prepare \
  --source "$SRC_DIR" \
  --target "$TARGET" \
  --plan "$PLAN" \
  --manifest-output "$DESIRED_MANIFEST" \
  --operations-output "$OPERATIONS" \
  --receipt-output "$TRANSACTION_RECEIPT" \
  --transaction-id "$BACKUP_TS" \
  --location-mode "$LOCATION_MODE" \
  --install-mode "$MODE" \
  --dashboard "$WITH_DASHBOARD" \
  --configure-subagent-depth false \
  --migrate-orchestrator "$MIGRATE_ORCHESTRATOR" \
  --replace-conflicts "$REPLACE_CONFLICTS"

MANIFEST_ACTION=create
if [ -f "${TARGET}/.naru-install.json" ]; then
  if cmp -s "$DESIRED_MANIFEST" "${TARGET}/.naru-install.json"; then
    MANIFEST_ACTION=unchanged
  else
    MANIFEST_ACTION=update
  fi
fi

record_migration() {
  migration_rel="$1"
  if [ -e "${TARGET}/${migration_rel}" ] || [ -L "${TARGET}/${migration_rel}" ]; then
    printf '%s\n' "$migration_rel" >> "$MIGRATIONS"
  fi
}

record_migration "commands/naru"
record_migration "agents/naru"
for f in "$TARGET"/commands/naru.bak.*; do
  [ -e "$f" ] || continue
  record_migration "commands/$(basename "$f")"
done
for f in "$TARGET"/agents/naru.bak.*; do
  [ -e "$f" ] || continue
  record_migration "agents/$(basename "$f")"
done
if [ "$MIGRATE_ORCHESTRATOR" = true ]; then
  record_migration "agents/orchestrator.md"
  record_migration "agents/minion"
  record_migration "plugins/orchestrator-dashboard.js"
fi
if [ "$WITH_DASHBOARD" = true ]; then
  record_migration "plugins/naru-minions-dashboard.js"
fi

ASSET_CREATE=0
ASSET_UNCHANGED=0
ASSET_UPDATE=0
ASSET_CONFLICT_UNOWNED=0
ASSET_CONFLICT_MODIFIED=0
ASSET_ORPHANED=0
ASSET_RETIRED=0
ASSET_RETIRED_MISSING=0
ASSET_RETIRED_PRESERVED=0
while IFS="$(printf '\t')" read -r action method source_rel rel reason; do
  [ -n "$action" ] || continue
  case "$action" in
    create) ASSET_CREATE=$((ASSET_CREATE + 1)) ;;
    unchanged) ASSET_UNCHANGED=$((ASSET_UNCHANGED + 1)) ;;
    update) ASSET_UPDATE=$((ASSET_UPDATE + 1)) ;;
    conflict-unowned) ASSET_CONFLICT_UNOWNED=$((ASSET_CONFLICT_UNOWNED + 1)) ;;
    conflict-modified) ASSET_CONFLICT_MODIFIED=$((ASSET_CONFLICT_MODIFIED + 1)) ;;
    preserve-orphaned) ASSET_ORPHANED=$((ASSET_ORPHANED + 1)) ;;
    retire) ASSET_RETIRED=$((ASSET_RETIRED + 1)) ;;
    retire-missing) ASSET_RETIRED_MISSING=$((ASSET_RETIRED_MISSING + 1)) ;;
    preserve-retired-modified) ASSET_RETIRED_PRESERVED=$((ASSET_RETIRED_PRESERVED + 1)) ;;
    *) echo "install.sh: unsupported preview action: $action" >&2; exit 1 ;;
  esac
done < "$OPERATIONS"

TUI_CONFIGURE=0
TUI_UNCHANGED=0
while IFS="$(printf '\t')" read -r action rel operation; do
  [ -n "$action" ] || continue
  if [ "$action" = configure ]; then
    TUI_CONFIGURE=$((TUI_CONFIGURE + 1))
  else
    TUI_UNCHANGED=$((TUI_UNCHANGED + 1))
  fi
done < "$TUI_OPERATIONS"

MIGRATION_COUNT=$(wc -l < "$MIGRATIONS" | tr -d ' ')
CONFLICT_COUNT=$((ASSET_CONFLICT_UNOWNED + ASSET_CONFLICT_MODIFIED))
CHANGE_COUNT=$((ASSET_CREATE + ASSET_UPDATE + ASSET_CONFLICT_UNOWNED + ASSET_CONFLICT_MODIFIED + ASSET_RETIRED + TUI_CONFIGURE + MIGRATION_COUNT))
if [ "$MANIFEST_ACTION" != unchanged ]; then CHANGE_COUNT=$((CHANGE_COUNT + 1)); fi

echo "Naru install preview"
echo "  target: ${TARGET}"
echo "  location/mode: ${LOCATION_MODE}/${MODE}"
echo "  managed assets: ${ASSET_CREATE} create, ${ASSET_UPDATE} update, ${ASSET_UNCHANGED} unchanged"
echo "  conflicts preserved by default: ${ASSET_CONFLICT_UNOWNED} unowned, ${ASSET_CONFLICT_MODIFIED} modified"
echo "  previously owned but no longer selected: ${ASSET_ORPHANED} preserved"
echo "  retired legacy assets: ${ASSET_RETIRED} remove, ${ASSET_RETIRED_MISSING} already missing, ${ASSET_RETIRED_PRESERVED} modified preserved"
echo "  OpenCode depth config: not changed (OpenCode default depth 1)"
echo "  dashboard config: ${TUI_CONFIGURE} configure, ${TUI_UNCHANGED} unchanged"
echo "  legacy migrations: ${MIGRATION_COUNT}"
echo "  ownership manifest: ${MANIFEST_ACTION}"

if [ "$CONFLICT_COUNT" -gt 0 ]; then
  echo "  conflicting paths (up to 10):"
  shown=0
  while IFS="$(printf '\t')" read -r action method source_rel rel reason; do
    case "$action" in
      conflict-unowned|conflict-modified)
        if [ "$shown" -lt 10 ]; then
          echo "    ${action}: ${rel}"
          shown=$((shown + 1))
        fi
        ;;
    esac
  done < "$OPERATIONS"
fi

if [ "$ASSET_RETIRED" -gt 0 ] || [ "$ASSET_RETIRED_MISSING" -gt 0 ] || [ "$ASSET_RETIRED_PRESERVED" -gt 0 ]; then
  echo "  retirement paths (up to 10):"
  shown=0
  while IFS="$(printf '\t')" read -r action method source_rel rel reason; do
    case "$action" in
      retire|retire-missing|preserve-retired-modified)
        if [ "$shown" -lt 10 ]; then
          echo "    ${action}: ${rel} (${reason})"
          shown=$((shown + 1))
        fi
        ;;
    esac
  done < "$OPERATIONS"
fi

if [ "$APPLY" = false ]; then
  echo "Preview only; no files changed. Rerun with --apply and the same options to install this preview."
  if [ "$CONFLICT_COUNT" -gt 0 ]; then
    echo "Conflicts will remain untouched unless that apply also includes --replace-conflicts."
  fi
  if [ "$CONFIGURE_SUBAGENT_DEPTH" = true ]; then
    echo "--configure-subagent-depth is deprecated and is a compatibility no-op; OpenCode default depth 1 is sufficient."
  fi
  exit 0
fi

if [ "$CONFLICT_COUNT" -gt 0 ] && [ "$REPLACE_CONFLICTS" = false ]; then
  echo "install.sh: refusing to replace ${CONFLICT_COUNT} unowned or modified managed path(s); review the preview, then pass --replace-conflicts for this exact apply" >&2
  exit 3
fi

# Build every changed asset under the target filesystem before touching an
# existing path. This preserves the original transaction and rollback model.
mkdir -p "$TARGET"
if [ "$CHANGE_COUNT" -gt 0 ]; then
  create_stage_dir
fi
while IFS="$(printf '\t')" read -r action method source_rel rel reason; do
  case "$action" in
    create|update|conflict-unowned|conflict-modified)
      staged="${STAGE_DIR}/${rel}"
      src="${SRC_DIR}/${source_rel}"
      mkdir -p "$(dirname "$staged")"
      if [ "$method" = copy ]; then
        cp -R "$src" "$staged"
      else
        ln -s "$src" "$staged"
      fi
      ;;
  esac
done < "$OPERATIONS"

if [ "$TUI_CONFIGURE" -gt 0 ]; then
  while IFS="$(printf '\t')" read -r action rel operation; do
    [ "$action" = configure ] || continue
    mkdir -p "$(dirname "${STAGE_DIR}/${rel}")"
    cp -p "${TUI_PREPARED_DIR}/${rel}" "${STAGE_DIR}/${rel}"
  done < "$TUI_OPERATIONS"
fi
if [ "$MANIFEST_ACTION" != unchanged ]; then
  cp -p "$DESIRED_MANIFEST" "${STAGE_DIR}/.naru-install.json"
fi

TRANSACTION_STARTED=true

while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  migrate_path "$rel"
done < "$MIGRATIONS"

while IFS="$(printf '\t')" read -r action method source_rel rel reason; do
  case "$action" in
    create|update|conflict-unowned|conflict-modified)
      dst="${TARGET}/${rel}"
      staged="${STAGE_DIR}/${rel}"
      mkdir -p "$(dirname "$dst")"
      backup_if_present "$rel"
      mv "$staged" "$dst"
      printf '%s\n' "$dst" >> "$CREATED"
      ;;
    retire)
      backup_if_present "$rel"
      ;;
  esac
done < "$OPERATIONS"

while IFS="$(printf '\t')" read -r action rel operation; do
  [ "$action" = configure ] || continue
  backup_if_present "$rel"
  mv "${STAGE_DIR}/${rel}" "${TARGET}/${rel}"
  printf '%s\n' "${TARGET}/${rel}" >> "$CREATED"
done < "$TUI_OPERATIONS"

if [ "$MANIFEST_ACTION" != unchanged ]; then
  backup_if_present ".naru-install.json"
  mv "${STAGE_DIR}/.naru-install.json" "${TARGET}/.naru-install.json"
  printf '%s\n' "${TARGET}/.naru-install.json" >> "$CREATED"
fi

if [ "$BACKUP_DIR_CREATED" = true ]; then
  persist_transaction_receipt
fi

if [ "$CHANGE_COUNT" -eq 0 ]; then
  echo "Naru is already up to date in ${TARGET} (${LOCATION_MODE}/${MODE}); no files changed."
else
  echo "Applied Naru install to ${TARGET} (${LOCATION_MODE}/${MODE})."
fi
if [ "$BACKUP_DIR_CREATED" = true ]; then
  echo "Replaced paths were backed up at ${BACKUP_DIR}. Backups are retained until you remove them manually."
else
  echo "No backups were needed."
fi
if [ "$CONFIGURE_SUBAGENT_DEPTH" = true ]; then
  echo "--configure-subagent-depth is deprecated and was not applied; OpenCode default depth 1 is sufficient."
fi
if [ "$LOCATION_MODE" = custom ]; then
  echo "Custom target: confirm OpenCode is configured to load ${TARGET}."
fi
if [ "$CHANGE_COUNT" -gt 0 ]; then
  echo "Restart OpenCode, then ask your active agent to use the naru-plan skill for your objective."
fi
