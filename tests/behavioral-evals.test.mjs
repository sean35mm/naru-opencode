import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MANAGED_SOL_XHIGH_ALIASES,
  NARU_AGENT_IDS,
  NARU_DISPATCH_GRAPH,
  NARU_MINIMUM_SUBAGENT_DEPTH,
  NARU_REQUIRED_SUBAGENT_DEPTH,
} from '../tools/naru-lib/model-routing.mjs';

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

function adaptiveCaseByID(id) {
  const item = fixture.adaptiveDelegationCases.find((entry) => entry.id === id);
  assert.ok(item, `missing adaptive delegation fixture case: ${id}`);
  return item;
}

function protocol3CaseByID(id) {
  const item = fixture.protocol3Cases.find((entry) => entry.id === id);
  assert.ok(item, `missing Protocol 3 fixture case: ${id}`);
  return item;
}

function reviewPostingCaseByID(id) {
  const item = fixture.reviewPostingCases.find((entry) => entry.id === id);
  assert.ok(item, `missing review posting fixture case: ${id}`);
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
    'scheduler-rolling-refill-timeline',
    'scheduler-work-item-contract',
    'scheduler-cap-two-timeline',
    'scheduler-active-peer-conflict-defers',
    'scheduler-baseline-lifecycle',
    'scheduler-provisional-dependency-invalidation',
    'scheduler-read-only-work-stealing',
    'scheduler-todo-phase-semantics',
    'scheduler-quiescent-two-shard-verification',
    'scheduler-final-identity-equality',
    'scheduler-remediation-delivery-serialized',
    'scheduler-automatic-isolated-worktrees',
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

test('adaptive delegation corpus covers every mode and enforces material-task decisions', () => {
  const requiredIDs = [
    'adaptive-auto-discovery-background',
    'adaptive-auto-diagnosis-selection',
    'adaptive-auto-command-diagnosis-selection',
    'adaptive-auto-structural-selection',
    'adaptive-auto-check-design-selection',
    'adaptive-lean-highest-value-one',
    'adaptive-thorough-single-best-of-two',
    'adaptive-foreground-no-background',
    'adaptive-off-typed-skip',
    'adaptive-known-scope-no-useful-lens',
    'adaptive-non-material-typed-skip',
    'adaptive-safety-blocked-typed-skip',
    'adaptive-capacity-seeking-refill',
  ];
  assert.deepEqual(fixture.adaptiveDelegationCases.map((entry) => entry.id), requiredIDs);
  assert.deepEqual(new Set(fixture.adaptiveDelegationCases.map((entry) => entry.policy.mode)), new Set([
    'auto', 'lean', 'thorough', 'foreground', 'off',
  ]));

  const allowedSkipReasons = new Set(['mode-off', 'not-material', 'no-useful-independent-lens', 'safety-blocked']);
  for (const entry of fixture.adaptiveDelegationCases) {
    assert.ok(Array.isArray(entry.prohibitedActions) && entry.prohibitedActions.length, entry.id);
    assert.equal(typeof entry.expected.disposition, 'string', entry.id);
    if (entry.decision) {
      const delegated = entry.decision.status === 'delegated';
      assert.equal(delegated, entry.decision.selected.length > 0, entry.id);
      if (entry.policy.material && !delegated) {
        assert.ok(allowedSkipReasons.has(entry.decision.skipReason?.code), `${entry.id} has a typed skip reason`);
        assert.equal(typeof entry.decision.skipReason.detail, 'string', entry.id);
        assert.ok(entry.decision.skipReason.detail.length > 0, entry.id);
      }
    }
  }
});

test('adaptive auto mode selects the exact useful role from task shape', () => {
  const expectedRoles = new Map([
    ['adaptive-auto-discovery-background', 'naru-minion-scout'],
    ['adaptive-auto-diagnosis-selection', 'naru-minion-investigate'],
    ['adaptive-auto-command-diagnosis-selection', 'naru-minion-debug'],
    ['adaptive-auto-structural-selection', 'naru-minion-architect'],
    ['adaptive-auto-check-design-selection', 'naru-minion-verify'],
  ]);
  for (const [id, role] of expectedRoles) {
    const entry = adaptiveCaseByID(id);
    assert.deepEqual(entry.decision.selected, [role], id);
    assert.equal(entry.decision.skipReason, null, id);
  }
  assert.equal(adaptiveCaseByID('adaptive-auto-check-design-selection').decision.verifyMode, 'preparation');
});

test('adaptive modes bound selection, background behavior, and best-of-2', () => {
  const lean = adaptiveCaseByID('adaptive-lean-highest-value-one');
  assert.equal(lean.decision.selected.length, 1);
  assert.equal(lean.decision.bestOf2Pairs, 0);

  const thorough = adaptiveCaseByID('adaptive-thorough-single-best-of-two');
  assert.equal(thorough.decision.bestOf2.pairs, 1);
  assert.equal(thorough.decision.bestOf2.freshChildren, 2);
  assert.equal(thorough.decision.bestOf2.sameBoundedQuestion, true);
  assert.equal(thorough.decision.bestOf2.independentPackets, true);
  assert.equal(thorough.expected.maxConcurrentReadOnly, 4);

  const foreground = adaptiveCaseByID('adaptive-foreground-no-background');
  assert.equal(foreground.decision.launch, 'foreground');
  assert.equal(foreground.expected.usesAutoSelection, true);

  const off = adaptiveCaseByID('adaptive-off-typed-skip');
  assert.equal(off.decision.skipReason.code, 'mode-off');
  assert.deepEqual(off.requiredStages, ['naru-minion-implement', 'naru-minion-verify', 'naru-minion-judge']);
});

test('adaptive delegation launches when its packet exists, refills useful capacity, and preserves all caps', () => {
  const background = adaptiveCaseByID('adaptive-auto-discovery-background');
  assert.equal(background.packet.dispatchAt, background.packet.availableAt);
  assert.equal(background.decision.launch, 'background');

  const refill = adaptiveCaseByID('adaptive-capacity-seeking-refill');
  assert.deepEqual(refill.timeline.map((entry) => entry.event), [
    'packet-ready', 'start-background', 'finish', 'refill-background', 'sufficient-evidence',
  ]);
  assert.deepEqual(refill.timeline[1].activeReadOnly, [
    'naru-minion-scout', 'naru-minion-investigate', 'naru-minion-debug', 'naru-minion-verify',
  ]);
  assert.deepEqual(refill.timeline[3].activeReadOnly, [
    'naru-minion-investigate', 'naru-minion-debug', 'naru-minion-verify', 'naru-minion-architect',
  ]);
  assert.deepEqual(refill.caps, {
    maxConcurrentImplement: 2,
    maxConcurrentReadOnly: 4,
    maxTotalNaruChildren: 6,
  });
  assert.equal(refill.expected.initialUsefulSlotsFilled, true);
  assert.equal(refill.expected.refilledWhilePeerActive, true);
  for (const action of ['duplicate settled lens', 'automatic xhigh escalation', 'automatic worktree']) {
    assert.ok(refill.prohibitedActions.includes(action));
  }
});

test('Protocol 3 corpus preserves off compatibility and distinct observe and enforce behavior', () => {
  assert.deepEqual(fixture.protocol3Cases.map((entry) => entry.id), [
    'protocol3-off-keeps-protocol2',
    'protocol3-observe-fails-open',
    'protocol3-enforce-fails-closed',
    'protocol3-correlated-quality-gates',
    'protocol3-honest-process-local-limit',
  ]);
  const off = protocol3CaseByID('protocol3-off-keeps-protocol2');
  assert.equal(off.schedulingProtocol, 2);
  assert.equal(off.expected.schedulerCalls, 0);
  assert.equal(off.expected.compatibilityPreserved, true);

  const observe = protocol3CaseByID('protocol3-observe-fails-open');
  assert.equal(observe.expected.taskProceeds, true);
  assert.equal(observe.expected.typedIncident, 'missing_marker');

  const enforce = protocol3CaseByID('protocol3-enforce-fails-closed');
  assert.equal(enforce.expected.taskProceeds, false);
  assert.equal(enforce.expected.protocol2Accepted, false);
});

test('Protocol 3 quality gates expose bounded correlation without overstating enforcement', () => {
  const gated = protocol3CaseByID('protocol3-correlated-quality-gates');
  assert.deepEqual(gated.artifactOrder, [
    'terminal', 'candidate', 'shard', 'verification-gate', 'judgment', 'judgment-gate', 'completion-gate',
  ]);
  assert.deepEqual(gated.budgets, {
    maxConcurrentWriters: 2,
    maxConcurrentReadOnly: 4,
    maxTotalChildren: 6,
    maxJudgePasses: 3,
  });
  assert.equal(gated.expected.allVerificationNeedsCovered, true);
  assert.equal(gated.expected.finalIdentityExact, true);

  const limited = protocol3CaseByID('protocol3-honest-process-local-limit');
  assert.deepEqual(limited.capability, {
    processLocal: true,
    synchronousTaskHook: true,
    durable: false,
    crossProcess: false,
    createsSessions: false,
    inspectsGit: false,
    provesReports: false,
    authoritativeBackgroundCompletion: false,
  });
  assert.equal(limited.expected.promptGatesStillRequired, true);
});

test('review posting corpus keeps schema v1 and covers authorization, freshness, and topology', () => {
  assert.equal(fixture.schemaVersion, 1);
  const requiredIDs = [
    'review-only-zero-post',
    'explicit-second-turn-post-it',
    'ambiguous-prior-target',
    'missing-target',
    'target-url-short-split-equivalence',
    'target-owner-repo-case-equivalence',
    'target-equivalent-duplicates',
    'target-same-number-different-repositories',
    'target-different-numbers',
    'target-bare-number-resolution-success',
    'target-bare-number-resolution-failure',
    'target-multiple-distinct-ambiguity',
    'stale-pasted-payload',
    'incomplete-degraded-refusal',
    'review-post-depth-topology',
    'mixed-delivery-then-fresh-post',
  ];
  assert.deepEqual(fixture.reviewPostingCases.map((entry) => entry.id), requiredIDs);
  for (const entry of fixture.reviewPostingCases) {
    assert.ok(Array.isArray(entry.prohibitedActions) && entry.prohibitedActions.length);
    assert.equal(typeof entry.expected.disposition, 'string');
  }
});

test('review-only and explicit second-turn posting remain distinct', () => {
  const dry = reviewPostingCaseByID('review-only-zero-post');
  assert.equal(dry.expected.canonicalReviewTasks, 1);
  assert.equal(dry.expected.postCalls, 0);
  assert.equal(dry.expected.implementationMinionCalls, 0);

  const post = reviewPostingCaseByID('explicit-second-turn-post-it');
  assert.deepEqual(post.targets.priorUser, ['owner/repo#42']);
  assert.equal(post.expected.resolvedTarget, 'owner/repo#42');
  assert.equal(post.expected.canonicalReviewTasksAfterPostRequest, 1);
  assert.equal(post.expected.postCalls, 1);
  assert.equal(post.expected.confirmationPrompts, 0);
  assert.equal(post.expected.payload, 'fresh-extracted-object-unchanged');
});

test('missing or ambiguous user-authored targets stop before review or posting', () => {
  for (const id of ['ambiguous-prior-target', 'missing-target']) {
    const entry = reviewPostingCaseByID(id);
    assert.equal(entry.expected.askForTarget, true, id);
    assert.equal(entry.expected.canonicalReviewTasks, 0, id);
    assert.equal(entry.expected.postCalls, 0, id);
  }
});

test('target syntax, case variants, and duplicate references normalize to one tuple', () => {
  for (const id of [
    'target-url-short-split-equivalence',
    'target-owner-repo-case-equivalence',
    'target-equivalent-duplicates',
  ]) {
    const entry = reviewPostingCaseByID(id);
    assert.deepEqual(entry.expected.canonicalTargets, [['owner', 'repo', 42]], id);
    assert.equal(entry.expected.distinctTargets, 1, id);
    assert.equal(entry.expected.postCalls, 1, id);
  }
  assert.equal(reviewPostingCaseByID('target-equivalent-duplicates').expected.deduplicatedReferences, 2);
});

test('different repositories or pull numbers remain distinct and ambiguous', () => {
  for (const id of [
    'target-same-number-different-repositories',
    'target-different-numbers',
    'target-multiple-distinct-ambiguity',
  ]) {
    const entry = reviewPostingCaseByID(id);
    assert.ok(entry.expected.distinctTargets > 1, id);
    assert.equal(entry.expected.askForTarget, true, id);
    assert.equal(entry.expected.postCalls, 0, id);
  }
  assert.deepEqual(
    reviewPostingCaseByID('target-same-number-different-repositories').expected.canonicalTargets,
    [['owner', 'alpha', 42], ['owner', 'beta', 42]],
  );
  assert.deepEqual(
    reviewPostingCaseByID('target-different-numbers').expected.canonicalTargets,
    [['owner', 'repo', 42], ['owner', 'repo', 43]],
  );
});

test('bare pull numbers resolve once from workspace context or fail closed', () => {
  const resolved = reviewPostingCaseByID('target-bare-number-resolution-success');
  assert.equal(resolved.workspaceRepository, 'owner/repo');
  assert.equal(resolved.expected.bareNumberResolutions, 1);
  assert.deepEqual(resolved.expected.canonicalTargets, [['owner', 'repo', 42]]);
  assert.equal(resolved.expected.postCalls, 1);

  const unresolved = reviewPostingCaseByID('target-bare-number-resolution-failure');
  assert.equal(unresolved.workspaceRepository, null);
  assert.equal(unresolved.expected.bareNumberResolutions, 1);
  assert.equal(unresolved.expected.askForTarget, true);
  assert.equal(unresolved.expected.postCalls, 0);
});

test('posting always uses a fresh result and rejects incomplete or degraded output', () => {
  const stale = reviewPostingCaseByID('stale-pasted-payload');
  assert.deepEqual(stale.payloadSources, ['pasted-json', 'prior-naru_review_result', 'assistant-text', 'tool-report']);
  assert.equal(stale.expected.canonicalReviewTasks, 1);
  assert.equal(stale.expected.reusedPayloads, 0);
  assert.equal(stale.expected.postPayload, 'fresh-extracted-object-unchanged');
  assert.equal(stale.expected.postCalls, 1);

  const refusal = reviewPostingCaseByID('incomplete-degraded-refusal');
  assert.deepEqual(refusal.expected.postCallsPerResult, [0, 0, 0]);
  assert.ok(refusal.freshReviewResults.some((result) => result.workflow.status === 'incomplete'));
  assert.ok(refusal.freshReviewResults.some((result) => result.workflow.degraded));
  assert.ok(refusal.freshReviewResults.some((result) => !result.snapshotComplete));
});

test('review posting topology requires configured two-level dispatch and mixed delivery posts last', () => {
  const topology = reviewPostingCaseByID('review-post-depth-topology');
  assert.equal(topology.expected.orchestratorReviewTarget, 'canonical-only');
  assert.equal(topology.expected.wrapperReviewTarget, 'generated-policy-selected');
  assert.equal(topology.expected.wrapperCommandSubtask, false);
  assert.deepEqual(topology.expected.rootOnlyTaskTargets, ['naru-orchestrator', 'naru-review-post']);
  assert.equal(topology.expected.maxTaskDepthAfterRoot, 2);
  assert.equal(topology.expected.minimumSubagentDepth, NARU_MINIMUM_SUBAGENT_DEPTH);
  assert.equal(topology.expected.openCodeDefaultCompatible, false);
  assert.equal(topology.expected.disposition, 'requires-compatible-depth-config');

  const mixed = reviewPostingCaseByID('mixed-delivery-then-fresh-post');
  assert.deepEqual(mixed.events.slice(-3), ['git-delivery', 'fresh-canonical-review', 'post-review']);
  assert.equal(mixed.expected.freshReviewAfterDelivery, true);
  assert.equal(mixed.expected.postIsFinalPhase, true);
  assert.equal(mixed.expected.postCalls, 1);
  assert.equal(mixed.expected.laterMutationInvalidatesReview, true);
});

test('subagent depth compatibility reflects the OpenCode default and current Naru topology', () => {
  assert.deepEqual(fixture.subagentDepthCompatibility, {
    openCodeVersion: '1.18.4',
    openCodeDefault: { value: 1, twoLevelWorkflowsCompatible: false },
    minimumRequired: 2,
    recommended: 2,
    configuredAboveMinimum: { compatible: true, recommendedByNaru: false },
    maximumCurrentNaruTopology: 2,
  });
  assert.equal(NARU_MINIMUM_SUBAGENT_DEPTH, 2);
  assert.equal(NARU_REQUIRED_SUBAGENT_DEPTH, fixture.subagentDepthCompatibility.maximumCurrentNaruTopology);
});

test('rolling cohorts refill immediately after a contained finish and never exceed two writers', () => {
  const rolling = schedulingCaseByID('scheduler-rolling-refill-timeline');
  assert.deepEqual(rolling.timeline.map(({ event, workItemId }) => [event, workItemId]), [
    ['start', 'a'],
    ['start', 'b'],
    ['finish-contained', 'a'],
    ['start', 'c'],
    ['finish-contained', 'b'],
    ['finish-contained', 'c'],
  ]);
  assert.equal(rolling.timeline[3].activePeer, 'b');
  assert.deepEqual(rolling.timeline[3].activeImplement, ['b', 'c']);
  assert.equal(rolling.expected.cStartsWhileBActive, true);
  assert.ok(rolling.timeline.every((event) => event.activeImplement.length <= 2));

  const capped = schedulingCaseByID('scheduler-cap-two-timeline');
  assert.equal(capped.timeline[2].event, 'defer-cap');
  assert.deepEqual(capped.timeline[2].activeImplement, ['a', 'b']);
  assert.deepEqual(capped.expected.deferredByCap, ['c']);
  assert.ok(capped.timeline.every((event) => event.activeImplement.length <= 2));
});

test('protocol 2 work items separate frozen reads from every mutable scheduling claim', () => {
  const contract = schedulingCaseByID('scheduler-work-item-contract');
  const itemFields = [
    'configurationClaims', 'dependencies', 'exclusions', 'frozenContractClaims', 'generatedArtifactClaims',
    'mutableContractClaims', 'mutableResourceClaims', 'ownedWriteScope', 'status', 'verificationNeeds', 'workItemId',
  ];
  for (const item of contract.workItems) assert.deepEqual(Object.keys(item).sort(), itemFields);
  assert.deepEqual(contract.workItems[0].frozenContractClaims, contract.workItems[1].frozenContractClaims);
  assert.equal(contract.expected.schedulingProtocol, 2);
  assert.equal(contract.expected.sharedFrozenContractConcurrent, true);
  assert.equal(contract.expected.mutableUncertaintySerializes, true);
});

test('active-peer conflicts defer refill until the remaining writer terminates', () => {
  const conflict = schedulingCaseByID('scheduler-active-peer-conflict-defers');
  assert.deepEqual(conflict.conflict.configurationClaims, ['tsconfig.json']);
  assert.equal(conflict.timeline[3].event, 'defer-active-peer-conflict');
  assert.equal(conflict.timeline[3].conflictsWith, 'b');
  assert.deepEqual(conflict.timeline[3].activeImplement, ['b']);
  assert.equal(conflict.timeline[5].event, 'start');
  assert.equal(conflict.timeline[5].workItemId, 'c');
  assert.equal(conflict.expected.cStartsAfterBFinishes, true);
  assert.equal(conflict.expected.userPromptRequired, false);
  assert.equal(conflict.expected.fallback, 'serialized-coordinator');
  assert.ok(conflict.prohibitedActions.includes('ask user about Weaver conflict'));
});

test('run and cohort baselines remain immutable while item dispatch observations stay provisional', () => {
  const lifecycle = schedulingCaseByID('scheduler-baseline-lifecycle');
  assert.equal(lifecycle.baselines.runBaseline.captureCount, 1);
  assert.equal(lifecycle.baselines.cohortBaseline.captureCount, 1);
  assert.equal(lifecycle.baselines.cohortBaseline.capturedOn, 'zero-to-one-writer');
  assert.deepEqual(lifecycle.baselines.itemDispatchBaselines[1].activePeerClaims, [
    { workItemId: 'a', ownedWriteScope: ['src/a.js'] },
  ]);
  assert.deepEqual(lifecycle.baselines.itemDispatchBaselines[2].terminalDependencyReports, ['report-a']);
  assert.equal(lifecycle.baselines.itemDispatchBaselines[2].provisionalWhilePeerWrites, true);
  assert.equal(lifecycle.expected.authoritativeDeltaBasis, 'cohortBaseline');
  assert.deepEqual(lifecycle.candidate.cohortDelta.changedPaths, lifecycle.candidate.ownershipUnion);
  assert.equal(lifecycle.expected.runBaselinePreserved, true);
});

test('terminal dependency reports unlock provisionally and faults freeze refill and invalidate descendants', () => {
  const provisional = schedulingCaseByID('scheduler-provisional-dependency-invalidation');
  assert.equal(provisional.timeline[2].event, 'finish-contained');
  assert.equal(provisional.timeline[3].event, 'start-provisional');
  assert.equal(provisional.timeline[4].event, 'external-change');
  assert.equal(provisional.timeline[5].event, 'freeze-refill-and-drain');
  assert.deepEqual(provisional.expected.provisionalItems, ['c', 'd']);
  assert.deepEqual(provisional.expected.invalidatedDescendants, ['c', 'd']);
  assert.equal(provisional.expected.reconciliation, 'serialized');
});

test('read-only work stealing is bounded, evidence-keyed, and invalidated by observed-path changes', () => {
  const stealing = schedulingCaseByID('scheduler-read-only-work-stealing');
  assert.equal(stealing.active.implement.length, 2);
  assert.equal(stealing.active.readOnly.length, 4);
  assert.equal(stealing.active.totalNaruChildren, 6);
  assert.deepEqual(Object.keys(stealing.evidence).sort(), [
    'basisIdentity', 'evidenceId', 'invalidationKeys', 'observedPaths', 'validityKeys',
  ]);
  assert.equal(stealing.expected.maxConcurrentReadOnly, 4);
  assert.equal(stealing.expected.maxTotalNaruChildren, 6);
  assert.equal(stealing.expected.changedObservedPathInvalidatesEvidence, true);
});

test('TodoWrite exposes one phase summary and completes only at the unchanged final checkpoint', () => {
  const todo = schedulingCaseByID('scheduler-todo-phase-semantics');
  assert.equal(todo.todo.inProgressCount, 1);
  assert.equal(todo.todo.level, 'phase');
  assert.deepEqual(Object.keys(todo.todo.contentSets).sort(), ['active', 'blocked', 'provisional', 'ready']);
  assert.deepEqual(todo.todo.completedBeforeFinalCheckpoint, []);
  assert.equal(todo.expected.completionPoint, 'unchanged-final-checkpoint');
});

test('quiescent verification uses at most two exact-candidate shards with disjoint mutable resources', () => {
  const verification = schedulingCaseByID('scheduler-quiescent-two-shard-verification');
  assert.deepEqual(verification.candidate.activeImplement, []);
  assert.equal(verification.shards.length, 2);
  assert.ok(verification.shards.every((shard) => shard.candidateIdentity === verification.candidate.candidateIdentity));
  assert.deepEqual(verification.shards[0].observedPaths.slice(-1), verification.shards[1].observedPaths.slice(-1));
  assert.notDeepEqual(verification.shards[0].mutableResourceClaims, verification.shards[1].mutableResourceClaims);
  assert.equal(verification.expected.maxConcurrentVerify, 2);
  assert.equal(verification.expected.completeShardManifestRequired, true);
  assert.equal(verification.expected.reportsValidOnlyForExactCandidate, true);
});

test('final identity equality gates todos, serialized remediation and delivery, and worktree behavior', () => {
  const equality = schedulingCaseByID('scheduler-final-identity-equality');
  assert.equal(equality.checkpoints[0].result, 'complete');
  assert.equal(equality.checkpoints[0].candidateIdentity, equality.checkpoints[0].finalIdentity);
  assert.equal(equality.checkpoints[0].candidateState, equality.checkpoints[0].finalState);
  assert.equal(equality.checkpoints[1].result, 'invalidate');
  assert.notEqual(equality.checkpoints[1].candidateIdentity, equality.checkpoints[1].finalIdentity);
  assert.deepEqual(equality.expected.invalidatedOnStatusChange, ['verification-shards', 'judgment']);

  const serialized = schedulingCaseByID('scheduler-remediation-delivery-serialized');
  assert.equal(serialized.expected.remediationConcurrency, 1);
  assert.equal(serialized.expected.deliveryConcurrency, 1);
  assert.equal(serialized.expected.postingConcurrency, 1);
  assert.equal(serialized.expected.maxJudges, 3);
  assert.deepEqual(serialized.phases.slice(-3), ['rejudgment', 'serialized-delivery', 'serialized-review-posting']);

  const worktrees = schedulingCaseByID('scheduler-automatic-isolated-worktrees');
  assert.equal(worktrees.expected.cleanRepositoryWriterLimit, 10);
  assert.equal(worktrees.expected.defaultConcurrentWriters, 6);
  assert.equal(worktrees.expected.writersPerWorktree, 1);
  assert.equal(worktrees.expected.dirtyRepositoryFallback, 'shared-two-writer');
  assert.equal(worktrees.expected.userPromptRequired, false);
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
    const rootTargets = NARU_DISPATCH_GRAPH[entry.rootAgent] ?? [];
    const targets = entry.workflow === 'implementation'
      ? rootTargets.filter((target) => target.startsWith('naru-minion-'))
      : rootTargets;
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
