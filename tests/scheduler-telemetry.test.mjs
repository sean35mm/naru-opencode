import assert from 'node:assert/strict';
import test from 'node:test';

import { appendSchedulerJournal } from '../tools/naru-lib/scheduler-journal.mjs';
import {
  projectSchedulerTelemetry,
  schedulerTelemetrySnapshot,
  SCHEDULER_TELEMETRY_LIMITS,
} from '../tools/naru-lib/scheduler-telemetry.mjs';
import {
  getSchedulerRuntimeRegistry,
  resetSchedulerRuntimeForTests,
} from '../tools/naru-lib/scheduler-token.mjs';

function schedulerRun() {
  return {
    runId: 'telemetry-run',
    schedulingProtocol: 3,
    closed: false,
    budgets: {
      maxConcurrentWriters: 1,
      maxConcurrentReadOnly: 1,
      maxTotalChildren: 1,
      maxJudgePasses: 2,
    },
    state: {
      budgets: {
        maxConcurrentWriters: 1,
        maxConcurrentReadOnly: 1,
        maxTotalChildren: 1,
        maxJudgePasses: 2,
      },
      judgePasses: 1,
      activeAdmissions: [{ tokenId: 'active-token', workItemId: 'live-work', lane: 'writer' }],
      workItems: [
        { workItemId: 'live-work', status: 'active' },
        { workItemId: 'pending-work', status: 'pending' },
        { workItemId: 'ready-work', status: 'ready' },
        { workItemId: 'blocked-work', status: 'blocked' },
        { workItemId: 'done-work', status: 'terminal-contained' },
      ],
      qualityArtifacts: [
        { artifactType: 'candidate', artifactId: 'candidate-a' },
        { artifactType: 'shard', artifactId: 'shard-a', reportAgent: 'naru-minion-verify' },
        {
          artifactType: 'gate',
          artifactId: 'verification-gate-a',
          candidateArtifactId: 'candidate-a',
          gateType: 'verification',
          status: 'passed',
        },
      ],
    },
  };
}

test.afterEach(() => resetSchedulerRuntimeForTests());

test('telemetry projects honest local state, pressure, blocking, gates, and evidenced actors', () => {
  const run = schedulerRun();
  const projection = projectSchedulerTelemetry({
    rootSessionID: 'telemetry-root',
    run,
    now: 2_000,
    admissions: new Map([['active-token', {
      rootSessionID: 'telemetry-root',
      mode: 'observe',
      target: 'naru-minion-implement',
    }]]),
    journal: [{
      type: 'run.created',
      timestamp: 100,
      metadata: { runId: 'telemetry-run', mode: 'observe' },
    }, {
      type: 'run.items-declared',
      timestamp: 200,
      metadata: { runId: 'telemetry-run' },
    }, {
      type: 'artifact.appended',
      timestamp: 500,
      metadata: { workItemId: 'blocked-work', status: 'blocked' },
    }],
  });

  assert.equal(projection.scope, 'process-local');
  assert.equal(projection.processLocal, true);
  assert.equal(projection.durable, false);
  assert.equal(projection.crossProcess, false);
  assert.equal(projection.backgroundEnforcement, false);
  assert.equal(projection.providerHardCaps, false);
  assert.equal(projection.mode, 'observe');
  assert.deepEqual(projection.counts, {
    live: 1,
    pending: 2,
    blocked: 1,
    terminal: 1,
    failed: 0,
    invalidated: 0,
    total: 5,
  });
  assert.equal(projection.budget.pressure, 'full');
  assert.equal(projection.budget.usage.totalChildren, 1);
  assert.deepEqual(projection.oldestBlocked, {
    workItemId: 'blocked-work',
    since: 500,
    ageMs: 1_500,
  });
  assert.equal(projection.qualityGate.status, 'awaiting-judgment');
  assert.deepEqual(projection.actors, [
    { agent: 'naru-minion-implement', active: 1, artifacts: 0 },
    { agent: 'naru-minion-verify', active: 0, artifacts: 1 },
  ]);
});

test('actor projection is bounded and reports omitted evidence groups', () => {
  const run = schedulerRun();
  run.state.activeAdmissions = [];
  run.state.qualityArtifacts = Array.from({ length: SCHEDULER_TELEMETRY_LIMITS.maxActors + 4 }, (_, index) => ({
    artifactType: 'evidence',
    artifactId: `artifact-${index}`,
    reportAgent: `naru-specialist-${index}`,
  }));
  const projection = projectSchedulerTelemetry({ rootSessionID: 'bounded-root', run, now: 1_000 });
  assert.equal(projection.actors.length, SCHEDULER_TELEMETRY_LIMITS.maxActors);
  assert.equal(projection.omittedActorCount, 4);
});

test('snapshot is absent by default and returns a detached projection for a local run', () => {
  assert.equal(schedulerTelemetrySnapshot('missing-root'), null);
  const registry = getSchedulerRuntimeRegistry();
  registry.roots.set('telemetry-root', schedulerRun());
  appendSchedulerJournal('telemetry-root', 'run.created', {
    runId: 'telemetry-run',
    protocol: 3,
    mode: 'enforce',
  }, { registry, now: 100 });
  const snapshot = schedulerTelemetrySnapshot('telemetry-root', { registry, now: 1_000 });
  assert.equal(snapshot.mode, 'enforce');
  snapshot.counts.live = 99;
  assert.equal(schedulerTelemetrySnapshot('telemetry-root', { registry, now: 1_000 }).counts.live, 1);
});
