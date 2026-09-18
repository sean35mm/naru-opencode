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
mkdir -p "$FIXTURE/bin"
mkdir -p "$FIXTURE/commands"
mkdir -p "$FIXTURE/plugins"
mkdir -p "$FIXTURE/skills"
mkdir -p "$FIXTURE/tools/naru-lib"
mkdir -p "$FIXTURE/scripts"

# 4 native skills, the orchestrator, and 4 subagents.
for skill in naru-plan naru-impact naru-triage naru-review; do
  mkdir -p "$FIXTURE/skills/$skill"
  cp "$ROOT/skills/$skill/SKILL.md" "$FIXTURE/skills/$skill/SKILL.md"
done
cp "$ROOT/agents/naru-orchestrator.md" "$FIXTURE/agents/naru-orchestrator.md"
cp "$ROOT/agents/naru-reader.md" "$FIXTURE/agents/naru-reader.md"
cp "$ROOT/agents/naru-runner.md" "$FIXTURE/agents/naru-runner.md"
cp "$ROOT/agents/naru-writer.md" "$FIXTURE/agents/naru-writer.md"
cp "$ROOT/commands/naru.md" "$FIXTURE/commands/naru.md"
cp "$ROOT/bin/naru" "$FIXTURE/bin/naru"

# Tools
touch "$FIXTURE/tools/naru-check.js"
touch "$FIXTURE/tools/naru-git-read.js"
touch "$FIXTURE/tools/naru-github-read.js"
touch "$FIXTURE/tools/naru-github-post-review.js"
touch "$FIXTURE/tools/naru-doctor.js"
touch "$FIXTURE/tools/naru-worktree.js"
cp "$ROOT/tools/package.json" "$FIXTURE/tools/package.json"
touch "$FIXTURE/tools/naru-lib/helper.js"
touch "$FIXTURE/tools/naru-lib/compatibility.mjs"
touch "$FIXTURE/tools/naru-lib/dispatch.mjs"
touch "$FIXTURE/tools/naru-lib/host-contract-probe.mjs"
touch "$FIXTURE/tools/naru-lib/review-defaults.mjs"
touch "$FIXTURE/tools/naru-lib/runtime-config.mjs"
cp "$ROOT/tools/naru-lib/install-manifest.mjs" "$FIXTURE/tools/naru-lib/install-manifest.mjs"
cp "$ROOT/plugins/naru-dispatch.js" "$FIXTURE/plugins/naru-dispatch.js"
cp "$ROOT/naru-runtime.example.json" "$FIXTURE/naru-runtime.example.json"
cp "$ROOT/THIRD_PARTY_NOTICES" "$FIXTURE/THIRD_PARTY_NOTICES"

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
  [ "$(find "$install_root/agents" \( -type f -o -type l \) -name 'naru-*.md' | wc -l | tr -d ' ')" -eq 4 ] || return 1
  [ -f "$install_root/commands/naru.md" ] || return 1
  [ ! -e "$install_root/commands/naru-plan.md" ]
}

has_exact_figma_read_permissions() {
  agent_file="$1"
  for tool in \
    figma-desktop_get_design_context \
    figma-desktop_get_variable_defs \
    figma-desktop_get_screenshot \
    figma-desktop_get_motion_context \
    figma-desktop_get_metadata \
    figma-desktop_get_figjam; do
    [ "$(grep -c "^  ${tool}: allow$" "$agent_file")" -eq 1 ] || return 1
  done
  [ "$(grep -c '^  figma-desktop_.*: allow$' "$agent_file")" -eq 6 ]
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
if is_link "$T1/commands/naru.md" && grep -q 'agent: naru-orchestrator' "$T1/commands/naru.md" && grep -q 'subtask: false' "$T1/commands/naru.md" && grep -q '\$ARGUMENTS' "$T1/commands/naru.md"; then pass "native command forwards arguments to the orchestrator"; else fail "native command forwards arguments to the orchestrator"; fi
if grep -q -- '--dry-run' "$T1/commands/naru.md" && grep -q -- '--comment-only' "$T1/commands/naru.md" && grep -q -- '--standard' "$T1/commands/naru.md" && grep -q 'independently' "$T1/commands/naru.md"; then pass "ship-review command documents batch and override semantics"; else fail "ship-review command documents batch and override semantics"; fi
if has_native_inventory "$T1"; then pass "native skills, agents, and command installed"; else fail "native skills, agents, and command installed"; fi
if is_file "$T1/tools/naru-git-read.js" && is_file "$T1/tools/naru-doctor.js" && is_file "$T1/tools/package.json"; then pass "tools and doctor copy-pinned with ESM marker"; else fail "tools and doctor copy-pinned with ESM marker"; fi
if is_dir "$T1/tools/naru-lib"; then pass "tool helper dir copy-pinned"; else fail "tool helper dir copy-pinned"; fi
if is_file "$T1/THIRD_PARTY_NOTICES" && grep -q '@clack/prompts 1.8.0' "$T1/THIRD_PARTY_NOTICES"; then pass "bundled prompt notices installed"; else fail "bundled prompt notices installed"; fi
if is_file "$T1/tools/naru-worktree.js"; then pass "worktree runtime copy-pinned"; else fail "worktree runtime copy-pinned"; fi
if is_file "$T1/naru-runtime.example.json"; then pass "runtime example copy-pinned"; else fail "runtime example copy-pinned"; fi
if [ "$(grep -c '^  naru-worktree: allow$' "$T1/agents/naru-orchestrator.md")" -eq 1 ] && ! grep -qE '^  naru-worktree: allow$' "$T1/agents/naru-writer.md"; then pass "global root and delegated runtime permissions"; else fail "global root and delegated runtime permissions"; fi
if has_exact_figma_read_permissions "$T1/agents/naru-orchestrator.md" && has_exact_figma_read_permissions "$T1/agents/naru-reader.md"; then pass "orchestrator and reader allow only the six approved Figma tools"; else fail "orchestrator and reader allow only the six approved Figma tools"; fi
if is_file "$T1/plugins/naru-dispatch.js" && [ "$(ls "$T1/plugins" | wc -l | tr -d " ")" = "1" ]; then pass "dispatch is the only plugin installed"; else fail "dispatch is the only plugin installed"; fi
if grep -q 'applyDispatchToConfigAtomically' "$T1/plugins/naru-dispatch.js" && grep -q '"configuredTools": "off"' "$T1/naru-runtime.example.json"; then pass "configured MCP policy hook and off-by-default example installed"; else fail "configured MCP policy hook and off-by-default example installed"; fi
if grep -q 'MCP permission prompt approves only that tool invocation' "$T1/agents/naru-orchestrator.md" && grep -q 'MCP permission prompt approves only that tool invocation' "$T1/agents/naru-writer.md"; then pass "eligible MCP roles retain authorization boundaries"; else fail "eligible MCP roles retain authorization boundaries"; fi
if [ -f "$T1/commands/naru.md" ] && [ ! -e "$T1/commands/naru-review.md" ] && [ ! -e "$T1/agents/naru" ] && [ ! -e "$T1/commands/naru-plan.md" ]; then pass "single convenience command installed and retired commands absent"; else fail "single convenience command installed and retired commands absent"; fi

# 2. Copy mode.
T2="$TMP/t2"
mkdir -p "$T2"
apply_install --dir "$T2" --copy
if is_file "$T2/skills/naru-plan/SKILL.md"; then pass "copied skill"; else fail "copied skill"; fi
if is_file "$T2/agents/naru-orchestrator.md"; then pass "copied orchestrator"; else fail "copied orchestrator"; fi
if has_native_inventory "$T2"; then pass "four copied skills and four agents installed"; else fail "four copied skills and four agents installed"; fi
if is_file "$T2/tools/naru-git-read.js"; then pass "copied tool"; else fail "copied tool"; fi

# Project mode targets the caller's project, not the Naru source clone.
PROJECT="$TMP/project"
mkdir -p "$PROJECT"
(cd "$PROJECT" && apply_install --project >/dev/null)
if is_link "$PROJECT/.opencode/skills/naru-plan/SKILL.md"; then pass "project install"; else fail "project install"; fi
if has_native_inventory "$PROJECT/.opencode"; then pass "four skills and four project agents installed"; else fail "four skills and four project agents installed"; fi
if [ "$(grep -c '^  naru-worktree: allow$' "$PROJECT/.opencode/agents/naru-orchestrator.md")" -eq 1 ] && ! grep -qE '^  naru-worktree: allow$' "$PROJECT/.opencode/agents/naru-writer.md"; then pass "project root and delegated runtime permissions"; else fail "project root and delegated runtime permissions"; fi

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
      pass "$LIFECYCLE_LABEL installs four skills and four agents"
    else
      fail "$LIFECYCLE_LABEL installs four skills and four agents"
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

    printf '%s\n' 'locally-modified' > "$LIFECYCLE_TARGET/tools/naru-worktree.js"
    LIFECYCLE_UNINSTALL_PREVIEW="$LIFECYCLE_ROOT/uninstall-preview"
    lifecycle_run "$LIFECYCLE_SOURCE" "$LIFECYCLE_SCOPE" "$LIFECYCLE_CONTEXT" "$LIFECYCLE_TARGET" --uninstall > "$LIFECYCLE_UNINSTALL_PREVIEW"
    UNINSTALL_TOKEN=$(preview_token "$LIFECYCLE_UNINSTALL_PREVIEW")
    if [ -n "$UNINSTALL_TOKEN" ] &&
       grep -q 'preserve-modified: tools/naru-worktree.js' "$LIFECYCLE_UNINSTALL_PREVIEW" &&
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
       grep -q '^locally-modified$' "$LIFECYCLE_TARGET/tools/naru-worktree.js" &&
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
    if [ ! -e "$LIFECYCLE_TARGET/tools/naru-worktree.js" ] &&
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

# 15. --only updates an existing manifest-owned subset without adopting,
# retiring, or rewriting any unselected ownership.
ONLY_SOURCE="$TMP/only-source"
cp -R "$FIXTURE" "$ONLY_SOURCE"
ONLY_TARGET="$TMP/only-target"
mkdir -p "$ONLY_TARGET"
"$ONLY_SOURCE/install.sh" --apply --copy --dir "$ONLY_TARGET" >/dev/null
cp "$ONLY_TARGET/.naru-install.json" "$TMP/only-before-manifest.json"
printf '%s\n' 'locally modified review skill' > "$ONLY_TARGET/skills/naru-review/SKILL.md"
rm "$ONLY_TARGET/agents/naru-runner.md"
printf '%s\n' 'doctor v2' > "$ONLY_SOURCE/tools/naru-doctor.js"
ONLY_PREVIEW="$TMP/only-preview"
"$ONLY_SOURCE/install.sh" --dir "$ONLY_TARGET" --only tools/naru-doctor.js > "$ONLY_PREVIEW"
if grep -q '^doctor v2$' "$ONLY_TARGET/tools/naru-doctor.js"; then fail "--only preview leaves selected target unchanged"; else pass "--only preview leaves selected target unchanged"; fi
if grep -q 'unselected prior-owned assets: .* preserved with ownership unchanged' "$ONLY_PREVIEW"; then pass "--only preview reports preserved unselected ownership"; else fail "--only preview reports preserved unselected ownership"; fi
"$ONLY_SOURCE/install.sh" --apply --dir "$ONLY_TARGET" --only tools/naru-doctor.js >/dev/null
if grep -q '^doctor v2$' "$ONLY_TARGET/tools/naru-doctor.js" &&
   grep -q '^locally modified review skill$' "$ONLY_TARGET/skills/naru-review/SKILL.md" &&
   [ ! -e "$ONLY_TARGET/agents/naru-runner.md" ]; then
  pass "--only updates exactly one selected asset and preserves modified or missing unselected assets"
else
  fail "--only updates exactly one selected asset and preserves modified or missing unselected assets"
fi
if node -e '
const fs=require("fs"); const before=JSON.parse(fs.readFileSync(process.argv[1])); const after=JSON.parse(fs.readFileSync(process.argv[2]));
const selected="tools/naru-doctor.js"; const old=new Map(before.managed.map(x=>[x.path,JSON.stringify(x)]));
if(after.managed.length!==before.managed.length||after.sourceVersion===before.sourceVersion) process.exit(1);
for(const entry of after.managed) if(entry.path!==selected&&JSON.stringify(entry)!==old.get(entry.path)) process.exit(1);
' "$TMP/only-before-manifest.json" "$ONLY_TARGET/.naru-install.json"; then
  pass "--only manifest changes selected metadata and sourceVersion only"
else
  fail "--only manifest changes selected metadata and sourceVersion only"
fi
if [ -f "$ONLY_TARGET/tools/naru-check.js" ] && [ -f "$ONLY_TARGET/agents/naru-reader.md" ] && [ -f "$ONLY_TARGET/skills/naru-review/SKILL.md" ]; then pass "--only leaves runner, review, and naru-check inventory untouched"; else fail "--only leaves runner, review, and naru-check inventory untouched"; fi

printf '%s\n' 'doctor v3' > "$ONLY_SOURCE/tools/naru-doctor.js"
HOME="$TMP/frontdoor-home" NARU_HOME="$TMP/frontdoor-naru-home" "$ONLY_SOURCE/bin/naru" install --apply --dir "$ONLY_TARGET" --only tools/naru-doctor.js >/dev/null
if grep -q '^doctor v3$' "$ONLY_TARGET/tools/naru-doctor.js" &&
   node -e 'const m=require(process.argv[1]);if(m.installMode!=="copy")process.exit(1)' "$ONLY_TARGET/.naru-install.json"; then
  pass "naru install --only preserves the prior install mode without adding --copy"
else
  fail "naru install --only preserves the prior install mode without adding --copy"
fi

# A leaf update stages a verified composite of the existing copy-managed helper
# directory, then overlays only explicitly selected regular package files.
cp "$ONLY_TARGET/tools/naru-lib/helper.js" "$TMP/only-helper-before"
printf '%s\n' 'compatibility v2' > "$ONLY_SOURCE/tools/naru-lib/compatibility.mjs"
printf '%s\n' 'probe v2' > "$ONLY_SOURCE/tools/naru-lib/host-contract-probe.mjs"
"$ONLY_SOURCE/install.sh" --apply --replace-conflicts --dir "$ONLY_TARGET" \
  --only tools/naru-lib/compatibility.mjs \
  --only tools/naru-lib/host-contract-probe.mjs >/dev/null
if grep -q '^compatibility v2$' "$ONLY_TARGET/tools/naru-lib/compatibility.mjs" &&
   grep -q '^probe v2$' "$ONLY_TARGET/tools/naru-lib/host-contract-probe.mjs" &&
   cmp -s "$ONLY_TARGET/tools/naru-lib/helper.js" "$TMP/only-helper-before"; then
  pass "--only composite overlays selected helper leaves and preserves siblings"
else
  fail "--only composite overlays selected helper leaves and preserves siblings"
fi

CLASSIFY_DRIFT_SOURCE="$TMP/only-classify-drift-source"
cp -R "$FIXTURE" "$CLASSIFY_DRIFT_SOURCE"
CLASSIFY_DRIFT_TARGET="$TMP/only-classify-drift-target"
mkdir -p "$CLASSIFY_DRIFT_TARGET"
"$CLASSIFY_DRIFT_SOURCE/install.sh" --apply --copy --dir "$CLASSIFY_DRIFT_TARGET" >/dev/null
printf '%s\n' 'compatibility classify desired' > "$CLASSIFY_DRIFT_SOURCE/tools/naru-lib/compatibility.mjs"
cp "$CLASSIFY_DRIFT_TARGET/tools/naru-lib/compatibility.mjs" "$TMP/only-classify-drift-compatibility"
cp "$CLASSIFY_DRIFT_TARGET/.naru-install.json" "$TMP/only-classify-drift-manifest"
node -e '
const fs=require("fs"); const file=process.argv[1]; const source=fs.readFileSync(file,"utf8");
const needle="        await cp(targetOwner, compositeOwner, { recursive: true, dereference: false, errorOnExist: true });\n";
if(source.split(needle).length!==2) process.exit(2);
fs.writeFileSync(file,source.replace(needle,needle+`        await writeFile(path.join(targetOwner, "helper.js"), "intervening sibling drift\\n");\n`));
' "$CLASSIFY_DRIFT_SOURCE/tools/naru-lib/install-manifest.mjs"
if "$CLASSIFY_DRIFT_SOURCE/install.sh" --apply --replace-conflicts --dir "$CLASSIFY_DRIFT_TARGET" --only tools/naru-lib/compatibility.mjs >/dev/null 2>&1; then
  fail "--only rejects composite sibling drift before classification despite conflict override"
else
  pass "--only rejects composite sibling drift before classification despite conflict override"
fi
if cmp -s "$CLASSIFY_DRIFT_TARGET/tools/naru-lib/compatibility.mjs" "$TMP/only-classify-drift-compatibility" &&
   grep -q '^intervening sibling drift$' "$CLASSIFY_DRIFT_TARGET/tools/naru-lib/helper.js" &&
   cmp -s "$CLASSIFY_DRIFT_TARGET/.naru-install.json" "$TMP/only-classify-drift-manifest" &&
   [ ! -d "$CLASSIFY_DRIFT_TARGET/.naru-backups" ]; then
  pass "classification-time composite drift causes no installer target, manifest, or backup mutation"
else
  fail "classification-time composite drift causes no installer target, manifest, or backup mutation"
fi

printf '%s\n' 'modified sibling' > "$ONLY_TARGET/tools/naru-lib/helper.js"
printf '%s\n' 'compatibility v3' > "$ONLY_SOURCE/tools/naru-lib/compatibility.mjs"
if "$ONLY_SOURCE/install.sh" --apply --replace-conflicts --dir "$ONLY_TARGET" --only tools/naru-lib/compatibility.mjs >/dev/null 2>&1; then
  fail "--only composite rejects a modified sibling despite conflict override"
else
  pass "--only composite rejects a modified sibling despite conflict override"
fi
if grep -q '^modified sibling$' "$ONLY_TARGET/tools/naru-lib/helper.js"; then pass "blocked composite leaves modified sibling untouched"; else fail "blocked composite leaves modified sibling untouched"; fi

for INVALID_ONLY in '../escape' '.naru-install.json' 'unknown/path'; do
  if "$ONLY_SOURCE/install.sh" --apply --dir "$ONLY_TARGET" --only "$INVALID_ONLY" >/dev/null 2>&1; then fail "reject invalid --only path $INVALID_ONLY"; else pass "reject invalid --only path $INVALID_ONLY"; fi
done
if "$ONLY_SOURCE/install.sh" --apply --dir "$ONLY_TARGET" --only tools/naru-doctor.js --only tools/naru-doctor.js >/dev/null 2>&1; then fail "reject duplicate --only path"; else pass "reject duplicate --only path"; fi
if "$ONLY_SOURCE/install.sh" --apply --dir "$ONLY_TARGET" --only tools/naru-lib --only tools/naru-lib/compatibility.mjs >/dev/null 2>&1; then fail "reject overlapping --only paths"; else pass "reject overlapping --only paths"; fi
if "$ONLY_SOURCE/install.sh" --apply --copy --dir "$ONLY_TARGET" --only tools/naru-doctor.js >/dev/null 2>&1; then fail "reject --only with inventory-wide mode flag"; else pass "reject --only with inventory-wide mode flag"; fi
NO_MANIFEST_TARGET="$TMP/only-no-manifest"
mkdir -p "$NO_MANIFEST_TARGET"
if "$ONLY_SOURCE/install.sh" --apply --dir "$NO_MANIFEST_TARGET" --only tools/naru-doctor.js >/dev/null 2>&1; then fail "--only requires a prior ownership manifest"; else pass "--only requires a prior ownership manifest"; fi

ESCAPE_SOURCE="$TMP/only-escape-source"
cp -R "$FIXTURE" "$ESCAPE_SOURCE"
rm "$ESCAPE_SOURCE/tools/naru-lib/compatibility.mjs"
ln -s "$TMP/outside-selected-leaf" "$ESCAPE_SOURCE/tools/naru-lib/compatibility.mjs"
touch "$TMP/outside-selected-leaf"
ESCAPE_TARGET="$TMP/only-escape-target"
mkdir -p "$ESCAPE_TARGET"
"$ESCAPE_SOURCE/install.sh" --apply --copy --dir "$ESCAPE_TARGET" >/dev/null
rm "$ESCAPE_SOURCE/tools/naru-lib/compatibility.mjs"
ln -s "$TMP/outside-selected-leaf" "$ESCAPE_SOURCE/tools/naru-lib/compatibility.mjs"
if "$ESCAPE_SOURCE/install.sh" --apply --dir "$ESCAPE_TARGET" --only tools/naru-lib/compatibility.mjs >/dev/null 2>&1; then fail "reject symlinked selected package leaf"; else pass "reject symlinked selected package leaf"; fi

# A selected symlink is replaced as a link when the package root changes; the
# old live source is never opened for writing.
LINK_SOURCE_A="$TMP/only-link-source-a"
LINK_SOURCE_B="$TMP/only-link-source-b"
cp -R "$FIXTURE" "$LINK_SOURCE_A"
cp -R "$FIXTURE" "$LINK_SOURCE_B"
LINK_TARGET="$TMP/only-link-target"
mkdir -p "$LINK_TARGET"
"$LINK_SOURCE_A/install.sh" --apply --dir "$LINK_TARGET" >/dev/null
LINK_SOURCE_B_PHYS=$(CDPATH= cd -- "$LINK_SOURCE_B" && pwd -P)
cp "$LINK_SOURCE_A/agents/naru-orchestrator.md" "$TMP/only-old-source-agent"
printf '%s\n' 'replacement orchestrator' > "$LINK_SOURCE_B/agents/naru-orchestrator.md"
"$LINK_SOURCE_B/install.sh" --apply --dir "$LINK_TARGET" --only agents/naru-orchestrator.md >/dev/null
if [ -L "$LINK_TARGET/agents/naru-orchestrator.md" ] &&
   [ "$(readlink "$LINK_TARGET/agents/naru-orchestrator.md")" = "$LINK_SOURCE_B_PHYS/agents/naru-orchestrator.md" ] &&
   cmp -s "$LINK_SOURCE_A/agents/naru-orchestrator.md" "$TMP/only-old-source-agent"; then
  pass "--only replaces symlinks without writing through the live link"
else
  fail "--only replaces symlinks without writing through the live link"
fi

# Drift after planning but before the first backup aborts without changing the
# selected target or ownership manifest.
DRIFT_SOURCE="$TMP/only-drift-source"
cp -R "$FIXTURE" "$DRIFT_SOURCE"
DRIFT_TARGET="$TMP/only-drift-target"
mkdir -p "$DRIFT_TARGET"
"$DRIFT_SOURCE/install.sh" --apply --copy --dir "$DRIFT_TARGET" >/dev/null
printf '%s\n' 'doctor desired' > "$DRIFT_SOURCE/tools/naru-doctor.js"
cp "$DRIFT_TARGET/.naru-install.json" "$TMP/only-drift-manifest"
DRIFT_BIN="$TMP/only-drift-bin"
mkdir -p "$DRIFT_BIN"
REAL_CP=$(command -v cp)
cat > "$DRIFT_BIN/cp" <<EOF
#!/usr/bin/env sh
"$REAL_CP" "\$@" || exit \$?
case "\$2" in
  */tools/naru-doctor.js) printf '%s\n' 'target drift' > "\$DRIFT_TARGET/tools/naru-doctor.js" ;;
esac
EOF
chmod +x "$DRIFT_BIN/cp"
if DRIFT_TARGET="$DRIFT_TARGET" PATH="$DRIFT_BIN:$PATH" "$DRIFT_SOURCE/install.sh" --apply --dir "$DRIFT_TARGET" --only tools/naru-doctor.js >/dev/null 2>&1; then fail "target drift aborts selected apply"; else pass "target drift aborts selected apply"; fi
if grep -q '^target drift$' "$DRIFT_TARGET/tools/naru-doctor.js" && cmp -s "$DRIFT_TARGET/.naru-install.json" "$TMP/only-drift-manifest" && [ ! -d "$DRIFT_TARGET/.naru-backups" ]; then pass "target drift aborts before backup or manifest mutation"; else fail "target drift aborts before backup or manifest mutation"; fi

MANIFEST_DRIFT_SOURCE="$TMP/only-manifest-drift-source"
cp -R "$FIXTURE" "$MANIFEST_DRIFT_SOURCE"
MANIFEST_DRIFT_TARGET="$TMP/only-manifest-drift-target"
mkdir -p "$MANIFEST_DRIFT_TARGET"
"$MANIFEST_DRIFT_SOURCE/install.sh" --apply --copy --dir "$MANIFEST_DRIFT_TARGET" >/dev/null
printf '%s\n' 'doctor desired' > "$MANIFEST_DRIFT_SOURCE/tools/naru-doctor.js"
cp "$MANIFEST_DRIFT_TARGET/tools/naru-doctor.js" "$TMP/only-manifest-drift-doctor"
MANIFEST_DRIFT_BIN="$TMP/only-manifest-drift-bin"
mkdir -p "$MANIFEST_DRIFT_BIN"
cat > "$MANIFEST_DRIFT_BIN/cp" <<EOF
#!/usr/bin/env sh
"$REAL_CP" "\$@" || exit \$?
case "\$2" in
  */tools/naru-doctor.js) printf ' ' >> "\$MANIFEST_DRIFT_TARGET/.naru-install.json" ;;
esac
EOF
chmod +x "$MANIFEST_DRIFT_BIN/cp"
if MANIFEST_DRIFT_TARGET="$MANIFEST_DRIFT_TARGET" PATH="$MANIFEST_DRIFT_BIN:$PATH" "$MANIFEST_DRIFT_SOURCE/install.sh" --apply --dir "$MANIFEST_DRIFT_TARGET" --only tools/naru-doctor.js >/dev/null 2>&1; then fail "manifest drift aborts selected apply"; else pass "manifest drift aborts selected apply"; fi
if cmp -s "$MANIFEST_DRIFT_TARGET/tools/naru-doctor.js" "$TMP/only-manifest-drift-doctor" && [ ! -d "$MANIFEST_DRIFT_TARGET/.naru-backups" ]; then pass "manifest drift aborts before selected target mutation"; else fail "manifest drift aborts before selected target mutation"; fi

SOURCE_DRIFT_SOURCE="$TMP/only-source-drift-source"
cp -R "$FIXTURE" "$SOURCE_DRIFT_SOURCE"
SOURCE_DRIFT_TARGET="$TMP/only-source-drift-target"
mkdir -p "$SOURCE_DRIFT_TARGET"
"$SOURCE_DRIFT_SOURCE/install.sh" --apply --copy --dir "$SOURCE_DRIFT_TARGET" >/dev/null
printf '%s\n' 'doctor staged' > "$SOURCE_DRIFT_SOURCE/tools/naru-doctor.js"
SOURCE_DRIFT_BIN="$TMP/only-source-drift-bin"
mkdir -p "$SOURCE_DRIFT_BIN"
cat > "$SOURCE_DRIFT_BIN/cp" <<EOF
#!/usr/bin/env sh
"$REAL_CP" "\$@" || exit \$?
case "\$2" in
  */tools/naru-doctor.js) printf '%s\n' 'source changed after stage' > "\$SOURCE_DRIFT_SOURCE/tools/naru-doctor.js" ;;
esac
EOF
chmod +x "$SOURCE_DRIFT_BIN/cp"
if SOURCE_DRIFT_SOURCE="$SOURCE_DRIFT_SOURCE" PATH="$SOURCE_DRIFT_BIN:$PATH" "$SOURCE_DRIFT_SOURCE/install.sh" --apply --dir "$SOURCE_DRIFT_TARGET" --only tools/naru-doctor.js >/dev/null 2>&1; then fail "staged-source drift aborts selected apply"; else pass "staged-source drift aborts selected apply"; fi
if [ ! -d "$SOURCE_DRIFT_TARGET/.naru-backups" ] && ! grep -q '^doctor staged$' "$SOURCE_DRIFT_TARGET/tools/naru-doctor.js"; then pass "staged-source drift aborts before target mutation"; else fail "staged-source drift aborts before target mutation"; fi

ROLLBACK_SOURCE="$TMP/only-rollback-source"
cp -R "$FIXTURE" "$ROLLBACK_SOURCE"
ROLLBACK_TARGET="$TMP/only-rollback-target"
mkdir -p "$ROLLBACK_TARGET"
"$ROLLBACK_SOURCE/install.sh" --apply --copy --dir "$ROLLBACK_TARGET" >/dev/null
cp -R "$ROLLBACK_TARGET/tools/naru-lib" "$TMP/only-rollback-lib"
cp "$ROLLBACK_TARGET/.naru-install.json" "$TMP/only-rollback-manifest"
printf '%s\n' 'compatibility rollback desired' > "$ROLLBACK_SOURCE/tools/naru-lib/compatibility.mjs"
ROLLBACK_BIN="$TMP/only-rollback-bin"
mkdir -p "$ROLLBACK_BIN"
REAL_MV_ONLY=$(command -v mv)
cat > "$ROLLBACK_BIN/mv" <<EOF
#!/usr/bin/env sh
case "\$1" in
  */.naru-staging/*/.naru-install.json) exit 99 ;;
esac
exec "$REAL_MV_ONLY" "\$@"
EOF
chmod +x "$ROLLBACK_BIN/mv"
if PATH="$ROLLBACK_BIN:$PATH" "$ROLLBACK_SOURCE/install.sh" --apply --dir "$ROLLBACK_TARGET" --only tools/naru-lib/compatibility.mjs >/dev/null 2>&1; then fail "injected selected mid-apply failure"; else pass "injected selected mid-apply failure"; fi
if diff -qr "$ROLLBACK_TARGET/tools/naru-lib" "$TMP/only-rollback-lib" >/dev/null && cmp -s "$ROLLBACK_TARGET/.naru-install.json" "$TMP/only-rollback-manifest"; then pass "selected mid-apply rollback restores composite and manifest"; else fail "selected mid-apply rollback restores composite and manifest"; fi

# 14. The naru CLI front door.
CLI="$ROOT/bin/naru"
if [ -x "$CLI" ]; then pass "naru CLI is executable"; else fail "naru CLI is executable"; fi

if "$CLI" help 2>&1 | grep -q 'naru <command>'; then pass "naru help describes usage"; else fail "naru help describes usage"; fi
if "$CLI" help 2>&1 | grep -q -- '--only PATH'; then pass "naru help documents selective installs"; else fail "naru help documents selective installs"; fi

if "$CLI" bogus-command >/dev/null 2>&1; then fail "naru rejects unknown commands"; else pass "naru rejects unknown commands"; fi

if "$CLI" version 2>&1 | grep -q "naru $(tr -d ' \n' < "$ROOT/VERSION")"; then pass "naru version reports the release version"; else fail "naru version reports the release version"; fi

# Non-interactive install must preview and refuse to mutate without --apply.
T14="$TMP/t14"
mkdir -p "$T14"
CLI_OUT="$(NARU_HOME="$T14/naru-home" "$CLI" install --dir "$T14/target" < /dev/null 2>&1 || true)"
if printf '%s' "$CLI_OUT" | grep -q 'Preview only; no files changed'; then pass "naru install previews first"; else fail "naru install previews first"; fi
if printf '%s' "$CLI_OUT" | grep -q 'Rerun with --apply'; then pass "naru install refuses to apply non-interactively"; else fail "naru install refuses to apply non-interactively"; fi
if [ ! -e "$T14/target" ]; then pass "naru install creates nothing without confirmation"; else fail "naru install creates nothing without confirmation"; fi

# bootstrap.sh must reject bad options rather than guessing.
if sh "$ROOT/bootstrap.sh" --nope >/dev/null 2>&1; then fail "bootstrap rejects unknown options"; else pass "bootstrap rejects unknown options"; fi
if sh "$ROOT/bootstrap.sh" --version >/dev/null 2>&1; then fail "bootstrap requires a value for --version"; else pass "bootstrap requires a value for --version"; fi
if sh "$ROOT/bootstrap.sh" --help 2>&1 | grep -q 'modify-path'; then pass "bootstrap documents --modify-path"; else fail "bootstrap documents --modify-path"; fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then exit 1; fi
