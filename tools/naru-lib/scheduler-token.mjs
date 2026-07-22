import { randomUUID } from 'node:crypto';

import { isSchedulerId, validateAdmissionTokenV1 } from './scheduler-protocol.mjs';

const RUNTIME_KEY = Symbol.for('naru.scheduler.runtime.v1');
const MAX_ROOTS = 64;
const MAX_TOKENS = 1024;
const MAX_CALLS = 2048;
const MAX_DESCRIPTION_LENGTH = 4096;
const MARKER_PREFIX = 'naru-admit:v1:';

function newRegistry() {
  return {
    version: 1,
    roots: new Map(),
    admissions: new Map(),
    calls: new Map(),
    journals: new Map(),
    lifecycle: {
      sessions: new Map(),
      taskCalls: new Map(),
      seenEvents: new Map(),
      incidents: new Set(),
    },
  };
}

function ensureRegistry(value) {
  const registry = value && typeof value === 'object' ? value : newRegistry();
  registry.version = 1;
  registry.roots ??= new Map();
  registry.admissions ??= new Map();
  registry.calls ??= new Map();
  registry.journals ??= new Map();
  registry.lifecycle ??= {};
  registry.lifecycle.sessions ??= new Map();
  registry.lifecycle.taskCalls ??= new Map();
  registry.lifecycle.seenEvents ??= new Map();
  registry.lifecycle.incidents ??= new Set();
  return registry;
}

export function getSchedulerRuntimeRegistry() {
  const registry = ensureRegistry(globalThis[RUNTIME_KEY]);
  globalThis[RUNTIME_KEY] = registry;
  return registry;
}

export function probeSchedulerRuntime({ registry = getSchedulerRuntimeRegistry() } = {}) {
  const available = (
    registry?.version === 1 &&
    registry.roots instanceof Map &&
    registry.admissions instanceof Map &&
    registry.calls instanceof Map &&
    typeof structuredClone === 'function'
  );
  return Object.freeze({
    available,
    protocol: available ? 3 : null,
    processLocal: true,
    synchronousAdmission: available,
    durable: false,
    crossProcess: false,
  });
}

function assertId(value, label) {
  if (!isSchedulerId(value)) throw new Error(`${label} is not a valid scheduler ID`);
  return value;
}

function isRuntimeId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function assertRuntimeId(value, label) {
  if (!isRuntimeId(value)) throw new Error(`${label} is not a valid runtime ID`);
  return value;
}

function assertMode(value) {
  if (value !== 'observe' && value !== 'enforce') {
    throw new Error('admission mode must be observe or enforce');
  }
  return value;
}

function canonicalClaims(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('admission claims must be a plain object');
  }
  const keys = [
    'ownedWriteScope',
    'frozenContractClaims',
    'mutableContractClaims',
    'generatedArtifactClaims',
    'configurationClaims',
    'mutableResourceClaims',
  ];
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new Error(`admission claims contain unknown fields: ${unknown.sort().join(', ')}`);
  const claims = {};
  for (const key of keys) {
    if (!Array.isArray(value[key]) || value[key].some((entry) => typeof entry !== 'string')) {
      throw new Error(`admission claims.${key} must be a string array`);
    }
    claims[key] = [...value[key]].sort();
  }
  return claims;
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function capacityError(resource) {
  const error = new Error(`scheduler ${resource} capacity exhausted; no safe historical state can be pruned`);
  error.code = 'scheduler_capacity_exhausted';
  return error;
}

function activeAdmissionTokenIds(registry) {
  return new Set([...registry.roots.values()].flatMap((run) => (
    run.state?.activeAdmissions?.map((admission) => admission.tokenId) ?? []
  )));
}

function deleteAdmission(registry, tokenId) {
  registry.admissions.delete(tokenId);
  for (const [callId, call] of registry.calls) {
    if (call.tokenId === tokenId) registry.calls.delete(callId);
  }
}

function deleteClosedRoot(registry, rootSessionID) {
  registry.roots.delete(rootSessionID);
  registry.journals.delete(rootSessionID);
  for (const [tokenId, admission] of registry.admissions) {
    if (admission.rootSessionID === rootSessionID) deleteAdmission(registry, tokenId);
  }
  for (const [callId, call] of registry.lifecycle.taskCalls) {
    if (call.rootSessionID === rootSessionID) registry.lifecycle.taskCalls.delete(callId);
  }
}

function pruneClosedRoots(registry, maximum) {
  for (const [rootSessionID, run] of registry.roots) {
    if (registry.roots.size <= maximum) break;
    if (run.closed && (run.state?.activeAdmissions?.length ?? 0) === 0) {
      deleteClosedRoot(registry, rootSessionID);
    }
  }
}

function pruneAdmissionHistory(registry, maximum) {
  const activeTokenIds = activeAdmissionTokenIds(registry);
  for (const [tokenId, admission] of registry.admissions) {
    if (registry.admissions.size <= maximum) break;
    if (admission.consumedBy !== null && !activeTokenIds.has(tokenId)) {
      deleteAdmission(registry, tokenId);
    }
  }
}

function pruneCallHistory(registry, maximum) {
  const activeTokenIds = activeAdmissionTokenIds(registry);
  for (const [callId, call] of registry.calls) {
    if (registry.calls.size <= maximum) break;
    if (!activeTokenIds.has(call.tokenId)) registry.calls.delete(callId);
  }
}

function pruneMap(map, maximum) {
  while (map.size > maximum) map.delete(map.keys().next().value);
}

export function pruneSchedulerRuntime(registry = getSchedulerRuntimeRegistry()) {
  pruneClosedRoots(registry, MAX_ROOTS);
  const liveRoots = new Set(registry.roots.keys());
  for (const [tokenId, admission] of registry.admissions) {
    if (!liveRoots.has(admission.rootSessionID)) deleteAdmission(registry, tokenId);
  }
  pruneAdmissionHistory(registry, MAX_TOKENS);
  pruneCallHistory(registry, MAX_CALLS);
  pruneMap(registry.lifecycle.sessions, MAX_ROOTS * 8);
  pruneMap(registry.lifecycle.taskCalls, MAX_CALLS);
  pruneMap(registry.lifecycle.seenEvents, MAX_CALLS);
  while (registry.lifecycle.incidents.size > MAX_CALLS) {
    registry.lifecycle.incidents.delete(registry.lifecycle.incidents.values().next().value);
  }
  return registry;
}

export function ensureSchedulerRootCapacity(registry = getSchedulerRuntimeRegistry()) {
  pruneClosedRoots(registry, MAX_ROOTS - 1);
  if (registry.roots.size >= MAX_ROOTS) throw capacityError('root');
}

function ensureAdmissionCapacity(registry) {
  pruneAdmissionHistory(registry, MAX_TOKENS - 1);
  if (registry.admissions.size >= MAX_TOKENS) throw capacityError('admission');
}

function ensureCallCapacity(registry) {
  pruneCallHistory(registry, MAX_CALLS - 1);
  if (registry.calls.size >= MAX_CALLS) throw capacityError('call');
}

export function admissionClaimsForWorkItem(workItem) {
  return canonicalClaims({
    ownedWriteScope: workItem.ownedWriteScope,
    frozenContractClaims: workItem.frozenContractClaims,
    mutableContractClaims: workItem.mutableContractClaims,
    generatedArtifactClaims: workItem.generatedArtifactClaims,
    configurationClaims: workItem.configurationClaims,
    mutableResourceClaims: workItem.mutableResourceClaims,
  });
}

export function reserveAdmission({
  token,
  rootSessionID,
  parentSessionID,
  target,
  mode,
  claims,
  version = 1,
  nonce = randomUUID(),
}, { registry = getSchedulerRuntimeRegistry() } = {}) {
  const validatedToken = validateAdmissionTokenV1(token);
  assertRuntimeId(rootSessionID, 'rootSessionID');
  assertRuntimeId(parentSessionID, 'parentSessionID');
  assertId(target, 'target');
  assertMode(mode);
  assertId(nonce, 'nonce');
  if (version !== 1) throw new Error('admission binding version must be 1');
  if (!registry.roots.has(rootSessionID)) throw new Error('scheduler root session is unknown');
  if (registry.admissions.has(validatedToken.tokenId)) throw new Error('admission token ID is already reserved');
  ensureAdmissionCapacity(registry);
  const record = {
    token: validatedToken,
    rootSessionID,
    parentSessionID,
    target,
    mode,
    claims: canonicalClaims(claims),
    version,
    nonce,
    consumedBy: null,
  };
  registry.admissions.set(validatedToken.tokenId, record);
  pruneSchedulerRuntime(registry);
  return structuredClone(record);
}

function deny(reason, code = 'invalid_admission') {
  return { allowed: false, idempotent: false, code, reason };
}

export function consumeAdmission({
  tokenId,
  rootSessionID,
  parentSessionID,
  target,
  mode,
  lane,
  claims,
  version = 1,
  callID,
  now = Date.now(),
  onConsume,
}, { registry = getSchedulerRuntimeRegistry() } = {}) {
  if (!isSchedulerId(tokenId)) return deny('admission token marker is invalid', 'invalid_marker');
  if (!isRuntimeId(callID)) return deny('Task callID is required for idempotent admission', 'missing_call_id');
  const prior = registry.calls.get(callID);
  if (prior) {
    if (prior.tokenId !== tokenId) return deny('Task callID was already bound to another token', 'call_id_mismatch');
    let repeatedClaims;
    try {
      repeatedClaims = canonicalClaims(claims);
    } catch {
      return deny('Task callID replay changed its admission binding', 'call_id_mismatch');
    }
    const repeatedBinding = { rootSessionID, parentSessionID, target, mode, lane, claims: repeatedClaims, version };
    if (!sameValue(prior.binding, repeatedBinding)) {
      return deny('Task callID replay changed its admission binding', 'call_id_mismatch');
    }
    return { ...structuredClone(prior.result), idempotent: true };
  }
  const record = registry.admissions.get(tokenId);
  if (!record) return deny('admission token is unknown', 'unknown_token');
  if (record.consumedBy !== null) return deny('admission token was already consumed', 'replayed_token');
  if (!Number.isSafeInteger(now) || now < record.token.issuedAt || now >= record.token.expiresAt) {
    return deny('admission token is expired or not yet valid', 'expired_token');
  }
  const checks = [
    [rootSessionID, record.rootSessionID, 'root session mismatch', 'root_mismatch'],
    [parentSessionID, record.parentSessionID, 'parent session mismatch', 'parent_mismatch'],
    [target, record.target, 'Task target mismatch', 'target_mismatch'],
    [mode, record.mode, 'scheduler mode mismatch', 'mode_mismatch'],
    [lane, record.token.lane, 'scheduler lane mismatch', 'lane_mismatch'],
    [version, record.version, 'admission binding version mismatch', 'version_mismatch'],
  ];
  for (const [actual, expected, reason, code] of checks) {
    if (actual !== expected) return deny(reason, code);
  }
  let normalizedClaims;
  try {
    normalizedClaims = canonicalClaims(claims);
  } catch (error) {
    return deny(error.message, 'claims_invalid');
  }
  if (!sameValue(normalizedClaims, record.claims)) return deny('work item claims mismatch', 'claims_mismatch');

  try {
    ensureCallCapacity(registry);
  } catch (error) {
    return deny(error.message, error.code);
  }

  try {
    if (typeof onConsume === 'function') onConsume(structuredClone(record));
  } catch (error) {
    return deny(error instanceof Error ? error.message : String(error), 'state_refused');
  }
  record.consumedBy = callID;
  const result = {
    allowed: true,
    idempotent: false,
    code: 'admitted',
    reason: null,
    token: structuredClone(record.token),
    rootSessionID: record.rootSessionID,
  };
  registry.calls.set(callID, {
    tokenId,
    binding: { rootSessionID, parentSessionID, target, mode, lane, claims: normalizedClaims, version },
    result,
  });
  pruneSchedulerRuntime(registry);
  return structuredClone(result);
}

export function admissionMarker(tokenId, lane) {
  assertId(tokenId, 'tokenId');
  if (lane !== 'writer' && lane !== 'read-only') throw new Error('admission marker lane must be writer or read-only');
  return `${MARKER_PREFIX}${lane}:${tokenId}`;
}

export function addAdmissionMarker(description, tokenId, lane) {
  const text = description === undefined ? '' : description;
  if (typeof text !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new Error('Task description is invalid');
  }
  const marker = admissionMarker(tokenId, lane);
  const combined = text.length === 0 ? marker : `${text}\n${marker}`;
  if (combined.length > MAX_DESCRIPTION_LENGTH) throw new Error('Task description exceeds admission marker limit');
  return combined;
}

export function parseAdmissionMarker(description) {
  if (typeof description !== 'string' || description.length === 0) {
    return { ok: false, code: 'missing_marker', reason: 'Task description has no admission marker' };
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return { ok: false, code: 'description_too_large', reason: 'Task description exceeds admission marker limit' };
  }
  const lines = description.split(/\r?\n/);
  const candidates = lines.filter((line) => line.startsWith('naru-admit:'));
  if (candidates.length === 0) {
    return { ok: false, code: 'missing_marker', reason: 'Task description has no admission marker' };
  }
  if (candidates.length !== 1) {
    return { ok: false, code: 'duplicate_marker', reason: 'Task description must contain one admission marker' };
  }
  const match = candidates[0].match(/^naru-admit:v1:(writer|read-only):([A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?)$/);
  if (!match || !isSchedulerId(match[2])) {
    return { ok: false, code: 'invalid_marker', reason: 'Task admission marker is malformed' };
  }
  return { ok: true, lane: match[1], tokenId: match[2], marker: candidates[0] };
}

export function resetSchedulerRuntimeForTests() {
  delete globalThis[RUNTIME_KEY];
}

export const SCHEDULER_RUNTIME_LIMITS = Object.freeze({
  maxRoots: MAX_ROOTS,
  maxTokens: MAX_TOKENS,
  maxCalls: MAX_CALLS,
  maxTaskDescriptionLength: MAX_DESCRIPTION_LENGTH,
});
