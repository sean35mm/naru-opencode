import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  adaptProtocol2Run,
  DEFAULT_SCHEDULER_BUDGETS,
  validateArtifactV1,
  validateAdmissionTokenV1,
  validateCandidateArtifactV1,
  validateEvidenceArtifactV1,
  validateGateArtifactV1,
  validateJudgmentArtifactV1,
  validateRunManifestV1,
  validateShardArtifactV1,
  validateTerminalArtifactV1,
  validateTransitionArtifactV1,
  validateTransitionTokenV1,
  validateWorkItemV1,
} from '../tools/naru-lib/scheduler-protocol.mjs';
import {
  DEFAULT_RUNTIME_CONFIG,
  DEFAULT_SCHEDULER_CONFIG,
  loadRuntimeConfigFile,
  parseRuntimeConfig,
  parseSchedulerConfig,
} from '../tools/naru-lib/scheduler-config.mjs';
import {
  admissionDecision,
  admitWorkItem,
  budgetUsage,
  consumeJudgeBudget,
  createSchedulerState,
  findWorkItemConflicts,
  getReadyWorkItems,
  invalidateDescendants,
  reduceSchedulerState,
  scopeCoversPath,
  transitionWorkItem,
  unfreezeScheduler,
} from '../tools/naru-lib/scheduler-state.mjs';

const fixturePath = new URL('./fixtures/scheduler-protocol3.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));

function copy(value) {
  return structuredClone(value);
}

function admissionFor(workItemId, expectedRevision, activePeerIds = [], overrides = {}) {
  return {
    schemaVersion: 1,
    tokenType: 'admission',
    tokenId: `admission-${workItemId}-${expectedRevision}`,
    runId: fixture.manifest.runId,
    workItemId,
    expectedRevision,
    lane: 'writer',
    activePeerIds,
    issuedAt: 100,
    expiresAt: 200,
    ...overrides,
  };
}

function transitionFor(workItemId, admissionTokenId, expectedRevision, toStatus) {
  const token = {
    schemaVersion: 1,
    tokenType: 'transition',
    tokenId: `transition-${workItemId}-${expectedRevision}-${toStatus}`,
    admissionTokenId,
    runId: fixture.manifest.runId,
    workItemId,
    expectedRevision,
    fromStatus: 'active',
    toStatus,
    issuedAt: 100,
    expiresAt: 200,
  };
  const artifact = {
    schemaVersion: 1,
    artifactType: 'transition',
    artifactId: `artifact-${workItemId}-${expectedRevision}-${toStatus}`,
    transitionTokenId: token.tokenId,
    runId: token.runId,
    workItemId,
    expectedRevision,
    fromStatus: token.fromStatus,
    toStatus,
    changedPaths: [`src/${workItemId}/index.mjs`],
  };
  return { token, artifact };
}

test('Protocol 3 fixture validates without mutating its strict schemas', () => {
  const before = copy(fixture);
  const manifest = validateRunManifestV1(fixture.manifest);
  assert.deepEqual(manifest, fixture.manifest);
  assert.deepEqual(validateWorkItemV1(fixture.manifest.workItems[0]), fixture.manifest.workItems[0]);
  assert.deepEqual(validateAdmissionTokenV1(fixture.admissionToken), fixture.admissionToken);
  assert.deepEqual(validateTransitionTokenV1(fixture.transitionToken), fixture.transitionToken);
  assert.deepEqual(validateTransitionArtifactV1(fixture.transitionArtifact), fixture.transitionArtifact);
  assert.deepEqual(fixture, before);
});

test('manifest validation rejects unknown fields, unsafe IDs, duplicates, size, dependencies, and cycles', () => {
  const unknown = copy(fixture.manifest);
  unknown.extra = true;
  assert.throws(() => validateRunManifestV1(unknown), /unknown fields: extra/);

  const badId = copy(fixture.manifest);
  badId.workItems[0].workItemId = '../a';
  assert.throws(() => validateRunManifestV1(badId), /scheduler ID/);

  const duplicate = copy(fixture.manifest);
  duplicate.workItems[1].workItemId = 'a';
  duplicate.workItems[1].dependencies = [];
  assert.throws(() => validateRunManifestV1(duplicate), /duplicate workItemId/);

  const unknownDependency = copy(fixture.manifest);
  unknownDependency.workItems[1].dependencies = ['missing'];
  assert.throws(() => validateRunManifestV1(unknownDependency), /unknown dependency/);

  const cycle = copy(fixture.manifest);
  cycle.workItems[0].dependencies = ['b'];
  assert.throws(() => validateRunManifestV1(cycle), /dependency cycle/);

  assert.throws(() => validateRunManifestV1(fixture.manifest, { maxBytes: 1024 }), /exceeds 1024 bytes/);
  const duplicateClaim = copy(fixture.manifest.workItems[0]);
  duplicateClaim.mutableContractClaims.push('contract-a');
  assert.throws(() => validateWorkItemV1(duplicateClaim), /duplicate value/);
});

test('token and artifact validators reject stale shapes and unsafe values', () => {
  const token = copy(fixture.admissionToken);
  token.unknown = true;
  assert.throws(() => validateAdmissionTokenV1(token), /unknown fields/);
  const expiredShape = { ...fixture.admissionToken, expiresAt: fixture.admissionToken.issuedAt };
  assert.throws(() => validateAdmissionTokenV1(expiredShape), /expiresAt/);
  assert.throws(
    () => validateTransitionTokenV1({ ...fixture.transitionToken, toStatus: 'complete' }),
    /toStatus/,
  );
  assert.throws(
    () => validateTransitionArtifactV1({ ...fixture.transitionArtifact, changedPaths: ['../outside'] }),
    /changedPaths\[0\]/,
  );
});

test('quality artifact validators are typed, strict, digest-bound, and report-correlated', () => {
  const digest = 'a'.repeat(64);
  const evidence = {
    schemaVersion: 1,
    artifactType: 'evidence',
    artifactId: 'evidence-a',
    runId: fixture.manifest.runId,
    expectedRevision: 7,
    reportId: 'evidence-report-a',
    reportAgent: 'naru-minion-verify',
    admissionTokenId: 'admission-evidence-a',
    evidenceId: 'preparation-evidence-a',
    workItemIds: ['a'],
    basisIdentity: 'dispatch-a',
    observedPaths: ['src/a/index.mjs'],
    validityKeys: ['src-a-unchanged'],
    invalidationKeys: ['src-a-changed'],
  };
  assert.deepEqual(validateEvidenceArtifactV1(evidence), evidence);
  assert.deepEqual(validateArtifactV1(evidence), evidence);
  const terminal = {
    schemaVersion: 1,
    artifactType: 'terminal',
    artifactId: 'terminal-a',
    runId: fixture.manifest.runId,
    expectedRevision: 8,
    cohortId: 'cohort-a',
    workItemId: 'a',
    reportId: 'report-a',
    reportAgent: 'naru-minion-implement',
    admissionTokenId: 'admission-a',
    outcome: 'terminal-contained',
    changedPaths: ['src/a/index.mjs'],
    dependencyReportIds: [],
  };
  assert.deepEqual(validateTerminalArtifactV1(terminal), terminal);
  assert.deepEqual(validateArtifactV1(terminal), terminal);
  assert.throws(
    () => validateTerminalArtifactV1({ ...terminal, reportAgent: 'naru-minion-verify' }),
    /reportAgent/,
  );

  const candidate = {
    schemaVersion: 1,
    artifactType: 'candidate',
    artifactId: 'candidate-a',
    runId: fixture.manifest.runId,
    expectedRevision: 9,
    cohortId: 'cohort-a',
    candidateIdentity: 'candidate-identity-a',
    candidateStateDigest: digest,
    workItemIds: ['a'],
    terminalArtifactIds: ['terminal-a'],
    changedPaths: ['src/a/index.mjs'],
  };
  assert.deepEqual(validateCandidateArtifactV1(candidate), candidate);
  assert.throws(() => validateCandidateArtifactV1({ ...candidate, candidateStateDigest: 'opaque' }), /SHA-256/);

  const shard = {
    schemaVersion: 1,
    artifactType: 'shard',
    artifactId: 'shard-a',
    runId: fixture.manifest.runId,
    expectedRevision: 10,
    candidateArtifactId: 'candidate-a',
    candidateIdentity: 'candidate-identity-a',
    candidateStateDigest: digest,
    shardId: 'verify-a',
    reportId: 'verify-report-a',
    reportAgent: 'naru-minion-verify',
    admissionTokenId: 'admission-verify-a',
    workItemIds: ['a'],
    coveredChecks: ['test-a'],
    observedPaths: ['src/a/index.mjs'],
    mutableResourceClaims: ['test-cache-a'],
    candidateValidity: 'exact-match',
    outcome: 'passed',
  };
  assert.deepEqual(validateShardArtifactV1(shard), shard);

  const judgment = {
    schemaVersion: 1,
    artifactType: 'judgment',
    artifactId: 'judgment-a',
    runId: fixture.manifest.runId,
    expectedRevision: 11,
    candidateArtifactId: 'candidate-a',
    candidateIdentity: 'candidate-identity-a',
    candidateStateDigest: digest,
    reportId: 'judge-report-a',
    reportAgent: 'naru-minion-judge',
    admissionTokenId: 'admission-judge-a',
    shardArtifactIds: ['shard-a'],
    verdict: 'ready',
    confidence: 'high',
    judgePass: 1,
  };
  assert.deepEqual(validateJudgmentArtifactV1(judgment), judgment);

  const gate = {
    schemaVersion: 1,
    artifactType: 'gate',
    artifactId: 'gate-a',
    runId: fixture.manifest.runId,
    expectedRevision: 12,
    gateType: 'completion',
    candidateArtifactId: 'candidate-a',
    candidateIdentity: 'candidate-identity-a',
    candidateStateDigest: digest,
    judgmentArtifactId: 'judgment-a',
    observedIdentity: 'candidate-identity-a',
    observedStateDigest: digest,
    status: 'passed',
    reasonCodes: [],
  };
  assert.deepEqual(validateGateArtifactV1(gate), gate);
  assert.throws(() => validateArtifactV1({ ...gate, unexpected: true }), /unknown fields/);
});

test('Protocol 2 adapter is deterministic for off and observe and refuses enforce mode', () => {
  const observed = adaptProtocol2Run(fixture.legacyRun, { mode: 'observe' });
  const off = adaptProtocol2Run(fixture.legacyRun, { mode: 'off' });
  assert.deepEqual(observed, off);
  assert.equal(observed.schedulingProtocol, 3);
  assert.equal(observed.schemaVersion, 1);
  assert.equal(observed.runId, fixture.legacyRun.cohortId);
  assert.deepEqual(observed.budgets, DEFAULT_SCHEDULER_BUDGETS);
  assert.throws(() => adaptProtocol2Run(fixture.legacyRun, { mode: 'enforce' }), /cannot be adapted/);
  assert.throws(
    () => adaptProtocol2Run({ ...fixture.legacyRun, unexpected: true }),
    /unknown fields/,
  );
});

test('runtime config is off by default, strict, bounded, and explicitly loadable', async () => {
  assert.deepEqual(parseSchedulerConfig(), DEFAULT_SCHEDULER_CONFIG);
  assert.deepEqual(parseRuntimeConfig(), DEFAULT_RUNTIME_CONFIG);
  assert.equal(parseSchedulerConfig({ mode: 'observe' }).mode, 'observe');
  assert.equal(parseSchedulerConfig({ mode: 'enforce' }).legacyProtocol2, 'reject');
  assert.throws(() => parseSchedulerConfig({ mode: 'enabled' }), /must be one of off, observe, enforce/);
  assert.throws(() => parseSchedulerConfig({ extra: true }), /unknown fields/);
  assert.throws(() => parseSchedulerConfig({ maxConcurrentWriters: 11 }), /from 1 to 10/);
  assert.throws(() => parseSchedulerConfig({ maxConcurrentReadOnly: 5 }), /from 0 to 4/);
  assert.throws(() => parseSchedulerConfig({ maxTotalChildren: 15 }), /from 1 to 14/);
  assert.equal(parseRuntimeConfig({ implementation: { maxConcurrentWriters: 10 } }).implementation.maxConcurrentWriters, 10);
  assert.throws(
    () => parseRuntimeConfig({ implementation: { maxConcurrentWriters: 11 } }),
    /implementation.maxConcurrentWriters must be an integer from 1 to 10/,
  );
  assert.throws(
    () => parseRuntimeConfig({ implementation: { cleanWorkspaceRequired: false } }),
    /cleanWorkspaceRequired must be true/,
  );
  assert.throws(
    () => parseSchedulerConfig({ mode: 'enforce', legacyProtocol2: 'observe' }),
    /must reject Protocol 2/,
  );

  const examplePath = fileURLToPath(new URL('../naru-runtime.example.json', import.meta.url));
  const loaded = await loadRuntimeConfigFile(examplePath);
  assert.deepEqual(loaded, parseRuntimeConfig(JSON.parse(await readFile(examplePath, 'utf8'))));
  assert.equal(loaded.scheduler.mode, 'off');
});

test('state creation and admission are deterministic, CAS-protected, and budgeted', () => {
  const first = createSchedulerState(fixture.manifest);
  const second = createSchedulerState(copy(fixture.manifest));
  assert.deepEqual(first, second);
  assert.deepEqual(getReadyWorkItems(first), ['a', 'c']);
  assert.deepEqual(budgetUsage(first), { writers: 0, readOnly: 0, totalChildren: 0, judgePasses: 0 });

  const activeA = admitWorkItem(first, fixture.admissionToken, { now: 150 });
  assert.equal(activeA.revision, 8);
  assert.equal(activeA.workItems[0].status, 'active');
  assert.deepEqual(budgetUsage(activeA), { writers: 1, readOnly: 0, totalChildren: 1, judgePasses: 0 });
  assert.throws(() => admitWorkItem(activeA, fixture.admissionToken, { now: 150 }), /CAS mismatch/);
  assert.equal(admissionDecision(first, fixture.admissionToken, { now: 200 }).reason, 'admission token is not currently valid');

  const stalePeers = admissionFor('c', 8);
  assert.equal(admissionDecision(activeA, stalePeers, { now: 150 }).reason, 'active peer snapshot is stale');
  const activeC = admitWorkItem(activeA, admissionFor('c', 8, ['a']), { now: 150 });
  assert.deepEqual(budgetUsage(activeC), { writers: 2, readOnly: 0, totalChildren: 2, judgePasses: 0 });

  const oneWriterManifest = copy(fixture.manifest);
  oneWriterManifest.budgets.maxConcurrentWriters = 1;
  const oneWriter = admitWorkItem(createSchedulerState(oneWriterManifest), fixture.admissionToken, { now: 150 });
  assert.equal(
    admissionDecision(oneWriter, admissionFor('c', 8, ['a']), { now: 150 }).reason,
    'writer budget exhausted',
  );
});

test('isolated scheduler budgets admit ten disjoint writers and refuse an eleventh', () => {
  const workItems = Array.from({ length: 11 }, (_, index) => ({
    workItemId: `isolated-${index + 1}`,
    dependencies: [],
    ownedWriteScope: [`src/isolated-${index + 1}.js`],
    frozenContractClaims: ['api-v1'],
    mutableContractClaims: [`contract-${index + 1}`],
    generatedArtifactClaims: [],
    configurationClaims: [],
    mutableResourceClaims: [`resource-${index + 1}`],
    exclusions: [],
    verificationNeeds: [`check-${index + 1}`],
    status: 'ready',
  }));
  const manifest = validateRunManifestV1({
    ...fixture.manifest,
    budgets: {
      maxConcurrentWriters: 10,
      maxConcurrentReadOnly: 4,
      maxTotalChildren: 14,
      maxJudgePasses: 3,
    },
    workItems,
  });
  let state = createSchedulerState(manifest);
  for (const item of workItems.slice(0, 10)) {
    const peers = state.activeAdmissions.map((entry) => entry.workItemId).sort();
    state = admitWorkItem(state, admissionFor(item.workItemId, state.revision, peers), { now: 150 });
  }
  assert.equal(budgetUsage(state).writers, 10);
  const peers = state.activeAdmissions.map((entry) => entry.workItemId).sort();
  const decision = admissionDecision(state, admissionFor('isolated-11', state.revision, peers), { now: 150 });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'writer budget exhausted');
});

test('claim and path conflicts are conservative while frozen contracts may overlap', () => {
  const a = fixture.manifest.workItems[0];
  const c = copy(fixture.manifest.workItems[2]);
  assert.deepEqual(findWorkItemConflicts(a, c), []);
  c.mutableContractClaims = ['contract-a'];
  assert.deepEqual(findWorkItemConflicts(a, c), [
    { field: 'mutableContractClaims', left: 'contract-a', right: 'contract-a' },
  ]);
  c.mutableContractClaims = ['contract-c'];
  c.ownedWriteScope = ['src/a/generated/**'];
  assert.equal(findWorkItemConflicts(a, c)[0].field, 'ownedWriteScope');
  assert.equal(scopeCoversPath('src/a/**', 'src/a/index.mjs'), true);
  assert.equal(scopeCoversPath('src/a/**', 'src/b/index.mjs'), false);
});

test('contained terminal transitions unlock dependencies provisionally and reject drift', () => {
  const initial = createSchedulerState(fixture.manifest);
  const active = admitWorkItem(initial, fixture.admissionToken, { now: 150 });
  const completed = transitionWorkItem(active, fixture.transitionToken, fixture.transitionArtifact);
  assert.equal(completed.revision, 9);
  assert.equal(completed.workItems.find((item) => item.workItemId === 'a').status, 'terminal-contained');
  const b = completed.workItems.find((item) => item.workItemId === 'b');
  assert.equal(b.status, 'ready');
  assert.equal(b.provisional, true);
  assert.deepEqual(getReadyWorkItems(completed), ['b', 'c']);

  assert.throws(
    () => transitionWorkItem(active, fixture.transitionToken, {
      ...fixture.transitionArtifact,
      changedPaths: ['src/outside.mjs'],
    }),
    /outside a ownership/,
  );
  assert.throws(
    () => transitionWorkItem(completed, fixture.transitionToken, fixture.transitionArtifact),
    /CAS mismatch/,
  );
});

test('faults freeze refill and recursively invalidate provisional descendants', () => {
  const active = admitWorkItem(createSchedulerState(fixture.manifest), fixture.admissionToken, { now: 150 });
  const { token, artifact } = transitionFor('a', fixture.admissionToken.tokenId, 8, 'failed');
  const failed = transitionWorkItem(active, token, artifact);
  assert.equal(failed.frozen, true);
  assert.equal(failed.freezeReason, 'a:failed');
  assert.equal(failed.workItems.find((item) => item.workItemId === 'b').status, 'invalidated');
  assert.equal(admissionDecision(failed, admissionFor('c', 9), { now: 150 }).reason, 'scheduler is frozen');

  const directlyInvalidated = invalidateDescendants(createSchedulerState(fixture.manifest), 'a', 'external-change', 7);
  assert.equal(directlyInvalidated.revision, 8);
  assert.equal(directlyInvalidated.workItems.find((item) => item.workItemId === 'b').status, 'invalidated');
});

test('reducer is pure and quiescent judge and unfreeze operations use CAS budgets', () => {
  const state = createSchedulerState(fixture.manifest);
  const before = copy(state);
  const active = reduceSchedulerState(state, { type: 'admit', token: fixture.admissionToken, now: 150 });
  assert.deepEqual(state, before);
  assert.equal(active.revision, 8);
  assert.throws(() => consumeJudgeBudget(active, { expectedRevision: 8 }), /only at quiescence/);

  const frozen = invalidateDescendants(state, 'a', 'reconcile', 7);
  const unfrozen = unfreezeScheduler(frozen, { expectedRevision: 8, reason: 'reconciled' });
  assert.equal(unfrozen.frozen, false);
  const judged = consumeJudgeBudget(unfrozen, { expectedRevision: 9 });
  assert.equal(judged.judgePasses, 1);
  assert.equal(judged.revision, 10);
  assert.throws(() => consumeJudgeBudget(judged, { expectedRevision: 9 }), /CAS mismatch/);
  assert.throws(() => reduceSchedulerState(state, { type: 'unknown' }), /unknown scheduler event/);
});
