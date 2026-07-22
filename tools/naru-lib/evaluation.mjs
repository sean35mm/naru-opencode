const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_CASES = 128;
const MAX_JOURNAL_ENTRIES = 128;
const MAX_STRING_LENGTH = 256;
const MODES = new Set(['auto', 'lean', 'thorough', 'foreground', 'off']);
const WORKFLOWS = new Set(['plan', 'impact', 'triage', 'review', 'implementation']);
const SCHEDULER_MODES = new Set(['off', 'observe', 'enforce']);
const WORKSPACE_MODES = new Set(['shared', 'isolated']);
const FALLBACK_MODES = new Set(['none', 'shared']);
const PERMITTED_MUTATIONS = new Set(['none', 'scoped-disposable']);
const EXPECTED_OUTCOMES = new Set([
  'complete-plan', 'complete-impact', 'root-cause', 'review-dry-run',
  'scoped-change', 'isolated-writer-success', 'safe-shared-fallback',
]);
const READ_ONLY_EXPECTED_OUTCOMES = new Map([
  ['plan', 'complete-plan'],
  ['impact', 'complete-impact'],
  ['triage', 'root-cause'],
  ['review', 'review-dry-run'],
]);
const REQUIRED_WORKFLOWS = ['plan', 'impact', 'triage', 'review', 'implementation'];
const REQUIRED_ABORT_CONDITIONS = [
  'authorization-failure', 'cleanup-failure', 'cost-limit',
  'safety-invariant-failure', 'timeout',
];
const SAFETY_INVARIANTS = [
  'cleanupComplete', 'noPersistentDataWrite', 'noPost',
  'noRawOutput', 'noSecret', 'scopeContained',
];
const JOURNAL_TYPES = new Set(['delegation', 'skip', 'admission', 'transition', 'remediation', 'best-of-2', 'check', 'candidate']);
const JOURNAL_OUTCOMES = new Set(['accepted', 'rejected', 'selected', 'invalidated', 'passed', 'failed', 'completed']);

export const EVALUATION_SCHEMA_VERSION = 1;
export const EVALUATION_REDACTION = Object.freeze({ prompts: 'omitted', code: 'omitted', diffs: 'omitted' });
export const EVALUATION_SPECIFICATION_SCHEMA_VERSION = 2;
export const EVALUATION_SPECIFICATION_REDACTION = Object.freeze({
  prompts: 'omitted',
  code: 'omitted',
  diffs: 'omitted',
  outputs: 'omitted',
  credentials: 'omitted',
});

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

function assertEnum(value, allowed, label) {
  if (!allowed.has(value)) throw new Error(`${label} is invalid`);
  return value;
}

function assertIdList(value, label, minimum = 0, maximum = 32) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} must be a bounded array`);
  }
  const ids = value.map((entry, index) => assertId(entry, `${label}[${index}]`));
  if (new Set(ids).size !== ids.length) throw new Error(`${label} must contain unique identifiers`);
  return ids;
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

function validateSpecificationRedaction(value, label) {
  assertExactKeys(value, ['prompts', 'code', 'diffs', 'outputs', 'credentials'], label);
  for (const field of Object.keys(EVALUATION_SPECIFICATION_REDACTION)) {
    if (value[field] !== 'omitted') throw new Error(`${label} must omit prompts, code, diffs, outputs, and credentials`);
  }
  return { ...EVALUATION_SPECIFICATION_REDACTION };
}

function validateSafetyInvariants(value, label, requireTrue = false) {
  assertExactKeys(value, SAFETY_INVARIANTS, label);
  const invariants = Object.fromEntries(SAFETY_INVARIANTS.map((field) => [
    field,
    assertBoolean(value[field], `${label}.${field}`),
  ]));
  if (requireTrue && Object.values(invariants).some((entry) => !entry)) {
    throw new Error(`${label} must require every safety invariant`);
  }
  return invariants;
}

function validateTopology(value, label) {
  assertExactKeys(value, ['workflow', 'schedulerMode', 'workspaceMode', 'fallbackMode'], label);
  const topology = {
    workflow: assertEnum(value.workflow, WORKFLOWS, `${label}.workflow`),
    schedulerMode: assertEnum(value.schedulerMode, SCHEDULER_MODES, `${label}.schedulerMode`),
    workspaceMode: assertEnum(value.workspaceMode, WORKSPACE_MODES, `${label}.workspaceMode`),
    fallbackMode: assertEnum(value.fallbackMode, FALLBACK_MODES, `${label}.fallbackMode`),
  };
  if (topology.fallbackMode === 'shared' && topology.workspaceMode !== 'shared') {
    throw new Error(`${label} shared fallback must use shared workspace mode`);
  }
  return topology;
}

function validateDecisionResults(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new Error(`${label} must be a bounded non-empty array`);
  }
  const ids = new Set();
  return value.map((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    assertExactKeys(entry, ['id', 'passed'], entryLabel);
    const id = assertId(entry.id, `${entryLabel}.id`);
    if (ids.has(id)) throw new Error(`${label} must contain unique decision IDs`);
    ids.add(id);
    return { id, passed: assertBoolean(entry.passed, `${entryLabel}.passed`) };
  });
}

function validateSpecificationRubric(value, label) {
  assertExactKeys(value, [
    'usefulDelegationRequired', 'justifiedSkipRequired', 'bestOf2', 'remediationRequired',
    'checks', 'decisions', 'safety', 'topologyRequired',
  ], label);
  const { decisions, safety, topologyRequired, ...legacyRubric } = value;
  return {
    ...validateRubric(legacyRubric, label),
    decisions: assertIdList(decisions, `${label}.decisions`, 1, 32),
    safety: validateSafetyInvariants(safety, `${label}.safety`, true),
    topologyRequired: assertBoolean(topologyRequired, `${label}.topologyRequired`),
  };
}

function validateSyntheticCaptureV2(value, label) {
  assertJsonSize(value, label);
  rejectSensitiveContent(value, label);
  assertExactKeys(value, [
    'mode', 'elapsedMs', 'childCount', 'peakConcurrency', 'usefulDelegation', 'justifiedSkip',
    'bestOf2', 'remediation', 'incidents', 'checks', 'journal', 'decisions', 'safety', 'topology',
  ], label);
  const { decisions, safety, topology, ...legacyCapture } = value;
  return {
    ...validateCapturedRunSummaryV1(legacyCapture),
    decisions: validateDecisionResults(decisions, `${label}.decisions`),
    safety: validateSafetyInvariants(safety, `${label}.safety`),
    topology: validateTopology(topology, `${label}.topology`),
  };
}

function validateSpecificationFixture(value, label) {
  assertExactKeys(value, ['id', 'version', 'kind', 'permittedMutation', 'expectedOutcome'], label);
  if (value.kind !== 'synthetic') throw new Error(`${label}.kind must be synthetic`);
  return {
    id: assertId(value.id, `${label}.id`),
    version: assertInteger(value.version, `${label}.version`, 1, 1_000_000),
    kind: 'synthetic',
    permittedMutation: assertEnum(value.permittedMutation, PERMITTED_MUTATIONS, `${label}.permittedMutation`),
    expectedOutcome: assertEnum(value.expectedOutcome, EXPECTED_OUTCOMES, `${label}.expectedOutcome`),
  };
}

function validateSpecificationContract(value, label) {
  assertExactKeys(value, ['stage', 'fixtureSet', 'environment', 'execution', 'baseline', 'abortConditions'], label);
  if (value.stage !== 'deterministic') throw new Error(`${label}.stage must be deterministic`);

  assertExactKeys(value.fixtureSet, ['id', 'version'], `${label}.fixtureSet`);
  const fixtureSet = {
    id: assertId(value.fixtureSet.id, `${label}.fixtureSet.id`),
    version: assertInteger(value.fixtureSet.version, `${label}.fixtureSet.version`, 1, 1_000_000),
  };

  assertExactKeys(value.environment, [
    'provider', 'modelIds', 'opencodeVersion', 'naruRevision', 'operatingSystem', 'date', 'networkTarget',
  ], `${label}.environment`);
  const environment = {
    provider: assertId(value.environment.provider, `${label}.environment.provider`),
    modelIds: assertIdList(value.environment.modelIds, `${label}.environment.modelIds`, 0, 16),
    opencodeVersion: assertString(value.environment.opencodeVersion, `${label}.environment.opencodeVersion`),
    naruRevision: assertString(value.environment.naruRevision, `${label}.environment.naruRevision`),
    operatingSystem: assertString(value.environment.operatingSystem, `${label}.environment.operatingSystem`),
    date: assertString(value.environment.date, `${label}.environment.date`),
    networkTarget: assertId(value.environment.networkTarget, `${label}.environment.networkTarget`),
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(environment.date)) throw new Error(`${label}.environment.date must use YYYY-MM-DD`);
  if (environment.provider !== 'none' || environment.modelIds.length !== 0
    || environment.opencodeVersion !== 'not-invoked' || environment.operatingSystem !== 'provider-free'
    || environment.networkTarget !== 'none') {
    throw new Error(`${label}.environment must remain provider-free for deterministic evaluation`);
  }

  assertExactKeys(value.execution, [
    'repetitions', 'perCaseTimeoutMs', 'runTimeoutMs', 'maximumSpendUsdMicros', 'costStopCondition',
  ], `${label}.execution`);
  const execution = {
    repetitions: assertInteger(value.execution.repetitions, `${label}.execution.repetitions`, 1, 100),
    perCaseTimeoutMs: assertInteger(value.execution.perCaseTimeoutMs, `${label}.execution.perCaseTimeoutMs`, 1, 86_400_000),
    runTimeoutMs: assertInteger(value.execution.runTimeoutMs, `${label}.execution.runTimeoutMs`, 1, 86_400_000),
    maximumSpendUsdMicros: assertInteger(value.execution.maximumSpendUsdMicros, `${label}.execution.maximumSpendUsdMicros`, 0),
    costStopCondition: assertId(value.execution.costStopCondition, `${label}.execution.costStopCondition`),
  };
  if (execution.repetitions !== 1 || execution.maximumSpendUsdMicros !== 0
    || execution.costStopCondition !== 'before-provider-call') {
    throw new Error(`${label}.execution must declare one zero-cost repetition and stop before provider calls`);
  }
  if (execution.runTimeoutMs < execution.perCaseTimeoutMs) {
    throw new Error(`${label}.execution.runTimeoutMs must cover at least one case timeout`);
  }

  assertExactKeys(value.baseline, [
    'kind', 'sameInputs', 'sameEnvironment', 'sameTimeout', 'sameModel', 'sameRubric', 'topologyException',
  ], `${label}.baseline`);
  const baseline = {
    kind: assertId(value.baseline.kind, `${label}.baseline.kind`),
    sameInputs: assertBoolean(value.baseline.sameInputs, `${label}.baseline.sameInputs`),
    sameEnvironment: assertBoolean(value.baseline.sameEnvironment, `${label}.baseline.sameEnvironment`),
    sameTimeout: assertBoolean(value.baseline.sameTimeout, `${label}.baseline.sameTimeout`),
    sameModel: assertBoolean(value.baseline.sameModel, `${label}.baseline.sameModel`),
    sameRubric: assertBoolean(value.baseline.sameRubric, `${label}.baseline.sameRubric`),
    topologyException: assertId(value.baseline.topologyException, `${label}.baseline.topologyException`),
  };
  if (baseline.kind !== 'single-agent-opencode' || baseline.topologyException !== 'single-agent-only'
    || !baseline.sameInputs || !baseline.sameEnvironment || !baseline.sameTimeout
    || !baseline.sameModel || !baseline.sameRubric) {
    throw new Error(`${label}.baseline must be a matched single-agent OpenCode baseline`);
  }

  const abortConditions = assertIdList(value.abortConditions, `${label}.abortConditions`, REQUIRED_ABORT_CONDITIONS.length, 16);
  if (abortConditions.length !== REQUIRED_ABORT_CONDITIONS.length
    || REQUIRED_ABORT_CONDITIONS.some((entry, index) => abortConditions[index] !== entry)) {
    throw new Error(`${label}.abortConditions must contain the canonical deterministic stop conditions`);
  }

  return { stage: 'deterministic', fixtureSet, environment, execution, baseline, abortConditions };
}

export function validateEvaluationSpecificationV2(value) {
  assertJsonSize(value, 'EvaluationSpecificationV2');
  assertObject(value, 'EvaluationSpecificationV2');
  const { redaction, ...specificationWithoutRedaction } = value;
  rejectSensitiveContent(specificationWithoutRedaction, 'EvaluationSpecificationV2');
  assertExactKeys(value, ['schemaVersion', 'suiteId', 'redaction', 'contract', 'budgets', 'cases'], 'EvaluationSpecificationV2');
  if (value.schemaVersion !== EVALUATION_SPECIFICATION_SCHEMA_VERSION) {
    throw new Error('EvaluationSpecificationV2.schemaVersion must be 2');
  }
  if (!Array.isArray(value.cases) || value.cases.length === 0 || value.cases.length > MAX_CASES) {
    throw new Error('EvaluationSpecificationV2.cases must be a bounded non-empty array');
  }

  const ids = new Set();
  const fixtureIds = new Set();
  const budgets = validateBudget(value.budgets, 'EvaluationSpecificationV2.budgets');
  const contract = validateSpecificationContract(value.contract, 'EvaluationSpecificationV2.contract');
  const cases = value.cases.map((entry, index) => {
    const label = `EvaluationSpecificationV2.cases[${index}]`;
    assertExactKeys(entry, ['id', 'scenario', 'fixture', 'topology', 'budget', 'rubric', 'syntheticCapture'], label);
    const id = assertId(entry.id, `${label}.id`);
    if (ids.has(id)) throw new Error(`EvaluationSpecificationV2 has duplicate case ID: ${id}`);
    ids.add(id);
    const fixture = validateSpecificationFixture(entry.fixture, `${label}.fixture`);
    const fixtureIdentity = `${fixture.id}@${fixture.version}`;
    if (fixtureIds.has(fixtureIdentity)) throw new Error(`EvaluationSpecificationV2 has duplicate fixture identity: ${fixtureIdentity}`);
    fixtureIds.add(fixtureIdentity);
    const topology = validateTopology(entry.topology, `${label}.topology`);
    const budget = validateBudget(entry.budget, `${label}.budget`);
    if (budget.maxPeakConcurrency > budgets.maxPeakConcurrency || budget.maxElapsedMs > budgets.maxElapsedMs
      || budget.maxChildCount > budgets.maxChildCount) {
      throw new Error(`${label}.budget exceeds EvaluationSpecificationV2.budgets`);
    }
    if (budget.maxElapsedMs > contract.execution.perCaseTimeoutMs) {
      throw new Error(`${label}.budget exceeds the contract per-case timeout`);
    }
    if (topology.workflow !== 'implementation' && fixture.permittedMutation !== 'none') {
      throw new Error(`${label} read-only workflows must prohibit mutation`);
    }
    const expectedReadOnlyOutcome = READ_ONLY_EXPECTED_OUTCOMES.get(topology.workflow);
    if (expectedReadOnlyOutcome && fixture.expectedOutcome !== expectedReadOnlyOutcome) {
      throw new Error(`${label}.fixture.expectedOutcome does not match its read-only workflow`);
    }
    return {
      id,
      scenario: assertId(entry.scenario, `${label}.scenario`),
      fixture,
      topology,
      budget,
      rubric: validateSpecificationRubric(entry.rubric, `${label}.rubric`),
      syntheticCapture: validateSyntheticCaptureV2(entry.syntheticCapture, `${label}.syntheticCapture`),
    };
  });

  if (contract.execution.runTimeoutMs < contract.execution.perCaseTimeoutMs * cases.length) {
    throw new Error('EvaluationSpecificationV2.contract.execution.runTimeoutMs must cover every deterministic case');
  }
  const workflows = new Set(cases.map((entry) => entry.topology.workflow));
  const schedulerModes = new Set(cases.map((entry) => entry.topology.schedulerMode));
  if (REQUIRED_WORKFLOWS.some((workflow) => !workflows.has(workflow))) {
    throw new Error('EvaluationSpecificationV2 must cover planning, impact, triage, review, and implementation');
  }
  if (!schedulerModes.has('off') || !cases.some((entry) => entry.topology.schedulerMode === 'observe' || entry.topology.schedulerMode === 'enforce')) {
    throw new Error('EvaluationSpecificationV2 must cover scheduler off and one observe or enforce path');
  }
  if (!cases.some((entry) => entry.topology.workflow === 'implementation'
    && entry.topology.workspaceMode === 'isolated'
    && entry.fixture.permittedMutation === 'scoped-disposable'
    && entry.fixture.expectedOutcome === 'isolated-writer-success')) {
    throw new Error('EvaluationSpecificationV2 must cover isolated-writer success');
  }
  if (!cases.some((entry) => entry.topology.workflow === 'implementation'
    && entry.topology.fallbackMode === 'shared'
    && entry.fixture.permittedMutation === 'scoped-disposable'
    && entry.fixture.expectedOutcome === 'safe-shared-fallback')) {
    throw new Error('EvaluationSpecificationV2 must cover safe shared-mode fallback');
  }
  if (!cases.some((entry) => entry.topology.workflow === 'implementation'
    && entry.fixture.permittedMutation === 'scoped-disposable')) {
    throw new Error('EvaluationSpecificationV2 must cover scoped implementation in a disposable fixture');
  }

  return {
    schemaVersion: EVALUATION_SPECIFICATION_SCHEMA_VERSION,
    suiteId: assertId(value.suiteId, 'EvaluationSpecificationV2.suiteId'),
    redaction: validateSpecificationRedaction(value.redaction, 'EvaluationSpecificationV2.redaction'),
    contract,
    budgets,
    cases,
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

function scoreEvaluationSpecificationCase(value) {
  const { decisions: requiredDecisions, safety: requiredSafety, topologyRequired, ...legacyRubric } = value.rubric;
  const {
    decisions: decisionResults,
    safety: capturedSafety,
    topology: capturedTopology,
    ...legacyCapture
  } = value.syntheticCapture;
  const legacyResult = scoreEvaluationCase({
    id: value.id,
    budget: value.budget,
    rubric: legacyRubric,
    capturedRun: legacyCapture,
  });
  const decisionsById = new Map(decisionResults.map((entry) => [entry.id, entry.passed]));
  const topologyMatches = Object.keys(value.topology)
    .every((field) => capturedTopology[field] === value.topology[field]);
  const points = [
    ...legacyResult.points,
    point('correctnessDecisions', requiredDecisions.every((id) => decisionsById.get(id) === true)
      && decisionResults.every((entry) => entry.passed)),
    ...SAFETY_INVARIANTS.map((field) => point(field, !requiredSafety[field] || capturedSafety[field])),
    point('topology', !topologyRequired || topologyMatches),
  ];
  const earned = points.reduce((total, item) => total + item.score, 0);
  return {
    id: value.id,
    fixtureId: `${value.fixture.id}@${value.fixture.version}`,
    workflow: value.topology.workflow,
    schedulerMode: value.topology.schedulerMode,
    workspaceMode: value.topology.workspaceMode,
    expectedOutcome: value.fixture.expectedOutcome,
    score: Math.max(0, earned * 10 - legacyResult.incidentPenalty),
    maximumScore: points.length * 10,
    passed: earned === points.length && legacyResult.incidentPenalty === 0,
    points,
    incidentPenalty: legacyResult.incidentPenalty,
    incidents: legacyResult.incidents,
  };
}

function evaluateLegacyManifest(value) {
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

function evaluateSpecification(value) {
  const specification = validateEvaluationSpecificationV2(value);
  const results = specification.cases.map(scoreEvaluationSpecificationCase);
  const incidents = { race: 0, schema: 0, gate: 0, authorization: 0 };
  for (const result of results) for (const key of Object.keys(incidents)) incidents[key] += result.incidents[key];
  const unique = (field) => [...new Set(specification.cases.map((entry) => entry.topology[field]))];
  return {
    schemaVersion: EVALUATION_SPECIFICATION_SCHEMA_VERSION,
    suiteId: specification.suiteId,
    stage: specification.contract.stage,
    redaction: specification.redaction,
    contract: specification.contract,
    coverage: {
      workflows: unique('workflow'),
      schedulerModes: unique('schedulerMode'),
      workspaceModes: unique('workspaceMode'),
      fallbackModes: unique('fallbackMode'),
    },
    aggregate: {
      caseCount: results.length,
      passedCases: results.filter((result) => result.passed).length,
      totalScore: results.reduce((total, result) => total + result.score, 0),
      maximumScore: results.reduce((total, result) => total + result.maximumScore, 0),
      incidents,
    },
    results,
  };
}

export function evaluateManifest(value) {
  if (value?.schemaVersion === EVALUATION_SPECIFICATION_SCHEMA_VERSION) return evaluateSpecification(value);
  return evaluateLegacyManifest(value);
}

export function createDryRunPlan(value) {
  const report = evaluateManifest(value);
  if (report.schemaVersion === EVALUATION_SPECIFICATION_SCHEMA_VERSION) {
    return {
      schemaVersion: report.schemaVersion,
      suiteId: report.suiteId,
      stage: report.stage,
      dryRun: true,
      redaction: report.redaction,
      contract: report.contract,
      coverage: report.coverage,
      aggregate: report.aggregate,
      cases: report.results.map(({
        id, fixtureId, workflow, schedulerMode, workspaceMode, expectedOutcome,
        score, maximumScore, passed,
      }) => ({
        id, fixtureId, workflow, schedulerMode, workspaceMode, expectedOutcome,
        score, maximumScore, passed,
      })),
    };
  }
  return {
    schemaVersion: report.schemaVersion,
    suiteId: report.suiteId,
    dryRun: true,
    redaction: report.redaction,
    aggregate: report.aggregate,
    cases: report.results.map(({ id, score, maximumScore, passed }) => ({ id, score, maximumScore, passed })),
  };
}
