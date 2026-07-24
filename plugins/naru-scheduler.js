import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SCHEDULER_CONFIG,
  loadSchedulerConfigFile,
  parseRuntimeConfig,
  parseSchedulerConfig,
} from '../tools/naru-lib/scheduler-config.mjs';
import { reduceSchedulerState } from '../tools/naru-lib/scheduler-state.mjs';
import {
  admissionClaimsForWorkItem,
  consumeAdmission,
  getSchedulerRuntimeRegistry,
  parseAdmissionMarker,
  probeSchedulerRuntime,
  pruneSchedulerRuntime,
} from '../tools/naru-lib/scheduler-token.mjs';
import { appendSchedulerJournal } from '../tools/naru-lib/scheduler-journal.mjs';

const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../naru-runtime.json', import.meta.url));
const MAX_SESSION_HOPS = 32;

async function loadConfig(options) {
  if (Object.hasOwn(options, 'schedulerConfig')) return parseSchedulerConfig(options.schedulerConfig);
  if (Object.hasOwn(options, 'runtimeConfig')) return parseRuntimeConfig(options.runtimeConfig).scheduler;
  if (Object.hasOwn(options, 'config')) return parseSchedulerConfig(options.config);
  const path = options.configPath ?? DEFAULT_CONFIG_PATH;
  try {
    return await loadSchedulerConfigFile(path);
  } catch (error) {
    if (error?.code === 'ENOENT' && path === DEFAULT_CONFIG_PATH) return { ...DEFAULT_SCHEDULER_CONFIG };
    throw error;
  }
}

function ensureLifecycle(value) {
  const state = value && typeof value === 'object' ? value : {};
  state.sessions ??= new Map();
  state.taskCalls ??= new Map();
  state.seenEvents ??= new Map();
  state.incidents ??= new Set();
  return state;
}

function nowFrom(options) {
  const value = typeof options.now === 'function' ? options.now() : Date.now();
  return Number.isSafeInteger(value) && value >= 0 ? value : Date.now();
}

function rootForSession(sessionID, lifecycle) {
  if (typeof sessionID !== 'string' || sessionID.length === 0) return 'unknown-root';
  let current = sessionID;
  const seen = new Set();
  for (let count = 0; count < MAX_SESSION_HOPS; count += 1) {
    if (seen.has(current)) return sessionID;
    seen.add(current);
    const parentID = lifecycle.sessions.get(current)?.parentID;
    if (typeof parentID !== 'string' || parentID.length === 0) return current;
    current = parentID;
  }
  return sessionID;
}

function boundedSet(map, key, value, maximum = 2048) {
  map.delete(key);
  map.set(key, value);
  while (map.size > maximum) map.delete(map.keys().next().value);
}

function eventKey(event) {
  const info = event?.properties?.info ?? {};
  const stable = {
    type: event?.type ?? null,
    eventId: event?.id ?? event?.properties?.id ?? null,
    sessionID: info.id ?? event?.properties?.sessionID ?? null,
    parentID: info.parentID ?? null,
    sequence: event?.sequence ?? event?.properties?.sequence ?? null,
    status: info.status ?? event?.properties?.status ?? null,
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function claimsFor(record, registry) {
  const run = registry.roots.get(record.rootSessionID);
  const item = run?.state?.workItems?.find((candidate) => candidate.workItemId === record.token.workItemId);
  return item ? admissionClaimsForWorkItem(item) : {
    ownedWriteScope: [],
    frozenContractClaims: [],
    mutableContractClaims: [],
    generatedArtifactClaims: [],
    configurationClaims: [],
    mutableResourceClaims: [],
  };
}

function runForRecord(record, registry) {
  const run = registry.roots.get(record.rootSessionID);
  if (!run || run.runId !== record.token.runId || !run.state) throw new Error('admission run state is unavailable');
  if (run.closed) throw new Error('admission run is closed');
  return run;
}

function taskName(input) {
  return typeof input?.tool === 'string' ? input.tool.toLowerCase() : '';
}

function callID(input) {
  return input?.callID ?? input?.callId;
}

function eventSequence(event) {
  const value = event?.sequence ?? event?.properties?.sequence;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export const NaruSchedulerPlugin = async ({ client, directory } = {}, options = {}) => {
  const config = await loadConfig(options);
  if (config.mode === 'off') return {};

  const registry = options.registry ?? getSchedulerRuntimeRegistry();
  const lifecycle = ensureLifecycle(options.state ?? registry.lifecycle);
  registry.lifecycle = lifecycle;
  const capability = options.capability ?? probeSchedulerRuntime({ registry });

  const journal = (rootSessionID, type, metadata) => appendSchedulerJournal(
    rootSessionID,
    type,
    metadata,
    { registry, now: nowFrom(options) },
  );

  const incident = (rootSessionID, code, metadata = {}) => {
    const reference = metadata.callID ?? metadata.sessionID ?? metadata.eventKey ?? 'runtime';
    const key = `${rootSessionID}:${code}:${reference}`;
    if (lifecycle.incidents.has(key)) return;
    lifecycle.incidents.add(key);
    while (lifecycle.incidents.size > 2048) {
      lifecycle.incidents.delete(lifecycle.incidents.values().next().value);
    }
    journal(rootSessionID, 'incident.observed', {
      code,
      severity: 'warning',
      terminalKnown: false,
      ...metadata,
    });
  };

  const refuseOrObserve = (rootSessionID, code, reason, metadata = {}) => {
    incident(rootSessionID, code, { ...metadata, reason });
    if (config.mode === 'enforce') throw new Error(`Naru scheduler admission refused: ${reason}`);
  };

  return {
    'tool.execute.before': (input, output) => {
      if (taskName(input) !== 'task') return;
      const args = output?.args;
      const parentSessionID = input?.sessionID;
      const rootSessionID = rootForSession(parentSessionID, lifecycle);
      const id = callID(input);
      const foreground = args?.run_in_background !== true && args?.background !== true;
      const pendingKey = typeof id === 'string' && id ? id : `missing:${parentSessionID ?? 'session'}`;
      const existingCall = lifecycle.taskCalls.get(pendingKey);
      if (!existingCall) {
        boundedSet(lifecycle.taskCalls, pendingKey, {
          rootSessionID,
          parentSessionID,
          foreground,
          admitted: false,
          afterSeen: false,
        });
      }

      if (capability.available !== true || capability.protocol !== 3 || capability.synchronousAdmission !== true) {
        refuseOrObserve(rootSessionID, 'unsupported_capability', 'process-local synchronous Protocol 3 capability is unavailable', { callID: id });
        return;
      }
      if (!args || typeof args !== 'object') {
        refuseOrObserve(rootSessionID, 'missing_task_args', 'Task arguments are unavailable', { callID: id });
        return;
      }
      const marker = parseAdmissionMarker(args.description);
      if (!marker.ok) {
        refuseOrObserve(rootSessionID, marker.code, marker.reason, { callID: id });
        return;
      }
      const record = registry.admissions.get(marker.tokenId);
      if (!record) {
        refuseOrObserve(rootSessionID, 'unknown_token', 'admission token is unknown', { callID: id });
        return;
      }
      const run = registry.roots.get(record.rootSessionID);
      if (config.mode === 'enforce' && run?.schedulingProtocol !== 3) {
        refuseOrObserve(rootSessionID, 'protocol2_refused', 'enforce mode refuses Protocol 2', { callID: id });
        return;
      }
      const result = consumeAdmission({
        tokenId: marker.tokenId,
        rootSessionID,
        parentSessionID,
        target: args.subagent_type,
        mode: config.mode,
        lane: marker.lane,
        claims: claimsFor(record, registry),
        version: 1,
        callID: id,
        now: nowFrom(options),
        onConsume: (reservation) => {
          const activeRun = runForRecord(reservation, registry);
          activeRun.state = reduceSchedulerState(activeRun.state, {
            type: 'admit',
            token: reservation.token,
            now: nowFrom(options),
          });
        },
      }, { registry });
      if (!result.allowed) {
        refuseOrObserve(rootSessionID, result.code, result.reason, { callID: id });
        return;
      }
      const pending = lifecycle.taskCalls.get(pendingKey);
      if (pending) pending.admitted = true;
      if (!result.idempotent) {
        journal(rootSessionID, 'task.admitted', {
          callID: id,
          workItemId: result.token.workItemId,
          foreground,
          terminalKnown: false,
        });
      }
      pruneSchedulerRuntime(registry);
    },

    'tool.execute.after': (input, output) => {
      if (taskName(input) !== 'task') return;
      const id = callID(input);
      const pending = lifecycle.taskCalls.get(id);
      if (!pending) {
        incident(rootForSession(input?.sessionID, lifecycle), 'task_after_without_before', {
          callID: id,
          status: 'child-terminal-unknown',
        });
        return;
      }
      if (!pending.foreground || pending.afterSeen) return;
      pending.afterSeen = true;
      journal(pending.rootSessionID, 'task.foreground-result', {
        callID: id,
        admitted: pending.admitted,
        foreground: true,
        resultObserved: output !== undefined,
        status: 'child-terminal-unknown',
        terminalKnown: false,
      });
    },

    event: ({ event }) => {
      if (!event || typeof event !== 'object') return;
      const key = eventKey(event);
      const info = event.properties?.info ?? {};
      const sessionID = info.id ?? event.properties?.sessionID;
      const rootSessionID = rootForSession(sessionID, lifecycle);
      if (lifecycle.seenEvents.has(key)) {
        incident(rootSessionID, 'duplicate_event', { eventKey: key, sessionID });
        return;
      }
      boundedSet(lifecycle.seenEvents, key, true);

      const sequence = eventSequence(event);
      const prior = lifecycle.sessions.get(sessionID);
      if (sequence !== null && Number.isSafeInteger(prior?.lastSequence) && sequence < prior.lastSequence) {
        incident(rootSessionID, 'reordered_event', { eventKey: key, sessionID, sequence });
      }

      if (event.type === 'session.created' || event.type === 'session.updated') {
        const parentID = typeof info.parentID === 'string' && info.parentID ? info.parentID : null;
        if (event.type === 'session.created' && parentID && !lifecycle.sessions.has(parentID) && !registry.roots.has(parentID)) {
          incident(parentID, 'missing_parent_event', { eventKey: key, sessionID });
        }
        boundedSet(lifecycle.sessions, sessionID, {
          parentID,
          lastSequence: sequence ?? prior?.lastSequence ?? null,
          updatedAt: nowFrom(options),
        }, 512);
        if (event.type === 'session.created' && parentID) {
          const matchingTask = [...lifecycle.taskCalls.values()].some((task) => task.parentSessionID === parentID && task.admitted);
          if (!matchingTask) incident(rootForSession(parentID, lifecycle), 'child_without_task_observation', { eventKey: key, sessionID });
        }
        return;
      }

      if (event.type === 'session.idle') {
        const run = registry.roots.get(rootSessionID);
        if (run?.state?.activeAdmissions?.length > 0) {
          incident(rootSessionID, 'idle_with_active_background', {
            eventKey: key,
            sessionID,
            background: true,
            status: 'unknown-background-terminal',
          });
        }
        return;
      }

      if (event.type === 'session.deleted' || event.type === 'session.error') {
        const run = registry.roots.get(rootSessionID);
        if (run?.state?.activeAdmissions?.length > 0) {
          incident(rootSessionID, 'session_terminal_without_artifact', {
            eventKey: key,
            sessionID,
            background: true,
            status: 'unknown-background-terminal',
          });
        }
        if (event.type === 'session.deleted') lifecycle.sessions.delete(sessionID);
      }
    },

    'chat.message': (input, output) => {
      const sessionID = input?.sessionID;
      const rootSessionID = rootForSession(sessionID, lifecycle);
      const parts = output?.parts ?? input?.parts ?? [];
      if (!Array.isArray(parts)) return;
      for (const part of parts) {
        const tool = part?.tool ?? part?.name;
        if (typeof tool !== 'string' || tool.toLowerCase() !== 'task') continue;
        const status = part?.state?.status ?? part?.status;
        const id = part?.callID ?? part?.callId;
        if (typeof id === 'string' && lifecycle.taskCalls.has(id)) continue;
        if (status === 'completed' || status === 'error' || status === 'failed') {
          incident(rootSessionID, 'advisory_task_terminal_unknown', {
            callID: id,
            sessionID,
            background: true,
            status: 'unknown-background-terminal',
          });
        }
      }
    },
  };
};
