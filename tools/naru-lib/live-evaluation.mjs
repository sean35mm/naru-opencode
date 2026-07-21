import {
  NARU_AGENT_IDS,
  canonicalAgentForRoute,
  isManagedRoutingAlias,
} from './model-routing.mjs';

export const LIVE_EVALUATION_REDACTION = Object.freeze({
  prompts: 'omitted',
  code: 'omitted',
  diffs: 'omitted',
  outputs: 'omitted',
});

const PLAN_SPECIALISTS = Object.freeze([
  'naru-plan-architecture',
  'naru-plan-minimal-change',
  'naru-plan-risk',
  'naru-plan-tests',
]);

export const LIVE_EVALUATION_CASES = Object.freeze({
  'plan-fanout': Object.freeze({
    command: 'naru-plan',
    rootAgent: 'naru-orchestrator',
    workflowAgent: 'naru-plan',
    specialists: PLAN_SPECIALISTS,
    judge: 'naru-plan-judge',
    minimumSpecialistConcurrency: 4,
    maximumDepth: 2,
    arguments: [
      'Plan a production-safe live workflow evaluator for this repository.',
      'It must launch OpenCode, recursively observe nested sessions, measure concurrency and model routing,',
      'redact prompts/code/diffs/outputs, enforce provider-cost and timeout gates, and add deterministic tests.',
      'Inspect the existing evaluator, session observability, routing, installer, and tests. Plan only.',
    ].join(' '),
  }),
});

const NARU_AGENTS = new Set(NARU_AGENT_IDS);

function canonicalAgent(agent) {
  if (NARU_AGENTS.has(agent)) return agent;
  if (isManagedRoutingAlias(agent)) return canonicalAgentForRoute(agent);
}

function depthFromRoot(session, byID, rootID) {
  let depth = 0;
  let current = session;
  const seen = new Set();
  while (current?.parentID) {
    if (seen.has(current.id)) return null;
    seen.add(current.id);
    depth += 1;
    if (current.parentID === rootID) return depth;
    current = byID.get(current.parentID);
  }
  return null;
}

function peakConcurrency(sessions) {
  const events = [];
  for (const session of sessions) {
    if (!Number.isFinite(session.createdAt) || !Number.isFinite(session.completedAt)) continue;
    events.push([session.createdAt, 1], [session.completedAt, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0;
  let peak = 0;
  for (const [, delta] of events) {
    active += delta;
    peak = Math.max(peak, active);
  }
  return peak;
}

function failure(code, detail) {
  return { code, detail };
}

export function evaluateLiveCapture(capture, scenario = LIVE_EVALUATION_CASES['plan-fanout']) {
  if (!capture?.root || !Array.isArray(capture.sessions)) throw new Error('live capture is incomplete');
  if (!scenario) throw new Error('live evaluation scenario is unknown');

  const rootID = capture.root.id;
  const byID = new Map(capture.sessions.map((session) => [session.id, session]));
  const records = capture.sessions.map((session) => {
    const agent = canonicalAgent(session.agent);
    return {
      agent: agent ?? 'unknown',
      route: agent && session.agent !== agent ? session.agent : 'canonical',
      provider: session.provider ?? 'unknown',
      model: session.model ?? 'unknown',
      variant: session.variant ?? 'unknown',
      status: session.error ? 'failed' : Number.isFinite(session.completedAt) ? 'completed' : 'incomplete',
      depth: depthFromRoot(session, byID, rootID),
      startMs: Number.isFinite(session.createdAt) ? Math.max(0, session.createdAt - capture.root.createdAt) : null,
      durationMs: Number.isFinite(session.createdAt) && Number.isFinite(session.completedAt)
        ? Math.max(0, session.completedAt - session.createdAt)
        : null,
      createdAt: session.createdAt,
      completedAt: session.completedAt,
    };
  });
  const failures = [];
  const requiredAgents = [scenario.workflowAgent, ...scenario.specialists, scenario.judge];
  for (const agent of requiredAgents) {
    const matches = records.filter((record) => record.agent === agent);
    if (matches.length === 0) failures.push(failure('missing-required-agent', agent));
    else if (!matches.some((record) => record.status === 'completed')) failures.push(failure('required-agent-incomplete', agent));
  }

  const unknown = records.filter((record) => record.agent === 'unknown');
  if (unknown.length) failures.push(failure('unknown-agent', `${unknown.length} descendant session(s)`));
  const invalidDepth = records.filter((record) => record.depth === null || record.depth > scenario.maximumDepth);
  if (invalidDepth.length) failures.push(failure('invalid-depth', `${invalidDepth.length} descendant session(s)`));

  const specialistRecords = records.filter((record) => scenario.specialists.includes(record.agent));
  const specialistPeak = peakConcurrency(specialistRecords.map((record) => ({
    createdAt: record.createdAt,
    completedAt: record.completedAt,
  })));
  if (specialistPeak < scenario.minimumSpecialistConcurrency) {
    failures.push(failure(
      'insufficient-specialist-concurrency',
      `expected ${scenario.minimumSpecialistConcurrency}, observed ${specialistPeak}`,
    ));
  }

  const completedSpecialists = specialistRecords.filter((record) => Number.isFinite(record.completedAt));
  const judge = records.find((record) => record.agent === scenario.judge && Number.isFinite(record.createdAt));
  if (judge && completedSpecialists.length === scenario.specialists.length) {
    const lastSpecialistCompletion = Math.max(...completedSpecialists.map((record) => record.completedAt));
    if (judge.createdAt < lastSpecialistCompletion) {
      failures.push(failure('judge-started-before-specialists-completed', scenario.judge));
    }
  }

  const publicRecords = records.map(({ createdAt, completedAt, ...record }) => record)
    .sort((a, b) => (a.startMs ?? Number.MAX_SAFE_INTEGER) - (b.startMs ?? Number.MAX_SAFE_INTEGER));
  const completedAt = capture.root.completedAt;
  return {
    schemaVersion: 1,
    live: true,
    caseId: capture.caseId,
    passed: failures.length === 0,
    redaction: LIVE_EVALUATION_REDACTION,
    rootSessionId: rootID,
    metrics: {
      elapsedMs: Number.isFinite(completedAt) ? Math.max(0, completedAt - capture.root.createdAt) : null,
      childCount: records.length,
      peakDescendantConcurrency: peakConcurrency(capture.sessions),
      peakSpecialistConcurrency: specialistPeak,
      maximumDepth: Math.max(0, ...records.map((record) => record.depth ?? 0)),
      observationPolls: capture.observation?.polls ?? 0,
      observedStatusTransitions: capture.observation?.statusTransitions ?? 0,
    },
    requirements: {
      requiredAgents,
      minimumSpecialistConcurrency: scenario.minimumSpecialistConcurrency,
      judgeAfterSpecialists: true,
      maximumDepth: scenario.maximumDepth,
    },
    agents: publicRecords,
    failures,
  };
}
