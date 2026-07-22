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
  validateEvaluationSpecificationV2,
} from '../tools/naru-lib/evaluation.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/live-evals.json', import.meta.url));
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));

function copy(value) {
  return structuredClone(value);
}

function legacyCaseFromSpecification(entry) {
  const { decisions: _decisions, safety: _safety, topology: _topology, ...capturedRun } = entry.syntheticCapture;
  const {
    decisions: _requiredDecisions,
    safety: _requiredSafety,
    topologyRequired: _topologyRequired,
    ...rubric
  } = entry.rubric;
  return { id: 'legacy-case', scenario: 'legacy-case', budget: entry.budget, rubric, capturedRun };
}

const legacyFixture = {
  schemaVersion: 1,
  suiteId: 'legacy-runtime-evaluation',
  redaction: { prompts: 'omitted', code: 'omitted', diffs: 'omitted' },
  budgets: fixture.budgets,
  cases: [legacyCaseFromSpecification(fixture.cases[0])],
};

test('phase 2 specification is strict, zero-cost, matched, and covers every required path', () => {
  const specification = validateEvaluationSpecificationV2(fixture);
  assert.equal(specification.schemaVersion, 2);
  assert.equal(specification.cases.length, 7);
  assert.deepEqual(specification.redaction, {
    prompts: 'omitted', code: 'omitted', diffs: 'omitted', outputs: 'omitted', credentials: 'omitted',
  });
  assert.equal(specification.contract.environment.provider, 'none');
  assert.deepEqual(specification.contract.environment.modelIds, []);
  assert.equal(specification.contract.execution.maximumSpendUsdMicros, 0);
  assert.equal(specification.contract.baseline.kind, 'single-agent-opencode');
  assert.ok(['plan', 'impact', 'triage', 'review', 'implementation']
    .every((workflow) => specification.cases.some((entry) => entry.topology.workflow === workflow)));
  assert.ok(specification.cases.some((entry) => entry.topology.schedulerMode === 'off'));
  assert.ok(specification.cases.some((entry) => entry.topology.schedulerMode === 'observe'));
  assert.ok(specification.cases.some((entry) => entry.topology.workspaceMode === 'isolated'));
  assert.ok(specification.cases.some((entry) => entry.topology.fallbackMode === 'shared'));

  assert.throws(() => validateEvaluationSpecificationV2({ ...fixture, extra: true }), /unknown fields/);
  const missingOutputRedaction = copy(fixture);
  delete missingOutputRedaction.redaction.outputs;
  assert.throws(() => validateEvaluationSpecificationV2(missingOutputRedaction), /missing required fields: outputs/);
  const duplicate = copy(fixture);
  duplicate.cases[1].id = duplicate.cases[0].id;
  assert.throws(() => validateEvaluationSpecificationV2(duplicate), /duplicate case ID/);
  const incompleteCoverage = copy(fixture);
  incompleteCoverage.cases = incompleteCoverage.cases.filter((entry) => entry.topology.workflow !== 'plan');
  assert.throws(() => validateEvaluationSpecificationV2(incompleteCoverage), /must cover planning/);
  const paid = copy(fixture);
  paid.contract.execution.maximumSpendUsdMicros = 1;
  assert.throws(() => validateEvaluationSpecificationV2(paid), /zero-cost repetition/);
  const unmatched = copy(fixture);
  unmatched.contract.baseline.sameModel = false;
  assert.throws(() => validateEvaluationSpecificationV2(unmatched), /matched single-agent/);
  const mutableReview = copy(fixture);
  mutableReview.cases.find((entry) => entry.topology.workflow === 'review').fixture.permittedMutation = 'scoped-disposable';
  assert.throws(() => validateEvaluationSpecificationV2(mutableReview), /read-only workflows must prohibit mutation/);
  const mislabeledReview = copy(fixture);
  mislabeledReview.cases.find((entry) => entry.topology.workflow === 'review').fixture.expectedOutcome = 'complete-plan';
  assert.throws(() => validateEvaluationSpecificationV2(mislabeledReview), /does not match its read-only workflow/);
});

test('captured summaries and specifications reject raw or sensitive content', () => {
  const legacySummary = legacyFixture.cases[0].capturedRun;
  for (const field of ['prompt', 'code', 'diff', 'source', 'secret']) {
    const summary = copy(legacySummary);
    summary.journal[0][field] = 'raw content';
    assert.throws(() => validateCapturedRunSummaryV1(summary), new RegExp(`prohibited raw field: ${field}`));
  }
  const secret = copy(legacySummary);
  secret.journal[0].outcome = 'bearer ghp_abcdefghijklmnopqrstuv';
  assert.throws(() => validateCapturedRunSummaryV1(secret), /sensitive content/);
  const rawSpecification = copy(fixture);
  rawSpecification.cases[0].syntheticCapture.decisions[0].raw = 'retained output';
  assert.throws(() => validateEvaluationSpecificationV2(rawSpecification), /prohibited raw field: raw/);
});

test('deterministic scoring covers correctness, safety, cleanup, and topology', () => {
  const first = evaluateManifest(fixture);
  const second = evaluateManifest(copy(fixture));
  assert.deepEqual(first, second);
  assert.equal(first.aggregate.caseCount, 7);
  assert.equal(first.aggregate.passedCases, 7);
  assert.equal(first.aggregate.totalScore, first.aggregate.maximumScore);
  assert.deepEqual(first.aggregate.incidents, { race: 0, schema: 0, gate: 0, authorization: 0 });
  assert.deepEqual(first.coverage.workflows, ['plan', 'impact', 'triage', 'review', 'implementation']);
  assert.deepEqual(first.coverage.schedulerModes, ['off', 'observe']);
  assert.ok(first.results.every((entry) => entry.points.find((point) => point.name === 'correctnessDecisions').passed));
  assert.ok(first.results.every((entry) => entry.points.find((point) => point.name === 'cleanupComplete').passed));
  assert.equal(scoreEvaluationCase(legacyFixture.cases[0]).passed, true);

  const unsafe = copy(fixture);
  unsafe.cases[0].syntheticCapture.safety.cleanupComplete = false;
  assert.equal(evaluateManifest(unsafe).results[0].passed, false);
  const incorrect = copy(fixture);
  incorrect.cases[1].syntheticCapture.decisions[0].passed = false;
  assert.equal(evaluateManifest(incorrect).results[1].passed, false);
  const wrongTopology = copy(fixture);
  wrongTopology.cases[2].syntheticCapture.topology.workspaceMode = 'isolated';
  assert.equal(evaluateManifest(wrongTopology).results[2].points.find((point) => point.name === 'topology').passed, false);
});

test('dry-run output is bounded and live mode remains behind the provider-cost gate', () => {
  const plan = createDryRunPlan(fixture);
  assert.equal(plan.schemaVersion, 2);
  assert.equal(plan.stage, 'deterministic');
  assert.equal(plan.dryRun, true);
  assert.equal(plan.contract.execution.maximumSpendUsdMicros, 0);
  assert.equal(plan.cases.length, fixture.cases.length);
  assert.ok(plan.cases.every((entry) => Object.keys(entry).every((key) => [
    'id', 'fixtureId', 'workflow', 'schedulerMode', 'workspaceMode', 'expectedOutcome',
    'score', 'maximumScore', 'passed',
  ].includes(key))));
  assert.doesNotMatch(JSON.stringify(plan), /syntheticCapture|journal|decisions/);

  const cli = fileURLToPath(new URL('../scripts/naru-live-eval.mjs', import.meta.url));
  const dry = spawnSync(process.execPath, [cli, '--manifest', fixturePath, '--dry-run'], { encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(JSON.parse(dry.stdout), plan);
  const live = spawnSync(process.execPath, [cli, '--live', '--case', 'plan-fanout', '--dir', '.'], { encoding: 'utf8' });
  assert.equal(live.status, 2);
  assert.match(live.stderr, /requires --confirm-provider-cost/);
});

test('schema v1 manifests remain valid and retain their original dry-run shape', () => {
  const manifest = validateEvaluationManifestV1(legacyFixture);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.cases.length, 1);
  const report = evaluateManifest(legacyFixture);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.aggregate.caseCount, 1);
  const plan = createDryRunPlan(legacyFixture);
  assert.deepEqual(Object.keys(plan), ['schemaVersion', 'suiteId', 'dryRun', 'redaction', 'aggregate', 'cases']);
  assert.deepEqual(Object.keys(plan.cases[0]), ['id', 'score', 'maximumScore', 'passed']);

  const incident = copy(legacyFixture.cases[0]);
  incident.capturedRun.incidents.gate = 1;
  assert.equal(scoreEvaluationCase(incident).incidentPenalty, 10);
  assert.equal(scoreEvaluationCase(incident).passed, false);
  const bestOf2 = copy(legacyFixture.cases[0]);
  bestOf2.rubric.bestOf2 = { required: true, maxDisagreement: 1, selectionRequired: true };
  bestOf2.capturedRun.bestOf2 = { attempted: true, disagreement: 1, selected: true };
  assert.equal(scoreEvaluationCase(bestOf2).points.find((point) => point.name === 'bestOf2').passed, true);
});
