import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  schedulerActorsLine,
  schedulerBlockedLine,
  schedulerBudgetLine,
  schedulerCountsLine,
  schedulerDialogMetadata,
  schedulerDialogTitle,
  schedulerHeaderLine,
  schedulerQualityLine,
  SIDEBAR_WIDTH,
} from '../plugins/naru-minions-dashboard-state.mjs';

const source = await readFile(new URL('../plugins/naru-minions-dashboard.tsx', import.meta.url), 'utf8');

function telemetry() {
  return {
    mode: 'observe',
    counts: { live: 2, pending: 3, blocked: 1 },
    budget: {
      pressure: 'elevated',
      usage: { totalChildren: 3 },
      limits: { maxTotalChildren: 4 },
    },
    oldestBlocked: { workItemId: 'blocked-specialist-work', since: 1_000 },
    qualityGate: { status: 'awaiting-judgment' },
    actors: [
      { agent: 'naru-minion-implement', active: 1, artifacts: 2 },
      { agent: 'naru-minion-verify', active: 1, artifacts: 1 },
      { agent: 'naru-minion-judge', active: 0, artifacts: 1 },
    ],
    omittedActorCount: 0,
  };
}

test('scheduler sidebar projection is compact, textual, and explicitly process-local', () => {
  const value = telemetry();
  const lines = [
    schedulerHeaderLine(value),
    schedulerCountsLine(value),
    schedulerBudgetLine(value),
    schedulerQualityLine(value),
    schedulerBlockedLine(value, 61_000),
    schedulerActorsLine(value),
  ];
  assert.ok(lines.every((line) => line.length <= SIDEBAR_WIDTH));
  assert.match(lines[0], /Scheduler · OBSERVE · local/);
  assert.match(lines[1], /Live 2 · Pend 3 · Block 1/);
  assert.match(lines[2], /Local budget elevated · 3\/4/);
  assert.match(lines[3], /Quality gate · awaiting-judg/);
  assert.match(lines[4], /Oldest block · blocked-spec/);
  assert.match(lines[5], /Roles · implement A1\/E2/);
});

test('scheduler dialog summary labels local limits without implying provider or global caps', () => {
  const title = schedulerDialogTitle(telemetry());
  const metadata = schedulerDialogMetadata(telemetry());
  assert.ok(title.length <= 61);
  assert.ok(metadata.length <= 100);
  assert.match(title, /Scheduler OBSERVE local · L:2 P:3 B:1/);
  assert.match(metadata, /^Process-local budget: elevated 3\/4/);
  assert.match(metadata, /Quality: awaiting-judgment/);
  assert.doesNotMatch(`${title} ${metadata}`, /global|provider cap/i);
});

test('absent scheduler telemetry renders no scheduler surface', () => {
  for (const helper of [
    schedulerHeaderLine,
    schedulerCountsLine,
    schedulerBudgetLine,
    schedulerQualityLine,
    schedulerBlockedLine,
    schedulerActorsLine,
    schedulerDialogTitle,
    schedulerDialogMetadata,
  ]) {
    assert.equal(helper(null), '');
  }
});

test('dashboard reuses its dialog and sidebar surfaces and hides absent telemetry', () => {
  assert.match(source, /schedulerTelemetrySnapshot\(rootID\)/);
  assert.match(source, /const options = telemetry \? \[\{/);
  assert.match(source, /\{telemetry\(\) \? <box flexDirection="column">/);
  assert.match(source, /setTelemetry\(null\)/);
  assert.doesNotMatch(source, /setInterval\([^,]+,\s*[0-9_]{1,4}\)/);
});
