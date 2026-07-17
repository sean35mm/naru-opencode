import { budgetUsage } from './scheduler-state.mjs';
import { schedulerJournalRuntimeMode, schedulerJournalSnapshot } from './scheduler-journal.mjs';
import { getSchedulerRuntimeRegistry } from './scheduler-token.mjs';

const MAX_ACTORS = 8;
const GATE_TYPES = Object.freeze(['verification', 'judgment', 'completion']);
const RUNTIME_MODES = new Set(['observe', 'enforce']);

function latestEntry(entries, predicate) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (predicate(entries[index])) return entries[index];
  }
  return null;
}

function runtimeMode(run, journal, admissions, recordedMode) {
  if (RUNTIME_MODES.has(run?.mode)) return run.mode;
  if (RUNTIME_MODES.has(recordedMode)) return recordedMode;
  const created = latestEntry(journal, (entry) => (
    entry.type === 'run.created' && entry.metadata?.runId === run?.runId
  ));
  if (RUNTIME_MODES.has(created?.metadata?.mode)) return created.metadata.mode;
  for (const admission of admissions.values()) {
    if (admission.rootSessionID === run?.rootSessionID && RUNTIME_MODES.has(admission.mode)) return admission.mode;
  }
  return null;
}

function itemCounts(items) {
  const counts = {
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

function budgetProjection(state, fallbackBudgets) {
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
  const ratios = [
    [usage.writers, limits.maxConcurrentWriters],
    [usage.readOnly, limits.maxConcurrentReadOnly],
    [usage.totalChildren, limits.maxTotalChildren],
    [usage.judgePasses, limits.maxJudgePasses],
  ].map(([used, limit]) => limit > 0 ? used / limit : 0);
  const highestRatio = Math.max(0, ...ratios);
  return {
    usage,
    limits: structuredClone(limits),
    pressure: highestRatio >= 1 ? 'full' : highestRatio >= 0.75 ? 'elevated' : 'normal',
    highestRatio,
  };
}

function blockedProjection(items, journal, now) {
  const declaredAt = journal.find((entry) => entry.type === 'run.items-declared')?.timestamp ?? null;
  const blocked = items
    .filter((item) => item.status === 'blocked')
    .map((item) => {
      const transition = latestEntry(journal, (entry) => (
        entry.type === 'artifact.appended' &&
        entry.metadata?.workItemId === item.workItemId &&
        entry.metadata?.status === 'blocked'
      ));
      const since = transition?.timestamp ?? declaredAt;
      return {
        workItemId: item.workItemId,
        since,
        ageMs: Number.isSafeInteger(since) ? Math.max(0, now - since) : null,
      };
    })
    .sort((left, right) => {
      if (left.since === null && right.since !== null) return 1;
      if (left.since !== null && right.since === null) return -1;
      return (left.since ?? 0) - (right.since ?? 0) || left.workItemId.localeCompare(right.workItemId);
    });
  return blocked[0] ?? null;
}

function qualityGateProjection(artifacts) {
  const candidate = [...artifacts].reverse().find((artifact) => artifact.artifactType === 'candidate');
  const gates = Object.fromEntries(GATE_TYPES.map((gateType) => [gateType, 'pending']));
  if (!candidate) return { status: 'awaiting-candidate', candidateArtifactId: null, gates };
  for (const artifact of artifacts) {
    if (artifact.artifactType !== 'gate' || artifact.candidateArtifactId !== candidate.artifactId) continue;
    gates[artifact.gateType] = artifact.status;
  }
  let status = 'awaiting-verification';
  if (Object.values(gates).includes('blocked')) status = 'blocked';
  else if (gates.completion === 'passed') status = 'passed';
  else if (gates.judgment === 'passed') status = 'awaiting-completion';
  else if (gates.verification === 'passed') status = 'awaiting-judgment';
  return { status, candidateArtifactId: candidate.artifactId, gates };
}

function actorProjection(state, admissions) {
  const actors = new Map();
  const actor = (agent) => {
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
    const current = actor(artifact.reportAgent);
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
}) {
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

export function schedulerTelemetrySnapshot(rootSessionID, {
  registry = getSchedulerRuntimeRegistry(),
  now = Date.now(),
} = {}) {
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
