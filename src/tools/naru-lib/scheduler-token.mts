import { randomUUID } from 'node:crypto';

import { isSchedulerId, validateAdmissionTokenV1 } from './scheduler-protocol.mjs';
import type {
  AdmissionTokenV1,
  SchedulerBudgets,
  SchedulerLane,
  WorkItemClaims,
  WorkItemV1,
} from './scheduler-protocol.mjs';
import type { SchedulerState } from './scheduler-state.mjs';

const RUNTIME_KEY = Symbol.for('naru.scheduler.runtime.v1');
const MAX_ROOTS = 64;
const MAX_TOKENS = 1024;
const MAX_CALLS = 2048;
const MAX_DESCRIPTION_LENGTH = 4096;
const MARKER_PREFIX = 'naru-admit:v1:';

type UnknownRecord = Record<string, unknown>;

export type SchedulerAdmissionMode = 'observe' | 'enforce';

export interface SchedulerRuntimeRun {
  rootSessionID: string;
  agent: string;
  directoryDigest: string;
  runId: string;
  schedulingProtocol: 2 | 3;
  revision: number;
  budgets: SchedulerBudgets;
  state: SchedulerState | null;
  closed: boolean;
  mode?: SchedulerAdmissionMode;
}

export interface SchedulerAdmissionReservation {
  token: AdmissionTokenV1;
  rootSessionID: string;
  parentSessionID: string;
  target: string;
  mode: SchedulerAdmissionMode;
  claims: WorkItemClaims;
  version: 1;
  nonce: string;
  consumedBy: string | null;
}

export interface SchedulerAdmissionBinding {
  rootSessionID: string;
  parentSessionID: string;
  target: string;
  mode: SchedulerAdmissionMode;
  lane: SchedulerLane;
  claims: WorkItemClaims;
  version: 1;
}

export interface SchedulerAdmissionAllowed {
  allowed: true;
  idempotent: boolean;
  code: 'admitted';
  reason: null;
  token: AdmissionTokenV1;
  rootSessionID: string;
}

export type SchedulerAdmissionDenyCode =
  | 'invalid_admission'
  | 'invalid_marker'
  | 'missing_call_id'
  | 'call_id_mismatch'
  | 'unknown_token'
  | 'replayed_token'
  | 'expired_token'
  | 'root_mismatch'
  | 'parent_mismatch'
  | 'target_mismatch'
  | 'mode_mismatch'
  | 'lane_mismatch'
  | 'version_mismatch'
  | 'claims_invalid'
  | 'claims_mismatch'
  | 'scheduler_capacity_exhausted'
  | 'state_refused';

export interface SchedulerAdmissionDenied {
  allowed: false;
  idempotent: false;
  code: SchedulerAdmissionDenyCode;
  reason: string;
}

export type SchedulerAdmissionResult = SchedulerAdmissionAllowed | SchedulerAdmissionDenied;

export interface SchedulerAdmissionCall {
  tokenId: string;
  binding: SchedulerAdmissionBinding;
  result: SchedulerAdmissionAllowed;
}

export interface SchedulerLifecycleSession {
  parentID: string | null;
  lastSequence: number | null;
  updatedAt: number;
}

export interface SchedulerLifecycleTaskCall {
  rootSessionID: string;
  parentSessionID: string | undefined;
  foreground: boolean;
  admitted: boolean;
  afterSeen: boolean;
}

export interface SchedulerLifecycleState {
  sessions: Map<unknown, SchedulerLifecycleSession>;
  taskCalls: Map<unknown, SchedulerLifecycleTaskCall>;
  seenEvents: Map<string, true>;
  incidents: Set<string>;
}

export type SchedulerJournalMetadata =
  | null
  | boolean
  | number
  | string
  | SchedulerJournalMetadata[]
  | { [key: string]: SchedulerJournalMetadata };

export interface SchedulerJournalEntry {
  schemaVersion: 1;
  sequence: number;
  timestamp: number;
  type: string;
  previousDigest: string | null;
  metadata: SchedulerJournalMetadata;
  digest: string;
}

export interface SchedulerRuntimeJournal {
  nextSequence: number;
  entries: SchedulerJournalEntry[];
  runtimeMode: SchedulerAdmissionMode | null;
}

export interface SchedulerRuntimeRegistry {
  version: 1;
  roots: Map<string, SchedulerRuntimeRun>;
  admissions: Map<string, SchedulerAdmissionReservation>;
  calls: Map<string, SchedulerAdmissionCall>;
  journals: Map<string, SchedulerRuntimeJournal>;
  lifecycle: SchedulerLifecycleState;
}

export interface SchedulerRuntimeCapability {
  available: boolean;
  protocol: 3 | null;
  processLocal: true;
  synchronousAdmission: boolean;
  durable: false;
  crossProcess: false;
}

type SchedulerGlobal = typeof globalThis & {
  [RUNTIME_KEY]?: SchedulerRuntimeRegistry;
};

interface SchedulerCapacityError extends Error {
  code: 'scheduler_capacity_exhausted';
}

function newRegistry(): SchedulerRuntimeRegistry {
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

function ensureRegistry(value: unknown): SchedulerRuntimeRegistry {
  const registry = (
    value && typeof value === 'object' ? value : newRegistry()
  ) as Partial<SchedulerRuntimeRegistry> & { lifecycle?: Partial<SchedulerLifecycleState> };
  registry.version = 1;
  registry.roots ??= new Map();
  registry.admissions ??= new Map();
  registry.calls ??= new Map();
  registry.journals ??= new Map();
  const lifecycle: Partial<SchedulerLifecycleState> = registry.lifecycle ?? {};
  lifecycle.sessions ??= new Map();
  lifecycle.taskCalls ??= new Map();
  lifecycle.seenEvents ??= new Map();
  lifecycle.incidents ??= new Set();
  registry.lifecycle = lifecycle as SchedulerLifecycleState;
  return registry as SchedulerRuntimeRegistry;
}

export function getSchedulerRuntimeRegistry(): SchedulerRuntimeRegistry {
  const schedulerGlobal = globalThis as SchedulerGlobal;
  const registry = ensureRegistry(schedulerGlobal[RUNTIME_KEY]);
  schedulerGlobal[RUNTIME_KEY] = registry;
  return registry;
}

export function probeSchedulerRuntime({
  registry = getSchedulerRuntimeRegistry(),
}: { registry?: SchedulerRuntimeRegistry } = {}): Readonly<SchedulerRuntimeCapability> {
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

function assertId(value: unknown, label: string): string {
  if (!isSchedulerId(value)) throw new Error(`${label} is not a valid scheduler ID`);
  return value;
}

function isRuntimeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function assertRuntimeId(value: unknown, label: string): string {
  if (!isRuntimeId(value)) throw new Error(`${label} is not a valid runtime ID`);
  return value;
}

function assertMode(value: unknown): SchedulerAdmissionMode {
  if (value !== 'observe' && value !== 'enforce') {
    throw new Error('admission mode must be observe or enforce');
  }
  return value;
}

function canonicalClaims(value: unknown): WorkItemClaims {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('admission claims must be a plain object');
  }
  const record = value as UnknownRecord;
  const keys = [
    'ownedWriteScope',
    'frozenContractClaims',
    'mutableContractClaims',
    'generatedArtifactClaims',
    'configurationClaims',
    'mutableResourceClaims',
  ] as const;
  const unknown = Object.keys(record).filter((key) => !keys.includes(key as (typeof keys)[number]));
  if (unknown.length > 0) throw new Error(`admission claims contain unknown fields: ${unknown.sort().join(', ')}`);
  const claims = {} as WorkItemClaims;
  for (const key of keys) {
    const entries = record[key];
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== 'string')) {
      throw new Error(`admission claims.${key} must be a string array`);
    }
    claims[key] = [...entries].sort() as string[];
  }
  return claims;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function capacityError(resource: string): SchedulerCapacityError {
  const error = new Error(
    `scheduler ${resource} capacity exhausted; no safe historical state can be pruned`,
  ) as SchedulerCapacityError;
  error.code = 'scheduler_capacity_exhausted';
  return error;
}

function activeAdmissionTokenIds(registry: SchedulerRuntimeRegistry): Set<string> {
  return new Set([...registry.roots.values()].flatMap((run) => (
    run.state?.activeAdmissions?.map((admission) => admission.tokenId) ?? []
  )));
}

function deleteAdmission(registry: SchedulerRuntimeRegistry, tokenId: string): void {
  registry.admissions.delete(tokenId);
  for (const [callId, call] of registry.calls) {
    if (call.tokenId === tokenId) registry.calls.delete(callId);
  }
}

function deleteClosedRoot(registry: SchedulerRuntimeRegistry, rootSessionID: string): void {
  registry.roots.delete(rootSessionID);
  registry.journals.delete(rootSessionID);
  for (const [tokenId, admission] of registry.admissions) {
    if (admission.rootSessionID === rootSessionID) deleteAdmission(registry, tokenId);
  }
  for (const [callId, call] of registry.lifecycle.taskCalls) {
    if (call.rootSessionID === rootSessionID) registry.lifecycle.taskCalls.delete(callId);
  }
}

function pruneClosedRoots(registry: SchedulerRuntimeRegistry, maximum: number): void {
  for (const [rootSessionID, run] of registry.roots) {
    if (registry.roots.size <= maximum) break;
    if (run.closed && (run.state?.activeAdmissions?.length ?? 0) === 0) {
      deleteClosedRoot(registry, rootSessionID);
    }
  }
}

function pruneAdmissionHistory(registry: SchedulerRuntimeRegistry, maximum: number): void {
  const activeTokenIds = activeAdmissionTokenIds(registry);
  for (const [tokenId, admission] of registry.admissions) {
    if (registry.admissions.size <= maximum) break;
    if (admission.consumedBy !== null && !activeTokenIds.has(tokenId)) {
      deleteAdmission(registry, tokenId);
    }
  }
}

function pruneCallHistory(registry: SchedulerRuntimeRegistry, maximum: number): void {
  const activeTokenIds = activeAdmissionTokenIds(registry);
  for (const [callId, call] of registry.calls) {
    if (registry.calls.size <= maximum) break;
    if (!activeTokenIds.has(call.tokenId)) registry.calls.delete(callId);
  }
}

function pruneMap<K, V>(map: Map<K, V>, maximum: number): void {
  while (map.size > maximum) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function pruneSchedulerRuntime(
  registry: SchedulerRuntimeRegistry = getSchedulerRuntimeRegistry(),
): SchedulerRuntimeRegistry {
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
    const oldest = registry.lifecycle.incidents.values().next().value;
    if (oldest === undefined) break;
    registry.lifecycle.incidents.delete(oldest);
  }
  return registry;
}

export function ensureSchedulerRootCapacity(
  registry: SchedulerRuntimeRegistry = getSchedulerRuntimeRegistry(),
): void {
  pruneClosedRoots(registry, MAX_ROOTS - 1);
  if (registry.roots.size >= MAX_ROOTS) throw capacityError('root');
}

function ensureAdmissionCapacity(registry: SchedulerRuntimeRegistry): void {
  pruneAdmissionHistory(registry, MAX_TOKENS - 1);
  if (registry.admissions.size >= MAX_TOKENS) throw capacityError('admission');
}

function ensureCallCapacity(registry: SchedulerRuntimeRegistry): void {
  pruneCallHistory(registry, MAX_CALLS - 1);
  if (registry.calls.size >= MAX_CALLS) throw capacityError('call');
}

export function admissionClaimsForWorkItem(workItem: WorkItemV1): WorkItemClaims {
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
}: {
  token: unknown;
  rootSessionID: unknown;
  parentSessionID: unknown;
  target: unknown;
  mode: unknown;
  claims: unknown;
  version?: unknown;
  nonce?: string;
}, { registry = getSchedulerRuntimeRegistry() }: { registry?: SchedulerRuntimeRegistry } = {}): SchedulerAdmissionReservation {
  const validatedToken = validateAdmissionTokenV1(token);
  const validatedRootSessionID = assertRuntimeId(rootSessionID, 'rootSessionID');
  const validatedParentSessionID = assertRuntimeId(parentSessionID, 'parentSessionID');
  const validatedTarget = assertId(target, 'target');
  const validatedMode = assertMode(mode);
  assertId(nonce, 'nonce');
  if (version !== 1) throw new Error('admission binding version must be 1');
  if (!registry.roots.has(validatedRootSessionID)) throw new Error('scheduler root session is unknown');
  if (registry.admissions.has(validatedToken.tokenId)) throw new Error('admission token ID is already reserved');
  ensureAdmissionCapacity(registry);
  const record: SchedulerAdmissionReservation = {
    token: validatedToken,
    rootSessionID: validatedRootSessionID,
    parentSessionID: validatedParentSessionID,
    target: validatedTarget,
    mode: validatedMode,
    claims: canonicalClaims(claims),
    version,
    nonce,
    consumedBy: null,
  };
  registry.admissions.set(validatedToken.tokenId, record);
  pruneSchedulerRuntime(registry);
  return structuredClone(record);
}

function deny(
  reason: string,
  code: SchedulerAdmissionDenyCode = 'invalid_admission',
): SchedulerAdmissionDenied {
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
}: {
  tokenId: unknown;
  rootSessionID: unknown;
  parentSessionID: unknown;
  target: unknown;
  mode: unknown;
  lane: unknown;
  claims: unknown;
  version?: unknown;
  callID: unknown;
  now?: number;
  onConsume?: (reservation: SchedulerAdmissionReservation) => void;
}, { registry = getSchedulerRuntimeRegistry() }: { registry?: SchedulerRuntimeRegistry } = {}): SchedulerAdmissionResult {
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
  const checks: Array<readonly [unknown, unknown, string, SchedulerAdmissionDenyCode]> = [
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
    return deny(error instanceof Error ? error.message : String(error), 'claims_invalid');
  }
  if (!sameValue(normalizedClaims, record.claims)) return deny('work item claims mismatch', 'claims_mismatch');

  try {
    ensureCallCapacity(registry);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof Error && 'code' in error && error.code === 'scheduler_capacity_exhausted'
      ? error.code
      : 'invalid_admission';
    return deny(message, code);
  }

  try {
    if (typeof onConsume === 'function') onConsume(structuredClone(record));
  } catch (error) {
    return deny(error instanceof Error ? error.message : String(error), 'state_refused');
  }
  record.consumedBy = callID;
  const result: SchedulerAdmissionAllowed = {
    allowed: true,
    idempotent: false,
    code: 'admitted',
    reason: null,
    token: structuredClone(record.token),
    rootSessionID: record.rootSessionID,
  };
  registry.calls.set(callID, {
    tokenId,
    binding: {
      rootSessionID: record.rootSessionID,
      parentSessionID: record.parentSessionID,
      target: record.target,
      mode: record.mode,
      lane: record.token.lane,
      claims: normalizedClaims,
      version: record.version,
    },
    result,
  });
  pruneSchedulerRuntime(registry);
  return structuredClone(result);
}

export function admissionMarker(tokenId: unknown, lane: unknown): string {
  assertId(tokenId, 'tokenId');
  if (lane !== 'writer' && lane !== 'read-only') throw new Error('admission marker lane must be writer or read-only');
  return `${MARKER_PREFIX}${lane}:${tokenId}`;
}

export function addAdmissionMarker(description: unknown, tokenId: unknown, lane: unknown): string {
  const text = description === undefined ? '' : description;
  if (typeof text !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new Error('Task description is invalid');
  }
  const marker = admissionMarker(tokenId, lane);
  const combined = text.length === 0 ? marker : `${text}\n${marker}`;
  if (combined.length > MAX_DESCRIPTION_LENGTH) throw new Error('Task description exceeds admission marker limit');
  return combined;
}

export type AdmissionMarkerErrorCode =
  | 'missing_marker'
  | 'description_too_large'
  | 'duplicate_marker'
  | 'invalid_marker';

export type AdmissionMarkerParseResult =
  | { ok: true; lane: SchedulerLane; tokenId: string; marker: string }
  | { ok: false; code: AdmissionMarkerErrorCode; reason: string };

export function parseAdmissionMarker(description: unknown): AdmissionMarkerParseResult {
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
  const candidate = candidates[0];
  if (candidate === undefined) {
    return { ok: false, code: 'missing_marker', reason: 'Task description has no admission marker' };
  }
  const match = candidate.match(/^naru-admit:v1:(writer|read-only):([A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?)$/);
  if (!match || !isSchedulerId(match[2]) || (match[1] !== 'writer' && match[1] !== 'read-only')) {
    return { ok: false, code: 'invalid_marker', reason: 'Task admission marker is malformed' };
  }
  return { ok: true, lane: match[1], tokenId: match[2], marker: candidate };
}

export function resetSchedulerRuntimeForTests() {
  delete (globalThis as SchedulerGlobal)[RUNTIME_KEY];
}

export const SCHEDULER_RUNTIME_LIMITS = Object.freeze({
  maxRoots: MAX_ROOTS,
  maxTokens: MAX_TOKENS,
  maxCalls: MAX_CALLS,
  maxTaskDescriptionLength: MAX_DESCRIPTION_LENGTH,
});
