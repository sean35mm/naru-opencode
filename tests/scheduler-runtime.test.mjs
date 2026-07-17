import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import schedulerTool from '../tools/naru-scheduler.js';
import { NaruSchedulerPlugin } from '../plugins/naru-scheduler.js';
import {
  consumeAdmission,
  getSchedulerRuntimeRegistry,
  probeSchedulerRuntime,
  reserveAdmission,
  resetSchedulerRuntimeForTests,
} from '../tools/naru-lib/scheduler-token.mjs';
import {
  appendSchedulerJournal,
  schedulerJournalSnapshot,
  SCHEDULER_JOURNAL_LIMITS,
} from '../tools/naru-lib/scheduler-journal.mjs';
import { schedulerTelemetrySnapshot } from '../tools/naru-lib/scheduler-telemetry.mjs';

const ROOT = 'root-session';
const TARGET = 'naru-minion-implement';
const CONTEXT = {
  sessionID: ROOT,
  agent: 'naru-orchestrator',
  directory: '/workspace/project',
  now: () => 1_000,
};

function workItem(overrides = {}) {
  return {
    workItemId: 'writer-a',
    dependencies: [],
    ownedWriteScope: ['src/a.mjs'],
    frozenContractClaims: ['protocol'],
    mutableContractClaims: ['runtime'],
    generatedArtifactClaims: [],
    configurationClaims: [],
    mutableResourceClaims: [],
    exclusions: ['outside'],
    verificationNeeds: ['targeted'],
    status: 'ready',
    ...overrides,
  };
}

function claims(item = workItem()) {
  return {
    ownedWriteScope: item.ownedWriteScope,
    frozenContractClaims: item.frozenContractClaims,
    mutableContractClaims: item.mutableContractClaims,
    generatedArtifactClaims: item.generatedArtifactClaims,
    configurationClaims: item.configurationClaims,
    mutableResourceClaims: item.mutableResourceClaims,
  };
}

function directToken(overrides = {}) {
  return {
    schemaVersion: 1,
    tokenType: 'admission',
    tokenId: 'admission-direct',
    runId: 'run-direct',
    workItemId: 'writer-a',
    expectedRevision: 0,
    lane: 'writer',
    activePeerIds: [],
    issuedAt: 100,
    expiresAt: 200,
    ...overrides,
  };
}

async function invoke(input, mode = 'observe', overrides = {}) {
  const raw = await schedulerTool.execute(
    { input },
    {
      ...CONTEXT,
      schedulerConfig: { mode, legacyProtocol2: mode === 'enforce' ? 'reject' : 'observe' },
      ...overrides,
    },
  );
  return JSON.parse(raw);
}

async function prepare(mode = 'observe') {
  const created = await invoke({
    operation: 'create_run',
    runId: 'run-a',
    schedulingProtocol: 3,
  }, mode);
  assert.equal(created.ok, true);
  const declared = await invoke({
    operation: 'declare_items',
    runId: 'run-a',
    expectedRevision: 0,
    workItems: [workItem()],
  }, mode);
  assert.equal(declared.ok, true);
  return invoke({
    operation: 'issue_admission',
    runId: 'run-a',
    workItemId: 'writer-a',
    expectedRevision: 0,
    lane: 'writer',
    target: TARGET,
  }, mode);
}

test.beforeEach(() => resetSchedulerRuntimeForTests());

test('off mode reports process-local capability without retaining runs or journal entries', async () => {
  const result = await invoke({
    operation: 'create_run',
    runId: 'off-run',
    schedulingProtocol: 3,
  }, 'off');
  const registry = getSchedulerRuntimeRegistry();
  assert.equal(result.ok, true);
  assert.equal(result.data.mode, 'off');
  assert.deepEqual(result.data.capability, probeSchedulerRuntime({ registry }));
  assert.equal(result.data.capability.durable, false);
  assert.equal(result.data.capability.crossProcess, false);
  assert.equal(registry.roots.size, 0);
  assert.equal(registry.journals.size, 0);
  assert.equal(schedulerTelemetrySnapshot(ROOT, { registry }), null);

  const legacy = await invoke({
    operation: 'create_run',
    runId: 'off-legacy-run',
    schedulingProtocol: 2,
  }, 'off');
  assert.equal(legacy.ok, true);
  assert.equal(legacy.data.mode, 'off');
  assert.equal(registry.roots.size, 0);
});

test('observe mode fails open while enforce denies missing and replayed admission markers', async () => {
  let plugin = await NaruSchedulerPlugin({}, { schedulerConfig: { mode: 'observe', legacyProtocol2: 'observe' }, now: () => 1_001 });
  assert.doesNotThrow(() => plugin['tool.execute.before'](
    { tool: 'Task', sessionID: ROOT, callID: 'call-missing-observe' },
    { args: { subagent_type: TARGET, description: 'ordinary task' } },
  ));
  assert.equal(schedulerJournalSnapshot(ROOT).some((entry) => entry.metadata.code === 'missing_marker'), true);

  resetSchedulerRuntimeForTests();
  plugin = await NaruSchedulerPlugin({}, { schedulerConfig: { mode: 'enforce' }, now: () => 1_001 });
  assert.throws(() => plugin['tool.execute.before'](
    { tool: 'task', sessionID: ROOT, callID: 'call-missing-enforce' },
    { args: { subagent_type: TARGET, description: 'ordinary task' } },
  ), /admission refused/);

  const issued = await prepare('enforce');
  assert.equal(issued.ok, true);
  assert.match(issued.data.marker, /^naru-admit:v1:writer:admission-/);
  plugin = await NaruSchedulerPlugin({}, { schedulerConfig: { mode: 'enforce' }, now: () => 1_001 });
  const args = { subagent_type: TARGET, description: issued.data.marker };
  plugin['tool.execute.before']({ tool: 'task', sessionID: ROOT, callID: 'call-one' }, { args });
  assert.throws(
    () => plugin['tool.execute.before']({ tool: 'task', sessionID: ROOT, callID: 'call-two' }, { args }),
    /already consumed/,
  );
});

test('duplicate plugin execution is callID-idempotent and admits only once', async () => {
  const issued = await prepare();
  const options = { schedulerConfig: { mode: 'observe', legacyProtocol2: 'observe' }, now: () => 1_001 };
  const first = await NaruSchedulerPlugin({}, options);
  const second = await NaruSchedulerPlugin({}, options);
  const input = { tool: 'task', sessionID: ROOT, callID: 'same-call' };
  const output = { args: { subagent_type: TARGET, description: issued.data.marker } };
  first['tool.execute.before'](input, output);
  second['tool.execute.before'](input, output);
  const registry = getSchedulerRuntimeRegistry();
  assert.equal(registry.roots.get(ROOT).state.activeAdmissions.length, 1);
  assert.equal(schedulerJournalSnapshot(ROOT).filter((entry) => entry.type === 'task.admitted').length, 1);
});

test('plugin admission is reflected by bounded process-local telemetry', async () => {
  const issued = await prepare();
  let telemetry = schedulerTelemetrySnapshot(ROOT, { now: 1_001 });
  assert.equal(telemetry.mode, 'observe');
  assert.deepEqual(telemetry.counts, {
    live: 0,
    pending: 1,
    blocked: 0,
    terminal: 0,
    failed: 0,
    invalidated: 0,
    total: 1,
  });

  const plugin = await NaruSchedulerPlugin({}, {
    schedulerConfig: { mode: 'observe', legacyProtocol2: 'observe' },
    now: () => 1_001,
  });
  plugin['tool.execute.before'](
    { tool: 'task', sessionID: ROOT, callID: 'telemetry-call' },
    { args: { subagent_type: TARGET, description: issued.data.marker } },
  );
  telemetry = schedulerTelemetrySnapshot(ROOT, { now: 1_001 });
  assert.equal(telemetry.scope, 'process-local');
  assert.equal(telemetry.counts.live, 1);
  assert.equal(telemetry.counts.pending, 0);
  assert.equal(telemetry.budget.usage.writers, 1);
  assert.deepEqual(telemetry.actors, [{ agent: TARGET, active: 1, artifacts: 0 }]);
});

test('successful admission stores only canonical claims from the validated work item', async () => {
  const issued = await prepare();
  assert.equal(issued.ok, true);
  const record = getSchedulerRuntimeRegistry().admissions.get(issued.data.token.tokenId);
  assert.deepEqual(record.claims, claims());
  assert.deepEqual(Object.keys(record.claims).sort(), Object.keys(claims()).sort());
});

test('read-only evidence admission preserves work-item readiness and releases on correlated artifact', async () => {
  assert.equal((await invoke({
    operation: 'create_run',
    runId: 'evidence-run',
    schedulingProtocol: 3,
  })).ok, true);
  assert.equal((await invoke({
    operation: 'declare_items',
    runId: 'evidence-run',
    expectedRevision: 0,
    workItems: [workItem()],
  })).ok, true);
  const issued = await invoke({
    operation: 'issue_admission',
    runId: 'evidence-run',
    workItemId: 'writer-a',
    expectedRevision: 0,
    lane: 'read-only',
    target: 'naru-minion-verify',
  });
  const plugin = await NaruSchedulerPlugin({}, {
    schedulerConfig: { mode: 'observe', legacyProtocol2: 'observe' },
    now: () => 1_001,
  });
  plugin['tool.execute.before'](
    { tool: 'task', sessionID: ROOT, callID: 'evidence-call' },
    { args: { subagent_type: 'naru-minion-verify', description: issued.data.marker } },
  );
  let snapshot = await invoke({ operation: 'snapshot', runId: 'evidence-run' });
  assert.equal(snapshot.data.run.state.workItems[0].status, 'ready');
  assert.equal(snapshot.data.run.state.activeAdmissions[0].lane, 'read-only');

  const appended = await invoke({
    operation: 'append_artifact',
    runId: 'evidence-run',
    artifact: {
      schemaVersion: 1,
      artifactType: 'evidence',
      artifactId: 'evidence-artifact-a',
      runId: 'evidence-run',
      expectedRevision: 1,
      reportId: 'evidence-report-a',
      reportAgent: 'naru-minion-verify',
      admissionTokenId: issued.data.token.tokenId,
      evidenceId: 'evidence-a',
      workItemIds: ['writer-a'],
      basisIdentity: 'evidence-basis-a',
      observedPaths: ['src/a.mjs'],
      validityKeys: ['src-a-unchanged'],
      invalidationKeys: ['src-a-changed'],
    },
  });
  assert.equal(appended.ok, true);
  snapshot = await invoke({ operation: 'snapshot', runId: 'evidence-run' });
  assert.equal(snapshot.data.run.state.revision, 2);
  assert.equal(snapshot.data.run.state.workItems[0].status, 'ready');
  assert.deepEqual(snapshot.data.run.state.activeAdmissions, []);
});

test('admission binding rejects expiry, target, root, and claim mismatches and permits one idempotent call', () => {
  const token = directToken();
  getSchedulerRuntimeRegistry().roots.set(ROOT, { runId: token.runId });
  reserveAdmission({
    token,
    rootSessionID: ROOT,
    parentSessionID: ROOT,
    target: TARGET,
    mode: 'observe',
    claims: claims(),
    nonce: 'nonce-direct',
  });
  const consume = (overrides = {}) => consumeAdmission({
    tokenId: token.tokenId,
    rootSessionID: ROOT,
    parentSessionID: ROOT,
    target: TARGET,
    mode: 'observe',
    lane: 'writer',
    claims: claims(),
    version: 1,
    callID: 'direct-call',
    now: 150,
    ...overrides,
  });
  assert.equal(consume({ now: 200, callID: 'expired-call' }).code, 'expired_token');
  assert.equal(consume({ target: 'naru-minion-debug', callID: 'target-call' }).code, 'target_mismatch');
  assert.equal(consume({ rootSessionID: 'other-root', callID: 'root-call' }).code, 'root_mismatch');
  assert.equal(consume({ claims: { ...claims(), mutableContractClaims: ['changed'] }, callID: 'claims-call' }).code, 'claims_mismatch');
  assert.equal(consume().allowed, true);
  assert.equal(consume({ target: 'naru-minion-debug' }).code, 'call_id_mismatch');
  const repeated = consume();
  assert.equal(repeated.allowed, true);
  assert.equal(repeated.idempotent, true);
  assert.equal(consume({ callID: 'replay-call' }).code, 'replayed_token');
});

test('admission reservation rejects an unknown root atomically', () => {
  const registry = getSchedulerRuntimeRegistry();
  const token = directToken({ tokenId: 'admission-unknown-root' });
  assert.throws(() => reserveAdmission({
    token,
    rootSessionID: 'unknown-root',
    parentSessionID: 'unknown-root',
    target: TARGET,
    mode: 'observe',
    claims: claims(),
    nonce: 'nonce-unknown-root',
  }, { registry }), /root session is unknown/);
  assert.equal(registry.roots.size, 0);
  assert.equal(registry.admissions.has(token.tokenId), false);
});

test('create_run inherits parsed scheduler budgets when the request omits budgets', async () => {
  const schedulerConfig = {
    mode: 'observe',
    legacyProtocol2: 'observe',
    maxConcurrentWriters: 1,
    maxConcurrentReadOnly: 0,
    maxTotalChildren: 1,
    maxJudgePasses: 2,
  };
  assert.equal((await invoke({
    operation: 'create_run',
    runId: 'configured-run',
    schedulingProtocol: 3,
  }, 'observe', { schedulerConfig })).ok, true);
  const declared = await invoke({
    operation: 'declare_items',
    runId: 'configured-run',
    expectedRevision: 0,
    workItems: [workItem()],
  }, 'observe', { schedulerConfig });
  assert.deepEqual(declared.data.run.state.budgets, {
    maxConcurrentWriters: 1,
    maxConcurrentReadOnly: 0,
    maxTotalChildren: 1,
    maxJudgePasses: 2,
  });
});

test('append_artifact rejects expired transition tokens without changing scheduler state', async () => {
  const issued = await prepare('enforce');
  const plugin = await NaruSchedulerPlugin({}, { schedulerConfig: { mode: 'enforce' }, now: () => 1_001 });
  plugin['tool.execute.before'](
    { tool: 'task', sessionID: ROOT, callID: 'expired-transition-call' },
    { args: { subagent_type: TARGET, description: issued.data.marker } },
  );
  const transition = await invoke({
    operation: 'request_transition',
    runId: 'run-a',
    workItemId: 'writer-a',
    expectedRevision: 1,
    admissionTokenId: issued.data.token.tokenId,
    toStatus: 'terminal-contained',
  }, 'enforce');
  const artifact = {
    schemaVersion: 1,
    artifactType: 'transition',
    artifactId: 'artifact-expired',
    transitionTokenId: transition.data.token.tokenId,
    runId: 'run-a',
    workItemId: 'writer-a',
    expectedRevision: 1,
    fromStatus: 'active',
    toStatus: 'terminal-contained',
    changedPaths: ['src/a.mjs'],
  };
  const expired = await invoke({
    operation: 'append_artifact',
    runId: 'run-a',
    token: transition.data.token,
    artifact,
  }, 'enforce', { now: () => transition.data.token.expiresAt });
  assert.equal(expired.ok, false);
  assert.match(expired.error, /transition token is not currently valid/);
  const snapshot = await invoke({ operation: 'snapshot', runId: 'run-a' }, 'enforce');
  assert.equal(snapshot.data.run.state.revision, 1);
  assert.equal(snapshot.data.run.state.workItems[0].status, 'active');
  assert.deepEqual(snapshot.data.run.state.artifactIds, []);
});

test('append_artifact applies configured maximum artifact bytes before changing state', async () => {
  const issued = await prepare('enforce');
  const plugin = await NaruSchedulerPlugin({}, { schedulerConfig: { mode: 'enforce' }, now: () => 1_001 });
  plugin['tool.execute.before'](
    { tool: 'task', sessionID: ROOT, callID: 'oversize-artifact-call' },
    { args: { subagent_type: TARGET, description: issued.data.marker } },
  );
  const transition = await invoke({
    operation: 'request_transition',
    runId: 'run-a',
    workItemId: 'writer-a',
    expectedRevision: 1,
    admissionTokenId: issued.data.token.tokenId,
    toStatus: 'terminal-contained',
  }, 'enforce');
  const oversized = await invoke({
    operation: 'append_artifact',
    runId: 'run-a',
    token: transition.data.token,
    artifact: {
      schemaVersion: 1,
      artifactType: 'transition',
      artifactId: 'artifact-oversized',
      transitionTokenId: transition.data.token.tokenId,
      runId: 'run-a',
      workItemId: 'writer-a',
      expectedRevision: 1,
      fromStatus: 'active',
      toStatus: 'terminal-contained',
      changedPaths: [`src/${'a'.repeat(900)}.mjs`],
    },
  }, 'enforce', { schedulerConfig: { mode: 'enforce', maxArtifactBytes: 1_024 } });
  assert.equal(oversized.ok, false);
  assert.match(oversized.error, /TransitionArtifactV1 exceeds 1024 bytes/);
  const snapshot = await invoke({ operation: 'snapshot', runId: 'run-a' }, 'enforce');
  assert.equal(snapshot.data.run.state.revision, 1);
  assert.deepEqual(snapshot.data.run.state.artifactIds, []);
});

test('tool validates Protocol 3 transitions, artifacts, snapshots, freeze, close, and Protocol 2 enforcement', async () => {
  const issued = await prepare('enforce');
  const plugin = await NaruSchedulerPlugin({}, { schedulerConfig: { mode: 'enforce' }, now: () => 1_001 });
  plugin['tool.execute.before'](
    { tool: 'task', sessionID: ROOT, callID: 'transition-call' },
    { args: { subagent_type: TARGET, description: issued.data.marker } },
  );
  const transition = await invoke({
    operation: 'request_transition',
    runId: 'run-a',
    workItemId: 'writer-a',
    expectedRevision: 1,
    admissionTokenId: issued.data.token.tokenId,
    toStatus: 'terminal-contained',
  }, 'enforce');
  assert.equal(transition.ok, true);
  const artifact = {
    schemaVersion: 1,
    artifactType: 'transition',
    artifactId: 'artifact-a',
    transitionTokenId: transition.data.token.tokenId,
    runId: 'run-a',
    workItemId: 'writer-a',
    expectedRevision: 1,
    fromStatus: 'active',
    toStatus: 'terminal-contained',
    changedPaths: ['src/a.mjs'],
  };
  const appended = await invoke({
    operation: 'append_artifact',
    runId: 'run-a',
    token: transition.data.token,
    artifact,
  }, 'enforce');
  assert.equal(appended.data.run.state.workItems[0].status, 'terminal-contained');
  assert.equal((await invoke({ operation: 'snapshot', runId: 'run-a' }, 'enforce')).ok, true);
  assert.equal((await invoke({ operation: 'close', runId: 'run-a', expectedRevision: 2 }, 'enforce')).ok, true);

  resetSchedulerRuntimeForTests();
  const legacy = await invoke({ operation: 'create_run', runId: 'legacy', schedulingProtocol: 2 }, 'enforce');
  assert.equal(legacy.ok, false);
  assert.match(legacy.error, /Protocol 2/);

  resetSchedulerRuntimeForTests();
  await invoke({ operation: 'create_run', runId: 'freeze-run', schedulingProtocol: 3 }, 'observe');
  await invoke({
    operation: 'declare_items',
    runId: 'freeze-run',
    expectedRevision: 0,
    workItems: [workItem()],
  }, 'observe');
  const frozen = await invoke({
    operation: 'freeze',
    runId: 'freeze-run',
    workItemId: 'writer-a',
    expectedRevision: 0,
    reason: 'observable drift',
  }, 'observe');
  assert.equal(frozen.data.run.state.frozen, true);
});

test('Protocol 3 quality artifacts correlate reports and gate verification, judgment, and completion', async () => {
  const digest = 'b'.repeat(64);
  const issued = await prepare('enforce');
  let plugin = await NaruSchedulerPlugin({}, { schedulerConfig: { mode: 'enforce' }, now: () => 1_001 });
  plugin['tool.execute.before'](
    { tool: 'task', sessionID: ROOT, callID: 'quality-writer-call' },
    { args: { subagent_type: TARGET, description: issued.data.marker } },
  );

  const append = (artifact) => invoke({ operation: 'append_artifact', runId: 'run-a', artifact }, 'enforce');
  assert.equal((await append({
    schemaVersion: 1,
    artifactType: 'terminal',
    artifactId: 'terminal-quality-a',
    runId: 'run-a',
    expectedRevision: 1,
    cohortId: 'cohort-quality-a',
    workItemId: 'writer-a',
    reportId: 'implement-report-a',
    reportAgent: 'naru-minion-implement',
    admissionTokenId: issued.data.token.tokenId,
    outcome: 'terminal-contained',
    changedPaths: ['src/a.mjs'],
    dependencyReportIds: [],
  })).ok, true);

  const prematureCandidate = await append({
    schemaVersion: 1,
    artifactType: 'candidate',
    artifactId: 'candidate-premature-a',
    runId: 'run-a',
    expectedRevision: 2,
    cohortId: 'cohort-quality-a',
    candidateIdentity: 'candidate-premature-identity',
    candidateStateDigest: digest,
    workItemIds: ['writer-a'],
    terminalArtifactIds: ['terminal-quality-a'],
    changedPaths: ['src/a.mjs'],
  });
  assert.equal(prematureCandidate.ok, false);
  assert.match(prematureCandidate.error, /requires scheduler quiescence/);

  const transition = await invoke({
    operation: 'request_transition',
    runId: 'run-a',
    workItemId: 'writer-a',
    expectedRevision: 2,
    admissionTokenId: issued.data.token.tokenId,
    toStatus: 'terminal-contained',
  }, 'enforce');
  assert.equal(transition.ok, true);
  assert.equal((await invoke({
    operation: 'append_artifact',
    runId: 'run-a',
    token: transition.data.token,
    artifact: {
      schemaVersion: 1,
      artifactType: 'transition',
      artifactId: 'transition-quality-a',
      transitionTokenId: transition.data.token.tokenId,
      runId: 'run-a',
      workItemId: 'writer-a',
      expectedRevision: 2,
      fromStatus: 'active',
      toStatus: 'terminal-contained',
      changedPaths: ['src/a.mjs'],
    },
  }, 'enforce')).ok, true);

  assert.equal((await append({
    schemaVersion: 1,
    artifactType: 'candidate',
    artifactId: 'candidate-quality-a',
    runId: 'run-a',
    expectedRevision: 3,
    cohortId: 'cohort-quality-a',
    candidateIdentity: 'candidate-quality-identity',
    candidateStateDigest: digest,
    workItemIds: ['writer-a'],
    terminalArtifactIds: ['terminal-quality-a'],
    changedPaths: ['src/a.mjs'],
  })).ok, true);

  const shardAdmission = await invoke({
    operation: 'issue_admission',
    runId: 'run-a',
    workItemId: 'writer-a',
    expectedRevision: 4,
    lane: 'read-only',
    target: 'naru-minion-verify',
  }, 'enforce');
  assert.match(shardAdmission.data.marker, /^naru-admit:v1:read-only:admission-/);
  plugin = await NaruSchedulerPlugin({}, { schedulerConfig: { mode: 'enforce' }, now: () => 1_001 });
  plugin['tool.execute.before'](
    { tool: 'task', sessionID: ROOT, callID: 'quality-shard-call' },
    { args: { subagent_type: 'naru-minion-verify', description: shardAdmission.data.marker } },
  );
  assert.equal((await append({
    schemaVersion: 1,
    artifactType: 'shard',
    artifactId: 'shard-quality-a',
    runId: 'run-a',
    expectedRevision: 5,
    candidateArtifactId: 'candidate-quality-a',
    candidateIdentity: 'candidate-quality-identity',
    candidateStateDigest: digest,
    shardId: 'verify-quality-a',
    reportId: 'verify-report-a',
    reportAgent: 'naru-minion-verify',
    admissionTokenId: shardAdmission.data.token.tokenId,
    workItemIds: ['writer-a'],
    coveredChecks: ['targeted'],
    observedPaths: ['src/a.mjs'],
    mutableResourceClaims: ['verify-cache-a'],
    candidateValidity: 'exact-match',
    outcome: 'passed',
  })).ok, true);

  const gate = (artifactId, expectedRevision, gateType, judgmentArtifactId = null) => append({
    schemaVersion: 1,
    artifactType: 'gate',
    artifactId,
    runId: 'run-a',
    expectedRevision,
    gateType,
    candidateArtifactId: 'candidate-quality-a',
    candidateIdentity: 'candidate-quality-identity',
    candidateStateDigest: digest,
    judgmentArtifactId,
    observedIdentity: 'candidate-quality-identity',
    observedStateDigest: digest,
    status: 'passed',
    reasonCodes: [],
  });
  assert.equal((await gate('verification-gate-a', 6, 'verification')).ok, true);

  const judgeAdmission = await invoke({
    operation: 'issue_admission',
    runId: 'run-a',
    workItemId: 'writer-a',
    expectedRevision: 7,
    lane: 'read-only',
    target: 'naru-minion-judge',
  }, 'enforce');
  plugin['tool.execute.before'](
    { tool: 'task', sessionID: ROOT, callID: 'quality-judge-call' },
    { args: { subagent_type: 'naru-minion-judge', description: judgeAdmission.data.marker } },
  );
  assert.equal((await append({
    schemaVersion: 1,
    artifactType: 'judgment',
    artifactId: 'judgment-quality-a',
    runId: 'run-a',
    expectedRevision: 8,
    candidateArtifactId: 'candidate-quality-a',
    candidateIdentity: 'candidate-quality-identity',
    candidateStateDigest: digest,
    reportId: 'judge-report-a',
    reportAgent: 'naru-minion-judge',
    admissionTokenId: judgeAdmission.data.token.tokenId,
    shardArtifactIds: ['shard-quality-a'],
    verdict: 'ready',
    confidence: 'high',
    judgePass: 1,
  })).ok, true);
  assert.equal((await gate('judgment-gate-a', 9, 'judgment', 'judgment-quality-a')).ok, true);
  const staleCompletion = await append({
    schemaVersion: 1,
    artifactType: 'gate',
    artifactId: 'completion-gate-stale-a',
    runId: 'run-a',
    expectedRevision: 10,
    gateType: 'completion',
    candidateArtifactId: 'candidate-quality-a',
    candidateIdentity: 'candidate-quality-identity',
    candidateStateDigest: digest,
    judgmentArtifactId: 'judgment-quality-a',
    observedIdentity: 'different-candidate-identity',
    observedStateDigest: digest,
    status: 'passed',
    reasonCodes: [],
  });
  assert.equal(staleCompletion.ok, false);
  assert.match(staleCompletion.error, /does not exactly match the candidate/);
  assert.equal((await gate('completion-gate-a', 10, 'completion', 'judgment-quality-a')).ok, true);

  const snapshot = await invoke({ operation: 'snapshot', runId: 'run-a' }, 'enforce');
  assert.equal(snapshot.data.run.state.revision, 11);
  assert.equal(snapshot.data.run.state.judgePasses, 1);
  assert.equal(snapshot.data.run.state.activeAdmissions.length, 0);
  assert.deepEqual(snapshot.data.run.state.qualityArtifacts.map((artifact) => artifact.artifactType), [
    'terminal', 'candidate', 'shard', 'gate', 'judgment', 'gate', 'gate',
  ]);
});

test('journal is bounded, digest-linked, and recursively redacts sensitive keys and credential values', () => {
  for (let index = 0; index < SCHEDULER_JOURNAL_LIMITS.maxEntriesPerRoot + 20; index += 1) {
    appendSchedulerJournal(ROOT, 'test.entry', {
      index,
      prompt: 'do not retain me',
      changedPaths: ['/private/user/file'],
      secret: 'credential',
      modelID: 'provider/model',
      commandOutput: 'sensitive output',
      reason: 'Bearer DEMO_CREDENTIAL',
      details: {
        header: 'Authorization: Basic DEMO_CREDENTIAL',
        status: 'ordinary bounded metadata',
        value: 'ghp_0000000000000000DEMO',
      },
    }, { now: index });
  }
  const journal = schedulerJournalSnapshot(ROOT);
  assert.equal(journal.length, SCHEDULER_JOURNAL_LIMITS.maxEntriesPerRoot);
  assert.equal(journal[0].sequence, 21);
  assert.equal(journal.at(-1).sequence, SCHEDULER_JOURNAL_LIMITS.maxEntriesPerRoot + 20);
  assert.equal(journal[0].metadata.prompt, '[redacted]');
  assert.equal(journal[0].metadata.changedPaths, '[redacted]');
  assert.equal(journal[0].metadata.secret, '[redacted]');
  assert.equal(journal[0].metadata.modelID, '[redacted]');
  assert.equal(journal[0].metadata.commandOutput, '[redacted]');
  assert.equal(journal[0].metadata.reason, '[redacted]');
  assert.equal(journal[0].metadata.details.header, '[redacted]');
  assert.equal(journal[0].metadata.details.value, '[redacted]');
  assert.equal(journal[0].metadata.details.status, 'ordinary bounded metadata');
  assert.equal(journal[1].previousDigest, journal[0].digest);
});

test('scheduler runtime and plugin contain no native session creation or external write path', async () => {
  const pluginSource = await readFile(new URL('../plugins/naru-scheduler.js', import.meta.url), 'utf8');
  const toolSource = await readFile(new URL('../tools/naru-scheduler.js', import.meta.url), 'utf8');
  assert.doesNotMatch(`${pluginSource}\n${toolSource}`, /client\??\.session\??\.create\s*\(/);
  assert.doesNotMatch(`${pluginSource}\n${toolSource}`, /(?:writeFile|appendFile|mkdir|rename|unlink)\s*\(/);
});
