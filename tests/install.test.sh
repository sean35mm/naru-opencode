#!/usr/bin/env sh
# Dependency-free installer tests. Never touches real ~/.config/opencode.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

FIXTURE="$TMP/naru-fixture"
mkdir -p "$FIXTURE"
FIXTURE_PHYS=$(CDPATH= cd -- "$FIXTURE" && pwd -P)
cp "$ROOT/install.sh" "$FIXTURE/install.sh"

mkdir -p "$FIXTURE/agents"
mkdir -p "$FIXTURE/skills"
mkdir -p "$FIXTURE/tools/naru-lib"
mkdir -p "$FIXTURE/plugins"
mkdir -p "$FIXTURE/scripts"

# 4 native skills and the orchestrator plus 7 minions.
for skill in naru-plan naru-impact naru-triage naru-review; do
  mkdir -p "$FIXTURE/skills/$skill"
  cp "$ROOT/skills/$skill/SKILL.md" "$FIXTURE/skills/$skill/SKILL.md"
done
cp "$ROOT/agents/naru-orchestrator.md" "$FIXTURE/agents/naru-orchestrator.md"
cp "$ROOT/agents/naru-minion-scout.md" "$FIXTURE/agents/naru-minion-scout.md"
cp "$ROOT/agents/naru-minion-investigate.md" "$FIXTURE/agents/naru-minion-investigate.md"
cp "$ROOT/agents/naru-minion-architect.md" "$FIXTURE/agents/naru-minion-architect.md"
cp "$ROOT/agents/naru-minion-implement.md" "$FIXTURE/agents/naru-minion-implement.md"
cp "$ROOT/agents/naru-minion-debug.md" "$FIXTURE/agents/naru-minion-debug.md"
cp "$ROOT/agents/naru-minion-verify.md" "$FIXTURE/agents/naru-minion-verify.md"
cp "$ROOT/agents/naru-minion-judge.md" "$FIXTURE/agents/naru-minion-judge.md"

# Tools and plugins
touch "$FIXTURE/tools/naru-git-read.js"
touch "$FIXTURE/tools/naru-github-read.js"
touch "$FIXTURE/tools/naru-github-post-review.js"
touch "$FIXTURE/tools/naru-doctor.js"
touch "$FIXTURE/tools/naru-scheduler.js"
touch "$FIXTURE/tools/naru-worktree.js"
cp "$ROOT/tools/package.json" "$FIXTURE/tools/package.json"
touch "$FIXTURE/tools/naru-lib/helper.js"
cp "$ROOT/tools/naru-lib/install-manifest.mjs" "$FIXTURE/tools/naru-lib/install-manifest.mjs"
touch "$FIXTURE/plugins/naru-delegate.js"
touch "$FIXTURE/plugins/naru-scheduler.js"
touch "$FIXTURE/plugins/naru-minions-dashboard.tsx"
cp "$ROOT/plugins/naru-minions-dashboard-state.mjs" "$FIXTURE/plugins/naru-minions-dashboard-state.mjs"
cp "$ROOT/scripts/merge-tui-config.mjs" "$FIXTURE/scripts/merge-tui-config.mjs"
touch "$FIXTURE/scripts/naru-live-eval.mjs"
mkdir -p "$FIXTURE/tests/fixtures"
touch "$FIXTURE/tests/fixtures/live-evals.json"
touch "$FIXTURE/naru-runtime.example.json"

LEGACY_MANIFEST_BUILDER="$TMP/legacy-manifest-builder.mjs"
cat > "$LEGACY_MANIFEST_BUILDER" <<'EOF'
import { writeFile } from 'node:fs/promises';
const [sourceRoot, targetRoot, manifestModule] = process.argv.slice(2);
const { buildInstallManifest, serializeInstallManifest } = await import(manifestModule);
const manifest = await buildInstallManifest({
  sourceRoot,
  locationMode: 'custom',
  installMode: 'copy',
  options: { dashboard: false, configureSubagentDepth: false, migrateOrchestrator: false },
  planEntries: [
    { method: 'copy', source: `${sourceRoot}/commands/naru-plan.md`, path: 'commands/naru-plan.md' },
    { method: 'copy', source: `${sourceRoot}/agents/naru-plan.md`, path: 'agents/naru-plan.md' },
    { method: 'copy', source: `${sourceRoot}/agents/naru-review-post.md`, path: 'agents/naru-review-post.md' },
  ],
});
await writeFile(`${targetRoot}/.naru-install.json`, serializeInstallManifest(manifest));
EOF

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL $1"; }

is_link() { [ -L "$1" ]; }
is_file() { [ -f "$1" ] && [ ! -L "$1" ]; }
is_dir() { [ -d "$1" ] && [ ! -L "$1" ]; }
has_mode_600() { [ "$(LC_ALL=C ls -ld "$1" | cut -c 2-10)" = "rw-------" ]; }

has_native_inventory() {
  install_root="$1"
  [ "$(find "$install_root/skills" \( -type f -o -type l \) -name SKILL.md | wc -l | tr -d ' ')" -eq 4 ] || return 1
  [ "$(find "$install_root/agents" \( -type f -o -type l \) -name 'naru-*.md' | wc -l | tr -d ' ')" -eq 8 ] || return 1
  [ ! -e "$install_root/commands/naru-plan.md" ]
}

backup_dir() {
  find "$1/.naru-backups" -mindepth 1 -maxdepth 1 -type d | head -n 1
}

apply_install() {
  "$FIXTURE/install.sh" --apply "$@"
}

lifecycle_run() {
  lifecycle_source="$1"
  lifecycle_scope="$2"
  lifecycle_context="$3"
  lifecycle_target="$4"
  shift 4
  case "$lifecycle_scope" in
    global) HOME="$lifecycle_context" "$lifecycle_source/install.sh" "$@" ;;
    project) (cd "$lifecycle_context" && "$lifecycle_source/install.sh" --project "$@") ;;
    custom) "$lifecycle_source/install.sh" --dir "$lifecycle_target" "$@" ;;
    *) return 97 ;;
  esac
}

lifecycle_install_run() {
  lifecycle_source="$1"
  lifecycle_scope="$2"
  lifecycle_context="$3"
  lifecycle_target="$4"
  lifecycle_mode="$5"
  shift 5
  if [ "$lifecycle_mode" = copy ]; then
    lifecycle_run "$lifecycle_source" "$lifecycle_scope" "$lifecycle_context" "$lifecycle_target" "$@" --copy
  else
    lifecycle_run "$lifecycle_source" "$lifecycle_scope" "$lifecycle_context" "$lifecycle_target" "$@"
  fi
}

preview_token() {
  sed -n 's/^  confirmation token: //p' "$1" | head -n 1
}

# Default execution is a read-only preview.
PREVIEW_TARGET="$TMP/preview-target"
PREVIEW_OUTPUT="$TMP/preview-output"
"$FIXTURE/install.sh" --dir "$PREVIEW_TARGET" --configure-subagent-depth > "$PREVIEW_OUTPUT"
if [ ! -e "$PREVIEW_TARGET" ]; then pass "default preview does not create target"; else fail "default preview does not create target"; fi
if grep -q '^Naru install preview$' "$PREVIEW_OUTPUT" && grep -q '^Preview only; no files changed\.' "$PREVIEW_OUTPUT" && grep -q 'compatibility no-op' "$PREVIEW_OUTPUT"; then pass "default preview reports explicit apply boundary and depth compatibility no-op"; else fail "default preview reports explicit apply boundary and depth compatibility no-op"; fi

# 1. Default symlink install into a custom dir.
T1="$TMP/t1"
mkdir -p "$T1"
apply_install --dir "$T1"
if is_link "$T1/skills/naru-plan/SKILL.md"; then pass "symlinked skill"; else fail "symlinked skill"; fi
if is_link "$T1/agents/naru-orchestrator.md"; then pass "symlinked orchestrator"; else fail "symlinked orchestrator"; fi
if has_native_inventory "$T1"; then pass "four skills and eight agents installed"; else fail "four skills and eight agents installed"; fi
if is_file "$T1/tools/naru-git-read.js" && is_file "$T1/tools/naru-doctor.js" && is_file "$T1/tools/package.json"; then pass "tools and doctor copy-pinned with ESM marker"; else fail "tools and doctor copy-pinned with ESM marker"; fi
if is_dir "$T1/tools/naru-lib"; then pass "tool helper dir copy-pinned"; else fail "tool helper dir copy-pinned"; fi
if is_file "$T1/plugins/naru-delegate.js"; then pass "delegate plugin installed by default"; else fail "delegate plugin installed by default"; fi
if is_file "$T1/tools/naru-scheduler.js" && is_file "$T1/plugins/naru-scheduler.js"; then pass "scheduler runtime copy-pinned"; else fail "scheduler runtime copy-pinned"; fi
if is_file "$T1/tools/naru-worktree.js"; then pass "worktree runtime copy-pinned"; else fail "worktree runtime copy-pinned"; fi
if is_file "$T1/naru-runtime.example.json" && is_file "$T1/scripts/naru-live-eval.mjs" && is_file "$T1/scripts/live-evals.example.json"; then pass "runtime example and evaluation assets copy-pinned"; else fail "runtime example and evaluation assets copy-pinned"; fi
if [ "$(grep -c '^  naru-scheduler: allow$' "$T1/agents/naru-orchestrator.md")" -eq 1 ] && [ "$(grep -c '^  naru-worktree: allow$' "$T1/agents/naru-orchestrator.md")" -eq 1 ] && ! grep -qE '^  naru-(scheduler|worktree): allow$' "$T1/agents/naru-minion-implement.md"; then pass "global root and delegated runtime permissions"; else fail "global root and delegated runtime permissions"; fi
if [ ! -e "$T1/plugins/naru-minions-dashboard.tsx" ]; then pass "dashboard omitted by default"; else fail "dashboard omitted by default"; fi
if [ ! -e "$T1/commands/naru" ] && [ ! -e "$T1/agents/naru" ] && [ ! -e "$T1/commands/naru-plan.md" ]; then pass "no retired Core paths installed"; else fail "no retired Core paths installed"; fi

# 2. Copy mode.
T2="$TMP/t2"
mkdir -p "$T2"
apply_install --dir "$T2" --copy
if is_file "$T2/skills/naru-plan/SKILL.md"; then pass "copied skill"; else fail "copied skill"; fi
if is_file "$T2/agents/naru-orchestrator.md"; then pass "copied orchestrator"; else fail "copied orchestrator"; fi
if has_native_inventory "$T2"; then pass "four copied skills and eight agents installed"; else fail "four copied skills and eight agents installed"; fi
if is_file "$T2/tools/naru-git-read.js"; then pass "copied tool"; else fail "copied tool"; fi
if is_file "$T2/plugins/naru-delegate.js"; then pass "copied delegate plugin"; else fail "copied delegate plugin"; fi

# Project mode targets the caller's project, not the Naru source clone.
PROJECT="$TMP/project"
mkdir -p "$PROJECT"
(cd "$PROJECT" && apply_install --project >/dev/null)
if is_link "$PROJECT/.opencode/skills/naru-plan/SKILL.md"; then pass "project install"; else fail "project install"; fi
if has_native_inventory "$PROJECT/.opencode"; then pass "four skills and eight project agents installed"; else fail "four skills and eight project agents installed"; fi
if [ "$(grep -c '^  naru-scheduler: allow$' "$PROJECT/.opencode/agents/naru-orchestrator.md")" -eq 1 ] && [ "$(grep -c '^  naru-worktree: allow$' "$PROJECT/.opencode/agents/naru-orchestrator.md")" -eq 1 ] && ! grep -qE '^  naru-(scheduler|worktree): allow$' "$PROJECT/.opencode/agents/naru-minion-implement.md"; then pass "project root and delegated runtime permissions"; else fail "project root and delegated runtime permissions"; fi

# 3. Paths with spaces.
T3="$TMP/path with spaces/target"
mkdir -p "$T3"
apply_install --dir "$T3"
if is_link "$T3/skills/naru-plan/SKILL.md"; then pass "spaces in path"; else fail "spaces in path"; fi

# 4. Legacy Core migration.
T4="$TMP/t4"
mkdir -p "$T4/commands/naru" "$T4/agents/naru"
touch "$T4/commands/naru.bak.123" "$T4/agents/naru.bak.456"
touch "$T4/commands/naru/old.md" "$T4/agents/naru/old.md"
apply_install --dir "$T4"
if [ ! -e "$T4/commands/naru" ] && [ ! -e "$T4/agents/naru" ]; then pass "legacy Core loaders migrated"; else fail "legacy Core loaders migrated"; fi
BD4=$(backup_dir "$T4")
if [ -n "$BD4" ] && [ -d "$BD4/commands/naru" ]; then pass "commands/naru backed up"; else fail "commands/naru backed up"; fi
if [ -n "$BD4" ] && [ -d "$BD4/agents/naru" ]; then pass "agents/naru backed up"; else fail "agents/naru backed up"; fi
if [ -n "$BD4" ] && [ -f "$BD4/commands/naru.bak.123" ]; then pass "commands/naru.bak.* backed up"; else fail "commands/naru.bak.* backed up"; fi
if [ -n "$BD4" ] && [ -f "$BD4/agents/naru.bak.456" ]; then pass "agents/naru.bak.* backed up"; else fail "agents/naru.bak.* backed up"; fi

# 5. Legacy orchestrator migration only with flag.
T5="$TMP/t5"
mkdir -p "$T5/agents/minion" "$T5/plugins"
touch "$T5/agents/orchestrator.md" "$T5/plugins/orchestrator-dashboard.js"
apply_install --dir "$T5" --migrate-orchestrator
if [ ! -e "$T5/agents/orchestrator.md" ] && [ ! -e "$T5/agents/minion" ] && [ ! -e "$T5/plugins/orchestrator-dashboard.js" ]; then pass "legacy orchestrator migrated with flag"; else fail "legacy orchestrator migrated with flag"; fi

T5B="$TMP/t5b"
mkdir -p "$T5B/agents/minion" "$T5B/plugins"
touch "$T5B/agents/orchestrator.md" "$T5B/plugins/orchestrator-dashboard.js"
apply_install --dir "$T5B"
if [ -e "$T5B/agents/orchestrator.md" ] && [ -e "$T5B/agents/minion" ] && [ -e "$T5B/plugins/orchestrator-dashboard.js" ]; then pass "legacy orchestrator preserved without flag"; else fail "legacy orchestrator preserved without flag"; fi

# 6. Dashboard opt-in.
T6="$TMP/t6"
mkdir -p "$T6"
apply_install --dir "$T6" --with-dashboard
if is_file "$T6/plugins/naru-minions-dashboard.tsx"; then pass "dashboard installed with --with-dashboard"; else fail "dashboard installed with --with-dashboard"; fi
if is_file "$T6/plugins/naru-minions-dashboard-state.mjs"; then pass "dashboard state helper installed with --with-dashboard"; else fail "dashboard state helper installed with --with-dashboard"; fi
if grep -q '"./plugins/naru-minions-dashboard.tsx"' "$T6/tui.json"; then pass "dashboard registered in new TUI config"; else fail "dashboard registered in new TUI config"; fi

T6B="$TMP/t6b"
mkdir -p "$T6B/plugins"
touch "$T6B/plugins/naru-minions-dashboard.js"
cat > "$T6B/tui.jsonc" <<'EOF'
{
  // Preserve this comment and unrelated setting.
  "theme": "system",
  "plugin": [
    "./plugins/unrelated.tsx",
    "./plugins/naru-minions-dashboard.js",
  ],
}
EOF
printf '%s\n' '{"plugin":["./plugins/ignored.tsx",["plugins/naru-minions-dashboard.js",{"legacy":true}]]}' > "$T6B/tui.json"
apply_install --dir "$T6B" --with-dashboard >/dev/null
if grep -q 'Preserve this comment' "$T6B/tui.jsonc" && grep -q 'unrelated.tsx' "$T6B/tui.jsonc"; then pass "JSONC merge preserves unrelated content"; else fail "JSONC merge preserves unrelated content"; fi
if [ "$(grep -c 'naru-minions-dashboard.tsx' "$T6B/tui.jsonc")" -eq 1 ] && ! grep -q 'naru-minions-dashboard.js' "$T6B/tui.jsonc"; then pass "dashboard registration migrated idempotently"; else fail "dashboard registration migrated idempotently"; fi
if [ ! -e "$T6B/plugins/naru-minions-dashboard.js" ]; then pass "legacy dashboard migrated"; else fail "legacy dashboard migrated"; fi
if grep -q 'ignored.tsx' "$T6B/tui.json" && ! grep -q 'naru-minions-dashboard' "$T6B/tui.json"; then pass "lower precedence TUI config legacy registration cleaned"; else fail "lower precedence TUI config legacy registration cleaned"; fi
apply_install --dir "$T6B" --with-dashboard >/dev/null
if [ "$(grep -c 'naru-minions-dashboard.tsx' "$T6B/tui.jsonc")" -eq 1 ]; then pass "dashboard config reinstall idempotent"; else fail "dashboard config reinstall idempotent"; fi

T6C="$TMP/t6c"
mkdir -p "$T6C"
printf '%s\n' '{ invalid' > "$T6C/tui.json"
if apply_install --dir "$T6C" --with-dashboard >/dev/null 2>&1; then fail "reject malformed TUI config"; else pass "reject malformed TUI config"; fi
if [ ! -e "$T6C/plugins/naru-minions-dashboard.tsx" ]; then pass "malformed config leaves dashboard uninstalled"; else fail "malformed config leaves dashboard uninstalled"; fi

T6D="$TMP/t6d"
mkdir -p "$T6D" "$TMP/outside-tui"
printf '%s\n' '{"plugin":[]}' > "$T6D/tui.jsonc"
ln -s "$TMP/outside-tui/config" "$T6D/tui.json"
if apply_install --dir "$T6D" --with-dashboard >/dev/null 2>&1; then fail "reject either symlinked TUI config"; else pass "reject either symlinked TUI config"; fi

# 7. Idempotency and backup retention.
T7="$TMP/t7"
mkdir -p "$T7"
printf '%s\n' '{"schemaVersion":1,"profiles":{"fast":{"model":"custom/fast"}}}' > "$T7/naru-models.json"
apply_install --dir "$T7"
echo "stale" > "$T7/skills/naru-plan/SKILL.md"
apply_install --dir "$T7"
if is_link "$T7/skills/naru-plan/SKILL.md" && [ "$(readlink "$T7/skills/naru-plan/SKILL.md")" = "$FIXTURE_PHYS/skills/naru-plan/SKILL.md" ]; then pass "idempotent reinstall refreshes target"; else fail "idempotent reinstall refreshes target"; fi
if grep -q 'custom/fast' "$T7/naru-models.json"; then pass "user model config preserved"; else fail "user model config preserved"; fi
BACKUP_COUNT=$(find "$T7/.naru-backups" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
if [ "$BACKUP_COUNT" -ge 1 ]; then pass "successful backups kept"; else fail "successful backups kept"; fi

T7N="$TMP/t7-noop"
mkdir -p "$T7N"
apply_install --copy --dir "$T7N" >/dev/null
NOOP_OUTPUT="$TMP/t7-noop-output"
apply_install --copy --dir "$T7N" > "$NOOP_OUTPUT"
if grep -q 'already up to date' "$NOOP_OUTPUT" && [ ! -d "$T7N/.naru-backups" ]; then pass "unchanged reinstall creates no backup directory"; else fail "unchanged reinstall creates no backup directory"; fi
if node -e 'const m=require(process.argv[1]); if(m.schemaVersion!==1||m.product!=="naru-opencode"||m.installMode!=="copy"||!Array.isArray(m.managed)||m.managed.length===0) process.exit(1)' "$T7N/.naru-install.json"; then pass "versioned ownership manifest records install method and managed assets"; else fail "versioned ownership manifest records install method and managed assets"; fi

printf '%s\n' 'locally modified' > "$T7N/skills/naru-plan/SKILL.md"
CONFLICT_OUTPUT="$TMP/t7-conflict-output"
if apply_install --copy --dir "$T7N" > "$CONFLICT_OUTPUT" 2>&1; then fail "modified managed asset blocks apply"; else pass "modified managed asset blocks apply"; fi
if grep -q 'conflict-modified: skills/naru-plan/SKILL.md' "$CONFLICT_OUTPUT" && grep -q 'locally modified' "$T7N/skills/naru-plan/SKILL.md"; then pass "modified managed asset is classified and preserved"; else fail "modified managed asset is classified and preserved"; fi
apply_install --copy --replace-conflicts --dir "$T7N" >/dev/null
if ! grep -q 'locally modified' "$T7N/skills/naru-plan/SKILL.md" && find "$T7N/.naru-backups" -type f -path '*/skills/naru-plan/SKILL.md' | grep -q .; then pass "exact conflict choice replaces and backs up managed asset"; else fail "exact conflict choice replaces and backs up managed asset"; fi

T7U="$TMP/t7-unowned"
mkdir -p "$T7U/skills/naru-plan"
printf '%s\n' 'unrelated owner' > "$T7U/skills/naru-plan/SKILL.md"
UNOWNED_OUTPUT="$TMP/t7-unowned-output"
"$FIXTURE/install.sh" --copy --dir "$T7U" > "$UNOWNED_OUTPUT"
if grep -q 'conflict-unowned: skills/naru-plan/SKILL.md' "$UNOWNED_OUTPUT" && grep -q 'unrelated owner' "$T7U/skills/naru-plan/SKILL.md"; then pass "preview classifies and preserves unowned selected path"; else fail "preview classifies and preserves unowned selected path"; fi
if apply_install --copy --dir "$T7U" >/dev/null 2>&1; then fail "unowned selected path blocks apply"; else pass "unowned selected path blocks apply"; fi

# 8. A bounded prior-manifest migration retires only healthy legacy assets.
install_legacy_manifest() {
  legacy_target="$1"
  legacy_source="$legacy_target/legacy-source"
  mkdir -p "$legacy_source/commands" "$legacy_source/agents" "$legacy_target/commands" "$legacy_target/agents"
  printf '%s\n' 'legacy command' > "$legacy_source/commands/naru-plan.md"
  printf '%s\n' 'legacy agent' > "$legacy_source/agents/naru-plan.md"
  printf '%s\n' 'legacy review-post agent' > "$legacy_source/agents/naru-review-post.md"
  cp "$legacy_source/commands/naru-plan.md" "$legacy_target/commands/naru-plan.md"
  cp "$legacy_source/agents/naru-plan.md" "$legacy_target/agents/naru-plan.md"
  cp "$legacy_source/agents/naru-review-post.md" "$legacy_target/agents/naru-review-post.md"
  node "$LEGACY_MANIFEST_BUILDER" "$legacy_source" "$legacy_target" "$FIXTURE_PHYS/tools/naru-lib/install-manifest.mjs"
}

T7R="$TMP/t7-retire"
mkdir -p "$T7R"
install_legacy_manifest "$T7R"
RETIRE_PREVIEW="$TMP/t7-retire-preview"
"$FIXTURE/install.sh" --copy --dir "$T7R" > "$RETIRE_PREVIEW"
if grep -q 'retire: commands/naru-plan.md' "$RETIRE_PREVIEW" && [ -f "$T7R/commands/naru-plan.md" ]; then pass "retirement preview lists healthy prior-owned assets"; else fail "retirement preview lists healthy prior-owned assets"; fi
apply_install --copy --dir "$T7R" >/dev/null
RETIRE_BACKUP=$(backup_dir "$T7R")
if [ ! -e "$T7R/commands/naru-plan.md" ] && [ ! -e "$T7R/agents/naru-plan.md" ] && [ ! -e "$T7R/agents/naru-review-post.md" ] && [ -f "$RETIRE_BACKUP/commands/naru-plan.md" ] && [ -f "$RETIRE_BACKUP/agents/naru-review-post.md" ] && [ -f "$RETIRE_BACKUP/.naru-transaction.json" ]; then pass "healthy retired assets are removed with rollback backup and receipt"; else fail "healthy retired assets are removed with rollback backup and receipt"; fi
if node -e 'const m=require(process.argv[1]); if(m.managed.some(x=>x.path.startsWith("commands/naru-")||x.path==="agents/naru-plan.md")) process.exit(1)' "$T7R/.naru-install.json"; then pass "migration drops retired ownership"; else fail "migration drops retired ownership"; fi
RETIRE_ID=$(basename "$RETIRE_BACKUP")
RETIRE_ROLLBACK_PREVIEW="$TMP/t7-retire-rollback-preview"
"$FIXTURE/install.sh" --dir "$T7R" --rollback "$RETIRE_ID" > "$RETIRE_ROLLBACK_PREVIEW"
RETIRE_ROLLBACK_TOKEN=$(preview_token "$RETIRE_ROLLBACK_PREVIEW")
"$FIXTURE/install.sh" --dir "$T7R" --rollback "$RETIRE_ID" --apply --confirm-rollback "$RETIRE_ROLLBACK_TOKEN" >/dev/null
if [ -f "$T7R/commands/naru-plan.md" ] && [ -f "$T7R/agents/naru-plan.md" ] && [ -f "$T7R/agents/naru-review-post.md" ]; then pass "retirement rollback restores prior manifest-owned assets"; else fail "retirement rollback restores prior manifest-owned assets"; fi

T7RM="$TMP/t7-retire-modified"
mkdir -p "$T7RM"
install_legacy_manifest "$T7RM"
printf '%s\n' 'modified legacy command' > "$T7RM/commands/naru-plan.md"
MODIFIED_RETIRE_PREVIEW="$TMP/t7-retire-modified-preview"
"$FIXTURE/install.sh" --copy --dir "$T7RM" > "$MODIFIED_RETIRE_PREVIEW"
if grep -q 'preserve-retired-modified: commands/naru-plan.md' "$MODIFIED_RETIRE_PREVIEW" && grep -q 'modified legacy command' "$T7RM/commands/naru-plan.md"; then pass "modified retired asset is clearly preserved by default"; else fail "modified retired asset is clearly preserved by default"; fi
apply_install --copy --dir "$T7RM" >/dev/null
if grep -q 'modified legacy command' "$T7RM/commands/naru-plan.md"; then pass "apply preserves modified retired asset"; else fail "apply preserves modified retired asset"; fi

T7RX="$TMP/t7-retire-replace"
mkdir -p "$T7RX"
install_legacy_manifest "$T7RX"
printf '%s\n' 'modified legacy command' > "$T7RX/commands/naru-plan.md"
apply_install --copy --replace-conflicts --dir "$T7RX" >/dev/null
if [ ! -e "$T7RX/commands/naru-plan.md" ] && find "$T7RX/.naru-backups" -type f -path '*/commands/naru-plan.md' | grep -q .; then pass "explicit replacement retires modified asset with backup"; else fail "explicit replacement retires modified asset with backup"; fi

T7RU="$TMP/t7-retire-unowned"
mkdir -p "$T7RU/commands"
printf '%s\n' 'unowned legacy command' > "$T7RU/commands/naru-plan.md"
apply_install --copy --dir "$T7RU" >/dev/null
if grep -q 'unowned legacy command' "$T7RU/commands/naru-plan.md"; then pass "unowned same-name retired path is preserved"; else fail "unowned same-name retired path is preserved"; fi

# 9. Source/target overlap rejection.
T8="$TMP/t8"
mkdir -p "$T8"
if apply_install --dir "$FIXTURE" >/dev/null 2>&1; then fail "reject source==target overlap"; else pass "reject source==target overlap"; fi
T8SUB="$FIXTURE/sub"
mkdir -p "$T8SUB"
if apply_install --dir "$T8SUB" >/dev/null 2>&1; then fail "reject target inside source"; else pass "reject target inside source"; fi

ROOT_REJECT_CWD="$TMP/root-reject-cwd"
ROOT_REJECT_OUTPUT="$TMP/root-reject-output"
ROOT_REJECT_BIN="$TMP/root-reject-bin"
ROOT_REJECT_MUTATION="$TMP/root-reject-mutation"
mkdir -p "$ROOT_REJECT_CWD" "$ROOT_REJECT_BIN"
cat > "$ROOT_REJECT_BIN/mkdir" <<'EOF'
#!/usr/bin/env sh
: > "$ROOT_REJECT_MUTATION"
exit 99
EOF
chmod +x "$ROOT_REJECT_BIN/mkdir"
for ROOT_TARGET in / /.; do
  rm -f "$ROOT_REJECT_MUTATION"
  if (cd "$ROOT_REJECT_CWD" && PATH="$ROOT_REJECT_BIN:$PATH" ROOT_REJECT_MUTATION="$ROOT_REJECT_MUTATION" apply_install --dir "$ROOT_TARGET") >"$ROOT_REJECT_OUTPUT" 2>&1; then fail "reject filesystem root target $ROOT_TARGET"; else pass "reject filesystem root target $ROOT_TARGET"; fi
  if [ "$(cat "$ROOT_REJECT_OUTPUT")" = 'install.sh: target directory must not be filesystem root: /' ]; then pass "filesystem root target $ROOT_TARGET reports clear error"; else fail "filesystem root target $ROOT_TARGET reports clear error"; fi
  if [ ! -e "$ROOT_REJECT_MUTATION" ]; then pass "filesystem root target $ROOT_TARGET rejection occurs before mutation"; else fail "filesystem root target $ROOT_TARGET rejection occurs before mutation"; fi
done

# 9. Malformed option rejection.
if apply_install --dir "$T8" --bogus >/dev/null 2>&1; then fail "reject unknown option"; else pass "reject unknown option"; fi
if apply_install --dir >/dev/null 2>&1; then fail "reject missing --dir argument"; else pass "reject missing --dir argument"; fi

# 11. A mid-install failure restores every destination already replaced.
T10="$TMP/t10"
mkdir -p "$T10"
apply_install --dir "$T10" >/dev/null
PLAN_LINK=$(readlink "$T10/skills/naru-plan/SKILL.md")
IMPACT_LINK=$(readlink "$T10/skills/naru-impact/SKILL.md")
FAKEBIN="$TMP/fakebin"
mkdir -p "$FAKEBIN"
REAL_MV=$(command -v mv)
cat > "$FAKEBIN/mv" <<EOF
#!/usr/bin/env sh
case "\$1" in
  */.naru-staging/*/skills/naru-impact/SKILL.md) exit 99 ;;
  */.naru-staging/*/tui.jsonc) exit 99 ;;
esac
exec "$REAL_MV" "\$@"
EOF
chmod +x "$FAKEBIN/mv"
if PATH="$FAKEBIN:$PATH" "$FIXTURE/install.sh" --apply --copy --dir "$T10" >/dev/null 2>&1; then
  fail "injected install failure"
else
  pass "injected install failure"
fi
if [ -L "$T10/skills/naru-plan/SKILL.md" ] && [ "$(readlink "$T10/skills/naru-plan/SKILL.md")" = "$PLAN_LINK" ] &&
   [ -L "$T10/skills/naru-impact/SKILL.md" ] && [ "$(readlink "$T10/skills/naru-impact/SKILL.md")" = "$IMPACT_LINK" ]; then
  pass "rollback restored replaced destinations"
else
  fail "rollback restored replaced destinations"
fi
if [ ! -d "$T10/.naru-staging" ]; then pass "rollback removed staging tree"; else fail "rollback removed staging tree"; fi

T10A="$TMP/t10a"
mkdir -p "$T10A/.naru-backups/user-kept"
printf '%s\n' 'keep' > "$T10A/.naru-backups/user-kept/content"
FAKECP="$TMP/fakecp"
mkdir -p "$FAKECP"
cat > "$FAKECP/cp" <<'EOF'
#!/usr/bin/env sh
exit 98
EOF
chmod +x "$FAKECP/cp"
if PATH="$FAKECP:$PATH" "$FIXTURE/install.sh" --apply --dir "$T10A" >/dev/null 2>&1; then
  fail "injected pre-replacement install failure"
else
  pass "injected pre-replacement install failure"
fi
if [ "$(find "$T10A/.naru-backups" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" -eq 1 ] &&
   [ -f "$T10A/.naru-backups/user-kept/content" ]; then
  pass "failed install removes only transaction-created empty backup directory"
else
  fail "failed install removes only transaction-created empty backup directory"
fi

T10B="$TMP/t10b"
mkdir -p "$T10B"
printf '%s\n' '{"plugin":["plugins/naru-minions-dashboard.js","lower"]}' > "$T10B/tui.json"
printf '%s\n' '{"plugin":["./plugins/naru-minions-dashboard.js","higher"]}' > "$T10B/tui.jsonc"
cp "$T10B/tui.json" "$TMP/t10b-tui.json"
cp "$T10B/tui.jsonc" "$TMP/t10b-tui.jsonc"
if PATH="$FAKEBIN:$PATH" "$FIXTURE/install.sh" --apply --dir "$T10B" --with-dashboard >/dev/null 2>&1; then
  fail "injected TUI config install failure"
else
  pass "injected TUI config install failure"
fi
if cmp -s "$T10B/tui.json" "$TMP/t10b-tui.json" && cmp -s "$T10B/tui.jsonc" "$TMP/t10b-tui.jsonc"; then
  pass "rollback restored both TUI configs"
else
  fail "rollback restored both TUI configs"
fi

# 12. Managed backup/staging paths cannot redirect writes through symlinks.
T11="$TMP/t11"
mkdir -p "$T11" "$TMP/outside-managed"
ln -s "$TMP/outside-managed" "$T11/.naru-backups"
if apply_install --dir "$T11" >/dev/null 2>&1; then
  fail "reject symlinked managed directory"
else
  pass "reject symlinked managed directory"
fi

T11B="$TMP/t11b"
mkdir -p "$T11B" "$TMP/outside-loader"
ln -s "$TMP/outside-loader" "$T11B/commands"
if apply_install --dir "$T11B" >/dev/null 2>&1; then
  fail "reject symlinked loader directory"
else
  pass "reject symlinked loader directory"
fi

SOURCE_ALIAS="$TMP/source-alias"
ln -s "$FIXTURE" "$SOURCE_ALIAS"
if apply_install --dir "$SOURCE_ALIAS" >/dev/null 2>&1; then
  fail "reject canonical source alias"
else
  pass "reject canonical source alias"
fi

# 13. OpenCode depth 1 is sufficient; the old option remains a no-op.
T12="$TMP/t12"
mkdir -p "$T12"
printf '%s\n' '{"subagent_depth":1,"untouched":"yes"}' > "$T12/opencode.json"
chmod 600 "$T12/opencode.json"
cp "$T12/opencode.json" "$TMP/t12-original.json"
apply_install --dir "$T12" --configure-subagent-depth >/dev/null
if cmp -s "$T12/opencode.json" "$TMP/t12-original.json" && has_mode_600 "$T12/opencode.json"; then pass "deprecated depth option leaves OpenCode config byte-for-byte untouched"; else fail "deprecated depth option leaves OpenCode config byte-for-byte untouched"; fi

# 14. Successful lifecycle receipts support previewed update, rollback, and
# uninstall across every location and skill/agent install mode. All mutations
# remain under this test's disposable temporary root.
for LIFECYCLE_SCOPE in global project custom; do
  for LIFECYCLE_MODE in symlink copy; do
    LIFECYCLE_LABEL="${LIFECYCLE_SCOPE}/${LIFECYCLE_MODE}"
    LIFECYCLE_ROOT="$TMP/lifecycle-${LIFECYCLE_SCOPE}-${LIFECYCLE_MODE}"
    LIFECYCLE_SOURCE="$LIFECYCLE_ROOT/source"
    mkdir -p "$LIFECYCLE_ROOT"
    cp -R "$FIXTURE" "$LIFECYCLE_SOURCE"
    printf '%s\n' 'v1' > "$LIFECYCLE_SOURCE/tools/naru-git-read.js"

    case "$LIFECYCLE_SCOPE" in
      global)
        LIFECYCLE_CONTEXT="$LIFECYCLE_ROOT/home"
        LIFECYCLE_TARGET="$LIFECYCLE_CONTEXT/.config/opencode"
        mkdir -p "$LIFECYCLE_CONTEXT"
        ;;
      project)
        LIFECYCLE_CONTEXT="$LIFECYCLE_ROOT/project"
        LIFECYCLE_TARGET="$LIFECYCLE_CONTEXT/.opencode"
        mkdir -p "$LIFECYCLE_CONTEXT"
        ;;
      custom)
        LIFECYCLE_CONTEXT="$LIFECYCLE_ROOT"
        LIFECYCLE_TARGET="$LIFECYCLE_ROOT/custom-target"
        ;;
    esac

    lifecycle_install_run "$LIFECYCLE_SOURCE" "$LIFECYCLE_SCOPE" "$LIFECYCLE_CONTEXT" "$LIFECYCLE_TARGET" "$LIFECYCLE_MODE" --apply >/dev/null
    if has_native_inventory "$LIFECYCLE_TARGET"; then
      pass "$LIFECYCLE_LABEL installs four skills and eight agents"
    else
      fail "$LIFECYCLE_LABEL installs four skills and eight agents"
    fi
    cp "$LIFECYCLE_TARGET/.naru-install.json" "$LIFECYCLE_ROOT/v1-manifest.json"
    mkdir -p "$LIFECYCLE_TARGET/commands"
    printf '%s\n' 'keep-unrelated' > "$LIFECYCLE_TARGET/commands/user-owned.md"
    printf '%s\n' 'v2' > "$LIFECYCLE_SOURCE/tools/naru-git-read.js"

    LIFECYCLE_UPDATE_PREVIEW="$LIFECYCLE_ROOT/update-preview"
    lifecycle_install_run "$LIFECYCLE_SOURCE" "$LIFECYCLE_SCOPE" "$LIFECYCLE_CONTEXT" "$LIFECYCLE_TARGET" "$LIFECYCLE_MODE" > "$LIFECYCLE_UPDATE_PREVIEW"
    if grep -q '^v1$' "$LIFECYCLE_TARGET/tools/naru-git-read.js" &&
       cmp -s "$LIFECYCLE_TARGET/.naru-install.json" "$LIFECYCLE_ROOT/v1-manifest.json" &&
       grep -q '^Preview only; no files changed\.' "$LIFECYCLE_UPDATE_PREVIEW"; then
      pass "$LIFECYCLE_LABEL update preview is read-only"
    else
      fail "$LIFECYCLE_LABEL update preview is read-only"
    fi

    lifecycle_install_run "$LIFECYCLE_SOURCE" "$LIFECYCLE_SCOPE" "$LIFECYCLE_CONTEXT" "$LIFECYCLE_TARGET" "$LIFECYCLE_MODE" --apply >/dev/null
    UPDATE_ID=""
    RECEIPT_COUNT=0
    for RECEIPT in "$LIFECYCLE_TARGET"/.naru-backups/*/.naru-transaction.json; do
      [ -f "$RECEIPT" ] || continue
      UPDATE_ID=$(basename "$(dirname "$RECEIPT")")
      RECEIPT_COUNT=$((RECEIPT_COUNT + 1))
    done
    if [ "$RECEIPT_COUNT" -eq 1 ] &&
       grep -q '^v2$' "$LIFECYCLE_TARGET/tools/naru-git-read.js" &&
       grep -q '^v1$' "$LIFECYCLE_TARGET/.naru-backups/$UPDATE_ID/tools/naru-git-read.js" &&
       cmp -s "$LIFECYCLE_TARGET/.naru-backups/$UPDATE_ID/.naru-install.json" "$LIFECYCLE_ROOT/v1-manifest.json"; then
      pass "$LIFECYCLE_LABEL update writes a bound rollback receipt"
    else
      fail "$LIFECYCLE_LABEL update writes a bound rollback receipt"
    fi

    LIFECYCLE_ROLLBACK_PREVIEW="$LIFECYCLE_ROOT/rollback-preview"
    lifecycle_run "$LIFECYCLE_SOURCE" "$LIFECYCLE_SCOPE" "$LIFECYCLE_CONTEXT" "$LIFECYCLE_TARGET" --rollback "$UPDATE_ID" > "$LIFECYCLE_ROLLBACK_PREVIEW"
    ROLLBACK_TOKEN=$(preview_token "$LIFECYCLE_ROLLBACK_PREVIEW")
    if [ -n "$ROLLBACK_TOKEN" ] && grep -q '^v2$' "$LIFECYCLE_TARGET/tools/naru-git-read.js"; then
      pass "$LIFECYCLE_LABEL rollback preview is read-only"
    else
      fail "$LIFECYCLE_LABEL rollback preview is read-only"
    fi
    lifecycle_run "$LIFECYCLE_SOURCE" "$LIFECYCLE_SCOPE" "$LIFECYCLE_CONTEXT" "$LIFECYCLE_TARGET" --rollback "$UPDATE_ID" --apply --confirm-rollback "$ROLLBACK_TOKEN" >/dev/null
    if grep -q '^v1$' "$LIFECYCLE_TARGET/tools/naru-git-read.js" &&
       cmp -s "$LIFECYCLE_TARGET/.naru-install.json" "$LIFECYCLE_ROOT/v1-manifest.json" &&
       grep -q '^keep-unrelated$' "$LIFECYCLE_TARGET/commands/user-owned.md"; then
      pass "$LIFECYCLE_LABEL rollback restores the prior manifest and assets"
    else
      fail "$LIFECYCLE_LABEL rollback restores the prior manifest and assets"
    fi

    printf '%s\n' 'locally-modified' > "$LIFECYCLE_TARGET/plugins/naru-delegate.js"
    LIFECYCLE_UNINSTALL_PREVIEW="$LIFECYCLE_ROOT/uninstall-preview"
    lifecycle_run "$LIFECYCLE_SOURCE" "$LIFECYCLE_SCOPE" "$LIFECYCLE_CONTEXT" "$LIFECYCLE_TARGET" --uninstall > "$LIFECYCLE_UNINSTALL_PREVIEW"
    UNINSTALL_TOKEN=$(preview_token "$LIFECYCLE_UNINSTALL_PREVIEW")
    if [ -n "$UNINSTALL_TOKEN" ] &&
       grep -q 'preserve-modified: plugins/naru-delegate.js' "$LIFECYCLE_UNINSTALL_PREVIEW" &&
       [ -f "$LIFECYCLE_TARGET/tools/naru-git-read.js" ] &&
       [ -f "$LIFECYCLE_TARGET/.naru-install.json" ]; then
      pass "$LIFECYCLE_LABEL uninstall preview preserves modified ownership"
    else
      fail "$LIFECYCLE_LABEL uninstall preview preserves modified ownership"
    fi

    if [ "$LIFECYCLE_SCOPE" = custom ] && [ "$LIFECYCLE_MODE" = copy ]; then
      if lifecycle_run "$LIFECYCLE_SOURCE" "$LIFECYCLE_SCOPE" "$LIFECYCLE_CONTEXT" "$LIFECYCLE_TARGET" --uninstall --apply >/dev/null 2>&1; then
        fail "uninstall apply requires exact confirmation token"
      elif [ -f "$LIFECYCLE_TARGET/tools/naru-git-read.js" ] && [ -f "$LIFECYCLE_TARGET/.naru-install.json" ]; then
        pass "uninstall apply requires exact confirmation token"
      else
        fail "missing uninstall token causes no mutation"
      fi
    fi

    lifecycle_run "$LIFECYCLE_SOURCE" "$LIFECYCLE_SCOPE" "$LIFECYCLE_CONTEXT" "$LIFECYCLE_TARGET" --uninstall --apply --confirm-uninstall "$UNINSTALL_TOKEN" >/dev/null
    if [ ! -e "$LIFECYCLE_TARGET/tools/naru-git-read.js" ] &&
       grep -q '^locally-modified$' "$LIFECYCLE_TARGET/plugins/naru-delegate.js" &&
       grep -q '^keep-unrelated$' "$LIFECYCLE_TARGET/commands/user-owned.md" &&
       [ -f "$LIFECYCLE_TARGET/.naru-install.json" ] &&
       [ -f "$LIFECYCLE_TARGET/.naru-backups/$UPDATE_ID/.naru-transaction.json" ]; then
      pass "$LIFECYCLE_LABEL partial uninstall removes only healthy owned paths"
    else
      fail "$LIFECYCLE_LABEL partial uninstall removes only healthy owned paths"
    fi

    LIFECYCLE_FORCE_PREVIEW="$LIFECYCLE_ROOT/uninstall-force-preview"
    lifecycle_run "$LIFECYCLE_SOURCE" "$LIFECYCLE_SCOPE" "$LIFECYCLE_CONTEXT" "$LIFECYCLE_TARGET" --uninstall --replace-conflicts > "$LIFECYCLE_FORCE_PREVIEW"
    FORCE_UNINSTALL_TOKEN=$(preview_token "$LIFECYCLE_FORCE_PREVIEW")
    lifecycle_run "$LIFECYCLE_SOURCE" "$LIFECYCLE_SCOPE" "$LIFECYCLE_CONTEXT" "$LIFECYCLE_TARGET" --uninstall --replace-conflicts --apply --confirm-uninstall "$FORCE_UNINSTALL_TOKEN" >/dev/null
    if [ ! -e "$LIFECYCLE_TARGET/plugins/naru-delegate.js" ] &&
       [ ! -e "$LIFECYCLE_TARGET/.naru-install.json" ] &&
       grep -q '^keep-unrelated$' "$LIFECYCLE_TARGET/commands/user-owned.md" &&
       [ -f "$LIFECYCLE_TARGET/.naru-backups/$UPDATE_ID/.naru-transaction.json" ]; then
      pass "$LIFECYCLE_LABEL exact uninstall removes reviewed conflicts and retains backups"
    else
      fail "$LIFECYCLE_LABEL exact uninstall removes reviewed conflicts and retains backups"
    fi
  done
done

T13_INVALID="$TMP/t13-invalid-lifecycle"
mkdir -p "$T13_INVALID"
apply_install --copy --dir "$T13_INVALID" >/dev/null
if "$FIXTURE/install.sh" --dir "$T13_INVALID" --rollback '../escape' >/dev/null 2>&1; then
  fail "rollback rejects traversal backup id"
elif [ -f "$T13_INVALID/.naru-install.json" ] && [ -f "$T13_INVALID/tools/naru-git-read.js" ]; then
  pass "rollback rejects traversal backup id before mutation"
else
  fail "invalid rollback id preserves installed state"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then exit 1; fi
