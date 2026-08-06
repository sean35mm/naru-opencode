import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SCHEDULER_CONFIG,
  loadSchedulerConfigFile,
  parseRuntimeConfig,
  parseSchedulerConfig,
} from '../tools/naru-lib/scheduler-config.mjs';
import type { SchedulerConfig } from '../tools/naru-lib/scheduler-config.mjs';
import { reduceSchedulerState } from '../tools/naru-lib/scheduler-state.mjs';
import {
  admissionClaimsForWorkItem,
  consumeAdmission,
  getSchedulerRuntimeRegistry,
  parseAdmissionMarker,
  probeSchedulerRuntime,
  pruneSchedulerRuntime,
} from '../tools/naru-lib/scheduler-token.mjs';
import type {
  SchedulerAdmissionReservation,
  SchedulerLifecycleState,
  SchedulerRuntimeCapability,
  SchedulerRuntimeRegistry,
  SchedulerRuntimeRun,
} from '../tools/naru-lib/scheduler-token.mjs';
import { appendSchedulerJournal } from '../tools/naru-lib/scheduler-journal.mjs';

const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../naru-runtime.json', import.meta.url));
const MAX_SESSION_HOPS = 32;

type UnknownRecord = Record<string, unknown>;

interface SchedulerPluginOptions {
  schedulerConfig?: unknown;
  runtimeConfig?: unknown;
  config?: unknown;
  configPath?: string;
  registry?: SchedulerRuntimeRegistry;
  state?: unknown;
  capability?: SchedulerRuntimeCapability;
  now?: () => number;
}

interface OpenCodePluginInput {
  client?: unknown;
  directory?: string;
}

interface OpenCodeToolHookInput {
  tool?: unknown;
  callID?: unknown;
  callId?: unknown;
  sessionID?: unknown;
}

interface OpenCodeToolHookOutput {
  args?: unknown;
}

interface OpenCodeSessionInfo {
  id?: string;
  parentID?: string;
  status?: unknown;
}

interface OpenCodeEvent {
  type?: unknown;
  id?: unknown;
  sequence?: unknown;
  properties?: {
    id?: unknown;
    info?: unknown;
    sessionID?: string;
    sequence?: unknown;
    status?: unknown;
  };
}

interface OpenCodeEventHookInput {
  event?: unknown;
}

interface OpenCodeChatInput {
  sessionID?: unknown;
  parts?: unknown;
}

interface OpenCodeChatOutput {
  parts?: unknown;
}

interface SchedulerPluginHooks {
  'tool.execute.before': (input: OpenCodeToolHookInput, output: OpenCodeToolHookOutput) => void;
  'tool.execute.after': (input: OpenCodeToolHookInput, output: unknown) => void;
  event: (input: OpenCodeEventHookInput) => void;
  'chat.message': (input: OpenCodeChatInput, output: OpenCodeChatOutput) => void;
}

function recordValue(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function objectValue(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' ? Object(value) as UnknownRecord : null;
}

function eventInfo(event: OpenCodeEvent): OpenCodeSessionInfo {
  return recordValue(event.properties?.info) as OpenCodeSessionInfo | null ?? {};
}

async function loadConfig(options: SchedulerPluginOptions): Promise<SchedulerConfig> {
  if (Object.hasOwn(options, 'schedulerConfig')) return parseSchedulerConfig(options.schedulerConfig);
  if (Object.hasOwn(options, 'runtimeConfig')) return parseRuntimeConfig(options.runtimeConfig).scheduler;
  if (Object.hasOwn(options, 'config')) return parseSchedulerConfig(options.config);
  const path = options.configPath ?? DEFAULT_CONFIG_PATH;
  try {
    return await loadSchedulerConfigFile(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT' && path === DEFAULT_CONFIG_PATH) {
      return { ...DEFAULT_SCHEDULER_CONFIG };
    }
    throw error;
  }
}

function ensureLifecycle(value: unknown): SchedulerLifecycleState {
  const state = (
    value && typeof value === 'object' ? value : {}
  ) as Partial<SchedulerLifecycleState>;
  state.sessions ??= new Map();
  state.taskCalls ??= new Map();
  state.seenEvents ??= new Map();
  state.incidents ??= new Set();
  return state as SchedulerLifecycleState;
}

function nowFrom(options: SchedulerPluginOptions): number {
  const value = typeof options.now === 'function' ? options.now() : Date.now();
  return Number.isSafeInteger(value) && value >= 0 ? value : Date.now();
}

function rootForSession(sessionID: unknown, lifecycle: SchedulerLifecycleState): string {
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

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, maximum = 2048): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > maximum) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function eventKey(event: OpenCodeEvent): string {
  const info = eventInfo(event);
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

function claimsFor(record: SchedulerAdmissionReservation, registry: SchedulerRuntimeRegistry) {
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

function runForRecord(
  record: SchedulerAdmissionReservation,
  registry: SchedulerRuntimeRegistry,
): SchedulerRuntimeRun & { state: NonNullable<SchedulerRuntimeRun['state']> } {
  const run = registry.roots.get(record.rootSessionID);
  if (!run || run.runId !== record.token.runId || !run.state) throw new Error('admission run state is unavailable');
  if (run.closed) throw new Error('admission run is closed');
  return run as SchedulerRuntimeRun & { state: NonNullable<SchedulerRuntimeRun['state']> };
}

function taskName(input: OpenCodeToolHookInput): string {
  return typeof input?.tool === 'string' ? input.tool.toLowerCase() : '';
}

function callID(input: OpenCodeToolHookInput): unknown {
  return input?.callID ?? input?.callId;
}

function eventSequence(event: OpenCodeEvent): number | null {
  const value = event?.sequence ?? event?.properties?.sequence;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export const NaruSchedulerPlugin = async (
  { client, directory }: OpenCodePluginInput = {},
  options: SchedulerPluginOptions = {},
): Promise<Partial<SchedulerPluginHooks>> => {
  const config = await loadConfig(options);
  if (config.mode === 'off') return {};

  const registry = options.registry ?? getSchedulerRuntimeRegistry();
  const lifecycle = ensureLifecycle(options.state ?? registry.lifecycle);
  registry.lifecycle = lifecycle;
  const capability = options.capability ?? probeSchedulerRuntime({ registry });

  const journal = (rootSessionID: string, type: string, metadata: unknown) => appendSchedulerJournal(
    rootSessionID,
    type,
    metadata,
    { registry, now: nowFrom(options) },
  );

  const incident = (rootSessionID: string, code: string, metadata: UnknownRecord = {}) => {
    const reference = metadata.callID ?? metadata.sessionID ?? metadata.eventKey ?? 'runtime';
    const key = `${rootSessionID}:${code}:${reference}`;
    if (lifecycle.incidents.has(key)) return;
    lifecycle.incidents.add(key);
    while (lifecycle.incidents.size > 2048) {
      const oldest = lifecycle.incidents.values().next().value;
      if (oldest === undefined) break;
      lifecycle.incidents.delete(oldest);
    }
    journal(rootSessionID, 'incident.observed', {
      code,
      severity: 'warning',
      terminalKnown: false,
      ...metadata,
    });
  };

  const refuseOrObserve = (
    rootSessionID: string,
    code: string,
    reason: string,
    metadata: UnknownRecord = {},
  ): void => {
    incident(rootSessionID, code, { ...metadata, reason });
    if (config.mode === 'enforce') throw new Error(`Naru scheduler admission refused: ${reason}`);
  };

  return {
    'tool.execute.before': (input, output) => {
      if (taskName(input) !== 'task') return;
      const args = objectValue(output?.args);
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
      const schedulerEvent = event as OpenCodeEvent;
      const key = eventKey(schedulerEvent);
      const info = eventInfo(schedulerEvent);
      const sessionID = info.id ?? schedulerEvent.properties?.sessionID;
      const rootSessionID = rootForSession(sessionID, lifecycle);
      if (lifecycle.seenEvents.has(key)) {
        incident(rootSessionID, 'duplicate_event', { eventKey: key, sessionID });
        return;
      }
      boundedSet(lifecycle.seenEvents, key, true);

      const sequence = eventSequence(schedulerEvent);
      const prior = lifecycle.sessions.get(sessionID);
      const priorSequence = prior?.lastSequence;
      if (
        sequence !== null &&
        typeof priorSequence === 'number' &&
        Number.isSafeInteger(priorSequence) &&
        sequence < priorSequence
      ) {
        incident(rootSessionID, 'reordered_event', { eventKey: key, sessionID, sequence });
      }

      if (schedulerEvent.type === 'session.created' || schedulerEvent.type === 'session.updated') {
        const parentID = typeof info.parentID === 'string' && info.parentID ? info.parentID : null;
        if (schedulerEvent.type === 'session.created' && parentID && !lifecycle.sessions.has(parentID) && !registry.roots.has(parentID)) {
          incident(parentID, 'missing_parent_event', { eventKey: key, sessionID });
        }
        boundedSet(lifecycle.sessions, sessionID, {
          parentID,
          lastSequence: sequence ?? prior?.lastSequence ?? null,
          updatedAt: nowFrom(options),
        }, 512);
        if (schedulerEvent.type === 'session.created' && parentID) {
          const matchingTask = [...lifecycle.taskCalls.values()].some((task) => task.parentSessionID === parentID && task.admitted);
          if (!matchingTask) incident(rootForSession(parentID, lifecycle), 'child_without_task_observation', { eventKey: key, sessionID });
        }
        return;
      }

      if (schedulerEvent.type === 'session.idle') {
        const run = registry.roots.get(rootSessionID);
        if ((run?.state?.activeAdmissions?.length ?? 0) > 0) {
          incident(rootSessionID, 'idle_with_active_background', {
            eventKey: key,
            sessionID,
            background: true,
            status: 'unknown-background-terminal',
          });
        }
        return;
      }

      if (schedulerEvent.type === 'session.deleted' || schedulerEvent.type === 'session.error') {
        const run = registry.roots.get(rootSessionID);
        if ((run?.state?.activeAdmissions?.length ?? 0) > 0) {
          incident(rootSessionID, 'session_terminal_without_artifact', {
            eventKey: key,
            sessionID,
            background: true,
            status: 'unknown-background-terminal',
          });
        }
        if (schedulerEvent.type === 'session.deleted') lifecycle.sessions.delete(sessionID);
      }
    },

    'chat.message': (input, output) => {
      const sessionID = input?.sessionID;
      const rootSessionID = rootForSession(sessionID, lifecycle);
      const parts = output?.parts ?? input?.parts ?? [];
      if (!Array.isArray(parts)) return;
      for (const rawPart of parts) {
        const part = recordValue(rawPart);
        const tool = part?.tool ?? part?.name;
        if (typeof tool !== 'string' || tool.toLowerCase() !== 'task') continue;
        const state = recordValue(part?.state);
        const status = state?.status ?? part?.status;
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
