import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MANAGED_SOL_XHIGH_ALIASES, NARU_AGENT_IDS, NARU_DISPATCH_GRAPH } from '../tools/naru-lib/model-routing.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/behavioral-evals.json', import.meta.url));
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const canonicalAgents = new Set(NARU_AGENT_IDS);
const workflowBaselines = {
  plan: ['naru-plan-minimal-change', 'naru-plan-tests', 'naru-plan-judge'],
  impact: ['naru-impact-topology', 'naru-impact-tests-ci', 'naru-impact-judge'],
  triage: ['naru-triage-reproduction', 'naru-triage-codepath', 'naru-triage-judge'],
  review: ['naru-review-judge'],
};

function caseByID(id) {
  const item = fixture.cases.find((entry) => entry.id === id);
  assert.ok(item, `missing fixture case: ${id}`);
  return item;
}

function schedulingCaseByID(id) {
  const item = fixture.implementationSchedulingCases.find((entry) => entry.id === id);
  assert.ok(item, `missing implementation scheduling fixture case: ${id}`);
  return item;
}

test('behavioral contract corpus has a stable, canonical shape', () => {
  assert.equal(fixture.schemaVersion, 1);
  assert.match(fixture.purpose, /not a live model-quality benchmark/i);
  const ids = fixture.cases.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of [
    'narrow-implementation', 'cross-package-implementation', 'ambiguous-diagnosis',
    'security-data-sensitive-change', 'frontend-review', 'backend-review', 'cross-service-review',
    'provider-failure', 'missing-context', 'conditional-specialist-selection',
    'high-root-xhigh-denial', 'xhigh-root-optional-children', 'max-root-xhigh-unlock',
    'routine-autonomous-local-commands', 'local-change-stopping-point', 'explicit-git-delivery',
  ]) caseByID(id);

  for (const entry of fixture.cases) {
    assert.equal(typeof entry.id, 'string');
    assert.ok(canonicalAgents.has(entry.rootAgent), `${entry.id} has a canonical root agent`);
    assert.equal(typeof entry.input?.summary, 'string');
    assert.ok(Array.isArray(entry.prohibited?.actions) && entry.prohibited.actions.length);
    assert.ok(Array.isArray(entry.prohibited?.routes) && entry.prohibited.routes.length);
    assert.equal(typeof entry.expected?.status, 'string');
    assert.equal(typeof entry.expected?.authorization, 'string');
  }
});

test('implementation scheduling corpus keeps schema v1 and covers bounded concurrency decisions', () => {
  assert.equal(fixture.schemaVersion, 1);
  assert.ok(Array.isArray(fixture.implementationSchedulingCases));
  const requiredIDs = [
    'scheduler-single-writer',
    'scheduler-safe-two-writer-wave',
    'scheduler-cap-two',
    'scheduler-same-file-serialization',
    'scheduler-shared-contract-serialization',
    'scheduler-shared-resource-serialization',
    'scheduler-dependency-serialization',
    'scheduler-weaver-conflict',
    'scheduler-weaver-unavailable-internal-gates',
    'scheduler-aggregate-verification-barrier',
    'scheduler-second-wave-baseline-delta',
    'scheduler-scope-drift-invalidates-evidence',
    'scheduler-remediation-delivery-serialized',
    'scheduler-no-automatic-worktrees',
  ];
  assert.deepEqual(fixture.implementationSchedulingCases.map((entry) => entry.id), requiredIDs);
  for (const entry of fixture.implementationSchedulingCases) {
    assert.equal(typeof entry.scenario, 'string');
    assert.ok(Array.isArray(entry.prohibitedActions) && entry.prohibitedActions.length);
    assert.equal(typeof entry.expected, 'object');
    if ('maxConcurrentImplement' in entry.expected) {
      assert.ok(entry.expected.maxConcurrentImplement <= 2, `${entry.id} respects writer cap`);
    }
  }
});

test('DAG readiness chooses one writer or a safe wave without forced fan-out and caps at two', () => {
  const single = schedulingCaseByID('scheduler-single-writer');
  assert.deepEqual(single.expected.implementWaves, [['a']]);
  assert.equal(single.expected.disposition, 'single-writer');

  const safe = schedulingCaseByID('scheduler-safe-two-writer-wave');
  assert.deepEqual(safe.expected.implementWaves, [['a', 'b']]);
  assert.equal(safe.expected.maxConcurrentImplement, 2);
  const packetFields = [
    'baselineIdentity', 'baselineState', 'contractClaims', 'dependencies', 'exclusions', 'generatedArtifactClaims', 'mutableResourceClaims',
    'ownedWriteScope', 'verificationNeeds', 'waveId', 'workItemId',
  ];
  for (const item of safe.workItems) assert.deepEqual(Object.keys(item).sort(), packetFields);

  const capped = schedulingCaseByID('scheduler-cap-two');
  assert.deepEqual(capped.expected.implementWaves, [['a', 'b'], ['c']]);
  assert.equal(capped.expected.maxConcurrentImplement, 2);
});

test('overlap, coupling, and dependencies deterministically serialize implementation writers', () => {
  for (const id of [
    'scheduler-same-file-serialization',
    'scheduler-shared-contract-serialization',
    'scheduler-shared-resource-serialization',
    'scheduler-dependency-serialization',
  ]) {
    const entry = schedulingCaseByID(id);
    assert.deepEqual(entry.expected.implementWaves, [['a'], ['b']], id);
    assert.equal(entry.expected.maxConcurrentImplement, 1, id);
    assert.equal(entry.expected.disposition, 'serialize', id);
  }
});

test('Weaver conflict serializes without retry while unavailable Weaver preserves strict internal gates', () => {
  const conflict = schedulingCaseByID('scheduler-weaver-conflict');
  assert.equal(conflict.weaver.available, true);
  assert.equal(conflict.weaver.claimRetries, 0);
  assert.equal(conflict.weaver.claimTiming, 'before-first-edit');
  assert.deepEqual(conflict.weaver.successfulClaims, []);
  assert.equal(conflict.expected.editsBeforeConflict, 0);
  assert.deepEqual(conflict.expected.reportChangedPaths, []);
  assert.equal(conflict.expected.coordinatorFallback, 'serialized');
  assert.equal(conflict.expected.disposition, 'blocked-then-serialize');

  const unavailable = schedulingCaseByID('scheduler-weaver-unavailable-internal-gates');
  assert.equal(unavailable.weaver.available, false);
  assert.equal(unavailable.weaver.fallback, 'strict-packet-ownership-and-changed-path-containment');
  assert.deepEqual(unavailable.expected.implementWaves, [['a', 'b']]);
  assert.equal(unavailable.expected.maxConcurrentImplement, 2);
});

test('wave barriers, stale evidence, remediation, delivery, and worktree behavior fail closed', () => {
  const barrier = schedulingCaseByID('scheduler-aggregate-verification-barrier');
  assert.equal(barrier.expected.verificationStarts, 'after-all-writers-terminal');
  assert.deepEqual(barrier.expected.implementationReports, ['a', 'b']);
  assert.equal(barrier.expected.claimComparison, 'current-wave-delta-vs-current-wave-ownership-union');

  const secondWave = schedulingCaseByID('scheduler-second-wave-baseline-delta');
  assert.equal(secondWave.wave.waveId, 'wave-2');
  assert.deepEqual(secondWave.wave.workItemIds, ['c']);
  assert.equal(secondWave.wave.baselineIdentity, 'wave-2-pre');
  assert.equal(secondWave.wave.postWaveIdentity, 'wave-2-post');
  assert.deepEqual(secondWave.wave.baselineState.changedPaths, ['src/a.js', 'src/b.js']);
  assert.deepEqual(secondWave.wave.postWaveState.changedPaths, ['src/a.js', 'src/b.js', 'src/c.js']);
  assert.deepEqual(secondWave.wave.currentWaveDelta.changedPaths, ['src/c.js']);
  assert.deepEqual(secondWave.wave.ownershipUnion, ['src/c.js']);
  assert.equal(secondWave.expected.verificationState, 'full-integrated-post-wave-state');
  assert.equal(secondWave.expected.claimComparison, 'current-wave-delta-vs-current-wave-ownership-union');
  assert.equal(secondWave.expected.earlierWavePaths, 'valid-baseline-state');
  assert.equal(secondWave.expected.disposition, 'verified');

  const stale = schedulingCaseByID('scheduler-scope-drift-invalidates-evidence');
  assert.deepEqual(stale.events, ['owned-path-drift', 'later-edit']);
  assert.equal(stale.expected.evidenceStatus, 'invalid');
  assert.deepEqual(stale.expected.invalidated, ['verification', 'judgment']);

  const serialized = schedulingCaseByID('scheduler-remediation-delivery-serialized');
  assert.equal(serialized.expected.remediationConcurrency, 1);
  assert.equal(serialized.expected.deliveryConcurrency, 1);
  assert.deepEqual(serialized.expected.phases.slice(-4), ['serialized-remediation', 'reverification', 'rejudgment', 'serialized-delivery']);

  const worktrees = schedulingCaseByID('scheduler-no-automatic-worktrees');
  assert.equal(worktrees.expected.automaticWorktreeCreation, false);
  assert.equal(worktrees.expected.workspaceMode, 'current-workspace');
});

test('model-route variants preserve high defaults and never create Max children', () => {
  for (const entry of fixture.cases) {
    const { root, children } = entry.routing;
    assert.ok(['luna', 'terra', 'sol'].includes(root.profile), `${entry.id} root profile`);
    assert.ok(['high', 'xhigh', 'max'].includes(root.variant), `${entry.id} root variant`);
    assert.deepEqual(children.standardVariants, ['high'], `${entry.id} standard child variants`);
    assert.ok(children.profiles.every((profile) => ['luna', 'terra', 'sol'].includes(profile)));
    assert.ok(![...children.standardVariants, ...children.optionalVariants].includes('max'), `${entry.id} has no Max child`);
  }
});

test('xhigh is optional and only reachable from direct Sol xhigh or max orchestrator roots', () => {
  for (const entry of fixture.cases) {
    const allowsXhigh = entry.routing.children.optionalVariants.includes('xhigh');
    if (allowsXhigh) {
      assert.equal(entry.rootAgent, 'naru-orchestrator', `${entry.id} xhigh root agent`);
      assert.equal(entry.routing.root.profile, 'sol', `${entry.id} xhigh Sol profile`);
      assert.ok(['xhigh', 'max'].includes(entry.routing.root.variant), `${entry.id} xhigh root variant`);
      assert.equal(entry.expected.authorization, 'xhigh-authorized');
    }
    if (entry.routing.root.variant === 'high') {
      assert.equal(allowsXhigh, false, `${entry.id} high roots cannot auto-use xhigh`);
    }
  }
  const denied = caseByID('high-root-xhigh-denial');
  assert.equal(denied.prohibited.routes[0], 'naru-delegate-sol-xhigh-minion-implement');
  assert.equal(denied.expected.status, 'denied');
  assert.equal(MANAGED_SOL_XHIGH_ALIASES.length, 7);
});

test('conditional fan-out keeps workflow baselines, selected sets, and skipped-not-relevant semantics', () => {
  for (const entry of fixture.cases.filter((item) => item.selection)) {
    const { selected, skipped, baseline, skippedStatus } = entry.selection;
    const targets = NARU_DISPATCH_GRAPH[entry.rootAgent] ?? [];
    assert.deepEqual(baseline, workflowBaselines[entry.workflow] ?? baseline, `${entry.id} baseline`);
    assert.equal(skippedStatus, 'skipped-not-relevant');
    for (const specialist of [...selected, ...skipped, ...baseline]) {
      assert.ok(canonicalAgents.has(specialist), `${entry.id} specialist is canonical`);
      assert.ok(targets.includes(specialist), `${entry.id} specialist is reachable from root`);
    }
    for (const specialist of baseline) assert.ok(selected.includes(specialist), `${entry.id} selected baseline ${specialist}`);
    assert.equal(new Set([...selected, ...skipped]).size, selected.length + skipped.length, `${entry.id} selection sets do not overlap`);
    assert.deepEqual(new Set([...selected, ...skipped]), new Set(targets), `${entry.id} selection sets cover root targets`);
  }
  assert.deepEqual(caseByID('conditional-specialist-selection').selection.skipped, [
    'naru-impact-contracts', 'naru-impact-data', 'naru-impact-frontend-mobile',
  ]);
});

test('authorization fixtures preserve routine autonomy, local stopping, and explicit delivery', () => {
  const routine = caseByID('routine-autonomous-local-commands');
  assert.equal(routine.expected.promptRequired, false);
  assert.deepEqual(routine.expected.allowedOperations, ['naru-git-read', 'naru-github-read', 'bash', 'weaver', 'targeted-check']);

  const localStop = caseByID('local-change-stopping-point');
  assert.equal(localStop.expected.authorization, 'local-changes-stop');
  assert.deepEqual(localStop.prohibited.actions, ['commit', 'push', 'open pull request']);

  const delivery = caseByID('explicit-git-delivery');
  assert.equal(delivery.expected.authorization, 'delivery-authorized');
  assert.equal(delivery.expected.promptRequired, false);
  assert.deepEqual(delivery.expected.allowedOperations, ['commit', 'push', 'open-pull-request']);
});
