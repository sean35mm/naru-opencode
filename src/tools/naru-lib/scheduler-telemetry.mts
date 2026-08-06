import { budgetUsage } from './scheduler-state.mjs';
import { schedulerJournalRuntimeMode, schedulerJournalSnapshot } from './scheduler-journal.mjs';
import { getSchedulerRuntimeRegistry } from './scheduler-token.mjs';
import type {
  CandidateArtifactV1,
  GateStatus,
  GateType,
  QualityArtifactV1,
  SchedulerBudgets,
} from './scheduler-protocol.mjs';
import type { SchedulerBudgetUsage, SchedulerState, SchedulerWorkItem } from './scheduler-state.mjs';
import type {
  SchedulerAdmissionMode,
  SchedulerAdmissionReservation,
  SchedulerJournalEntry,
  SchedulerRuntimeRegistry,
  SchedulerRuntimeRun,
} from './scheduler-token.mjs';

const MAX_ACTORS = 8;
const GATE_TYPES = Object.freeze(['verification', 'judgment', 'completion'] as const);
const RUNTIME_MODES = new Set<unknown>(['observe', 'enforce']);

export interface SchedulerItemCounts {
  live: number;
  pending: number;
  blocked: number;
  terminal: number;
  failed: number;
  invalidated: number;
  total: number;
}

export interface SchedulerBudgetProjection {
  usage: SchedulerBudgetUsage;
  limits: SchedulerBudgets;
  pressure: 'normal' | 'elevated' | 'full';
  highestRatio: number;
}

export interface SchedulerBlockedProjection {
  workItemId: string;
  since: number | null;
  ageMs: number | null;
}

type ProjectedGateStatus = GateStatus | 'pending';

export interface SchedulerQualityGateProjection {
  status:
    | 'awaiting-candidate'
    | 'awaiting-verification'
    | 'awaiting-judgment'
    | 'awaiting-completion'
    | 'blocked'
    | 'passed';
  candidateArtifactId: string | null;
  gates: Record<GateType, ProjectedGateStatus>;
}

export interface SchedulerActorProjection {
  agent: string;
  active: number;
  artifacts: number;
}

export interface SchedulerTelemetryProjection {
  schemaVersion: 1;
  scope: 'process-local';
  processLocal: true;
  durable: false;
  crossProcess: false;
  backgroundEnforcement: false;
  providerHardCaps: false;
  rootSessionID: string;
  runId: string | null;
  schedulingProtocol: 2 | 3 | null;
  mode: SchedulerAdmissionMode | null;
  declared: boolean;
  closed: boolean;
  observedAt: number;
  counts: SchedulerItemCounts;
  budget: SchedulerBudgetProjection;
  oldestBlocked: SchedulerBlockedProjection | null;
  qualityGate: SchedulerQualityGateProjection;
  actors: SchedulerActorProjection[];
  omittedActorCount: number;
}

function metadataRecord(entry: SchedulerJournalEntry | null | undefined): Record<string, unknown> | null {
  return entry?.metadata !== null && typeof entry?.metadata === 'object' && !Array.isArray(entry.metadata)
    ? entry.metadata as Record<string, unknown>
    : null;
}

function isRuntimeMode(value: unknown): value is SchedulerAdmissionMode {
  return RUNTIME_MODES.has(value);
}

function latestEntry(
  entries: SchedulerJournalEntry[],
  predicate: (entry: SchedulerJournalEntry) => boolean,
): SchedulerJournalEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry !== undefined && predicate(entry)) return entry;
  }
  return null;
}

function runtimeMode(
  run: SchedulerRuntimeRun,
  journal: SchedulerJournalEntry[],
  admissions: Map<string, SchedulerAdmissionReservation>,
  recordedMode: SchedulerAdmissionMode | null,
): SchedulerAdmissionMode | null {
  if (isRuntimeMode(run.mode)) return run.mode;
  if (isRuntimeMode(recordedMode)) return recordedMode;
  const created = latestEntry(journal, (entry) => (
    entry.type === 'run.created' && metadataRecord(entry)?.runId === run.runId
  ));
  const createdMode = metadataRecord(created)?.mode;
  if (isRuntimeMode(createdMode)) return createdMode;
  for (const admission of admissions.values()) {
    if (admission.rootSessionID === run.rootSessionID && isRuntimeMode(admission.mode)) return admission.mode;
  }
  return null;
}

function itemCounts(items: SchedulerWorkItem[]): SchedulerItemCounts {
  const counts: SchedulerItemCounts = {
    live: 0,
    pending: 0,
    blocked: 0,
    terminal: 0,
    failed: 0,
    invalidated: 0,
    total: items.length,
  };
  for (const item of items) {
    if (item.status === 'active') counts.live += 1;
    else if (item.status === 'pending' || item.status === 'ready') counts.pending += 1;
    else if (item.status === 'blocked') counts.blocked += 1;
    else if (item.status === 'terminal-contained') counts.terminal += 1;
    else if (item.status === 'failed') counts.failed += 1;
    else if (item.status === 'invalidated') counts.invalidated += 1;
  }
  return counts;
}

function budgetProjection(
  state: SchedulerState | null,
  fallbackBudgets: SchedulerBudgets,
): SchedulerBudgetProjection {
  const limits = state?.budgets ?? fallbackBudgets ?? {
    maxConcurrentWriters: 0,
    maxConcurrentReadOnly: 0,
    maxTotalChildren: 0,
    maxJudgePasses: 0,
  };
  const usage = state ? budgetUsage(state) : {
    writers: 0,
    readOnly: 0,
    totalChildren: 0,
    judgePasses: 0,
  };
  const ratios = ([
    [usage.writers, limits.maxConcurrentWriters],
    [usage.readOnly, limits.maxConcurrentReadOnly],
    [usage.totalChildren, limits.maxTotalChildren],
    [usage.judgePasses, limits.maxJudgePasses],
  ] as const).map(([used, limit]) => limit > 0 ? used / limit : 0);
  const highestRatio = Math.max(0, ...ratios);
  return {
    usage,
    limits: structuredClone(limits),
    pressure: highestRatio >= 1 ? 'full' : highestRatio >= 0.75 ? 'elevated' : 'normal',
    highestRatio,
  };
}

function blockedProjection(
  items: SchedulerWorkItem[],
  journal: SchedulerJournalEntry[],
  now: number,
): SchedulerBlockedProjection | null {
  const declaredAt = journal.find((entry) => entry.type === 'run.items-declared')?.timestamp ?? null;
  const blocked = items
    .filter((item) => item.status === 'blocked')
    .map((item) => {
      const transition = latestEntry(journal, (entry) => (
        entry.type === 'artifact.appended' &&
        metadataRecord(entry)?.workItemId === item.workItemId &&
        metadataRecord(entry)?.status === 'blocked'
      ));
      const since = transition?.timestamp ?? declaredAt;
      return {
        workItemId: item.workItemId,
        since,
        ageMs: typeof since === 'number' && Number.isSafeInteger(since) ? Math.max(0, now - since) : null,
      };
    })
    .sort((left, right) => {
      if (left.since === null && right.since !== null) return 1;
      if (left.since !== null && right.since === null) return -1;
      return (left.since ?? 0) - (right.since ?? 0) || left.workItemId.localeCompare(right.workItemId);
    });
  return blocked[0] ?? null;
}

function qualityGateProjection(artifacts: QualityArtifactV1[]): SchedulerQualityGateProjection {
  const candidate = [...artifacts].reverse().find(
    (artifact): artifact is CandidateArtifactV1 => artifact.artifactType === 'candidate',
  );
  const gates: Record<GateType, ProjectedGateStatus> = {
    verification: 'pending',
    judgment: 'pending',
    completion: 'pending',
  };
  if (!candidate) return { status: 'awaiting-candidate', candidateArtifactId: null, gates };
  for (const artifact of artifacts) {
    if (artifact.artifactType !== 'gate' || artifact.candidateArtifactId !== candidate.artifactId) continue;
    gates[artifact.gateType] = artifact.status;
  }
  let status: SchedulerQualityGateProjection['status'] = 'awaiting-verification';
  if (Object.values(gates).includes('blocked')) status = 'blocked';
  else if (gates.completion === 'passed') status = 'passed';
  else if (gates.judgment === 'passed') status = 'awaiting-completion';
  else if (gates.verification === 'passed') status = 'awaiting-judgment';
  return { status, candidateArtifactId: candidate.artifactId, gates };
}

function actorProjection(
  state: SchedulerState | null,
  admissions: Map<string, SchedulerAdmissionReservation>,
): Pick<SchedulerTelemetryProjection, 'actors' | 'omittedActorCount'> {
  const actors = new Map<string, SchedulerActorProjection>();
  const actor = (agent: unknown): SchedulerActorProjection | null => {
    if (typeof agent !== 'string' || agent.length === 0) return null;
    const current = actors.get(agent) ?? { agent, active: 0, artifacts: 0 };
    actors.set(agent, current);
    return current;
  };
  for (const active of state?.activeAdmissions ?? []) {
    const current = actor(admissions.get(active.tokenId)?.target);
    if (current) current.active += 1;
  }
  for (const artifact of state?.qualityArtifacts ?? []) {
    const current = actor('reportAgent' in artifact ? artifact.reportAgent : undefined);
    if (current) current.artifacts += 1;
  }
  const ordered = [...actors.values()].sort((left, right) => (
    right.active - left.active || right.artifacts - left.artifacts || left.agent.localeCompare(right.agent)
  ));
  return {
    actors: ordered.slice(0, MAX_ACTORS),
    omittedActorCount: Math.max(0, ordered.length - MAX_ACTORS),
  };
}

export function projectSchedulerTelemetry({
  rootSessionID,
  run,
  journal = [],
  admissions = new Map(),
  recordedMode = null,
  now = Date.now(),
}: {
  rootSessionID: string;
  run: SchedulerRuntimeRun | null | undefined;
  journal?: SchedulerJournalEntry[];
  admissions?: Map<string, SchedulerAdmissionReservation>;
  recordedMode?: SchedulerAdmissionMode | null;
  now?: number;
}): SchedulerTelemetryProjection | null {
  if (!run || typeof run !== 'object') return null;
  const state = run.state && typeof run.state === 'object' ? run.state : null;
  const items = Array.isArray(state?.workItems) ? state.workItems : [];
  const artifacts = Array.isArray(state?.qualityArtifacts) ? state.qualityArtifacts : [];
  const actors = actorProjection(state, admissions);
  return {
    schemaVersion: 1,
    scope: 'process-local',
    processLocal: true,
    durable: false,
    crossProcess: false,
    backgroundEnforcement: false,
    providerHardCaps: false,
    rootSessionID,
    runId: run.runId ?? null,
    schedulingProtocol: run.schedulingProtocol ?? null,
    mode: runtimeMode({ ...run, rootSessionID }, journal, admissions, recordedMode),
    declared: state !== null,
    closed: run.closed === true,
    observedAt: now,
    counts: itemCounts(items),
    budget: budgetProjection(state, run.budgets),
    oldestBlocked: blockedProjection(items, journal, now),
    qualityGate: qualityGateProjection(artifacts),
    ...actors,
  };
}

export function schedulerTelemetrySnapshot(rootSessionID: unknown, {
  registry = getSchedulerRuntimeRegistry(),
  now = Date.now(),
}: { registry?: SchedulerRuntimeRegistry; now?: number } = {}): SchedulerTelemetryProjection | null {
  if (typeof rootSessionID !== 'string' || rootSessionID.length === 0) return null;
  const run = registry.roots.get(rootSessionID);
  if (!run) return null;
  return structuredClone(projectSchedulerTelemetry({
    rootSessionID,
    run,
    journal: schedulerJournalSnapshot(rootSessionID, { registry }),
    admissions: registry.admissions,
    recordedMode: schedulerJournalRuntimeMode(rootSessionID, { registry }),
    now,
  }));
}

export const SCHEDULER_TELEMETRY_LIMITS = Object.freeze({
  maxActors: MAX_ACTORS,
});
