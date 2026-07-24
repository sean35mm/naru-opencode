const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ITEM_BYTES = 32 * 1024;
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_WORK_ITEMS = 256;
const MAX_LIST_ITEMS = 128;
const MAX_ID_LENGTH = 128;
const MAX_VALUE_LENGTH = 512;

export const SCHEDULING_PROTOCOL = 3;
export const SCHEDULER_SCHEMA_VERSION = 1;
export const WORK_ITEM_STATUSES = Object.freeze([
  'pending',
  'ready',
  'active',
  'terminal-contained',
  'blocked',
  'failed',
  'invalidated',
]);
export const QUALITY_ARTIFACT_TYPES = Object.freeze([
  'evidence',
  'terminal',
  'candidate',
  'shard',
  'judgment',
  'gate',
]);

export const DEFAULT_SCHEDULER_BUDGETS = Object.freeze({
  maxConcurrentWriters: 10,
  maxConcurrentReadOnly: 10,
  maxTotalChildren: 10,
  maxJudgePasses: 3,
});

export const MAX_SCHEDULER_BUDGETS = Object.freeze({
  maxConcurrentWriters: 50,
  maxConcurrentReadOnly: 50,
  maxTotalChildren: 50,
  maxJudgePasses: 3,
});

const WORK_ITEM_FIELDS = Object.freeze([
  'workItemId',
  'dependencies',
  'ownedWriteScope',
  'frozenContractClaims',
  'mutableContractClaims',
  'generatedArtifactClaims',
  'configurationClaims',
  'mutableResourceClaims',
  'exclusions',
  'verificationNeeds',
  'status',
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be a plain object`);
}

function assertAllowedKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown fields: ${unknown.sort().join(', ')}`);
}

function assertExactKeys(value, fields, label) {
  assertAllowedKeys(value, fields, label);
  const missing = fields.filter((field) => !Object.hasOwn(value, field));
  if (missing.length > 0) throw new Error(`${label} is missing required fields: ${missing.join(', ')}`);
}

function assertJsonSize(value, maximum, label) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON serializable`);
  }
  if (text === undefined) throw new Error(`${label} must be JSON serializable`);
  if (Buffer.byteLength(text, 'utf8') > maximum) throw new Error(`${label} exceeds ${maximum} bytes`);
}

function isSafeString(value, maximum = MAX_VALUE_LENGTH) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export function isSchedulerId(value) {
  return (
    isSafeString(value, MAX_ID_LENGTH) &&
    /^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/.test(value)
  );
}

function assertId(value, label) {
  if (!isSchedulerId(value)) throw new Error(`${label} is not a valid scheduler ID`);
  return value;
}

function assertInteger(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function assertEnum(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`${label} must be one of ${allowed.join(', ')}`);
  return value;
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function assertUniqueStringList(value, label, {
  maximum = MAX_LIST_ITEMS,
  validator = (entry) => isSafeString(entry),
} = {}) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > maximum) throw new Error(`${label} exceeds ${maximum} entries`);
  const seen = new Set();
  return value.map((entry, index) => {
    if (!validator(entry)) throw new Error(`${label}[${index}] is invalid`);
    if (seen.has(entry)) throw new Error(`${label} contains duplicate value: ${entry}`);
    seen.add(entry);
    return entry;
  });
}

export function isSafeScope(value, { allowGlob = true } = {}) {
  if (!isSafeString(value, 1024) || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) return false;
  const normalized = value.replaceAll('\\', '/');
  if (/[{}[\]]/.test(normalized) || (!allowGlob && /[*?]/.test(normalized))) return false;
  const parts = normalized.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return false;
  return !parts.some((part) => /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.kube|\.gnupg)$/i.test(part));
}

function validateBudgets(value, label = 'budgets') {
  assertObject(value, label);
  assertExactKeys(value, Object.keys(DEFAULT_SCHEDULER_BUDGETS), label);
  const budgets = {
    maxConcurrentWriters: assertInteger(value.maxConcurrentWriters, `${label}.maxConcurrentWriters`, {
      minimum: 1,
      maximum: MAX_SCHEDULER_BUDGETS.maxConcurrentWriters,
    }),
    maxConcurrentReadOnly: assertInteger(value.maxConcurrentReadOnly, `${label}.maxConcurrentReadOnly`, {
      minimum: 0,
      maximum: MAX_SCHEDULER_BUDGETS.maxConcurrentReadOnly,
    }),
    maxTotalChildren: assertInteger(value.maxTotalChildren, `${label}.maxTotalChildren`, {
      minimum: 1,
      maximum: MAX_SCHEDULER_BUDGETS.maxTotalChildren,
    }),
    maxJudgePasses: assertInteger(value.maxJudgePasses, `${label}.maxJudgePasses`, {
      minimum: 1,
      maximum: MAX_SCHEDULER_BUDGETS.maxJudgePasses,
    }),
  };
  if (budgets.maxConcurrentWriters > budgets.maxTotalChildren) {
    throw new Error(`${label}.maxConcurrentWriters cannot exceed maxTotalChildren`);
  }
  if (budgets.maxConcurrentReadOnly > budgets.maxTotalChildren) {
    throw new Error(`${label}.maxConcurrentReadOnly cannot exceed maxTotalChildren`);
  }
  return budgets;
}

export function validateSchedulerBudgets(value) {
  return validateBudgets(value);
}

export function validateWorkItemV1(value) {
  assertJsonSize(value, MAX_ITEM_BYTES, 'WorkItemV1');
  assertObject(value, 'WorkItemV1');
  assertExactKeys(value, WORK_ITEM_FIELDS, 'WorkItemV1');
  const workItemId = assertId(value.workItemId, 'WorkItemV1.workItemId');
  const dependencies = assertUniqueStringList(value.dependencies, 'WorkItemV1.dependencies', {
    validator: isSchedulerId,
  });
  if (dependencies.includes(workItemId)) throw new Error(`WorkItemV1 ${workItemId} cannot depend on itself`);
  const ownedWriteScope = assertUniqueStringList(value.ownedWriteScope, 'WorkItemV1.ownedWriteScope', {
    validator: (entry) => isSafeScope(entry),
  });
  const claim = (field) => assertUniqueStringList(value[field], `WorkItemV1.${field}`);
  return {
    workItemId,
    dependencies,
    ownedWriteScope,
    frozenContractClaims: claim('frozenContractClaims'),
    mutableContractClaims: claim('mutableContractClaims'),
    generatedArtifactClaims: claim('generatedArtifactClaims'),
    configurationClaims: claim('configurationClaims'),
    mutableResourceClaims: claim('mutableResourceClaims'),
    exclusions: claim('exclusions'),
    verificationNeeds: claim('verificationNeeds'),
    status: assertEnum(value.status, WORK_ITEM_STATUSES, 'WorkItemV1.status'),
  };
}

function assertAcyclic(workItems) {
  const byId = new Map(workItems.map((item) => [item.workItemId, item]));
  for (const item of workItems) {
    for (const dependency of item.dependencies) {
      if (!byId.has(dependency)) {
        throw new Error(`WorkItemV1 ${item.workItemId} has unknown dependency: ${dependency}`);
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id, path) {
    if (visiting.has(id)) throw new Error(`work item dependency cycle: ${[...path, id].join(' -> ')}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependencies) visit(dependency, [...path, id]);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of [...byId.keys()].sort()) visit(id, []);
}

export function validateRunManifestV1(value, {
  maxBytes = MAX_MANIFEST_BYTES,
  maxWorkItems = MAX_WORK_ITEMS,
} = {}) {
  assertInteger(maxBytes, 'maxBytes', { minimum: 1024, maximum: 1024 * 1024 });
  assertInteger(maxWorkItems, 'maxWorkItems', { minimum: 1, maximum: MAX_WORK_ITEMS });
  assertJsonSize(value, maxBytes, 'RunManifestV1');
  assertObject(value, 'RunManifestV1');
  assertExactKeys(
    value,
    ['schemaVersion', 'schedulingProtocol', 'runId', 'revision', 'budgets', 'workItems'],
    'RunManifestV1',
  );
  if (value.schemaVersion !== SCHEDULER_SCHEMA_VERSION) {
    throw new Error(`RunManifestV1.schemaVersion must be ${SCHEDULER_SCHEMA_VERSION}`);
  }
  if (value.schedulingProtocol !== SCHEDULING_PROTOCOL) {
    throw new Error(`RunManifestV1.schedulingProtocol must be ${SCHEDULING_PROTOCOL}`);
  }
  if (!Array.isArray(value.workItems) || value.workItems.length === 0) {
    throw new Error('RunManifestV1.workItems must be a non-empty array');
  }
  if (value.workItems.length > maxWorkItems) {
    throw new Error(`RunManifestV1.workItems exceeds ${maxWorkItems} entries`);
  }
  const workItems = value.workItems.map(validateWorkItemV1);
  const ids = new Set();
  for (const item of workItems) {
    if (ids.has(item.workItemId)) throw new Error(`duplicate workItemId: ${item.workItemId}`);
    ids.add(item.workItemId);
  }
  assertAcyclic(workItems);
  return {
    schemaVersion: SCHEDULER_SCHEMA_VERSION,
    schedulingProtocol: SCHEDULING_PROTOCOL,
    runId: assertId(value.runId, 'RunManifestV1.runId'),
    revision: assertInteger(value.revision, 'RunManifestV1.revision'),
    budgets: validateBudgets(value.budgets, 'RunManifestV1.budgets'),
    workItems,
  };
}

function validateTokenBase(value, label, fields, tokenType) {
  assertJsonSize(value, MAX_TOKEN_BYTES, label);
  assertObject(value, label);
  assertExactKeys(value, fields, label);
  if (value.schemaVersion !== SCHEDULER_SCHEMA_VERSION) {
    throw new Error(`${label}.schemaVersion must be ${SCHEDULER_SCHEMA_VERSION}`);
  }
  if (value.tokenType !== tokenType) throw new Error(`${label}.tokenType must be ${tokenType}`);
}

export function validateAdmissionTokenV1(value) {
  const label = 'AdmissionTokenV1';
  validateTokenBase(
    value,
    label,
    [
      'schemaVersion', 'tokenType', 'tokenId', 'runId', 'workItemId', 'expectedRevision',
      'lane', 'activePeerIds', 'issuedAt', 'expiresAt',
    ],
    'admission',
  );
  const issuedAt = assertInteger(value.issuedAt, `${label}.issuedAt`);
  const expiresAt = assertInteger(value.expiresAt, `${label}.expiresAt`, { minimum: issuedAt + 1 });
  return {
    schemaVersion: SCHEDULER_SCHEMA_VERSION,
    tokenType: 'admission',
    tokenId: assertId(value.tokenId, `${label}.tokenId`),
    runId: assertId(value.runId, `${label}.runId`),
    workItemId: assertId(value.workItemId, `${label}.workItemId`),
    expectedRevision: assertInteger(value.expectedRevision, `${label}.expectedRevision`),
    lane: assertEnum(value.lane, ['writer', 'read-only'], `${label}.lane`),
    activePeerIds: assertUniqueStringList(value.activePeerIds, `${label}.activePeerIds`, {
      validator: isSchedulerId,
    }).sort(),
    issuedAt,
    expiresAt,
  };
}

export function validateTransitionTokenV1(value) {
  const label = 'TransitionTokenV1';
  validateTokenBase(
    value,
    label,
    [
      'schemaVersion', 'tokenType', 'tokenId', 'admissionTokenId', 'runId', 'workItemId',
      'expectedRevision', 'fromStatus', 'toStatus', 'issuedAt', 'expiresAt',
    ],
    'transition',
  );
  const issuedAt = assertInteger(value.issuedAt, `${label}.issuedAt`);
  const expiresAt = assertInteger(value.expiresAt, `${label}.expiresAt`, { minimum: issuedAt + 1 });
  return {
    schemaVersion: SCHEDULER_SCHEMA_VERSION,
    tokenType: 'transition',
    tokenId: assertId(value.tokenId, `${label}.tokenId`),
    admissionTokenId: assertId(value.admissionTokenId, `${label}.admissionTokenId`),
    runId: assertId(value.runId, `${label}.runId`),
    workItemId: assertId(value.workItemId, `${label}.workItemId`),
    expectedRevision: assertInteger(value.expectedRevision, `${label}.expectedRevision`),
    fromStatus: assertEnum(value.fromStatus, WORK_ITEM_STATUSES, `${label}.fromStatus`),
    toStatus: assertEnum(value.toStatus, WORK_ITEM_STATUSES, `${label}.toStatus`),
    issuedAt,
    expiresAt,
  };
}

export function validateTransitionArtifactV1(value, { maxBytes = 64 * 1024 } = {}) {
  const label = 'TransitionArtifactV1';
  assertInteger(maxBytes, 'maxBytes', { minimum: 1024, maximum: 256 * 1024 });
  assertJsonSize(value, maxBytes, label);
  assertObject(value, label);
  assertExactKeys(
    value,
    [
      'schemaVersion', 'artifactType', 'artifactId', 'transitionTokenId', 'runId', 'workItemId',
      'expectedRevision', 'fromStatus', 'toStatus', 'changedPaths',
    ],
    label,
  );
  if (value.schemaVersion !== SCHEDULER_SCHEMA_VERSION) {
    throw new Error(`${label}.schemaVersion must be ${SCHEDULER_SCHEMA_VERSION}`);
  }
  if (value.artifactType !== 'transition') throw new Error(`${label}.artifactType must be transition`);
  return {
    schemaVersion: SCHEDULER_SCHEMA_VERSION,
    artifactType: 'transition',
    artifactId: assertId(value.artifactId, `${label}.artifactId`),
    transitionTokenId: assertId(value.transitionTokenId, `${label}.transitionTokenId`),
    runId: assertId(value.runId, `${label}.runId`),
    workItemId: assertId(value.workItemId, `${label}.workItemId`),
    expectedRevision: assertInteger(value.expectedRevision, `${label}.expectedRevision`),
    fromStatus: assertEnum(value.fromStatus, WORK_ITEM_STATUSES, `${label}.fromStatus`),
    toStatus: assertEnum(value.toStatus, WORK_ITEM_STATUSES, `${label}.toStatus`),
    changedPaths: assertUniqueStringList(value.changedPaths, `${label}.changedPaths`, {
      maximum: 256,
      validator: (entry) => isSafeScope(entry, { allowGlob: false }),
    }).sort(),
  };
}

function validateQualityArtifactBase(value, label, fields, artifactType, maxBytes) {
  assertInteger(maxBytes, 'maxBytes', { minimum: 1024, maximum: 256 * 1024 });
  assertJsonSize(value, maxBytes, label);
  assertObject(value, label);
  assertExactKeys(
    value,
    ['schemaVersion', 'artifactType', 'artifactId', 'runId', 'expectedRevision', ...fields],
    label,
  );
  if (value.schemaVersion !== SCHEDULER_SCHEMA_VERSION) {
    throw new Error(`${label}.schemaVersion must be ${SCHEDULER_SCHEMA_VERSION}`);
  }
  if (value.artifactType !== artifactType) throw new Error(`${label}.artifactType must be ${artifactType}`);
  return {
    schemaVersion: SCHEDULER_SCHEMA_VERSION,
    artifactType,
    artifactId: assertId(value.artifactId, `${label}.artifactId`),
    runId: assertId(value.runId, `${label}.runId`),
    expectedRevision: assertInteger(value.expectedRevision, `${label}.expectedRevision`),
  };
}

function qualityOptions(options) {
  return options?.maxBytes ?? 64 * 1024;
}

export function validateEvidenceArtifactV1(value, options = {}) {
  const label = 'EvidenceArtifactV1';
  return {
    ...validateQualityArtifactBase(
      value,
      label,
      [
        'reportId', 'reportAgent', 'admissionTokenId', 'evidenceId', 'workItemIds', 'basisIdentity',
        'observedPaths', 'validityKeys', 'invalidationKeys',
      ],
      'evidence',
      qualityOptions(options),
    ),
    reportId: assertId(value.reportId, `${label}.reportId`),
    reportAgent: assertEnum(
      value.reportAgent,
      [
        'naru-minion-scout', 'naru-minion-investigate', 'naru-minion-architect',
        'naru-minion-debug', 'naru-minion-verify',
      ],
      `${label}.reportAgent`,
    ),
    admissionTokenId: assertId(value.admissionTokenId, `${label}.admissionTokenId`),
    evidenceId: assertId(value.evidenceId, `${label}.evidenceId`),
    workItemIds: assertUniqueStringList(value.workItemIds, `${label}.workItemIds`, { validator: isSchedulerId }).sort(),
    basisIdentity: assertId(value.basisIdentity, `${label}.basisIdentity`),
    observedPaths: assertUniqueStringList(value.observedPaths, `${label}.observedPaths`, {
      maximum: 256,
      validator: (entry) => isSafeScope(entry, { allowGlob: false }),
    }).sort(),
    validityKeys: assertUniqueStringList(value.validityKeys, `${label}.validityKeys`).sort(),
    invalidationKeys: assertUniqueStringList(value.invalidationKeys, `${label}.invalidationKeys`).sort(),
  };
}

export function validateTerminalArtifactV1(value, options = {}) {
  const label = 'TerminalArtifactV1';
  return {
    ...validateQualityArtifactBase(
      value,
      label,
      [
        'cohortId', 'workItemId', 'reportId', 'reportAgent', 'admissionTokenId',
        'outcome', 'changedPaths', 'dependencyReportIds',
      ],
      'terminal',
      qualityOptions(options),
    ),
    cohortId: assertId(value.cohortId, `${label}.cohortId`),
    workItemId: assertId(value.workItemId, `${label}.workItemId`),
    reportId: assertId(value.reportId, `${label}.reportId`),
    reportAgent: assertEnum(value.reportAgent, ['naru-minion-implement'], `${label}.reportAgent`),
    admissionTokenId: assertId(value.admissionTokenId, `${label}.admissionTokenId`),
    outcome: assertEnum(
      value.outcome,
      ['terminal-contained', 'blocked', 'failed', 'uncertain-partial'],
      `${label}.outcome`,
    ),
    changedPaths: assertUniqueStringList(value.changedPaths, `${label}.changedPaths`, {
      maximum: 256,
      validator: (entry) => isSafeScope(entry, { allowGlob: false }),
    }).sort(),
    dependencyReportIds: assertUniqueStringList(value.dependencyReportIds, `${label}.dependencyReportIds`, {
      validator: isSchedulerId,
    }).sort(),
  };
}

export function validateCandidateArtifactV1(value, options = {}) {
  const label = 'CandidateArtifactV1';
  return {
    ...validateQualityArtifactBase(
      value,
      label,
      [
        'cohortId', 'candidateIdentity', 'candidateStateDigest', 'workItemIds',
        'terminalArtifactIds', 'changedPaths',
      ],
      'candidate',
      qualityOptions(options),
    ),
    cohortId: assertId(value.cohortId, `${label}.cohortId`),
    candidateIdentity: assertId(value.candidateIdentity, `${label}.candidateIdentity`),
    candidateStateDigest: assertDigest(value.candidateStateDigest, `${label}.candidateStateDigest`),
    workItemIds: assertUniqueStringList(value.workItemIds, `${label}.workItemIds`, { validator: isSchedulerId }).sort(),
    terminalArtifactIds: assertUniqueStringList(value.terminalArtifactIds, `${label}.terminalArtifactIds`, {
      validator: isSchedulerId,
    }).sort(),
    changedPaths: assertUniqueStringList(value.changedPaths, `${label}.changedPaths`, {
      maximum: 256,
      validator: (entry) => isSafeScope(entry, { allowGlob: false }),
    }).sort(),
  };
}

export function validateShardArtifactV1(value, options = {}) {
  const label = 'ShardArtifactV1';
  return {
    ...validateQualityArtifactBase(
      value,
      label,
      [
        'candidateArtifactId', 'candidateIdentity', 'candidateStateDigest', 'shardId',
        'reportId', 'reportAgent', 'admissionTokenId', 'workItemIds', 'coveredChecks', 'observedPaths',
        'mutableResourceClaims', 'candidateValidity', 'outcome',
      ],
      'shard',
      qualityOptions(options),
    ),
    candidateArtifactId: assertId(value.candidateArtifactId, `${label}.candidateArtifactId`),
    candidateIdentity: assertId(value.candidateIdentity, `${label}.candidateIdentity`),
    candidateStateDigest: assertDigest(value.candidateStateDigest, `${label}.candidateStateDigest`),
    shardId: assertId(value.shardId, `${label}.shardId`),
    reportId: assertId(value.reportId, `${label}.reportId`),
    reportAgent: assertEnum(value.reportAgent, ['naru-minion-verify'], `${label}.reportAgent`),
    admissionTokenId: assertId(value.admissionTokenId, `${label}.admissionTokenId`),
    workItemIds: assertUniqueStringList(value.workItemIds, `${label}.workItemIds`, { validator: isSchedulerId }).sort(),
    coveredChecks: assertUniqueStringList(value.coveredChecks, `${label}.coveredChecks`).sort(),
    observedPaths: assertUniqueStringList(value.observedPaths, `${label}.observedPaths`, {
      maximum: 256,
      validator: (entry) => isSafeScope(entry, { allowGlob: false }),
    }).sort(),
    mutableResourceClaims: assertUniqueStringList(
      value.mutableResourceClaims,
      `${label}.mutableResourceClaims`,
    ).sort(),
    candidateValidity: assertEnum(
      value.candidateValidity,
      ['exact-match', 'invalidated', 'blocked'],
      `${label}.candidateValidity`,
    ),
    outcome: assertEnum(value.outcome, ['passed', 'failed', 'blocked'], `${label}.outcome`),
  };
}

export function validateJudgmentArtifactV1(value, options = {}) {
  const label = 'JudgmentArtifactV1';
  return {
    ...validateQualityArtifactBase(
      value,
      label,
      [
        'candidateArtifactId', 'candidateIdentity', 'candidateStateDigest', 'reportId',
        'reportAgent', 'admissionTokenId', 'shardArtifactIds', 'verdict', 'confidence', 'judgePass',
      ],
      'judgment',
      qualityOptions(options),
    ),
    candidateArtifactId: assertId(value.candidateArtifactId, `${label}.candidateArtifactId`),
    candidateIdentity: assertId(value.candidateIdentity, `${label}.candidateIdentity`),
    candidateStateDigest: assertDigest(value.candidateStateDigest, `${label}.candidateStateDigest`),
    reportId: assertId(value.reportId, `${label}.reportId`),
    reportAgent: assertEnum(value.reportAgent, ['naru-minion-judge'], `${label}.reportAgent`),
    admissionTokenId: assertId(value.admissionTokenId, `${label}.admissionTokenId`),
    shardArtifactIds: assertUniqueStringList(value.shardArtifactIds, `${label}.shardArtifactIds`, {
      validator: isSchedulerId,
    }).sort(),
    verdict: assertEnum(value.verdict, ['ready', 'needs-remediation', 'blocked'], `${label}.verdict`),
    confidence: assertEnum(value.confidence, ['low', 'medium', 'high'], `${label}.confidence`),
    judgePass: assertInteger(value.judgePass, `${label}.judgePass`, { minimum: 1, maximum: 3 }),
  };
}

export function validateGateArtifactV1(value, options = {}) {
  const label = 'GateArtifactV1';
  const base = validateQualityArtifactBase(
    value,
    label,
    [
      'gateType', 'candidateArtifactId', 'candidateIdentity', 'candidateStateDigest',
      'judgmentArtifactId', 'observedIdentity', 'observedStateDigest', 'status', 'reasonCodes',
    ],
    'gate',
    qualityOptions(options),
  );
  if (value.judgmentArtifactId !== null && !isSchedulerId(value.judgmentArtifactId)) {
    throw new Error(`${label}.judgmentArtifactId must be null or a scheduler ID`);
  }
  return {
    ...base,
    gateType: assertEnum(value.gateType, ['verification', 'judgment', 'completion'], `${label}.gateType`),
    candidateArtifactId: assertId(value.candidateArtifactId, `${label}.candidateArtifactId`),
    candidateIdentity: assertId(value.candidateIdentity, `${label}.candidateIdentity`),
    candidateStateDigest: assertDigest(value.candidateStateDigest, `${label}.candidateStateDigest`),
    judgmentArtifactId: value.judgmentArtifactId,
    observedIdentity: assertId(value.observedIdentity, `${label}.observedIdentity`),
    observedStateDigest: assertDigest(value.observedStateDigest, `${label}.observedStateDigest`),
    status: assertEnum(value.status, ['passed', 'blocked'], `${label}.status`),
    reasonCodes: assertUniqueStringList(value.reasonCodes, `${label}.reasonCodes`, {
      validator: isSchedulerId,
    }).sort(),
  };
}

export function validateArtifactV1(value, options = {}) {
  assertObject(value, 'ArtifactV1');
  switch (value.artifactType) {
    case 'transition': return validateTransitionArtifactV1(value, options);
    case 'evidence': return validateEvidenceArtifactV1(value, options);
    case 'terminal': return validateTerminalArtifactV1(value, options);
    case 'candidate': return validateCandidateArtifactV1(value, options);
    case 'shard': return validateShardArtifactV1(value, options);
    case 'judgment': return validateJudgmentArtifactV1(value, options);
    case 'gate': return validateGateArtifactV1(value, options);
    default: throw new Error(`ArtifactV1.artifactType must be transition or one of ${QUALITY_ARTIFACT_TYPES.join(', ')}`);
  }
}

export function adaptProtocol2Run(value, { mode = 'observe', budgets = DEFAULT_SCHEDULER_BUDGETS } = {}) {
  if (mode === 'enforce') throw new Error('Protocol 2 cannot be adapted in enforce mode');
  if (mode !== 'off' && mode !== 'observe') throw new Error('legacy adapter mode must be off or observe');
  assertJsonSize(value, MAX_MANIFEST_BYTES, 'Protocol 2 run');
  assertObject(value, 'Protocol 2 run');
  assertAllowedKeys(
    value,
    [
      'schedulingProtocol', 'runId', 'cohortId', 'workItem', 'workItems', 'runBaseline',
      'cohortBaseline', 'itemDispatchBaseline', 'provisionalDependencyStatus', 'activePeerClaims',
    ],
    'Protocol 2 run',
  );
  if (value.schedulingProtocol !== 2) throw new Error('legacy adapter requires schedulingProtocol 2');
  if (Object.hasOwn(value, 'workItem') === Object.hasOwn(value, 'workItems')) {
    throw new Error('Protocol 2 run must contain exactly one of workItem or workItems');
  }
  const sourceItems = Object.hasOwn(value, 'workItems') ? value.workItems : [value.workItem];
  if (!Array.isArray(sourceItems)) throw new Error('Protocol 2 workItems must be an array');
  const manifest = {
    schemaVersion: SCHEDULER_SCHEMA_VERSION,
    schedulingProtocol: SCHEDULING_PROTOCOL,
    runId: value.runId ?? value.cohortId,
    revision: 0,
    budgets: validateBudgets(budgets),
    workItems: sourceItems,
  };
  return validateRunManifestV1(manifest);
}

export const adaptProtocol2Manifest = adaptProtocol2Run;

export const SCHEDULER_PROTOCOL_LIMITS = Object.freeze({
  maxManifestBytes: MAX_MANIFEST_BYTES,
  maxWorkItemBytes: MAX_ITEM_BYTES,
  maxTokenBytes: MAX_TOKEN_BYTES,
  maxWorkItems: MAX_WORK_ITEMS,
});
