import assert from 'node:assert/strict';
import test from 'node:test';

import { NaruSchedulerPlugin } from '../plugins/naru-scheduler.js';
import schedulerTool from '../tools/naru-scheduler.js';
import { schedulerJournalSnapshot } from '../tools/naru-lib/scheduler-journal.mjs';
import {
  getSchedulerRuntimeRegistry,
  resetSchedulerRuntimeForTests,
} from '../tools/naru-lib/scheduler-token.mjs';

const ROOT = 'lifecycle-root';
const TARGET = 'naru-minion-implement';
const CONTEXT = {
  sessionID: ROOT,
  agent: 'naru-orchestrator',
  directory: '/workspace/lifecycle',
  schedulerConfig: { mode: 'observe', legacyProtocol2: 'observe' },
  now: () => 5_000,
};

function item() {
  return {
    workItemId: 'lifecycle-item',
    dependencies: [],
    ownedWriteScope: ['src/lifecycle.mjs'],
    frozenContractClaims: [],
    mutableContractClaims: ['lifecycle'],
    generatedArtifactClaims: [],
    configurationClaims: [],
    mutableResourceClaims: [],
    exclusions: [],
    verificationNeeds: ['lifecycle'],
    status: 'ready',
  };
}

async function tool(input) {
  return JSON.parse(await schedulerTool.execute({ input }, CONTEXT));
}

async function setup() {
  assert.equal((await tool({
    operation: 'create_run',
    runId: 'lifecycle-run',
    schedulingProtocol: 3,
  })).ok, true);
  assert.equal((await tool({
    operation: 'declare_items',
    runId: 'lifecycle-run',
    expectedRevision: 0,
    workItems: [item()],
  })).ok, true);
  const issued = await tool({
    operation: 'issue_admission',
    runId: 'lifecycle-run',
    workItemId: 'lifecycle-item',
    expectedRevision: 0,
    lane: 'writer',
    target: TARGET,
  });
  assert.equal(issued.ok, true);
  const plugin = await NaruSchedulerPlugin(
    { client: { session: { create: () => { throw new Error('must not create sessions'); } } }, directory: CONTEXT.directory },
    { schedulerConfig: CONTEXT.schedulerConfig, now: () => 5_001 },
  );
  return { issued, plugin };
}

test.beforeEach(() => resetSchedulerRuntimeForTests());

test('before and after correlate only a foreground Task result without claiming child terminal state', async () => {
  const { issued, plugin } = await setup();
  const input = { tool: 'Task', sessionID: ROOT, callID: 'foreground-call' };
  plugin['tool.execute.before'](input, {
    args: {
      subagent_type: TARGET,
      description: `bounded task\n${issued.data.marker}`,
      run_in_background: false,
    },
  });
  plugin['tool.execute.after'](input, { title: 'Task result', output: 'not journaled' });
  plugin['tool.execute.after'](input, { title: 'duplicate result', output: 'not journaled' });

  const journal = schedulerJournalSnapshot(ROOT);
  const results = journal.filter((entry) => entry.type === 'task.foreground-result');
  assert.equal(results.length, 1);
  assert.equal(results[0].metadata.status, 'child-terminal-unknown');
  assert.equal(results[0].metadata.terminalKnown, false);
  assert.equal(JSON.stringify(journal).includes('not journaled'), false);
  assert.equal(getSchedulerRuntimeRegistry().roots.get(ROOT).state.activeAdmissions.length, 1);
});

test('background terminal state remains unknown and conservatively never auto-releases its active slot', async () => {
  const { issued, plugin } = await setup();
  const input = { tool: 'task', sessionID: ROOT, callID: 'background-call' };
  plugin['tool.execute.before'](input, {
    args: {
      subagent_type: TARGET,
      description: issued.data.marker,
      run_in_background: true,
    },
  });
  plugin['tool.execute.after'](input, { output: 'launch complete only' });
  plugin.event({
    event: {
      type: 'session.created',
      properties: { info: { id: 'child-session', parentID: ROOT }, sequence: 1 },
    },
  });
  plugin.event({
    event: {
      type: 'session.idle',
      properties: { sessionID: 'child-session', sequence: 2 },
    },
  });

  const run = getSchedulerRuntimeRegistry().roots.get(ROOT);
  assert.equal(run.state.activeAdmissions.length, 1);
  const journal = schedulerJournalSnapshot(ROOT);
  assert.equal(journal.some((entry) => entry.type === 'task.foreground-result'), false);
  assert.equal(journal.some((entry) => entry.metadata.code === 'idle_with_active_background'), true);
  assert.equal(journal.some((entry) => entry.metadata.status === 'unknown-background-terminal'), true);
});

test('duplicate, reordered, missing, and advisory terminal events are deduped into bounded incidents', async () => {
  const plugin = await NaruSchedulerPlugin({}, {
    schedulerConfig: { mode: 'observe', legacyProtocol2: 'observe' },
    now: () => 6_000,
  });
  const created = {
    type: 'session.created',
    properties: { info: { id: 'orphan-child', parentID: 'missing-parent' }, sequence: 5 },
  };
  plugin.event({ event: created });
  plugin.event({ event: created });
  plugin.event({
    event: {
      type: 'session.updated',
      properties: { info: { id: 'orphan-child', parentID: 'missing-parent' }, sequence: 4 },
    },
  });
  plugin['tool.execute.after'](
    { tool: 'task', sessionID: 'missing-parent', callID: 'missing-before' },
    { output: 'unknown' },
  );
  plugin['chat.message'](
    { sessionID: 'missing-parent' },
    { parts: [{ type: 'tool', tool: 'Task', callID: 'missing-chat-call', state: { status: 'completed' } }] },
  );

  const journal = schedulerJournalSnapshot('missing-parent');
  const codes = journal.map((entry) => entry.metadata.code).filter(Boolean);
  assert.equal(codes.includes('missing_parent_event'), true);
  assert.equal(codes.includes('duplicate_event'), true);
  assert.equal(codes.includes('reordered_event'), true);
  assert.equal(codes.includes('task_after_without_before'), true);
  assert.equal(codes.includes('advisory_task_terminal_unknown'), true);
  assert.equal(codes.filter((code) => code === 'duplicate_event').length, 1);
});

test('observe records malformed markers without blocking and enforce rejects root and target mismatches', async () => {
  let plugin = await NaruSchedulerPlugin({}, {
    schedulerConfig: { mode: 'observe', legacyProtocol2: 'observe' },
    now: () => 7_000,
  });
  assert.doesNotThrow(() => plugin['tool.execute.before'](
    { tool: 'task', sessionID: ROOT, callID: 'malformed-call' },
    { args: { subagent_type: TARGET, description: 'naru-admit:v2:bad' } },
  ));
  assert.equal(schedulerJournalSnapshot(ROOT).some((entry) => entry.metadata.code === 'invalid_marker'), true);

  resetSchedulerRuntimeForTests();
  const enforceContext = { ...CONTEXT, schedulerConfig: { mode: 'enforce' } };
  const callTool = async (input) => JSON.parse(await schedulerTool.execute({ input }, enforceContext));
  await callTool({ operation: 'create_run', runId: 'enforced-run', schedulingProtocol: 3 });
  await callTool({ operation: 'declare_items', runId: 'enforced-run', expectedRevision: 0, workItems: [item()] });
  const issued = await callTool({
    operation: 'issue_admission',
    runId: 'enforced-run',
    workItemId: 'lifecycle-item',
    expectedRevision: 0,
    lane: 'writer',
    target: TARGET,
  });
  plugin = await NaruSchedulerPlugin({}, { schedulerConfig: { mode: 'enforce' }, now: () => 5_001 });
  assert.throws(() => plugin['tool.execute.before'](
    { tool: 'task', sessionID: 'wrong-root', callID: 'wrong-root-call' },
    { args: { subagent_type: TARGET, description: issued.data.marker } },
  ), /root session mismatch/);
  assert.throws(() => plugin['tool.execute.before'](
    { tool: 'task', sessionID: ROOT, callID: 'wrong-target-call' },
    { args: { subagent_type: 'naru-minion-debug', description: issued.data.marker } },
  ), /Task target mismatch/);
  assert.throws(() => plugin['tool.execute.before'](
    { tool: 'task', sessionID: ROOT, callID: 'wrong-lane-call' },
    { args: { subagent_type: TARGET, description: issued.data.marker.replace(':writer:', ':read-only:') } },
  ), /scheduler lane mismatch/);
});
