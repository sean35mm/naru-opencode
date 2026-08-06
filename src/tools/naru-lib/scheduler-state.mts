import {
  QUALITY_ARTIFACT_TYPES,
  validateAdmissionTokenV1,
  validateArtifactV1,
  validateRunManifestV1,
  validateTransitionArtifactV1,
  validateTransitionTokenV1,
} from './scheduler-protocol.mjs';
import type {
  AdmissionTokenV1,
  ArtifactV1,
  CandidateArtifactV1,
  EvidenceArtifactV1,
  GateArtifactV1,
  GateType,
  JudgmentArtifactV1,
  QualityArtifactType,
  QualityArtifactV1,
  RunManifestV1,
  SchedulerBudgets,
  SchedulerLane,
  ShardArtifactV1,
  TerminalArtifactV1,
  TransitionArtifactV1,
  TransitionTokenV1,
  WorkItemStatus,
  WorkItemV1,
} from './scheduler-protocol.mjs';

type UnknownRecord = Record<string, unknown>;

export interface SchedulerWorkItem extends WorkItemV1 {
  provisional: boolean;
  invalidatedBy: string[];
}

export interface ActiveAdmission {
  tokenId: string;
  workItemId: string;
  lane: SchedulerLane;
}

export interface SchedulerState {
  schemaVersion: 1;
  runId: string;
  revision: number;
  frozen: boolean;
  freezeReason: string | null;
  budgets: SchedulerBudgets;
  judgePasses: number;
  consumedTokenIds: string[];
  artifactIds: string[];
  qualityArtifacts: QualityArtifactV1[];
  activeAdmissions: ActiveAdmission[];
  workItems: SchedulerWorkItem[];
}

export interface SchedulerBudgetUsage {
  writers: number;
  readOnly: number;
  totalChildren: number;
  judgePasses: number;
}

export type MutableConflictClaim =
  | 'ownedWriteScope'
  | 'mutableContractClaims'
  | 'generatedArtifactClaims'
  | 'configurationClaims'
  | 'mutableResourceClaims';

export interface WorkItemConflict {
  field: MutableConflictClaim;
  left: string;
  right: string;
}

export interface ActivePeerConflict extends WorkItemConflict {
  peerWorkItemId: string;
}

export interface AdmissionAllowed {
  allowed: true;
  reason: null;
  conflicts: [];
}

export interface AdmissionDenied {
  allowed: false;
  reason: string;
  conflicts: ActivePeerConflict[];
}

export type AdmissionDecision = AdmissionAllowed | AdmissionDenied;

export type SchedulerEvent =
  | { type: 'admit'; token: AdmissionTokenV1; now: number | undefined }
  | {
    type: 'transition';
    token: TransitionTokenV1;
    artifact: TransitionArtifactV1;
    now: number | undefined;
  }
  | { type: 'append-quality-artifact'; artifact: QualityArtifactV1 }
  | { type: 'invalidate'; workItemId: string; reason: string; expectedRevision: number }
  | { type: 'unfreeze'; reason: string; expectedRevision: number }
  | { type: 'consume-judge-budget'; expectedRevision: number };

const TERMINAL_SUCCESS = 'terminal-contained';
const ALLOWED_TRANSITIONS: Readonly<Record<WorkItemStatus, ReadonlySet<WorkItemStatus>>> = Object.freeze({
  pending: new Set<WorkItemStatus>(['ready', 'blocked', 'invalidated']),
  ready: new Set<WorkItemStatus>(['blocked', 'invalidated']),
  active: new Set<WorkItemStatus>(['terminal-contained', 'blocked', 'failed', 'invalidated']),
  'terminal-contained': new Set<WorkItemStatus>(['invalidated']),
  blocked: new Set<WorkItemStatus>(['ready', 'invalidated']),
  failed: new Set<WorkItemStatus>(['ready', 'invalidated']),
  invalidated: new Set<WorkItemStatus>(['ready']),
});

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertPlainObject(value: unknown, label: string): asserts value is UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
}

function assertExactKeys(value: unknown, fields: readonly string[], label: string): asserts value is UnknownRecord {
  assertPlainObject(value, label);
  const allowed = new Set(fields);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown fields: ${unknown.sort().join(', ')}`);
  const missing = fields.filter((field) => !Object.hasOwn(value, field));
  if (missing.length > 0) throw new Error(`${label} is missing required fields: ${missing.join(', ')}`);
}

function itemById(state: SchedulerState, workItemId: unknown): SchedulerWorkItem {
  const item = state.workItems.find((candidate) => candidate.workItemId === workItemId);
  if (!item) throw new Error(`unknown work item: ${workItemId}`);
  return item;
}

function assertCas(state: SchedulerState, expectedRevision: unknown): asserts expectedRevision is number {
  if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error('expectedRevision must be a non-negative safe integer');
  }
  if (state.revision !== expectedRevision) {
    throw new Error(`CAS mismatch: expected revision ${expectedRevision}, current revision ${state.revision}`);
  }
}

function wildcardRegex(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === undefined) continue;
    if (character === '*' && pattern[index + 1] === '*') {
      source += '.*';
      index += 1;
    } else if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

function staticPrefix(scope: string): string {
  const wildcard = scope.search(/[*?{[]/);
  return (wildcard === -1 ? scope : scope.slice(0, wildcard)).replace(/\/$/, '');
}

export function scopeCoversPath(scope: string, path: string): boolean {
  if (scope === path) return true;
  if (!/[*?{[]/.test(scope)) return false;
  return wildcardRegex(scope).test(path);
}

function scopesMayOverlap(left: string, right: string): boolean {
  if (left === right || scopeCoversPath(left, right) || scopeCoversPath(right, left)) return true;
  const leftPrefix = staticPrefix(left);
  const rightPrefix = staticPrefix(right);
  if (!leftPrefix || !rightPrefix) return true;
  if (!left.includes('*') && !left.includes('?') && !right.includes('*') && !right.includes('?')) return false;
  return leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix);
}

function stringClaimsMayOverlap(left: string, right: string): boolean {
  return left === right || left === '*' || right === '*';
}

export function findWorkItemConflicts(left: WorkItemV1, right: WorkItemV1): WorkItemConflict[] {
  const conflicts: WorkItemConflict[] = [];
  const compare = (field: MutableConflictClaim, overlap: (left: string, right: string) => boolean): void => {
    for (const leftValue of left[field]) {
      for (const rightValue of right[field]) {
        if (overlap(leftValue, rightValue)) {
          conflicts.push({ field, left: leftValue, right: rightValue });
        }
      }
    }
  };
  compare('ownedWriteScope', scopesMayOverlap);
  compare('mutableContractClaims', stringClaimsMayOverlap);
  compare('generatedArtifactClaims', stringClaimsMayOverlap);
  compare('configurationClaims', stringClaimsMayOverlap);
  compare('mutableResourceClaims', stringClaimsMayOverlap);
  return conflicts.sort((a, b) => {
    const leftKey = `${a.field}\0${a.left}\0${a.right}`;
    const rightKey = `${b.field}\0${b.left}\0${b.right}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

export function workItemsConflict(left: WorkItemV1, right: WorkItemV1): boolean {
  return findWorkItemConflicts(left, right).length > 0;
}

function dependenciesComplete(state: SchedulerState, item: SchedulerWorkItem): boolean {
  return item.dependencies.every((dependency) => itemById(state, dependency).status === TERMINAL_SUCCESS);
}

function refreshReadiness(state: SchedulerState): void {
  for (const item of state.workItems) {
    if (item.status === 'pending' && dependenciesComplete(state, item)) {
      item.status = 'ready';
      item.provisional = item.dependencies.length > 0;
    }
  }
}

export function createSchedulerState(manifestValue: unknown): SchedulerState {
  const manifest = validateRunManifestV1(manifestValue);
  const state: SchedulerState = {
    schemaVersion: 1,
    runId: manifest.runId,
    revision: manifest.revision,
    frozen: false,
    freezeReason: null,
    budgets: clone(manifest.budgets),
    judgePasses: 0,
    consumedTokenIds: [],
    artifactIds: [],
    qualityArtifacts: [],
    activeAdmissions: [],
    workItems: manifest.workItems.map((item) => ({
      ...clone(item),
      provisional: false,
      invalidatedBy: [],
    })),
  };
  if (state.workItems.some((item) => item.status === 'active')) {
    throw new Error('RunManifestV1 cannot initialize an active item without an admission token');
  }
  for (const item of state.workItems) {
    if (item.status === 'ready' && !dependenciesComplete(state, item)) item.status = 'pending';
  }
  refreshReadiness(state);
  return state;
}

export function getReadyWorkItems(state: SchedulerState): string[] {
  return state.workItems
    .filter((item) => item.status === 'ready' && dependenciesComplete(state, item))
    .map((item) => item.workItemId)
    .sort();
}

export const readyWorkItemIds = getReadyWorkItems;

export function budgetUsage(state: SchedulerState): SchedulerBudgetUsage {
  const writers = state.activeAdmissions.filter((admission) => admission.lane === 'writer').length;
  const readOnly = state.activeAdmissions.filter((admission) => admission.lane === 'read-only').length;
  return { writers, readOnly, totalChildren: writers + readOnly, judgePasses: state.judgePasses };
}

function activePeerIds(state: SchedulerState): string[] {
  return state.activeAdmissions.map((admission) => admission.workItemId).sort();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function admissionDecision(
  state: SchedulerState,
  tokenValue: unknown,
  { now }: { now?: unknown } = {},
): AdmissionDecision {
  let token: AdmissionTokenV1;
  try {
    token = validateAdmissionTokenV1(tokenValue);
  } catch (error) {
    return { allowed: false, reason: errorMessage(error), conflicts: [] };
  }
  if (token.runId !== state.runId) return { allowed: false, reason: 'run ID mismatch', conflicts: [] };
  if (token.expectedRevision !== state.revision) return { allowed: false, reason: 'CAS mismatch', conflicts: [] };
  if (state.frozen) return { allowed: false, reason: 'scheduler is frozen', conflicts: [] };
  if (now !== undefined) {
    if (typeof now !== 'number' || !Number.isSafeInteger(now) || now < 0) {
      return { allowed: false, reason: 'now is invalid', conflicts: [] };
    }
    if (now < token.issuedAt || now >= token.expiresAt) {
      return { allowed: false, reason: 'admission token is not currently valid', conflicts: [] };
    }
  }
  if (state.consumedTokenIds.includes(token.tokenId)) {
    return { allowed: false, reason: 'admission token was already consumed', conflicts: [] };
  }
  let item;
  try {
    item = itemById(state, token.workItemId);
  } catch (error) {
    return { allowed: false, reason: errorMessage(error), conflicts: [] };
  }
  const admissibleStatus = token.lane === 'writer'
    ? item.status === 'ready' && dependenciesComplete(state, item)
    : (item.status === 'ready' && dependenciesComplete(state, item)) || item.status === TERMINAL_SUCCESS;
  if (!admissibleStatus) {
    return { allowed: false, reason: 'work item is not ready', conflicts: [] };
  }
  if (state.activeAdmissions.some((admission) => admission.workItemId === item.workItemId)) {
    return { allowed: false, reason: 'work item already has an active admission', conflicts: [] };
  }
  if (JSON.stringify(token.activePeerIds) !== JSON.stringify(activePeerIds(state))) {
    return { allowed: false, reason: 'active peer snapshot is stale', conflicts: [] };
  }
  const usage = budgetUsage(state);
  if (usage.totalChildren >= state.budgets.maxTotalChildren) {
    return { allowed: false, reason: 'total child budget exhausted', conflicts: [] };
  }
  if (token.lane === 'writer' && usage.writers >= state.budgets.maxConcurrentWriters) {
    return { allowed: false, reason: 'writer budget exhausted', conflicts: [] };
  }
  if (token.lane === 'read-only' && usage.readOnly >= state.budgets.maxConcurrentReadOnly) {
    return { allowed: false, reason: 'read-only budget exhausted', conflicts: [] };
  }
  const conflicts: ActivePeerConflict[] = [];
  for (const admission of state.activeAdmissions) {
    const peer = itemById(state, admission.workItemId);
    for (const conflict of findWorkItemConflicts(item, peer)) {
      conflicts.push({ peerWorkItemId: peer.workItemId, ...conflict });
    }
  }
  if (conflicts.length > 0) return { allowed: false, reason: 'active peer conflict', conflicts };
  return { allowed: true, reason: null, conflicts: [] };
}

export function canAdmitWorkItem(
  state: SchedulerState,
  token: unknown,
  options?: { now?: unknown },
): boolean {
  return admissionDecision(state, token, options).allowed;
}

export function admitWorkItem(
  stateValue: SchedulerState,
  tokenValue: unknown,
  options: { now?: unknown } = {},
): SchedulerState {
  const state = clone(stateValue);
  const token = validateAdmissionTokenV1(tokenValue);
  assertCas(state, token.expectedRevision);
  const decision = admissionDecision(state, token, options);
  if (!decision.allowed) throw new Error(`admission refused: ${decision.reason}`);
  const item = itemById(state, token.workItemId);
  if (token.lane === 'writer') {
    item.status = 'active';
    item.provisional = item.provisional || item.dependencies.length > 0;
  }
  state.activeAdmissions.push({
    tokenId: token.tokenId,
    workItemId: token.workItemId,
    lane: token.lane,
  });
  state.activeAdmissions.sort((a, b) => a.tokenId < b.tokenId ? -1 : a.tokenId > b.tokenId ? 1 : 0);
  state.consumedTokenIds.push(token.tokenId);
  state.consumedTokenIds.sort();
  state.revision += 1;
  return state;
}

function descendantsOf(state: SchedulerState, workItemId: string): string[] {
  const descendants = new Set<string>();
  const queue = [workItemId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    for (const item of state.workItems) {
      if (item.dependencies.includes(current) && !descendants.has(item.workItemId)) {
        descendants.add(item.workItemId);
        queue.push(item.workItemId);
      }
    }
  }
  return [...descendants].sort();
}

function invalidateDescendantsInPlace(state: SchedulerState, workItemId: string, reason: string): string[] {
  const descendants = descendantsOf(state, workItemId);
  for (const descendantId of descendants) {
    const item = itemById(state, descendantId);
    item.status = 'invalidated';
    item.provisional = true;
    if (!item.invalidatedBy.includes(reason)) item.invalidatedBy.push(reason);
    item.invalidatedBy.sort();
  }
  const invalidated = new Set(descendants);
  state.activeAdmissions = state.activeAdmissions.filter((entry) => !invalidated.has(entry.workItemId));
  return descendants;
}

export function invalidateDescendants(
  stateValue: SchedulerState,
  workItemId: unknown,
  reason: unknown,
  expectedRevision: unknown = stateValue.revision,
): SchedulerState {
  if (typeof reason !== 'string' || reason.length === 0 || reason.length > 512) {
    throw new Error('invalidation reason is invalid');
  }
  const state = clone(stateValue);
  assertCas(state, expectedRevision);
  const item = itemById(state, workItemId);
  invalidateDescendantsInPlace(state, item.workItemId, reason);
  state.frozen = true;
  state.freezeReason = reason;
  state.revision += 1;
  return state;
}

function artifactMatchesToken(artifact: TransitionArtifactV1, token: TransitionTokenV1): void {
  const pairs = [
    ['transitionTokenId', 'tokenId'],
    ['runId', 'runId'],
    ['workItemId', 'workItemId'],
    ['expectedRevision', 'expectedRevision'],
    ['fromStatus', 'fromStatus'],
    ['toStatus', 'toStatus'],
  ] as const;
  for (const [artifactField, tokenField] of pairs) {
    if (artifact[artifactField] !== token[tokenField]) {
      throw new Error(`transition artifact does not match token field: ${artifactField}`);
    }
  }
}

function assertChangedPathsContained(item: SchedulerWorkItem, changedPaths: string[]): void {
  for (const path of changedPaths) {
    if (!item.ownedWriteScope.some((scope) => scopeCoversPath(scope, path))) {
      throw new Error(`changed path is outside ${item.workItemId} ownership: ${path}`);
    }
  }
}

function hasQualityArtifactType<TType extends QualityArtifactType>(
  artifact: QualityArtifactV1,
  artifactType: TType,
): artifact is Extract<QualityArtifactV1, { artifactType: TType }> {
  return artifact.artifactType === artifactType;
}

function qualityArtifactById<TType extends QualityArtifactType>(
  state: SchedulerState,
  artifactId: string,
  artifactType: TType,
): Extract<QualityArtifactV1, { artifactType: TType }> {
  const artifact = state.qualityArtifacts.find((candidate) => candidate.artifactId === artifactId);
  if (!artifact) throw new Error(`unknown quality artifact: ${artifactId}`);
  if (!hasQualityArtifactType(artifact, artifactType)) {
    throw new Error(`quality artifact ${artifactId} must be ${artifactType}`);
  }
  return artifact;
}

type CandidateCorrelatedArtifact = ShardArtifactV1 | JudgmentArtifactV1 | GateArtifactV1;

function assertCandidateCorrelation(
  candidate: CandidateArtifactV1,
  artifact: CandidateCorrelatedArtifact,
  label: string,
): void {
  for (const field of ['candidateIdentity', 'candidateStateDigest'] as const) {
    if (artifact[field] !== candidate[field]) throw new Error(`${label} candidate ${field} mismatch`);
  }
}

function assertQuiescent(state: SchedulerState, label: string): void {
  if (state.activeAdmissions.length > 0) throw new Error(`${label} requires scheduler quiescence`);
}

function appendEvidence(state: SchedulerState, artifact: EvidenceArtifactV1): void {
  for (const workItemId of artifact.workItemIds) itemById(state, workItemId);
  const admission = state.activeAdmissions.find((entry) => entry.tokenId === artifact.admissionTokenId);
  if (!admission || admission.lane !== 'read-only' || !artifact.workItemIds.includes(admission.workItemId)) {
    throw new Error('evidence artifact does not correlate to a read-only admission');
  }
}

function appendTerminal(state: SchedulerState, artifact: TerminalArtifactV1): void {
  const item = itemById(state, artifact.workItemId);
  const admission = state.activeAdmissions.find((entry) => entry.tokenId === artifact.admissionTokenId);
  if (!admission || admission.workItemId !== artifact.workItemId || item.status !== 'active') {
    throw new Error('terminal artifact does not correlate to an active admission');
  }
  assertChangedPathsContained(item, artifact.changedPaths);
  for (const reportId of artifact.dependencyReportIds) {
    const dependency = state.qualityArtifacts.find((candidate): candidate is TerminalArtifactV1 => (
      hasQualityArtifactType(candidate, 'terminal') && candidate.reportId === reportId
    ));
    if (!dependency) throw new Error(`terminal artifact has unknown dependency report: ${reportId}`);
    if (!item.dependencies.includes(dependency.workItemId)) {
      throw new Error(`terminal artifact dependency report is not a direct dependency: ${reportId}`);
    }
  }
}

function appendCandidate(state: SchedulerState, artifact: CandidateArtifactV1): void {
  assertQuiescent(state, 'candidate artifact');
  const expectedIds = state.workItems.map((item) => item.workItemId).sort();
  if (JSON.stringify(artifact.workItemIds) !== JSON.stringify(expectedIds)) {
    throw new Error('candidate artifact must cover every work item');
  }
  if (artifact.terminalArtifactIds.length !== expectedIds.length) {
    throw new Error('candidate artifact must correlate one terminal artifact per work item');
  }
  const terminalWorkItems = [];
  const terminalChangedPaths = new Set<string>();
  for (const artifactId of artifact.terminalArtifactIds) {
    const terminal = qualityArtifactById(state, artifactId, 'terminal');
    if (terminal.cohortId !== artifact.cohortId || terminal.outcome !== TERMINAL_SUCCESS) {
      throw new Error(`candidate terminal artifact is not contained in cohort: ${artifactId}`);
    }
    terminalWorkItems.push(terminal.workItemId);
    for (const path of terminal.changedPaths) terminalChangedPaths.add(path);
  }
  if (JSON.stringify(terminalWorkItems.sort()) !== JSON.stringify(expectedIds)) {
    throw new Error('candidate terminal artifacts do not correlate to every work item');
  }
  for (const item of state.workItems) {
    if (item.status !== TERMINAL_SUCCESS) throw new Error(`candidate work item is not terminal-contained: ${item.workItemId}`);
  }
  if (JSON.stringify(artifact.changedPaths) !== JSON.stringify([...terminalChangedPaths].sort())) {
    throw new Error('candidate changed paths must equal the correlated terminal changed-path union');
  }
  for (const path of artifact.changedPaths) {
    if (!state.workItems.some((item) => item.ownedWriteScope.some((scope) => scopeCoversPath(scope, path)))) {
      throw new Error(`candidate changed path is outside the ownership union: ${path}`);
    }
  }
}

function appendShard(state: SchedulerState, artifact: ShardArtifactV1): void {
  const candidate = qualityArtifactById(state, artifact.candidateArtifactId, 'candidate');
  assertCandidateCorrelation(candidate, artifact, 'shard artifact');
  const admission = state.activeAdmissions.find((entry) => entry.tokenId === artifact.admissionTokenId);
  if (!admission || admission.lane !== 'read-only' || !artifact.workItemIds.includes(admission.workItemId)) {
    throw new Error('shard artifact does not correlate to a read-only admission');
  }
  if (artifact.workItemIds.length === 0 || artifact.coveredChecks.length === 0) {
    throw new Error('shard artifact must cover at least one work item and check');
  }
  for (const workItemId of artifact.workItemIds) {
    if (!candidate.workItemIds.includes(workItemId)) throw new Error(`shard has unknown candidate work item: ${workItemId}`);
  }
  const declaredChecks = new Set(artifact.workItemIds.flatMap((workItemId) => itemById(state, workItemId).verificationNeeds));
  for (const check of artifact.coveredChecks) {
    if (!declaredChecks.has(check)) throw new Error(`shard covers an undeclared check: ${check}`);
  }
  const existing = state.qualityArtifacts.filter((entry): entry is ShardArtifactV1 => (
    hasQualityArtifactType(entry, 'shard') && entry.candidateArtifactId === candidate.artifactId
  ));
  if (existing.length >= state.budgets.maxConcurrentReadOnly) throw new Error('verification shard budget exhausted');
  for (const other of existing) {
    const overlap = artifact.mutableResourceClaims.filter((claim) => other.mutableResourceClaims.includes(claim));
    if (overlap.length > 0) throw new Error(`verification shards share mutable resources: ${overlap.join(', ')}`);
  }
}

function passedGate(
  state: SchedulerState,
  candidateArtifactId: string,
  gateType: GateType,
): GateArtifactV1 | undefined {
  return state.qualityArtifacts.find((artifact): artifact is GateArtifactV1 => (
    hasQualityArtifactType(artifact, 'gate') &&
    artifact.candidateArtifactId === candidateArtifactId &&
    artifact.gateType === gateType &&
    artifact.status === 'passed'
  ));
}

function appendJudgment(state: SchedulerState, artifact: JudgmentArtifactV1): void {
  const candidate = qualityArtifactById(state, artifact.candidateArtifactId, 'candidate');
  assertCandidateCorrelation(candidate, artifact, 'judgment artifact');
  const admission = state.activeAdmissions.find((entry) => entry.tokenId === artifact.admissionTokenId);
  if (!admission || admission.lane !== 'read-only' || !candidate.workItemIds.includes(admission.workItemId)) {
    throw new Error('judgment artifact does not correlate to a read-only admission');
  }
  if (state.activeAdmissions.some((entry) => entry.tokenId !== admission.tokenId)) {
    throw new Error('judgment artifact requires no other active admissions');
  }
  if (!passedGate(state, candidate.artifactId, 'verification')) {
    throw new Error('judgment artifact requires a passed verification gate');
  }
  const shards = state.qualityArtifacts.filter((entry): entry is ShardArtifactV1 => (
    hasQualityArtifactType(entry, 'shard') && entry.candidateArtifactId === candidate.artifactId
  ));
  if (JSON.stringify(artifact.shardArtifactIds) !== JSON.stringify(shards.map((entry) => entry.artifactId).sort())) {
    throw new Error('judgment artifact must correlate every candidate shard');
  }
  if (artifact.judgePass !== state.judgePasses + 1) throw new Error('judgment artifact judge pass is stale');
  if (state.judgePasses >= state.budgets.maxJudgePasses) throw new Error('judge budget exhausted');
  state.judgePasses += 1;
}

function appendGate(state: SchedulerState, artifact: GateArtifactV1): void {
  assertQuiescent(state, 'gate artifact');
  const candidate = qualityArtifactById(state, artifact.candidateArtifactId, 'candidate');
  assertCandidateCorrelation(candidate, artifact, 'gate artifact');
  if (artifact.status === 'passed' && (
    artifact.observedIdentity !== candidate.candidateIdentity ||
    artifact.observedStateDigest !== candidate.candidateStateDigest
  )) {
    throw new Error('passed gate observation does not exactly match the candidate');
  }
  if (artifact.status === 'passed' && artifact.reasonCodes.length > 0) {
    throw new Error('passed gate cannot contain reason codes');
  }
  if (artifact.status === 'blocked' && artifact.reasonCodes.length === 0) {
    throw new Error('blocked gate requires a reason code');
  }
  const shards = state.qualityArtifacts.filter((entry): entry is ShardArtifactV1 => (
    hasQualityArtifactType(entry, 'shard') && entry.candidateArtifactId === candidate.artifactId
  ));
  if (artifact.gateType === 'verification') {
    if (artifact.judgmentArtifactId !== null) throw new Error('verification gate cannot reference a judgment');
    if (artifact.status === 'passed') {
      if (shards.length === 0 || shards.length > state.budgets.maxConcurrentReadOnly) {
        throw new Error('verification gate requires a bounded non-empty shard set');
      }
      if (shards.some((shard) => shard.candidateValidity !== 'exact-match' || shard.outcome !== 'passed')) {
        throw new Error('verification gate requires passed exact-candidate shards');
      }
      const coveredItems = new Set(shards.flatMap((shard) => shard.workItemIds));
      const coveredChecks = new Set(shards.flatMap((shard) => shard.coveredChecks));
      for (const workItemId of candidate.workItemIds) {
        const item = itemById(state, workItemId);
        if (!coveredItems.has(workItemId)) throw new Error(`verification gate misses work item: ${workItemId}`);
        for (const check of item.verificationNeeds) {
          if (!coveredChecks.has(check)) throw new Error(`verification gate misses required check: ${check}`);
        }
      }
    }
    return;
  }
  if (!artifact.judgmentArtifactId) throw new Error(`${artifact.gateType} gate requires a judgment artifact`);
  const judgment = qualityArtifactById(state, artifact.judgmentArtifactId, 'judgment');
  if (judgment.candidateArtifactId !== candidate.artifactId) throw new Error('gate judgment candidate mismatch');
  if (artifact.gateType === 'judgment') {
    if (artifact.status === 'passed' && !passedGate(state, candidate.artifactId, 'verification')) {
      throw new Error('judgment gate requires a passed verification gate');
    }
    return;
  }
  if (artifact.status === 'passed') {
    if (!passedGate(state, candidate.artifactId, 'judgment')) {
      throw new Error('completion gate requires a passed judgment gate');
    }
    if (judgment.verdict !== 'ready') throw new Error('completion gate requires a ready judgment');
  }
}

function isQualityArtifact(artifact: ArtifactV1): artifact is QualityArtifactV1 {
  return artifact.artifactType !== 'transition';
}

export function appendQualityArtifact(
  stateValue: SchedulerState,
  artifactValue: unknown,
): SchedulerState {
  const state = clone(stateValue);
  const artifact = validateArtifactV1(artifactValue);
  if (!isQualityArtifact(artifact) || !QUALITY_ARTIFACT_TYPES.includes(artifact.artifactType)) {
    throw new Error('appendQualityArtifact requires a quality artifact');
  }
  assertCas(state, artifact.expectedRevision);
  if (artifact.runId !== state.runId) throw new Error('quality artifact run ID mismatch');
  if (state.artifactIds.includes(artifact.artifactId)) throw new Error('artifact was already consumed');
  if ('reportId' in artifact && artifact.reportId && state.qualityArtifacts.some((entry) => (
    'reportId' in entry && entry.reportId === artifact.reportId
  ))) {
    throw new Error(`quality artifact report ID was already correlated: ${artifact.reportId}`);
  }
  if ('admissionTokenId' in artifact && artifact.admissionTokenId && state.qualityArtifacts.some((entry) => (
    'admissionTokenId' in entry && entry.admissionTokenId === artifact.admissionTokenId
  ))) {
    throw new Error(`quality artifact admission token was already correlated: ${artifact.admissionTokenId}`);
  }
  switch (artifact.artifactType) {
    case 'evidence': appendEvidence(state, artifact); break;
    case 'terminal': appendTerminal(state, artifact); break;
    case 'candidate': appendCandidate(state, artifact); break;
    case 'shard': appendShard(state, artifact); break;
    case 'judgment': appendJudgment(state, artifact); break;
    case 'gate': appendGate(state, artifact); break;
  }
  if (
    artifact.artifactType === 'evidence' ||
    artifact.artifactType === 'shard' ||
    artifact.artifactType === 'judgment'
  ) {
    state.activeAdmissions = state.activeAdmissions.filter((entry) => entry.tokenId !== artifact.admissionTokenId);
  }
  state.qualityArtifacts.push(artifact);
  state.artifactIds.push(artifact.artifactId);
  state.artifactIds.sort();
  state.revision += 1;
  return state;
}

export function transitionWorkItem(
  stateValue: SchedulerState,
  tokenValue: unknown,
  artifactValue: unknown,
  { now }: { now?: unknown } = {},
): SchedulerState {
  const state = clone(stateValue);
  const token = validateTransitionTokenV1(tokenValue);
  const artifact = validateTransitionArtifactV1(artifactValue);
  assertCas(state, token.expectedRevision);
  if (token.runId !== state.runId) throw new Error('transition run ID mismatch');
  if (now !== undefined) {
    if (
      typeof now !== 'number' ||
      !Number.isSafeInteger(now) ||
      now < token.issuedAt ||
      now >= token.expiresAt
    ) {
      throw new Error('transition token is not currently valid');
    }
  }
  if (state.consumedTokenIds.includes(token.tokenId)) throw new Error('transition token was already consumed');
  if (state.artifactIds.includes(artifact.artifactId)) throw new Error('transition artifact was already consumed');
  artifactMatchesToken(artifact, token);
  const item = itemById(state, token.workItemId);
  if (item.status !== token.fromStatus) throw new Error('transition source status is stale');
  if (!ALLOWED_TRANSITIONS[token.fromStatus]?.has(token.toStatus)) {
    throw new Error(`transition ${token.fromStatus} -> ${token.toStatus} is not allowed`);
  }
  const admission = state.activeAdmissions.find((entry) => entry.tokenId === token.admissionTokenId);
  if (token.fromStatus === 'active') {
    if (!admission || admission.workItemId !== token.workItemId) {
      throw new Error('transition admission token does not own the active work item');
    }
  } else if (admission) {
    throw new Error('non-active transition cannot consume an admission');
  }
  const terminalArtifact = state.qualityArtifacts.find((entry): entry is TerminalArtifactV1 => (
    hasQualityArtifactType(entry, 'terminal') && entry.admissionTokenId === token.admissionTokenId
  ));
  if (terminalArtifact) {
    const terminalStatus = terminalArtifact.outcome === 'uncertain-partial'
      ? 'invalidated'
      : terminalArtifact.outcome;
    if (token.toStatus !== terminalStatus) throw new Error('transition does not match the terminal report outcome');
    if (JSON.stringify(artifact.changedPaths) !== JSON.stringify(terminalArtifact.changedPaths)) {
      throw new Error('transition changed paths do not match the terminal report');
    }
  }
  assertChangedPathsContained(item, artifact.changedPaths);
  item.status = token.toStatus;
  state.activeAdmissions = state.activeAdmissions.filter((entry) => entry.tokenId !== token.admissionTokenId);
  state.consumedTokenIds.push(token.tokenId);
  state.consumedTokenIds.sort();
  state.artifactIds.push(artifact.artifactId);
  state.artifactIds.sort();
  if (token.toStatus === TERMINAL_SUCCESS) {
    item.provisional = true;
    refreshReadiness(state);
  } else if (['blocked', 'failed', 'invalidated'].includes(token.toStatus)) {
    const reason = `${token.workItemId}:${token.toStatus}`;
    invalidateDescendantsInPlace(state, token.workItemId, reason);
    state.frozen = true;
    state.freezeReason = reason;
  }
  state.revision += 1;
  return state;
}

export function unfreezeScheduler(
  stateValue: SchedulerState,
  { expectedRevision, reason }: { expectedRevision?: unknown; reason?: unknown } = {},
): SchedulerState {
  const state = clone(stateValue);
  assertCas(state, expectedRevision);
  if (state.activeAdmissions.length > 0) throw new Error('cannot unfreeze while admissions are active');
  if (typeof reason !== 'string' || reason.length === 0 || reason.length > 512) {
    throw new Error('unfreeze reason is invalid');
  }
  state.frozen = false;
  state.freezeReason = null;
  state.revision += 1;
  return state;
}

export function consumeJudgeBudget(
  stateValue: SchedulerState,
  { expectedRevision }: { expectedRevision?: unknown } = {},
): SchedulerState {
  const state = clone(stateValue);
  assertCas(state, expectedRevision);
  if (state.activeAdmissions.length > 0) throw new Error('judge budget is available only at quiescence');
  if (state.judgePasses >= state.budgets.maxJudgePasses) throw new Error('judge budget exhausted');
  state.judgePasses += 1;
  state.revision += 1;
  return state;
}

export function reduceSchedulerState(state: SchedulerState, event: unknown): SchedulerState {
  assertPlainObject(event, 'scheduler event');
  switch (event.type) {
    case 'admit':
      assertExactKeys(event, ['type', 'token', 'now'], 'admit event');
      return admitWorkItem(state, event.token, { now: event.now });
    case 'transition':
      assertExactKeys(event, ['type', 'token', 'artifact', 'now'], 'transition event');
      return transitionWorkItem(state, event.token, event.artifact, { now: event.now });
    case 'append-quality-artifact':
      assertExactKeys(event, ['type', 'artifact'], 'append-quality-artifact event');
      return appendQualityArtifact(state, event.artifact);
    case 'invalidate':
      assertExactKeys(event, ['type', 'workItemId', 'reason', 'expectedRevision'], 'invalidate event');
      return invalidateDescendants(state, event.workItemId, event.reason, event.expectedRevision);
    case 'unfreeze':
      assertExactKeys(event, ['type', 'reason', 'expectedRevision'], 'unfreeze event');
      return unfreezeScheduler(state, event);
    case 'consume-judge-budget':
      assertExactKeys(event, ['type', 'expectedRevision'], 'consume-judge-budget event');
      return consumeJudgeBudget(state, event);
    default:
      throw new Error(`unknown scheduler event: ${String(event.type)}`);
  }
}

export const applySchedulerTransition = reduceSchedulerState;
