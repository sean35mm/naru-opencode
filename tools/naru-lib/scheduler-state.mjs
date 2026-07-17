import {
  QUALITY_ARTIFACT_TYPES,
  validateAdmissionTokenV1,
  validateArtifactV1,
  validateRunManifestV1,
  validateTransitionArtifactV1,
  validateTransitionTokenV1,
} from './scheduler-protocol.mjs';

const TERMINAL_SUCCESS = 'terminal-contained';
const ALLOWED_TRANSITIONS = Object.freeze({
  pending: new Set(['ready', 'blocked', 'invalidated']),
  ready: new Set(['blocked', 'invalidated']),
  active: new Set(['terminal-contained', 'blocked', 'failed', 'invalidated']),
  'terminal-contained': new Set(['invalidated']),
  blocked: new Set(['ready', 'invalidated']),
  failed: new Set(['ready', 'invalidated']),
  invalidated: new Set(['ready']),
});

function clone(value) {
  return structuredClone(value);
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
}

function assertExactKeys(value, fields, label) {
  assertPlainObject(value, label);
  const allowed = new Set(fields);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown fields: ${unknown.sort().join(', ')}`);
  const missing = fields.filter((field) => !Object.hasOwn(value, field));
  if (missing.length > 0) throw new Error(`${label} is missing required fields: ${missing.join(', ')}`);
}

function itemById(state, workItemId) {
  const item = state.workItems.find((candidate) => candidate.workItemId === workItemId);
  if (!item) throw new Error(`unknown work item: ${workItemId}`);
  return item;
}

function assertCas(state, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error('expectedRevision must be a non-negative safe integer');
  }
  if (state.revision !== expectedRevision) {
    throw new Error(`CAS mismatch: expected revision ${expectedRevision}, current revision ${state.revision}`);
  }
}

function wildcardRegex(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
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

function staticPrefix(scope) {
  const wildcard = scope.search(/[*?{[]/);
  return (wildcard === -1 ? scope : scope.slice(0, wildcard)).replace(/\/$/, '');
}

export function scopeCoversPath(scope, path) {
  if (scope === path) return true;
  if (!/[*?{[]/.test(scope)) return false;
  return wildcardRegex(scope).test(path);
}

function scopesMayOverlap(left, right) {
  if (left === right || scopeCoversPath(left, right) || scopeCoversPath(right, left)) return true;
  const leftPrefix = staticPrefix(left);
  const rightPrefix = staticPrefix(right);
  if (!leftPrefix || !rightPrefix) return true;
  if (!left.includes('*') && !left.includes('?') && !right.includes('*') && !right.includes('?')) return false;
  return leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix);
}

function stringClaimsMayOverlap(left, right) {
  return left === right || left === '*' || right === '*';
}

export function findWorkItemConflicts(left, right) {
  const conflicts = [];
  const compare = (field, overlap) => {
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

export function workItemsConflict(left, right) {
  return findWorkItemConflicts(left, right).length > 0;
}

function dependenciesComplete(state, item) {
  return item.dependencies.every((dependency) => itemById(state, dependency).status === TERMINAL_SUCCESS);
}

function refreshReadiness(state) {
  for (const item of state.workItems) {
    if (item.status === 'pending' && dependenciesComplete(state, item)) {
      item.status = 'ready';
      item.provisional = item.dependencies.length > 0;
    }
  }
}

export function createSchedulerState(manifestValue) {
  const manifest = validateRunManifestV1(manifestValue);
  const state = {
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

export function getReadyWorkItems(state) {
  return state.workItems
    .filter((item) => item.status === 'ready' && dependenciesComplete(state, item))
    .map((item) => item.workItemId)
    .sort();
}

export const readyWorkItemIds = getReadyWorkItems;

export function budgetUsage(state) {
  const writers = state.activeAdmissions.filter((admission) => admission.lane === 'writer').length;
  const readOnly = state.activeAdmissions.filter((admission) => admission.lane === 'read-only').length;
  return { writers, readOnly, totalChildren: writers + readOnly, judgePasses: state.judgePasses };
}

function activePeerIds(state) {
  return state.activeAdmissions.map((admission) => admission.workItemId).sort();
}

export function admissionDecision(state, tokenValue, { now } = {}) {
  let token;
  try {
    token = validateAdmissionTokenV1(tokenValue);
  } catch (error) {
    return { allowed: false, reason: error.message, conflicts: [] };
  }
  if (token.runId !== state.runId) return { allowed: false, reason: 'run ID mismatch', conflicts: [] };
  if (token.expectedRevision !== state.revision) return { allowed: false, reason: 'CAS mismatch', conflicts: [] };
  if (state.frozen) return { allowed: false, reason: 'scheduler is frozen', conflicts: [] };
  if (now !== undefined) {
    if (!Number.isSafeInteger(now) || now < 0) return { allowed: false, reason: 'now is invalid', conflicts: [] };
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
    return { allowed: false, reason: error.message, conflicts: [] };
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
  const conflicts = [];
  for (const admission of state.activeAdmissions) {
    const peer = itemById(state, admission.workItemId);
    for (const conflict of findWorkItemConflicts(item, peer)) {
      conflicts.push({ peerWorkItemId: peer.workItemId, ...conflict });
    }
  }
  if (conflicts.length > 0) return { allowed: false, reason: 'active peer conflict', conflicts };
  return { allowed: true, reason: null, conflicts: [] };
}

export function canAdmitWorkItem(state, token, options) {
  return admissionDecision(state, token, options).allowed;
}

export function admitWorkItem(stateValue, tokenValue, options = {}) {
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

function descendantsOf(state, workItemId) {
  const descendants = new Set();
  const queue = [workItemId];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const item of state.workItems) {
      if (item.dependencies.includes(current) && !descendants.has(item.workItemId)) {
        descendants.add(item.workItemId);
        queue.push(item.workItemId);
      }
    }
  }
  return [...descendants].sort();
}

function invalidateDescendantsInPlace(state, workItemId, reason) {
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

export function invalidateDescendants(stateValue, workItemId, reason, expectedRevision = stateValue.revision) {
  if (typeof reason !== 'string' || reason.length === 0 || reason.length > 512) {
    throw new Error('invalidation reason is invalid');
  }
  const state = clone(stateValue);
  assertCas(state, expectedRevision);
  itemById(state, workItemId);
  invalidateDescendantsInPlace(state, workItemId, reason);
  state.frozen = true;
  state.freezeReason = reason;
  state.revision += 1;
  return state;
}

function artifactMatchesToken(artifact, token) {
  const pairs = [
    ['transitionTokenId', 'tokenId'],
    ['runId', 'runId'],
    ['workItemId', 'workItemId'],
    ['expectedRevision', 'expectedRevision'],
    ['fromStatus', 'fromStatus'],
    ['toStatus', 'toStatus'],
  ];
  for (const [artifactField, tokenField] of pairs) {
    if (artifact[artifactField] !== token[tokenField]) {
      throw new Error(`transition artifact does not match token field: ${artifactField}`);
    }
  }
}

function assertChangedPathsContained(item, changedPaths) {
  for (const path of changedPaths) {
    if (!item.ownedWriteScope.some((scope) => scopeCoversPath(scope, path))) {
      throw new Error(`changed path is outside ${item.workItemId} ownership: ${path}`);
    }
  }
}

function qualityArtifactById(state, artifactId, artifactType) {
  const artifact = state.qualityArtifacts.find((candidate) => candidate.artifactId === artifactId);
  if (!artifact) throw new Error(`unknown quality artifact: ${artifactId}`);
  if (artifactType && artifact.artifactType !== artifactType) {
    throw new Error(`quality artifact ${artifactId} must be ${artifactType}`);
  }
  return artifact;
}

function assertCandidateCorrelation(candidate, artifact, label) {
  for (const field of ['candidateIdentity', 'candidateStateDigest']) {
    if (artifact[field] !== candidate[field]) throw new Error(`${label} candidate ${field} mismatch`);
  }
}

function assertQuiescent(state, label) {
  if (state.activeAdmissions.length > 0) throw new Error(`${label} requires scheduler quiescence`);
}

function appendEvidence(state, artifact) {
  for (const workItemId of artifact.workItemIds) itemById(state, workItemId);
  const admission = state.activeAdmissions.find((entry) => entry.tokenId === artifact.admissionTokenId);
  if (!admission || admission.lane !== 'read-only' || !artifact.workItemIds.includes(admission.workItemId)) {
    throw new Error('evidence artifact does not correlate to a read-only admission');
  }
}

function appendTerminal(state, artifact) {
  const item = itemById(state, artifact.workItemId);
  const admission = state.activeAdmissions.find((entry) => entry.tokenId === artifact.admissionTokenId);
  if (!admission || admission.workItemId !== artifact.workItemId || item.status !== 'active') {
    throw new Error('terminal artifact does not correlate to an active admission');
  }
  assertChangedPathsContained(item, artifact.changedPaths);
  for (const reportId of artifact.dependencyReportIds) {
    const dependency = state.qualityArtifacts.find((candidate) => (
      candidate.artifactType === 'terminal' && candidate.reportId === reportId
    ));
    if (!dependency) throw new Error(`terminal artifact has unknown dependency report: ${reportId}`);
    if (!item.dependencies.includes(dependency.workItemId)) {
      throw new Error(`terminal artifact dependency report is not a direct dependency: ${reportId}`);
    }
  }
}

function appendCandidate(state, artifact) {
  assertQuiescent(state, 'candidate artifact');
  const expectedIds = state.workItems.map((item) => item.workItemId).sort();
  if (JSON.stringify(artifact.workItemIds) !== JSON.stringify(expectedIds)) {
    throw new Error('candidate artifact must cover every work item');
  }
  if (artifact.terminalArtifactIds.length !== expectedIds.length) {
    throw new Error('candidate artifact must correlate one terminal artifact per work item');
  }
  const terminalWorkItems = [];
  const terminalChangedPaths = new Set();
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

function appendShard(state, artifact) {
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
  const existing = state.qualityArtifacts.filter((entry) => (
    entry.artifactType === 'shard' && entry.candidateArtifactId === candidate.artifactId
  ));
  if (existing.length >= state.budgets.maxConcurrentReadOnly) throw new Error('verification shard budget exhausted');
  for (const other of existing) {
    const overlap = artifact.mutableResourceClaims.filter((claim) => other.mutableResourceClaims.includes(claim));
    if (overlap.length > 0) throw new Error(`verification shards share mutable resources: ${overlap.join(', ')}`);
  }
}

function passedGate(state, candidateArtifactId, gateType) {
  return state.qualityArtifacts.find((artifact) => (
    artifact.artifactType === 'gate' &&
    artifact.candidateArtifactId === candidateArtifactId &&
    artifact.gateType === gateType &&
    artifact.status === 'passed'
  ));
}

function appendJudgment(state, artifact) {
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
  const shards = state.qualityArtifacts.filter((entry) => (
    entry.artifactType === 'shard' && entry.candidateArtifactId === candidate.artifactId
  ));
  if (JSON.stringify(artifact.shardArtifactIds) !== JSON.stringify(shards.map((entry) => entry.artifactId).sort())) {
    throw new Error('judgment artifact must correlate every candidate shard');
  }
  if (artifact.judgePass !== state.judgePasses + 1) throw new Error('judgment artifact judge pass is stale');
  if (state.judgePasses >= state.budgets.maxJudgePasses) throw new Error('judge budget exhausted');
  state.judgePasses += 1;
}

function appendGate(state, artifact) {
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
  const shards = state.qualityArtifacts.filter((entry) => (
    entry.artifactType === 'shard' && entry.candidateArtifactId === candidate.artifactId
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

export function appendQualityArtifact(stateValue, artifactValue) {
  const state = clone(stateValue);
  const artifact = validateArtifactV1(artifactValue);
  if (!QUALITY_ARTIFACT_TYPES.includes(artifact.artifactType)) {
    throw new Error('appendQualityArtifact requires a quality artifact');
  }
  assertCas(state, artifact.expectedRevision);
  if (artifact.runId !== state.runId) throw new Error('quality artifact run ID mismatch');
  if (state.artifactIds.includes(artifact.artifactId)) throw new Error('artifact was already consumed');
  if (artifact.reportId && state.qualityArtifacts.some((entry) => entry.reportId === artifact.reportId)) {
    throw new Error(`quality artifact report ID was already correlated: ${artifact.reportId}`);
  }
  if (artifact.admissionTokenId && state.qualityArtifacts.some((entry) => (
    entry.admissionTokenId === artifact.admissionTokenId
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
    default: throw new Error(`unsupported quality artifact: ${artifact.artifactType}`);
  }
  if (['evidence', 'shard', 'judgment'].includes(artifact.artifactType)) {
    state.activeAdmissions = state.activeAdmissions.filter((entry) => entry.tokenId !== artifact.admissionTokenId);
  }
  state.qualityArtifacts.push(artifact);
  state.artifactIds.push(artifact.artifactId);
  state.artifactIds.sort();
  state.revision += 1;
  return state;
}

export function transitionWorkItem(stateValue, tokenValue, artifactValue, { now } = {}) {
  const state = clone(stateValue);
  const token = validateTransitionTokenV1(tokenValue);
  const artifact = validateTransitionArtifactV1(artifactValue);
  assertCas(state, token.expectedRevision);
  if (token.runId !== state.runId) throw new Error('transition run ID mismatch');
  if (now !== undefined) {
    if (!Number.isSafeInteger(now) || now < token.issuedAt || now >= token.expiresAt) {
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
  const terminalArtifact = state.qualityArtifacts.find((entry) => (
    entry.artifactType === 'terminal' && entry.admissionTokenId === token.admissionTokenId
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

export function unfreezeScheduler(stateValue, { expectedRevision, reason } = {}) {
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

export function consumeJudgeBudget(stateValue, { expectedRevision } = {}) {
  const state = clone(stateValue);
  assertCas(state, expectedRevision);
  if (state.activeAdmissions.length > 0) throw new Error('judge budget is available only at quiescence');
  if (state.judgePasses >= state.budgets.maxJudgePasses) throw new Error('judge budget exhausted');
  state.judgePasses += 1;
  state.revision += 1;
  return state;
}

export function reduceSchedulerState(state, event) {
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
