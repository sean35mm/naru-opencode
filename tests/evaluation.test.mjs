import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createDryRunPlan,
  evaluateManifest,
  scoreEvaluationCase,
  validateCapturedRunSummaryV1,
  validateEvaluationManifestV1,
} from '../tools/naru-lib/evaluation.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/live-evals.json', import.meta.url));
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));

function copy(value) {
  return structuredClone(value);
}

test('evaluation manifest schema is strict and covers local runtime cases', () => {
  const manifest = validateEvaluationManifestV1(fixture);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.cases.length, 11);
  assert.deepEqual(manifest.redaction, { prompts: 'omitted', code: 'omitted', diffs: 'omitted' });
  assert.throws(() => validateEvaluationManifestV1({ ...fixture, extra: true }), /unknown fields/);
  const missingRedactionCode = copy(fixture);
  delete missingRedactionCode.redaction.code;
  assert.throws(() => validateEvaluationManifestV1(missingRedactionCode), /missing required fields: code/);
  const rawRedactionCode = copy(fixture);
  rawRedactionCode.redaction.code = 'raw source code';
  assert.throws(() => validateEvaluationManifestV1(rawRedactionCode), /must omit prompts, code, and diffs/);
  const duplicate = copy(fixture);
  duplicate.cases[1].id = duplicate.cases[0].id;
  assert.throws(() => validateEvaluationManifestV1(duplicate), /duplicate case ID/);
});

test('captured summaries reject raw content and preserve only sanitized journal metrics', () => {
  for (const field of ['prompt', 'code', 'diff', 'source', 'secret']) {
    const summary = copy(fixture.cases[0].capturedRun);
    summary.journal[0][field] = 'raw content';
    assert.throws(() => validateCapturedRunSummaryV1(summary), new RegExp(`prohibited raw field: ${field}`));
  }
  const secret = copy(fixture.cases[0].capturedRun);
  secret.journal[0].outcome = 'bearer ghp_abcdefghijklmnopqrstuv';
  assert.throws(() => validateCapturedRunSummaryV1(secret), /sensitive content/);
});

test('scoring is deterministic and depends only on supplied rubric and captured outcomes', () => {
  const first = evaluateManifest(fixture);
  const second = evaluateManifest(copy(fixture));
  assert.deepEqual(first, second);
  assert.equal(first.aggregate.caseCount, 11);
  assert.deepEqual(first.aggregate.incidents, { race: 2, schema: 1, gate: 2, authorization: 1 });
  assert.equal(scoreEvaluationCase(fixture.cases[2]).points.find((point) => point.name === 'bestOf2').passed, true);
  assert.equal(scoreEvaluationCase(fixture.cases[5]).points.find((point) => point.name === 'checks').passed, true);
  assert.equal(scoreEvaluationCase(fixture.cases[4]).incidentPenalty, 10);
});

test('dry-run plan is bounded and live CLI requires an explicit provider-cost gate', () => {
  const plan = createDryRunPlan(fixture);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.cases.length, fixture.cases.length);
  assert.ok(plan.cases.every((entry) => Object.keys(entry).every((key) => ['id', 'score', 'maximumScore', 'passed'].includes(key))));

  const cli = fileURLToPath(new URL('../scripts/naru-live-eval.mjs', import.meta.url));
  const dry = spawnSync(process.execPath, [cli, '--manifest', fixturePath, '--dry-run'], { encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(JSON.parse(dry.stdout), plan);
  const live = spawnSync(process.execPath, [cli, '--live', '--case', 'plan-fanout', '--dir', '.'], { encoding: 'utf8' });
  assert.equal(live.status, 2);
  assert.match(live.stderr, /requires --confirm-provider-cost/);
});
