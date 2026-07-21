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

mkdir -p "$FIXTURE/commands"
mkdir -p "$FIXTURE/agents"
mkdir -p "$FIXTURE/tools/naru-lib"
mkdir -p "$FIXTURE/plugins"
mkdir -p "$FIXTURE/scripts"

# 5 commands
touch "$FIXTURE/commands/naru-plan.md"
touch "$FIXTURE/commands/naru-impact.md"
touch "$FIXTURE/commands/naru-triage.md"
touch "$FIXTURE/commands/naru-review.md"
touch "$FIXTURE/commands/naru-review-post.md"

# 35 agents
touch "$FIXTURE/agents/naru-plan.md"
touch "$FIXTURE/agents/naru-plan-architecture.md"
touch "$FIXTURE/agents/naru-plan-minimal-change.md"
touch "$FIXTURE/agents/naru-plan-risk.md"
touch "$FIXTURE/agents/naru-plan-tests.md"
touch "$FIXTURE/agents/naru-plan-judge.md"

touch "$FIXTURE/agents/naru-impact.md"
touch "$FIXTURE/agents/naru-impact-topology.md"
touch "$FIXTURE/agents/naru-impact-contracts.md"
touch "$FIXTURE/agents/naru-impact-data.md"
touch "$FIXTURE/agents/naru-impact-frontend-mobile.md"
touch "$FIXTURE/agents/naru-impact-tests-ci.md"
touch "$FIXTURE/agents/naru-impact-judge.md"

touch "$FIXTURE/agents/naru-triage.md"
touch "$FIXTURE/agents/naru-triage-reproduction.md"
touch "$FIXTURE/agents/naru-triage-codepath.md"
touch "$FIXTURE/agents/naru-triage-regression.md"
touch "$FIXTURE/agents/naru-triage-tests.md"
touch "$FIXTURE/agents/naru-triage-judge.md"

touch "$FIXTURE/agents/naru-review.md"
touch "$FIXTURE/agents/naru-review-security.md"
touch "$FIXTURE/agents/naru-review-backend.md"
touch "$FIXTURE/agents/naru-review-frontend-mobile.md"
touch "$FIXTURE/agents/naru-review-integrations.md"
touch "$FIXTURE/agents/naru-review-tests-ci.md"
touch "$FIXTURE/agents/naru-review-judge.md"

touch "$FIXTURE/agents/naru-review-post.md"
cp "$ROOT/agents/naru-orchestrator.md" "$FIXTURE/agents/naru-orchestrator.md"
touch "$FIXTURE/agents/naru-minion-scout.md"
touch "$FIXTURE/agents/naru-minion-investigate.md"
touch "$FIXTURE/agents/naru-minion-architect.md"
cp "$ROOT/agents/naru-minion-implement.md" "$FIXTURE/agents/naru-minion-implement.md"
touch "$FIXTURE/agents/naru-minion-debug.md"
touch "$FIXTURE/agents/naru-minion-verify.md"
touch "$FIXTURE/agents/naru-minion-judge.md"

# Tools and plugins
touch "$FIXTURE/tools/naru-git-read.js"
touch "$FIXTURE/tools/naru-github-read.js"
touch "$FIXTURE/tools/naru-github-post-review.js"
touch "$FIXTURE/tools/naru-scheduler.js"
touch "$FIXTURE/tools/naru-worktree.js"
touch "$FIXTURE/tools/naru-lib/helper.js"
touch "$FIXTURE/plugins/naru-delegate.js"
touch "$FIXTURE/plugins/naru-scheduler.js"
touch "$FIXTURE/plugins/naru-minions-dashboard.tsx"
cp "$ROOT/plugins/naru-minions-dashboard-state.mjs" "$FIXTURE/plugins/naru-minions-dashboard-state.mjs"
cp "$ROOT/scripts/merge-tui-config.mjs" "$FIXTURE/scripts/merge-tui-config.mjs"
cp "$ROOT/scripts/merge-opencode-config.mjs" "$FIXTURE/scripts/merge-opencode-config.mjs"
touch "$FIXTURE/scripts/naru-live-eval.mjs"
mkdir -p "$FIXTURE/tests/fixtures"
touch "$FIXTURE/tests/fixtures/live-evals.json"
touch "$FIXTURE/naru-runtime.example.json"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL $1"; }

is_link() { [ -L "$1" ]; }
is_file() { [ -f "$1" ] && [ ! -L "$1" ]; }
is_dir() { [ -d "$1" ] && [ ! -L "$1" ]; }
has_mode_600() { [ "$(LC_ALL=C ls -ld "$1" | cut -c 2-10)" = "rw-------" ]; }

backup_dir() {
  find "$1/.naru-backups" -mindepth 1 -maxdepth 1 -type d | head -n 1
}

# 1. Default symlink install into a custom dir.
T1="$TMP/t1"
mkdir -p "$T1"
"$FIXTURE/install.sh" --dir "$T1"
if is_link "$T1/commands/naru-plan.md"; then pass "symlinked command"; else fail "symlinked command"; fi
if is_link "$T1/agents/naru-plan.md"; then pass "symlinked agent"; else fail "symlinked agent"; fi
if is_file "$T1/tools/naru-git-read.js"; then pass "tool copy-pinned"; else fail "tool copy-pinned"; fi
if is_dir "$T1/tools/naru-lib"; then pass "tool helper dir copy-pinned"; else fail "tool helper dir copy-pinned"; fi
if is_file "$T1/plugins/naru-delegate.js"; then pass "delegate plugin installed by default"; else fail "delegate plugin installed by default"; fi
if is_file "$T1/tools/naru-scheduler.js" && is_file "$T1/plugins/naru-scheduler.js"; then pass "scheduler runtime copy-pinned"; else fail "scheduler runtime copy-pinned"; fi
if is_file "$T1/tools/naru-worktree.js"; then pass "worktree runtime copy-pinned"; else fail "worktree runtime copy-pinned"; fi
if is_file "$T1/naru-runtime.example.json" && is_file "$T1/scripts/naru-live-eval.mjs" && is_file "$T1/scripts/live-evals.example.json"; then pass "runtime example and evaluation assets copy-pinned"; else fail "runtime example and evaluation assets copy-pinned"; fi
if [ "$(grep -c '^  naru-scheduler: allow$' "$T1/agents/naru-orchestrator.md")" -eq 1 ] && [ "$(grep -c '^  naru-worktree: allow$' "$T1/agents/naru-orchestrator.md")" -eq 1 ] && ! grep -qE '^  naru-(scheduler|worktree): allow$' "$T1/agents/naru-minion-implement.md"; then pass "global root and delegated runtime permissions"; else fail "global root and delegated runtime permissions"; fi
if [ ! -e "$T1/plugins/naru-minions-dashboard.tsx" ]; then pass "dashboard omitted by default"; else fail "dashboard omitted by default"; fi
if [ ! -e "$T1/commands/naru" ] && [ ! -e "$T1/agents/naru" ]; then pass "no old loader paths"; else fail "no old loader paths"; fi

# 2. Copy mode.
T2="$TMP/t2"
mkdir -p "$T2"
"$FIXTURE/install.sh" --dir "$T2" --copy
if is_file "$T2/commands/naru-plan.md"; then pass "copied command"; else fail "copied command"; fi
if is_file "$T2/agents/naru-plan.md"; then pass "copied agent"; else fail "copied agent"; fi
if is_file "$T2/tools/naru-git-read.js"; then pass "copied tool"; else fail "copied tool"; fi
if is_file "$T2/plugins/naru-delegate.js"; then pass "copied delegate plugin"; else fail "copied delegate plugin"; fi

# Project mode targets the caller's project, not the Naru source clone.
PROJECT="$TMP/project"
mkdir -p "$PROJECT"
(cd "$PROJECT" && "$FIXTURE/install.sh" --project >/dev/null)
if is_link "$PROJECT/.opencode/commands/naru-plan.md"; then pass "project install"; else fail "project install"; fi
if [ "$(grep -c '^  naru-scheduler: allow$' "$PROJECT/.opencode/agents/naru-orchestrator.md")" -eq 1 ] && [ "$(grep -c '^  naru-worktree: allow$' "$PROJECT/.opencode/agents/naru-orchestrator.md")" -eq 1 ] && ! grep -qE '^  naru-(scheduler|worktree): allow$' "$PROJECT/.opencode/agents/naru-minion-implement.md"; then pass "project root and delegated runtime permissions"; else fail "project root and delegated runtime permissions"; fi

# 3. Paths with spaces.
T3="$TMP/path with spaces/target"
mkdir -p "$T3"
"$FIXTURE/install.sh" --dir "$T3"
if is_link "$T3/commands/naru-plan.md"; then pass "spaces in path"; else fail "spaces in path"; fi

# 4. Legacy Core migration.
T4="$TMP/t4"
mkdir -p "$T4/commands/naru" "$T4/agents/naru"
touch "$T4/commands/naru.bak.123" "$T4/agents/naru.bak.456"
touch "$T4/commands/naru/old.md" "$T4/agents/naru/old.md"
"$FIXTURE/install.sh" --dir "$T4"
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
"$FIXTURE/install.sh" --dir "$T5" --migrate-orchestrator
if [ ! -e "$T5/agents/orchestrator.md" ] && [ ! -e "$T5/agents/minion" ] && [ ! -e "$T5/plugins/orchestrator-dashboard.js" ]; then pass "legacy orchestrator migrated with flag"; else fail "legacy orchestrator migrated with flag"; fi

T5B="$TMP/t5b"
mkdir -p "$T5B/agents/minion" "$T5B/plugins"
touch "$T5B/agents/orchestrator.md" "$T5B/plugins/orchestrator-dashboard.js"
"$FIXTURE/install.sh" --dir "$T5B"
if [ -e "$T5B/agents/orchestrator.md" ] && [ -e "$T5B/agents/minion" ] && [ -e "$T5B/plugins/orchestrator-dashboard.js" ]; then pass "legacy orchestrator preserved without flag"; else fail "legacy orchestrator preserved without flag"; fi

# 6. Dashboard opt-in.
T6="$TMP/t6"
mkdir -p "$T6"
"$FIXTURE/install.sh" --dir "$T6" --with-dashboard
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
"$FIXTURE/install.sh" --dir "$T6B" --with-dashboard >/dev/null
if grep -q 'Preserve this comment' "$T6B/tui.jsonc" && grep -q 'unrelated.tsx' "$T6B/tui.jsonc"; then pass "JSONC merge preserves unrelated content"; else fail "JSONC merge preserves unrelated content"; fi
if [ "$(grep -c 'naru-minions-dashboard.tsx' "$T6B/tui.jsonc")" -eq 1 ] && ! grep -q 'naru-minions-dashboard.js' "$T6B/tui.jsonc"; then pass "dashboard registration migrated idempotently"; else fail "dashboard registration migrated idempotently"; fi
if [ ! -e "$T6B/plugins/naru-minions-dashboard.js" ]; then pass "legacy dashboard migrated"; else fail "legacy dashboard migrated"; fi
if grep -q 'ignored.tsx' "$T6B/tui.json" && ! grep -q 'naru-minions-dashboard' "$T6B/tui.json"; then pass "lower precedence TUI config legacy registration cleaned"; else fail "lower precedence TUI config legacy registration cleaned"; fi
"$FIXTURE/install.sh" --dir "$T6B" --with-dashboard >/dev/null
if [ "$(grep -c 'naru-minions-dashboard.tsx' "$T6B/tui.jsonc")" -eq 1 ]; then pass "dashboard config reinstall idempotent"; else fail "dashboard config reinstall idempotent"; fi

T6C="$TMP/t6c"
mkdir -p "$T6C"
printf '%s\n' '{ invalid' > "$T6C/tui.json"
if "$FIXTURE/install.sh" --dir "$T6C" --with-dashboard >/dev/null 2>&1; then fail "reject malformed TUI config"; else pass "reject malformed TUI config"; fi
if [ ! -e "$T6C/plugins/naru-minions-dashboard.tsx" ]; then pass "malformed config leaves dashboard uninstalled"; else fail "malformed config leaves dashboard uninstalled"; fi

T6D="$TMP/t6d"
mkdir -p "$T6D" "$TMP/outside-tui"
printf '%s\n' '{"plugin":[]}' > "$T6D/tui.jsonc"
ln -s "$TMP/outside-tui/config" "$T6D/tui.json"
if "$FIXTURE/install.sh" --dir "$T6D" --with-dashboard >/dev/null 2>&1; then fail "reject either symlinked TUI config"; else pass "reject either symlinked TUI config"; fi

# 7. Idempotency and backup retention.
T7="$TMP/t7"
mkdir -p "$T7"
printf '%s\n' '{"schemaVersion":1,"profiles":{"fast":{"model":"custom/fast"}}}' > "$T7/naru-models.json"
"$FIXTURE/install.sh" --dir "$T7"
echo "stale" > "$T7/commands/naru-plan.md"
"$FIXTURE/install.sh" --dir "$T7"
if is_link "$T7/commands/naru-plan.md" && [ "$(readlink "$T7/commands/naru-plan.md")" = "$FIXTURE_PHYS/commands/naru-plan.md" ]; then pass "idempotent reinstall refreshes target"; else fail "idempotent reinstall refreshes target"; fi
if grep -q 'custom/fast' "$T7/naru-models.json"; then pass "user model config preserved"; else fail "user model config preserved"; fi
BACKUP_COUNT=$(find "$T7/.naru-backups" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
if [ "$BACKUP_COUNT" -ge 1 ]; then pass "successful backups kept"; else fail "successful backups kept"; fi

# 8. Source/target overlap rejection.
T8="$TMP/t8"
mkdir -p "$T8"
if "$FIXTURE/install.sh" --dir "$FIXTURE" >/dev/null 2>&1; then fail "reject source==target overlap"; else pass "reject source==target overlap"; fi
T8SUB="$FIXTURE/sub"
mkdir -p "$T8SUB"
if "$FIXTURE/install.sh" --dir "$T8SUB" >/dev/null 2>&1; then fail "reject target inside source"; else pass "reject target inside source"; fi

# 9. Malformed option rejection.
if "$FIXTURE/install.sh" --dir "$T8" --bogus >/dev/null 2>&1; then fail "reject unknown option"; else pass "reject unknown option"; fi
if "$FIXTURE/install.sh" --dir >/dev/null 2>&1; then fail "reject missing --dir argument"; else pass "reject missing --dir argument"; fi

# 10. A mid-install failure restores every destination already replaced.
T10="$TMP/t10"
mkdir -p "$T10"
"$FIXTURE/install.sh" --dir "$T10" >/dev/null
PLAN_LINK=$(readlink "$T10/commands/naru-plan.md")
IMPACT_LINK=$(readlink "$T10/commands/naru-impact.md")
FAKEBIN="$TMP/fakebin"
mkdir -p "$FAKEBIN"
REAL_MV=$(command -v mv)
cat > "$FAKEBIN/mv" <<EOF
#!/usr/bin/env sh
case "\$1" in
  */.naru-staging/*/commands/naru-impact.md) exit 99 ;;
  */.naru-staging/*/tui.jsonc) exit 99 ;;
esac
exec "$REAL_MV" "\$@"
EOF
chmod +x "$FAKEBIN/mv"
if PATH="$FAKEBIN:$PATH" "$FIXTURE/install.sh" --dir "$T10" >/dev/null 2>&1; then
  fail "injected install failure"
else
  pass "injected install failure"
fi
if [ -L "$T10/commands/naru-plan.md" ] && [ "$(readlink "$T10/commands/naru-plan.md")" = "$PLAN_LINK" ] &&
   [ -L "$T10/commands/naru-impact.md" ] && [ "$(readlink "$T10/commands/naru-impact.md")" = "$IMPACT_LINK" ]; then
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
if PATH="$FAKECP:$PATH" "$FIXTURE/install.sh" --dir "$T10A" >/dev/null 2>&1; then
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
if PATH="$FAKEBIN:$PATH" "$FIXTURE/install.sh" --dir "$T10B" --with-dashboard >/dev/null 2>&1; then
  fail "injected TUI config install failure"
else
  pass "injected TUI config install failure"
fi
if cmp -s "$T10B/tui.json" "$TMP/t10b-tui.json" && cmp -s "$T10B/tui.jsonc" "$TMP/t10b-tui.jsonc"; then
  pass "rollback restored both TUI configs"
else
  fail "rollback restored both TUI configs"
fi

# 11. Managed backup/staging paths cannot redirect writes through symlinks.
T11="$TMP/t11"
mkdir -p "$T11" "$TMP/outside-managed"
ln -s "$TMP/outside-managed" "$T11/.naru-backups"
if "$FIXTURE/install.sh" --dir "$T11" >/dev/null 2>&1; then
  fail "reject symlinked managed directory"
else
  pass "reject symlinked managed directory"
fi

T11B="$TMP/t11b"
mkdir -p "$T11B" "$TMP/outside-loader"
ln -s "$TMP/outside-loader" "$T11B/commands"
if "$FIXTURE/install.sh" --dir "$T11B" >/dev/null 2>&1; then
  fail "reject symlinked loader directory"
else
  pass "reject symlinked loader directory"
fi

SOURCE_ALIAS="$TMP/source-alias"
ln -s "$FIXTURE" "$SOURCE_ALIAS"
if "$FIXTURE/install.sh" --dir "$SOURCE_ALIAS" >/dev/null 2>&1; then
  fail "reject canonical source alias"
else
  pass "reject canonical source alias"
fi

# 12. OpenCode subagent depth configuration is explicit, safe, and transactional.
T12="$TMP/t12"
mkdir -p "$T12"
printf '%s\n' '{"subagent_depth":1,"untouched":"yes"}' > "$T12/opencode.json"
chmod 600 "$T12/opencode.json"
cp "$T12/opencode.json" "$TMP/t12-original.json"
"$FIXTURE/install.sh" --dir "$T12" >/dev/null
if cmp -s "$T12/opencode.json" "$TMP/t12-original.json"; then pass "default install leaves OpenCode config byte-for-byte untouched"; else fail "default install leaves OpenCode config byte-for-byte untouched"; fi
if has_mode_600 "$T12/opencode.json"; then pass "default install leaves OpenCode config mode untouched"; else fail "default install leaves OpenCode config mode untouched"; fi
"$FIXTURE/install.sh" --dir "$T12" --configure-subagent-depth >/dev/null
if grep -q '"subagent_depth":2' "$T12/opencode.json" && has_mode_600 "$T12/opencode.json"; then pass "explicit depth merge preserves 0600 through transaction"; else fail "explicit depth merge preserves 0600 through transaction"; fi

T12C="$TMP/t12-custom"
mkdir -p "$T12C"
(umask 000; "$FIXTURE/install.sh" --dir "$T12C" --configure-subagent-depth >/dev/null)
if grep -q '"$schema": "https://opencode.ai/config.json"' "$T12C/opencode.json" && grep -q '"subagent_depth": 2' "$T12C/opencode.json"; then pass "custom explicit depth config creates minimal file"; else fail "custom explicit depth config creates minimal file"; fi
if has_mode_600 "$T12C/opencode.json"; then pass "new explicit depth config uses 0600 under permissive umask"; else fail "new explicit depth config uses 0600 under permissive umask"; fi

T12G_HOME="$TMP/t12-global-home"
mkdir -p "$T12G_HOME/.config/opencode"
printf '%s\n' '{"subagent_depth":0,"global":true}' > "$T12G_HOME/.config/opencode/opencode.json"
HOME="$T12G_HOME" "$FIXTURE/install.sh" --configure-subagent-depth >/dev/null
if grep -q '"subagent_depth":2' "$T12G_HOME/.config/opencode/opencode.json" && grep -q '"global":true' "$T12G_HOME/.config/opencode/opencode.json"; then pass "global explicit depth merge"; else fail "global explicit depth merge"; fi

T12P="$TMP/t12-project"
mkdir -p "$T12P"
printf '%s\n' '{"subagent_depth":1,"project":true}' > "$T12P/opencode.json"
(cd "$T12P" && "$FIXTURE/install.sh" --project --configure-subagent-depth >/dev/null)
if grep -q '"subagent_depth":2' "$T12P/opencode.json" && [ ! -e "$T12P/.opencode/opencode.json" ]; then pass "project explicit merge uses project root"; else fail "project explicit merge uses project root"; fi

T12J="$TMP/t12-jsonc"
mkdir -p "$T12J"
printf '{\r\n\t// keep\r\n\t"subagent_depth": 1,\r\n\t"other": true,\r\n}\r\n' > "$T12J/opencode.jsonc"
"$FIXTURE/install.sh" --dir "$T12J" --configure-subagent-depth >/dev/null
if grep -q '// keep' "$T12J/opencode.jsonc" && grep -q '"other": true,' "$T12J/opencode.jsonc" && ! tr -d '\r' < "$T12J/opencode.jsonc" | cmp -s - "$T12J/opencode.jsonc"; then pass "explicit JSONC merge preserves comments CRLF and trailing comma"; else fail "explicit JSONC merge preserves comments CRLF and trailing comma"; fi

T12H="$TMP/t12-high"
mkdir -p "$T12H"
printf '%s\n' '{"subagent_depth":7,"keep":true}' > "$T12H/opencode.json"
"$FIXTURE/install.sh" --dir "$T12H" --configure-subagent-depth >/dev/null
cp "$T12H/opencode.json" "$TMP/t12-high-once.json"
"$FIXTURE/install.sh" --dir "$T12H" --configure-subagent-depth >/dev/null
if cmp -s "$T12H/opencode.json" "$TMP/t12-high-once.json" && grep -q '"subagent_depth":7' "$T12H/opencode.json"; then pass "explicit depth merge preserves values above two and is idempotent"; else fail "explicit depth merge preserves values above two and is idempotent"; fi
BD12=$(backup_dir "$T12H")
if [ -n "$BD12" ] && [ -f "$BD12/opencode.json" ]; then pass "explicit depth merge backs up config"; else fail "explicit depth merge backs up config"; fi

T12M="$TMP/t12-malformed"
mkdir -p "$T12M"
printf '%s\n' '{ invalid' > "$T12M/opencode.json"
if "$FIXTURE/install.sh" --dir "$T12M" --configure-subagent-depth >/dev/null 2>&1; then fail "reject malformed OpenCode config"; else pass "reject malformed OpenCode config"; fi
if [ ! -e "$T12M/commands/naru-plan.md" ]; then pass "malformed OpenCode config rejects before install mutation"; else fail "malformed OpenCode config rejects before install mutation"; fi

T12S="$TMP/t12-symlink"
mkdir -p "$T12S" "$TMP/t12-outside"
printf '%s\n' '{"subagent_depth":1}' > "$TMP/t12-outside/opencode.json"
ln -s "$TMP/t12-outside/opencode.json" "$T12S/opencode.json"
if "$FIXTURE/install.sh" --dir "$T12S" --configure-subagent-depth >/dev/null 2>&1; then fail "reject symlinked OpenCode config"; else pass "reject symlinked OpenCode config"; fi
if grep -q '"subagent_depth":1' "$TMP/t12-outside/opencode.json"; then pass "symlink refusal does not touch external target"; else fail "symlink refusal does not touch external target"; fi

T12B="$TMP/t12-both"
mkdir -p "$T12B"
printf '%s\n' '{}' > "$T12B/opencode.json"
printf '%s\n' '{}' > "$T12B/opencode.jsonc"
if "$FIXTURE/install.sh" --dir "$T12B" --configure-subagent-depth >/dev/null 2>&1; then fail "reject ambiguous JSON and JSONC config"; else pass "reject ambiguous JSON and JSONC config"; fi

T12R="$TMP/t12-rollback"
mkdir -p "$T12R"
printf '%s\n' '{"subagent_depth":1,"rollback":true}' > "$T12R/opencode.json"
cp "$T12R/opencode.json" "$TMP/t12-rollback-original.json"
if PATH="$FAKEBIN:$PATH" "$FIXTURE/install.sh" --dir "$T12R" --configure-subagent-depth >/dev/null 2>&1; then fail "injected post-config install failure"; else pass "injected post-config install failure"; fi
if cmp -s "$T12R/opencode.json" "$TMP/t12-rollback-original.json"; then pass "rollback restores OpenCode config"; else fail "rollback restores OpenCode config"; fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then exit 1; fi
