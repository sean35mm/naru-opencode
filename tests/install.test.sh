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
touch "$FIXTURE/agents/naru-orchestrator.md"
touch "$FIXTURE/agents/naru-minion-scout.md"
touch "$FIXTURE/agents/naru-minion-investigate.md"
touch "$FIXTURE/agents/naru-minion-architect.md"
touch "$FIXTURE/agents/naru-minion-implement.md"
touch "$FIXTURE/agents/naru-minion-debug.md"
touch "$FIXTURE/agents/naru-minion-verify.md"
touch "$FIXTURE/agents/naru-minion-judge.md"

# Tools and optional plugin
touch "$FIXTURE/tools/naru-git-read.js"
touch "$FIXTURE/tools/naru-github-read.js"
touch "$FIXTURE/tools/naru-github-post-review.js"
touch "$FIXTURE/tools/naru-lib/helper.js"
touch "$FIXTURE/plugins/naru-minions-dashboard.js"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL $1"; }

is_link() { [ -L "$1" ]; }
is_file() { [ -f "$1" ] && [ ! -L "$1" ]; }
is_dir() { [ -d "$1" ] && [ ! -L "$1" ]; }

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
if [ ! -e "$T1/plugins/naru-minions-dashboard.js" ]; then pass "dashboard omitted by default"; else fail "dashboard omitted by default"; fi
if [ ! -e "$T1/commands/naru" ] && [ ! -e "$T1/agents/naru" ]; then pass "no old loader paths"; else fail "no old loader paths"; fi

# 2. Copy mode.
T2="$TMP/t2"
mkdir -p "$T2"
"$FIXTURE/install.sh" --dir "$T2" --copy
if is_file "$T2/commands/naru-plan.md"; then pass "copied command"; else fail "copied command"; fi
if is_file "$T2/agents/naru-plan.md"; then pass "copied agent"; else fail "copied agent"; fi
if is_file "$T2/tools/naru-git-read.js"; then pass "copied tool"; else fail "copied tool"; fi

# Project mode targets the caller's project, not the Naru source clone.
PROJECT="$TMP/project"
mkdir -p "$PROJECT"
(cd "$PROJECT" && "$FIXTURE/install.sh" --project >/dev/null)
if is_link "$PROJECT/.opencode/commands/naru-plan.md"; then pass "project install"; else fail "project install"; fi

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
if is_file "$T6/plugins/naru-minions-dashboard.js"; then pass "dashboard installed with --with-dashboard"; else fail "dashboard installed with --with-dashboard"; fi

# 7. Idempotency and backup retention.
T7="$TMP/t7"
mkdir -p "$T7"
"$FIXTURE/install.sh" --dir "$T7"
echo "stale" > "$T7/commands/naru-plan.md"
"$FIXTURE/install.sh" --dir "$T7"
if is_link "$T7/commands/naru-plan.md" && [ "$(readlink "$T7/commands/naru-plan.md")" = "$FIXTURE_PHYS/commands/naru-plan.md" ]; then pass "idempotent reinstall refreshes target"; else fail "idempotent reinstall refreshes target"; fi
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

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then exit 1; fi
