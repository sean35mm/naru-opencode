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
] as const);
export const QUALITY_ARTIFACT_TYPES = Object.freeze([
  'evidence',
  'terminal',
  'candidate',
  'shard',
  'judgment',
  'gate',
] as const);

export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];
export type QualityArtifactType = (typeof QUALITY_ARTIFACT_TYPES)[number];
export type ArtifactType = 'transition' | QualityArtifactType;
export type SchedulerLane = 'writer' | 'read-only';
export type TerminalOutcome = 'terminal-contained' | 'blocked' | 'failed' | 'uncertain-partial';
export type ShardCandidateValidity = 'exact-match' | 'invalidated' | 'blocked';
export type ShardOutcome = 'passed' | 'failed' | 'blocked';
export type JudgmentVerdict = 'ready' | 'needs-remediation' | 'blocked';
export type JudgmentConfidence = 'low' | 'medium' | 'high';
export type GateType = 'verification' | 'judgment' | 'completion';
export type GateStatus = 'passed' | 'blocked';
export type EvidenceReportAgent =
  | 'naru-minion-scout'
  | 'naru-minion-investigate'
  | 'naru-minion-architect'
  | 'naru-minion-debug'
  | 'naru-minion-verify';

export interface SchedulerBudgets {
  maxConcurrentWriters: number;
  maxConcurrentReadOnly: number;
  maxTotalChildren: number;
  maxJudgePasses: number;
}

export const DEFAULT_SCHEDULER_BUDGETS: Readonly<SchedulerBudgets> = Object.freeze({
  maxConcurrentWriters: 50,
  maxConcurrentReadOnly: 50,
  maxTotalChildren: 50,
  maxJudgePasses: 3,
});

export const MAX_SCHEDULER_BUDGETS: Readonly<SchedulerBudgets> = Object.freeze({
  maxConcurrentWriters: 50,
  maxConcurrentReadOnly: 50,
  maxTotalChildren: 50,
  maxJudgePasses: 3,
});

export type ClaimCategory =
  | 'ownedWriteScope'
  | 'frozenContractClaims'
  | 'mutableContractClaims'
  | 'generatedArtifactClaims'
  | 'configurationClaims'
  | 'mutableResourceClaims';

export interface WorkItemClaims {
  ownedWriteScope: string[];
  frozenContractClaims: string[];
  mutableContractClaims: string[];
  generatedArtifactClaims: string[];
  configurationClaims: string[];
  mutableResourceClaims: string[];
}

export interface WorkItemV1 extends WorkItemClaims {
  workItemId: string;
  dependencies: string[];
  exclusions: string[];
  verificationNeeds: string[];
  status: WorkItemStatus;
}

export interface RunManifestV1 {
  schemaVersion: typeof SCHEDULER_SCHEMA_VERSION;
  schedulingProtocol: typeof SCHEDULING_PROTOCOL;
  runId: string;
  revision: number;
  budgets: SchedulerBudgets;
  workItems: WorkItemV1[];
}

export interface AdmissionTokenV1 {
  schemaVersion: typeof SCHEDULER_SCHEMA_VERSION;
  tokenType: 'admission';
  tokenId: string;
  runId: string;
  workItemId: string;
  expectedRevision: number;
  lane: SchedulerLane;
  activePeerIds: string[];
  issuedAt: number;
  expiresAt: number;
}

export interface TransitionTokenV1 {
  schemaVersion: typeof SCHEDULER_SCHEMA_VERSION;
  tokenType: 'transition';
  tokenId: string;
  admissionTokenId: string;
  runId: string;
  workItemId: string;
  expectedRevision: number;
  fromStatus: WorkItemStatus;
  toStatus: WorkItemStatus;
  issuedAt: number;
  expiresAt: number;
}

export interface TransitionArtifactV1 {
  schemaVersion: typeof SCHEDULER_SCHEMA_VERSION;
  artifactType: 'transition';
  artifactId: string;
  transitionTokenId: string;
  runId: string;
  workItemId: string;
  expectedRevision: number;
  fromStatus: WorkItemStatus;
  toStatus: WorkItemStatus;
  changedPaths: string[];
}

export interface QualityArtifactBaseV1<TType extends QualityArtifactType> {
  schemaVersion: typeof SCHEDULER_SCHEMA_VERSION;
  artifactType: TType;
  artifactId: string;
  runId: string;
  expectedRevision: number;
}

export interface EvidenceArtifactV1 extends QualityArtifactBaseV1<'evidence'> {
  reportId: string;
  reportAgent: EvidenceReportAgent;
  admissionTokenId: string;
  evidenceId: string;
  workItemIds: string[];
  basisIdentity: string;
  observedPaths: string[];
  validityKeys: string[];
  invalidationKeys: string[];
}

export interface TerminalArtifactV1 extends QualityArtifactBaseV1<'terminal'> {
  cohortId: string;
  workItemId: string;
  reportId: string;
  reportAgent: 'naru-minion-implement';
  admissionTokenId: string;
  outcome: TerminalOutcome;
  changedPaths: string[];
  dependencyReportIds: string[];
}

export interface CandidateArtifactV1 extends QualityArtifactBaseV1<'candidate'> {
  cohortId: string;
  candidateIdentity: string;
  candidateStateDigest: string;
  workItemIds: string[];
  terminalArtifactIds: string[];
  changedPaths: string[];
}

export interface ShardArtifactV1 extends QualityArtifactBaseV1<'shard'> {
  candidateArtifactId: string;
  candidateIdentity: string;
  candidateStateDigest: string;
  shardId: string;
  reportId: string;
  reportAgent: 'naru-minion-verify';
  admissionTokenId: string;
  workItemIds: string[];
  coveredChecks: string[];
  observedPaths: string[];
  mutableResourceClaims: string[];
  candidateValidity: ShardCandidateValidity;
  outcome: ShardOutcome;
}

export interface JudgmentArtifactV1 extends QualityArtifactBaseV1<'judgment'> {
  candidateArtifactId: string;
  candidateIdentity: string;
  candidateStateDigest: string;
  reportId: string;
  reportAgent: 'naru-minion-judge';
  admissionTokenId: string;
  shardArtifactIds: string[];
  verdict: JudgmentVerdict;
  confidence: JudgmentConfidence;
  judgePass: number;
}

export interface GateArtifactV1 extends QualityArtifactBaseV1<'gate'> {
  gateType: GateType;
  candidateArtifactId: string;
  candidateIdentity: string;
  candidateStateDigest: string;
  judgmentArtifactId: string | null;
  observedIdentity: string;
  observedStateDigest: string;
  status: GateStatus;
  reasonCodes: string[];
}

export type QualityArtifactV1 =
  | EvidenceArtifactV1
  | TerminalArtifactV1
  | CandidateArtifactV1
  | ShardArtifactV1
  | JudgmentArtifactV1
  | GateArtifactV1;
export type ArtifactV1 = TransitionArtifactV1 | QualityArtifactV1;

export interface ValidationSizeOptions {
  maxBytes?: number;
}

export interface RunManifestValidationOptions {
  maxBytes?: number;
  maxWorkItems?: number;
}

export interface LegacyProtocol2AdapterOptions {
  mode?: 'off' | 'observe' | 'enforce';
  budgets?: unknown;
}

type UnknownRecord = Record<string, unknown>;
type StringValidator = (value: unknown) => value is string;

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
] as const);

function isPlainObject(value: unknown): value is UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value: unknown, label: string): asserts value is UnknownRecord {
  if (!isPlainObject(value)) throw new Error(`${label} must be a plain object`);
}

function assertAllowedKeys(value: UnknownRecord, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown fields: ${unknown.sort().join(', ')}`);
}

function assertExactKeys(value: UnknownRecord, fields: readonly string[], label: string): void {
  assertAllowedKeys(value, fields, label);
  const missing = fields.filter((field) => !Object.hasOwn(value, field));
  if (missing.length > 0) throw new Error(`${label} is missing required fields: ${missing.join(', ')}`);
}

function assertJsonSize(value: unknown, maximum: number, label: string): void {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON serializable`);
  }
  if (text === undefined) throw new Error(`${label} must be JSON serializable`);
  if (Buffer.byteLength(text, 'utf8') > maximum) throw new Error(`${label} exceeds ${maximum} bytes`);
}

function isSafeString(value: unknown, maximum = MAX_VALUE_LENGTH): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export function isSchedulerId(value: unknown): value is string {
  return (
    isSafeString(value, MAX_ID_LENGTH) &&
    /^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/.test(value)
  );
}

function assertId(value: unknown, label: string): string {
  if (!isSchedulerId(value)) throw new Error(`${label} is not a valid scheduler ID`);
  return value;
}

function assertInteger(
  value: unknown,
  label: string,
  { minimum = 0, maximum = Number.MAX_SAFE_INTEGER }: { minimum?: number; maximum?: number } = {},
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function assertEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  const match = typeof value === 'string' ? allowed.find((entry) => entry === value) : undefined;
  if (match === undefined) {
    throw new Error(`${label} must be one of ${allowed.join(', ')}`);
  }
  return match;
}

function assertDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function assertUniqueStringList(value: unknown, label: string, {
  maximum = MAX_LIST_ITEMS,
  validator = (entry) => isSafeString(entry),
}: { maximum?: number; validator?: StringValidator } = {}): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > maximum) throw new Error(`${label} exceeds ${maximum} entries`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!validator(entry)) throw new Error(`${label}[${index}] is invalid`);
    if (seen.has(entry)) throw new Error(`${label} contains duplicate value: ${entry}`);
    seen.add(entry);
    return entry;
  });
}

export function isSafeScope(value: unknown, { allowGlob = true }: { allowGlob?: boolean } = {}): value is string {
  if (!isSafeString(value, 1024) || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) return false;
  const normalized = value.replaceAll('\\', '/');
  if (/[{}[\]]/.test(normalized) || (!allowGlob && /[*?]/.test(normalized))) return false;
  const parts = normalized.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return false;
  return !parts.some((part) => /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.kube|\.gnupg)$/i.test(part));
}

function validateBudgets(value: unknown, label = 'budgets'): SchedulerBudgets {
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

export function validateSchedulerBudgets(value: unknown): SchedulerBudgets {
  return validateBudgets(value);
}

export function validateWorkItemV1(value: unknown): WorkItemV1 {
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
  const claim = (field: Exclude<keyof WorkItemV1, 'workItemId' | 'dependencies' | 'ownedWriteScope' | 'status'>) => (
    assertUniqueStringList(value[field], `WorkItemV1.${field}`)
  );
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

function assertAcyclic(workItems: WorkItemV1[]): void {
  const byId = new Map(workItems.map((item) => [item.workItemId, item]));
  for (const item of workItems) {
    for (const dependency of item.dependencies) {
      if (!byId.has(dependency)) {
        throw new Error(`WorkItemV1 ${item.workItemId} has unknown dependency: ${dependency}`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string, path: string[]): void {
    if (visiting.has(id)) throw new Error(`work item dependency cycle: ${[...path, id].join(' -> ')}`);
    if (visited.has(id)) return;
    visiting.add(id);
    const item = byId.get(id);
    if (!item) throw new Error(`unknown work item: ${id}`);
    for (const dependency of item.dependencies) visit(dependency, [...path, id]);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of [...byId.keys()].sort()) visit(id, []);
}

export function validateRunManifestV1(value: unknown, {
  maxBytes = MAX_MANIFEST_BYTES,
  maxWorkItems = MAX_WORK_ITEMS,
}: RunManifestValidationOptions = {}): RunManifestV1 {
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
  const ids = new Set<string>();
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

function validateTokenBase(
  value: unknown,
  label: string,
  fields: readonly string[],
  tokenType: AdmissionTokenV1['tokenType'] | TransitionTokenV1['tokenType'],
): asserts value is UnknownRecord {
  assertJsonSize(value, MAX_TOKEN_BYTES, label);
  assertObject(value, label);
  assertExactKeys(value, fields, label);
  if (value.schemaVersion !== SCHEDULER_SCHEMA_VERSION) {
    throw new Error(`${label}.schemaVersion must be ${SCHEDULER_SCHEMA_VERSION}`);
  }
  if (value.tokenType !== tokenType) throw new Error(`${label}.tokenType must be ${tokenType}`);
}

export function validateAdmissionTokenV1(value: unknown): AdmissionTokenV1 {
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

export function validateTransitionTokenV1(value: unknown): TransitionTokenV1 {
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

export function validateTransitionArtifactV1(
  value: unknown,
  { maxBytes = 64 * 1024 }: ValidationSizeOptions = {},
): TransitionArtifactV1 {
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

function validateQualityArtifactBase<TType extends QualityArtifactType>(
  value: unknown,
  label: string,
  fields: readonly string[],
  artifactType: TType,
  maxBytes: number,
): QualityArtifactBaseV1<TType> {
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

function qualityOptions(options: ValidationSizeOptions | undefined): number {
  return options?.maxBytes ?? 64 * 1024;
}

export function validateEvidenceArtifactV1(
  value: unknown,
  options: ValidationSizeOptions = {},
): EvidenceArtifactV1 {
  const label = 'EvidenceArtifactV1';
  const base = validateQualityArtifactBase(
    value,
    label,
    [
      'reportId', 'reportAgent', 'admissionTokenId', 'evidenceId', 'workItemIds', 'basisIdentity',
      'observedPaths', 'validityKeys', 'invalidationKeys',
    ],
    'evidence',
    qualityOptions(options),
  );
  assertObject(value, label);
  return {
    ...base,
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

export function validateTerminalArtifactV1(
  value: unknown,
  options: ValidationSizeOptions = {},
): TerminalArtifactV1 {
  const label = 'TerminalArtifactV1';
  const base = validateQualityArtifactBase(
    value,
    label,
    [
      'cohortId', 'workItemId', 'reportId', 'reportAgent', 'admissionTokenId',
      'outcome', 'changedPaths', 'dependencyReportIds',
    ],
    'terminal',
    qualityOptions(options),
  );
  assertObject(value, label);
  return {
    ...base,
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

export function validateCandidateArtifactV1(
  value: unknown,
  options: ValidationSizeOptions = {},
): CandidateArtifactV1 {
  const label = 'CandidateArtifactV1';
  const base = validateQualityArtifactBase(
    value,
    label,
    [
      'cohortId', 'candidateIdentity', 'candidateStateDigest', 'workItemIds',
      'terminalArtifactIds', 'changedPaths',
    ],
    'candidate',
    qualityOptions(options),
  );
  assertObject(value, label);
  return {
    ...base,
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

export function validateShardArtifactV1(
  value: unknown,
  options: ValidationSizeOptions = {},
): ShardArtifactV1 {
  const label = 'ShardArtifactV1';
  const base = validateQualityArtifactBase(
    value,
    label,
    [
      'candidateArtifactId', 'candidateIdentity', 'candidateStateDigest', 'shardId',
      'reportId', 'reportAgent', 'admissionTokenId', 'workItemIds', 'coveredChecks', 'observedPaths',
      'mutableResourceClaims', 'candidateValidity', 'outcome',
    ],
    'shard',
    qualityOptions(options),
  );
  assertObject(value, label);
  return {
    ...base,
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

export function validateJudgmentArtifactV1(
  value: unknown,
  options: ValidationSizeOptions = {},
): JudgmentArtifactV1 {
  const label = 'JudgmentArtifactV1';
  const base = validateQualityArtifactBase(
    value,
    label,
    [
      'candidateArtifactId', 'candidateIdentity', 'candidateStateDigest', 'reportId',
      'reportAgent', 'admissionTokenId', 'shardArtifactIds', 'verdict', 'confidence', 'judgePass',
    ],
    'judgment',
    qualityOptions(options),
  );
  assertObject(value, label);
  return {
    ...base,
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

export function validateGateArtifactV1(
  value: unknown,
  options: ValidationSizeOptions = {},
): GateArtifactV1 {
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
  assertObject(value, label);
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

export function validateArtifactV1(value: unknown, options: ValidationSizeOptions = {}): ArtifactV1 {
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

export function adaptProtocol2Run(
  value: unknown,
  { mode = 'observe', budgets = DEFAULT_SCHEDULER_BUDGETS }: LegacyProtocol2AdapterOptions = {},
): RunManifestV1 {
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
