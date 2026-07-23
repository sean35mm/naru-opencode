import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  APPROVED_EVALUATION_CASE_IDS,
  createDryRunPlan,
  evaluateManifest,
  scoreEvaluationCase,
  validateCapturedRunSummaryV1,
  validateEvaluationManifestV1,
  validateReusableEvaluationSpecificationV3,
} from '../tools/naru-lib/evaluation.mjs';
import { inspectCandidateArtifacts } from '../tools/naru-lib/live-evaluation.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/live-evals.json', import.meta.url));
const fixturesRoot = fileURLToPath(new URL('./fixtures/live-evals', import.meta.url));
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const candidateDigest = (await inspectCandidateArtifacts(repositoryRoot)).digest;

function copy(value) {
  return structuredClone(value);
}

const capturedRun = {
  mode: 'auto', elapsedMs: 10, childCount: 1, peakConcurrency: 1,
  usefulDelegation: true, justifiedSkip: false,
  bestOf2: { attempted: false, disagreement: 0, selected: false },
  remediation: { required: false, performed: false },
  incidents: { race: 0, schema: 0, gate: 0, authorization: 0 },
  checks: { passed: 1, failed: 0, candidateInvalidated: false },
  journal: [{ at: 1, type: 'check', outcome: 'passed' }],
};
const legacyFixture = {
  schemaVersion: 1,
  suiteId: 'legacy-runtime-evaluation',
  redaction: { prompts: 'omitted', code: 'omitted', diffs: 'omitted' },
  budgets: { maxPeakConcurrency: 2, maxElapsedMs: 1000, maxChildCount: 2 },
  cases: [{
    id: 'legacy-case', scenario: 'legacy-case',
    budget: { maxPeakConcurrency: 2, maxElapsedMs: 1000, maxChildCount: 2 },
    rubric: {
      usefulDelegationRequired: true, justifiedSkipRequired: false,
      bestOf2: { required: false, maxDisagreement: 0, selectionRequired: false },
      remediationRequired: false,
      checks: { minimumPassed: 1, maximumFailed: 0, candidateValid: true },
    },
    capturedRun,
  }],
};

test('reusable specification contains exactly the seven approved data-driven cases without run provenance', () => {
  const specification = validateReusableEvaluationSpecificationV3(fixture);
  assert.equal(specification.schemaVersion, 3);
  assert.deepEqual(specification.cases.map((entry) => entry.id), APPROVED_EVALUATION_CASE_IDS);
  assert.equal(specification.cases.length, 7);
  assert.ok(specification.cases.every((entry) => entry.fixture.kind === 'synthetic'));
  assert.ok(specification.cases.every((entry) => !Object.hasOwn(entry, 'syntheticCapture')));
  for (const field of ['candidate', 'contract', 'environment', 'provider', 'model', 'date']) {
    assert.equal(Object.hasOwn(specification, field), false);
  }
  assert.ok(['plan', 'impact', 'triage', 'review', 'implementation']
    .every((workflow) => specification.cases.some((entry) => entry.topology.workflow === workflow)));
  assert.ok(specification.cases.some((entry) => entry.topology.workspaceMode === 'isolated'));
  assert.ok(specification.cases.some((entry) => entry.topology.fallbackMode === 'shared'));

  assert.throws(() => validateReusableEvaluationSpecificationV3({ ...fixture, candidate: {} }), /unknown fields/);
  const reordered = copy(fixture);
  [reordered.cases[0], reordered.cases[1]] = [reordered.cases[1], reordered.cases[0]];
  assert.throws(() => validateReusableEvaluationSpecificationV3(reordered), /canonical approved order/);
  const traversal = copy(fixture);
  traversal.cases[0].fixture.path = '../planning';
  assert.throws(() => validateReusableEvaluationSpecificationV3(traversal), /safe fixture directory/);
  const mutableReview = copy(fixture);
  mutableReview.cases[3].fixture.permittedMutation = 'scoped-disposable';
  assert.throws(() => validateReusableEvaluationSpecificationV3(mutableReview), /read-only workflows/);
});

test('reusable specification planning is deterministic and omits captures', () => {
  const first = evaluateManifest(fixture);
  const second = evaluateManifest(copy(fixture));
  assert.deepEqual(first, second);
  assert.equal(first.stage, 'specification');
  assert.equal(first.aggregate.caseCount, 7);
  const plan = createDryRunPlan(fixture);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.cases.length, 7);
  assert.doesNotMatch(JSON.stringify(plan), /syntheticCapture|journal|candidate|provider|model/);
});

test('schema v1 readers retain validation, scoring, and dry-run compatibility', () => {
  assert.deepEqual(validateCapturedRunSummaryV1(capturedRun), capturedRun);
  assert.equal(validateEvaluationManifestV1(legacyFixture).schemaVersion, 1);
  assert.equal(scoreEvaluationCase(legacyFixture.cases[0]).passed, true);
  const report = evaluateManifest(legacyFixture);
  assert.equal(report.aggregate.caseCount, 1);
  const plan = createDryRunPlan(legacyFixture);
  assert.deepEqual(Object.keys(plan), ['schemaVersion', 'suiteId', 'dryRun', 'redaction', 'aggregate', 'cases']);

  const raw = copy(capturedRun);
  raw.journal[0].prompt = 'retained prompt';
  assert.throws(() => validateCapturedRunSummaryV1(raw), /prohibited raw field/);
});

test('CLI dry-run and contract preparation print only reviewable provider-free data', () => {
  const cli = fileURLToPath(new URL('../scripts/naru-live-eval.mjs', import.meta.url));
  const legacyLive = spawnSync(process.execPath, [cli, '--live'], { encoding: 'utf8' });
  assert.equal(legacyLive.status, 2);
  assert.match(legacyLive.stderr, /Legacy bare --live is unsafe.*Prepare and review a contract/s);

  const dry = spawnSync(process.execPath, [cli, '--manifest', fixturePath, '--dry-run'], { encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(JSON.parse(dry.stdout), createDryRunPlan(fixture));

  const prepared = spawnSync(process.execPath, [
    cli, '--prepare-contract', '--manifest', fixturePath, '--fixtures', fixturesRoot,
    '--candidate-id', 'candidate-a', '--candidate-revision', 'revision-a',
    '--candidate-digest', candidateDigest, '--opencode-version', '2.0.0',
    '--opencode-digest', 'b'.repeat(64),
    '--provider', 'none', '--provider-version', 'not-invoked',
    '--model', 'none', '--model-version', 'not-invoked',
  ], { encoding: 'utf8' });
  assert.equal(prepared.status, 0, prepared.stderr);
  const contract = JSON.parse(prepared.stdout);
  assert.equal(contract.candidate.id, 'candidate-a');
  assert.equal(contract.case.ids.length, 7);
  assert.equal(contract.network.mode, 'none');
  assert.equal(contract.spend.maxUsdMicros, 0);
  assert.match(prepared.stderr, /exact stdout authorization SHA-256: [a-f0-9]{64}/);
});
