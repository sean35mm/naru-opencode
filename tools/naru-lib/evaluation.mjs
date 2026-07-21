const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_CASES = 128;
const MAX_JOURNAL_ENTRIES = 128;
const MAX_STRING_LENGTH = 256;
const MODES = new Set(['auto', 'lean', 'thorough', 'foreground', 'off']);
const JOURNAL_TYPES = new Set(['delegation', 'skip', 'admission', 'transition', 'remediation', 'best-of-2', 'check', 'candidate']);
const JOURNAL_OUTCOMES = new Set(['accepted', 'rejected', 'selected', 'invalidated', 'passed', 'failed', 'completed']);

export const EVALUATION_SCHEMA_VERSION = 1;
export const EVALUATION_REDACTION = Object.freeze({ prompts: 'omitted', code: 'omitted', diffs: 'omitted' });

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function assertObject(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be a plain object`);
}

function assertExactKeys(value, fields, label) {
  assertObject(value, label);
  const allowed = new Set(fields);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = fields.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length) throw new Error(`${label} contains unknown fields: ${unknown.sort().join(', ')}`);
  if (missing.length) throw new Error(`${label} is missing required fields: ${missing.join(', ')}`);
}

function assertInteger(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function assertBoolean(value, label) {
  if (value !== true && value !== false) throw new Error(`${label} must be a boolean`);
  return value;
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_STRING_LENGTH
    || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be a bounded safe string`);
  }
  return value;
}

function assertId(value, label) {
  assertString(value, label);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/.test(value)) {
    throw new Error(`${label} must be a safe identifier`);
  }
  return value;
}

function assertJsonSize(value, label) {
  const text = JSON.stringify(value);
  if (text === undefined || Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new Error(`${label} exceeds ${MAX_MANIFEST_BYTES} bytes`);
  }
}

function rejectSensitiveContent(value, label = 'evaluation input') {
  if (typeof value === 'string') {
    if (/(?:gh[pousr]_[A-Za-z0-9_]{20,}|bearer\s+\S+|authorization:\s*\S+)/i.test(value)) {
      throw new Error(`${label} contains sensitive content`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectSensitiveContent(entry, `${label}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (/^(?:prompts?|codes?|diffs?|sources?|patch|secrets?|credential|password|token|raw)$/i.test(key)) {
        throw new Error(`${label} contains prohibited raw field: ${key}`);
      }
      rejectSensitiveContent(entry, `${label}.${key}`);
    }
  }
}

function validateRedaction(value, label) {
  assertExactKeys(value, ['prompts', 'code', 'diffs'], label);
  if (value.prompts !== 'omitted' || value.code !== 'omitted' || value.diffs !== 'omitted') {
    throw new Error(`${label} must omit prompts, code, and diffs`);
  }
  return { ...EVALUATION_REDACTION };
}

function validateBudget(value, label) {
  assertExactKeys(value, ['maxPeakConcurrency', 'maxElapsedMs', 'maxChildCount'], label);
  return {
    maxPeakConcurrency: assertInteger(value.maxPeakConcurrency, `${label}.maxPeakConcurrency`, 0, 14),
    maxElapsedMs: assertInteger(value.maxElapsedMs, `${label}.maxElapsedMs`, 1, 86_400_000),
    maxChildCount: assertInteger(value.maxChildCount, `${label}.maxChildCount`, 0, 14),
  };
}

function validateChecks(value, label) {
  assertExactKeys(value, ['passed', 'failed', 'candidateInvalidated'], label);
  return {
    passed: assertInteger(value.passed, `${label}.passed`),
    failed: assertInteger(value.failed, `${label}.failed`),
    candidateInvalidated: assertBoolean(value.candidateInvalidated, `${label}.candidateInvalidated`),
  };
}

function validateExpectedChecks(value, label) {
  assertExactKeys(value, ['minimumPassed', 'maximumFailed', 'candidateValid'], label);
  return {
    minimumPassed: assertInteger(value.minimumPassed, `${label}.minimumPassed`),
    maximumFailed: assertInteger(value.maximumFailed, `${label}.maximumFailed`),
    candidateValid: assertBoolean(value.candidateValid, `${label}.candidateValid`),
  };
}

function validateBestOf2(value, label) {
  assertExactKeys(value, ['attempted', 'disagreement', 'selected'], label);
  return {
    attempted: assertBoolean(value.attempted, `${label}.attempted`),
    disagreement: assertInteger(value.disagreement, `${label}.disagreement`, 0, 2),
    selected: assertBoolean(value.selected, `${label}.selected`),
  };
}

function validateExpectedBestOf2(value, label) {
  assertExactKeys(value, ['required', 'maxDisagreement', 'selectionRequired'], label);
  return {
    required: assertBoolean(value.required, `${label}.required`),
    maxDisagreement: assertInteger(value.maxDisagreement, `${label}.maxDisagreement`, 0, 2),
    selectionRequired: assertBoolean(value.selectionRequired, `${label}.selectionRequired`),
  };
}

function validateIncidents(value, label) {
  assertExactKeys(value, ['race', 'schema', 'gate', 'authorization'], label);
  return Object.fromEntries(Object.entries(value).map(([key, count]) => [key, assertInteger(count, `${label}.${key}`)]));
}

function validateJournal(value, label) {
  if (!Array.isArray(value) || value.length > MAX_JOURNAL_ENTRIES) throw new Error(`${label} must be a bounded array`);
  let previousAt = -1;
  return value.map((entry, index) => {
    assertExactKeys(entry, ['at', 'type', 'outcome'], `${label}[${index}]`);
    const at = assertInteger(entry.at, `${label}[${index}].at`);
    if (at < previousAt) throw new Error(`${label} must be ordered by at`);
    previousAt = at;
    if (!JOURNAL_TYPES.has(entry.type)) throw new Error(`${label}[${index}].type is invalid`);
    if (!JOURNAL_OUTCOMES.has(entry.outcome)) throw new Error(`${label}[${index}].outcome is invalid`);
    return { at, type: entry.type, outcome: entry.outcome };
  });
}

export function validateCapturedRunSummaryV1(value) {
  assertJsonSize(value, 'CapturedRunSummaryV1');
  rejectSensitiveContent(value, 'CapturedRunSummaryV1');
  assertExactKeys(value, [
    'mode', 'elapsedMs', 'childCount', 'peakConcurrency', 'usefulDelegation', 'justifiedSkip',
    'bestOf2', 'remediation', 'incidents', 'checks', 'journal',
  ], 'CapturedRunSummaryV1');
  if (!MODES.has(value.mode)) throw new Error('CapturedRunSummaryV1.mode is invalid');
  assertExactKeys(value.remediation, ['required', 'performed'], 'CapturedRunSummaryV1.remediation');
  return {
    mode: value.mode,
    elapsedMs: assertInteger(value.elapsedMs, 'CapturedRunSummaryV1.elapsedMs'),
    childCount: assertInteger(value.childCount, 'CapturedRunSummaryV1.childCount', 0, 14),
    peakConcurrency: assertInteger(value.peakConcurrency, 'CapturedRunSummaryV1.peakConcurrency', 0, 14),
    usefulDelegation: assertBoolean(value.usefulDelegation, 'CapturedRunSummaryV1.usefulDelegation'),
    justifiedSkip: assertBoolean(value.justifiedSkip, 'CapturedRunSummaryV1.justifiedSkip'),
    bestOf2: validateBestOf2(value.bestOf2, 'CapturedRunSummaryV1.bestOf2'),
    remediation: {
      required: assertBoolean(value.remediation.required, 'CapturedRunSummaryV1.remediation.required'),
      performed: assertBoolean(value.remediation.performed, 'CapturedRunSummaryV1.remediation.performed'),
    },
    incidents: validateIncidents(value.incidents, 'CapturedRunSummaryV1.incidents'),
    checks: validateChecks(value.checks, 'CapturedRunSummaryV1.checks'),
    journal: validateSanitizedJournalV1(value.journal),
  };
}

export function validateSanitizedJournalV1(value) {
  rejectSensitiveContent(value, 'SanitizedJournalV1');
  return validateJournal(value, 'SanitizedJournalV1');
}

function validateRubric(value, label) {
  assertExactKeys(value, ['usefulDelegationRequired', 'justifiedSkipRequired', 'bestOf2', 'remediationRequired', 'checks'], label);
  return {
    usefulDelegationRequired: assertBoolean(value.usefulDelegationRequired, `${label}.usefulDelegationRequired`),
    justifiedSkipRequired: assertBoolean(value.justifiedSkipRequired, `${label}.justifiedSkipRequired`),
    bestOf2: validateExpectedBestOf2(value.bestOf2, `${label}.bestOf2`),
    remediationRequired: assertBoolean(value.remediationRequired, `${label}.remediationRequired`),
    checks: validateExpectedChecks(value.checks, `${label}.checks`),
  };
}

export function validateEvaluationManifestV1(value) {
  assertJsonSize(value, 'EvaluationManifestV1');
  assertObject(value, 'EvaluationManifestV1');
  const { redaction, ...manifestWithoutRedaction } = value;
  rejectSensitiveContent(manifestWithoutRedaction, 'EvaluationManifestV1');
  assertExactKeys(value, ['schemaVersion', 'suiteId', 'redaction', 'budgets', 'cases'], 'EvaluationManifestV1');
  if (value.schemaVersion !== EVALUATION_SCHEMA_VERSION) throw new Error('EvaluationManifestV1.schemaVersion must be 1');
  if (!Array.isArray(value.cases) || value.cases.length === 0 || value.cases.length > MAX_CASES) {
    throw new Error('EvaluationManifestV1.cases must be a bounded non-empty array');
  }
  const ids = new Set();
  const budgets = validateBudget(value.budgets, 'EvaluationManifestV1.budgets');
  const cases = value.cases.map((entry, index) => {
    const label = `EvaluationManifestV1.cases[${index}]`;
    assertExactKeys(entry, ['id', 'scenario', 'budget', 'rubric', 'capturedRun'], label);
    const id = assertId(entry.id, `${label}.id`);
    if (ids.has(id)) throw new Error(`EvaluationManifestV1 has duplicate case ID: ${id}`);
    ids.add(id);
    const budget = validateBudget(entry.budget, `${label}.budget`);
    if (budget.maxPeakConcurrency > budgets.maxPeakConcurrency || budget.maxElapsedMs > budgets.maxElapsedMs
      || budget.maxChildCount > budgets.maxChildCount) {
      throw new Error(`${label}.budget exceeds EvaluationManifestV1.budgets`);
    }
    return {
      id,
      scenario: assertId(entry.scenario, `${label}.scenario`),
      budget,
      rubric: validateRubric(entry.rubric, `${label}.rubric`),
      capturedRun: validateCapturedRunSummaryV1(entry.capturedRun),
    };
  });
  return {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    suiteId: assertId(value.suiteId, 'EvaluationManifestV1.suiteId'),
    redaction: validateRedaction(value.redaction, 'EvaluationManifestV1.redaction'),
    budgets,
    cases,
  };
}

function point(name, passed) {
  return { name, passed, score: passed ? 1 : 0 };
}

export function scoreEvaluationCase(value) {
  const entry = value?.capturedRun ? value : { id: 'captured-run', budget: { maxPeakConcurrency: 14, maxElapsedMs: 86_400_000, maxChildCount: 14 }, rubric: value?.rubric, capturedRun: value };
  const rubric = validateRubric(entry.rubric, 'Evaluation rubric');
  const budget = validateBudget(entry.budget, 'Evaluation budget');
  const capturedRun = validateCapturedRunSummaryV1(entry.capturedRun);
  const points = [
    point('usefulDelegation', !rubric.usefulDelegationRequired || capturedRun.usefulDelegation),
    point('justifiedSkip', !rubric.justifiedSkipRequired || capturedRun.justifiedSkip),
    point('peakConcurrency', capturedRun.peakConcurrency <= budget.maxPeakConcurrency),
    point('elapsedDuration', capturedRun.elapsedMs <= budget.maxElapsedMs),
    point('childCount', capturedRun.childCount <= budget.maxChildCount),
    point('remediation', !rubric.remediationRequired || (capturedRun.remediation.required && capturedRun.remediation.performed)),
    point('bestOf2', rubric.bestOf2.required
      ? capturedRun.bestOf2.attempted && capturedRun.bestOf2.disagreement <= rubric.bestOf2.maxDisagreement
        && (!rubric.bestOf2.selectionRequired || capturedRun.bestOf2.selected)
      : !capturedRun.bestOf2.attempted),
    point('checks', capturedRun.checks.passed >= rubric.checks.minimumPassed
      && capturedRun.checks.failed <= rubric.checks.maximumFailed
      && capturedRun.checks.candidateInvalidated !== rubric.checks.candidateValid),
  ];
  const incidentCount = Object.values(capturedRun.incidents).reduce((total, count) => total + count, 0);
  const earned = points.reduce((total, item) => total + item.score, 0);
  const incidentPenalty = incidentCount * 10;
  return {
    id: entry.id ?? 'captured-run',
    score: Math.max(0, earned * 10 - incidentPenalty),
    maximumScore: points.length * 10,
    passed: earned === points.length && incidentCount === 0,
    points,
    incidentPenalty,
    incidents: capturedRun.incidents,
  };
}

export function evaluateManifest(value) {
  const manifest = validateEvaluationManifestV1(value);
  const results = manifest.cases.map(scoreEvaluationCase);
  const incidents = { race: 0, schema: 0, gate: 0, authorization: 0 };
  for (const result of results) for (const key of Object.keys(incidents)) incidents[key] += result.incidents[key];
  const totalScore = results.reduce((total, result) => total + result.score, 0);
  return {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    suiteId: manifest.suiteId,
    redaction: manifest.redaction,
    aggregate: {
      caseCount: results.length,
      passedCases: results.filter((result) => result.passed).length,
      totalScore,
      maximumScore: results.reduce((total, result) => total + result.maximumScore, 0),
      incidents,
    },
    results,
  };
}

export function createDryRunPlan(value) {
  const report = evaluateManifest(value);
  return {
    schemaVersion: report.schemaVersion,
    suiteId: report.suiteId,
    dryRun: true,
    redaction: report.redaction,
    aggregate: report.aggregate,
    cases: report.results.map(({ id, score, maximumScore, passed }) => ({ id, score, maximumScore, passed })),
  };
}
