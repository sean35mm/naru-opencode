import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  applyRoutingToConfig,
  canonicalAgentForRoute,
  isManagedRoutingAlias,
  isSolXhighAlias,
  mergeRoutingOverrides,
  NARU_AGENT_IDS,
  NARU_DISPATCH_GRAPH,
  NARU_MINIMUM_SUBAGENT_DEPTH,
  parseRoutingOverrides,
  resolveRoutingPolicy,
} from '../tools/naru-lib/model-routing.mjs';
import type {
  ModelProfile,
  NaruAgentId,
  NormalizedRoutingOverrides,
} from '../tools/naru-lib/model-routing.mjs';

const CONFIG_PATH = fileURLToPath(new URL('../naru-models.json', import.meta.url));
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_SESSION_METADATA = 512;
const SESSION_METADATA_TTL_MS = 30 * 60 * 1000;
const NARU_AGENTS: ReadonlySet<unknown> = new Set(NARU_AGENT_IDS);
const ROOT_ONLY_NARU_AGENTS: ReadonlySet<unknown> = new Set(['naru-orchestrator']);
const OPENCODE_DEFAULT_SUBAGENT_DEPTH = 1;
const STATE_KEY = Symbol.for('naru.delegate.config-state.v1');

type UnknownRecord = Record<string, unknown>;

interface DelegatePluginOptions {
  routingOverrides?: unknown;
}

interface OpenCodeRequestResult {
  data?: unknown;
  error?: unknown;
}

interface OpenCodeSessionRequest {
  path: { id: string };
  query?: { directory: string };
}

interface OpenCodeClient {
  app: {
    log: (request: {
      body: { service: string; level: 'error'; message: string };
    }) => Promise<unknown>;
  };
  session?: {
    get?: (request: OpenCodeSessionRequest) => Promise<OpenCodeRequestResult | unknown>;
    messages?: (request: OpenCodeSessionRequest) => Promise<OpenCodeRequestResult | unknown>;
  };
}

interface OpenCodePluginInput {
  client: OpenCodeClient;
  directory?: unknown;
}

interface SubagentDepthCompatibility {
  compatible: boolean;
  description: string;
  effectiveDepth: unknown;
}

interface SessionMetadata {
  root?: boolean | undefined;
  agent?: string | undefined;
  modelID?: string | undefined;
  providerID?: string | undefined;
  variant?: string | undefined;
  updatedAt: number;
}

interface CompleteSessionMetadata extends SessionMetadata {
  root: boolean;
  agent: string;
  modelID: string;
  providerID: string;
  variant: string;
}

interface OriginalAgentConfiguration {
  present: boolean;
  value: unknown;
}

interface LegacyRoutingProjection {
  schemaVersion: 1;
  profiles: {
    fast: ModelProfile;
    deep: ModelProfile;
  };
  agents: Record<NaruAgentId, 'fast' | 'deep'>;
}

interface DelegateConfigState {
  disabled: boolean;
  originals: Record<NaruAgentId, OriginalAgentConfiguration>;
  aliases: Set<string>;
  overrides: unknown;
  overridesV2: unknown;
  depthCompatibility?: SubagentDepthCompatibility;
  depthWarningLogged?: boolean;
}

interface StoredDelegateState {
  configs: WeakMap<UnknownRecord, DelegateConfigState>;
  sessions?: Map<string, SessionMetadata>;
  solModels?: Map<string, string>;
}

interface SharedDelegateState extends StoredDelegateState {
  sessions: Map<string, SessionMetadata>;
  solModels: Map<string, string>;
}

interface DelegatePluginHooks {
  config: (config: unknown) => Promise<void>;
  event: (input: unknown) => Promise<void>;
  'chat.message': (input: unknown) => Promise<void>;
  'tool.execute.before': (input: unknown, output: unknown) => Promise<void>;
}

const delegateGlobal = globalThis as typeof globalThis & { [STATE_KEY]?: StoredDelegateState };
const storedShared = delegateGlobal[STATE_KEY] ?? { configs: new WeakMap() };
storedShared.sessions ??= new Map();
storedShared.solModels ??= new Map();
delegateGlobal[STATE_KEY] = storedShared;
const shared = storedShared as SharedDelegateState;

function recordValue(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function errorMessage(error: unknown, fallback?: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback ?? String(error);
}

async function readOverrides(options: DelegatePluginOptions | null): Promise<unknown> {
  if (Object.hasOwn(options ?? {}, 'routingOverrides')) return options?.routingOverrides;
  let info;
  try {
    info = await lstat(CONFIG_PATH);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error('naru-models.json must not be a symlink');
  if (!info.isFile()) throw new Error('naru-models.json must be a regular file');
  if (info.size > MAX_CONFIG_BYTES) throw new Error('naru-models.json exceeds 64 KiB');

  const handle = await open(CONFIG_PATH, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error('naru-models.json must be a regular file');
    if (opened.size > MAX_CONFIG_BYTES) throw new Error('naru-models.json exceeds 64 KiB');
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_CONFIG_BYTES) throw new Error('naru-models.json exceeds 64 KiB');
    return JSON.parse(buffer.subarray(0, total).toString('utf8')) as unknown;
  } finally {
    await handle.close();
  }
}

async function logFailure(client: OpenCodeClient, error: unknown): Promise<void> {
  const message = errorMessage(error);
  try {
    await client.app.log({
      body: {
        service: 'naru-delegate',
        level: 'error',
        message: `Dynamic model routing disabled: ${message}`,
      },
    });
  } catch {
    console.warn(`[naru-delegate] Dynamic model routing disabled: ${message}`);
  }
}

async function logDepthIncompatibility(
  client: OpenCodeClient,
  compatibility: SubagentDepthCompatibility,
): Promise<void> {
  const message = `Naru dispatcher launches are blocked: ${compatibility.description}; required minimum is ${NARU_MINIMUM_SUBAGENT_DEPTH}. Set top-level subagent_depth to at least ${NARU_MINIMUM_SUBAGENT_DEPTH} in OpenCode config, then restart OpenCode. Leaf Naru routes remain available.`;
  try {
    await client.app.log({
      body: {
        service: 'naru-delegate',
        level: 'error',
        message,
      },
    });
  } catch {
    console.warn(`[naru-delegate] ${message}`);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function subagentDepthCompatibility(configuredDepth: unknown): SubagentDepthCompatibility {
  if (configuredDepth === undefined) {
    return {
      compatible: OPENCODE_DEFAULT_SUBAGENT_DEPTH >= NARU_MINIMUM_SUBAGENT_DEPTH,
      description: `top-level subagent_depth is omitted (OpenCode 1.18.4 default ${OPENCODE_DEFAULT_SUBAGENT_DEPTH})`,
      effectiveDepth: OPENCODE_DEFAULT_SUBAGENT_DEPTH,
    };
  }
  const display = typeof configuredDepth === 'string'
    ? JSON.stringify(configuredDepth)
    : String(configuredDepth);
  return {
    compatible: typeof configuredDepth === 'number'
      && Number.isInteger(configuredDepth)
      && configuredDepth >= NARU_MINIMUM_SUBAGENT_DEPTH,
    description: `found top-level subagent_depth value ${display}`,
    effectiveDepth: configuredDepth,
  };
}

function isNaruDispatcherTarget(target: unknown): boolean {
  const canonical = NARU_AGENTS.has(target) ? target : canonicalAgentForRoute(target);
  return typeof canonical === 'string'
    && canonical in NARU_DISPATCH_GRAPH
    && (NARU_DISPATCH_GRAPH[canonical as keyof typeof NARU_DISPATCH_GRAPH]?.length ?? 0) > 0;
}

function responseData(result: unknown): unknown {
  const response = recordValue(result);
  if (response?.error) {
    const error = recordValue(response.error);
    throw new Error(typeof error?.message === 'string' ? error.message : 'OpenCode client request failed');
  }
  return response?.data ?? result;
}

function sessionOptions(sessionID: string, directory: unknown): OpenCodeSessionRequest {
  return {
    path: { id: sessionID },
    ...(typeof directory === 'string' && directory ? { query: { directory } } : {}),
  };
}

function modelParts(model: unknown): { providerID?: string; modelID?: string } {
  if (typeof model !== 'string') return {};
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) return {};
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

function pruneSessions(now = Date.now()): void {
  for (const [sessionID, metadata] of shared.sessions) {
    if (metadata.updatedAt + SESSION_METADATA_TTL_MS <= now) shared.sessions.delete(sessionID);
  }
  while (shared.sessions.size > MAX_SESSION_METADATA) {
    const oldest = shared.sessions.keys().next().value;
    if (oldest === undefined) break;
    shared.sessions.delete(oldest);
  }
}

function updateSession(sessionID: unknown, values: Partial<SessionMetadata>): void {
  if (typeof sessionID !== 'string' || !sessionID) return;
  const current = shared.sessions.get(sessionID) ?? { updatedAt: 0 };
  shared.sessions.delete(sessionID);
  shared.sessions.set(sessionID, { ...current, ...values, updatedAt: Date.now() });
  pruneSessions();
}

function messageMetadata(message: unknown): Partial<SessionMetadata> | undefined {
  const messageRecord = recordValue(message);
  const info = recordValue(messageRecord?.info) ?? messageRecord;
  if (info?.role !== 'user') return undefined;
  const model = recordValue(info.model);
  return {
    agent: typeof info.agent === 'string' ? info.agent : undefined,
    modelID: typeof model?.modelID === 'string' ? model.modelID : undefined,
    providerID: typeof model?.providerID === 'string' ? model.providerID : undefined,
    variant: typeof info.variant === 'string' ? info.variant : undefined,
  };
}

function completeRootMetadata(metadata: SessionMetadata | undefined): metadata is CompleteSessionMetadata {
  return (
    typeof metadata?.root === 'boolean'
    && typeof metadata.agent === 'string'
    && typeof metadata.providerID === 'string'
    && typeof metadata.modelID === 'string'
    && typeof metadata.variant === 'string'
  );
}

async function hydrateSession(
  client: OpenCodeClient,
  directory: unknown,
  sessionID: string,
): Promise<SessionMetadata | undefined> {
  if (!client.session?.get || !client.session.messages) {
    throw new Error('OpenCode session client is unavailable');
  }
  const session = recordValue(responseData(await client.session.get(sessionOptions(sessionID, directory))));
  if (session?.id !== sessionID) throw new Error('OpenCode returned incomplete session metadata');
  updateSession(sessionID, { root: !session.parentID });
  let metadata = shared.sessions.get(sessionID);
  if (!completeRootMetadata(metadata)) {
    const messages = responseData(await client.session.messages(sessionOptions(sessionID, directory)));
    const user = Array.isArray(messages)
      ? messages.map(messageMetadata).findLast((value) => value !== undefined)
      : undefined;
    if (user) updateSession(sessionID, user);
    metadata = shared.sessions.get(sessionID);
  }
  return metadata;
}

async function rootMetadata(
  client: OpenCodeClient,
  directory: unknown,
  sessionID: string,
): Promise<SessionMetadata | undefined> {
  pruneSessions();
  const cached = shared.sessions.get(sessionID);
  if (completeRootMetadata(cached)) return cached;
  if (!client.session?.get || !client.session.messages) return cached;
  try {
    return await hydrateSession(client, directory, sessionID);
  } catch {
    return shared.sessions.get(sessionID);
  }
}

async function assertSolXhighRoot(
  client: OpenCodeClient,
  directory: unknown,
  scope: string,
  sessionID: string,
): Promise<void> {
  const expected = modelParts(shared.solModels.get(scope));
  const metadata = await rootMetadata(client, directory, sessionID);
  const authorized =
    completeRootMetadata(metadata)
    && metadata.root
    && metadata.agent === 'naru-orchestrator'
    && (metadata.variant === 'xhigh' || metadata.variant === 'max')
    && metadata.providerID === expected.providerID
    && metadata.modelID === expected.modelID;
  if (!authorized) {
    throw new Error('Sol xhigh routes require a direct naru-orchestrator root running the configured Sol model at xhigh or max');
  }
}

function legacyProjection(value: unknown): LegacyRoutingProjection {
  const policy = resolveRoutingPolicy(value);
  const agents = {} as Record<NaruAgentId, 'fast' | 'deep'>;
  for (const agent of NARU_AGENT_IDS) agents[agent] = policy.agents[agent] === 'sol' ? 'deep' : 'fast';
  return {
    schemaVersion: 1,
    profiles: {
      fast: clone(policy.profiles.terra),
      deep: clone(policy.profiles.sol),
    },
    agents,
  };
}

function stateFor(config: UnknownRecord): DelegateConfigState {
  let state = shared.configs.get(config);
  if (state) return state;
  const agents = recordValue(config.agent);
  const originals = {} as Record<NaruAgentId, OriginalAgentConfiguration>;
  for (const agent of NARU_AGENT_IDS) {
    const present = Boolean(agents && Object.hasOwn(agents, agent));
    originals[agent] = { present, value: present ? clone(agents?.[agent]) : undefined };
  }
  state = {
    disabled: false,
    originals,
    aliases: new Set(),
    // A stale v1 plugin may share this state key, so keep its overrides in v1 form.
    overrides: { schemaVersion: 1, profiles: {}, agents: {} },
    overridesV2: parseRoutingOverrides(),
  };
  shared.configs.set(config, state);
  return state;
}

function restoreOriginals(config: UnknownRecord, state: DelegateConfigState): void {
  const agents = recordValue(config.agent);
  if (!agents) return;
  for (const alias of state.aliases) delete agents[alias];
  for (const agent of NARU_AGENT_IDS) {
    const original = state.originals[agent];
    if (original.present) agents[agent] = clone(original.value);
    else delete agents[agent];
  }
  state.aliases.clear();
}

export const NaruDelegatePlugin = async (
  { client, directory }: OpenCodePluginInput,
  options: DelegatePluginOptions | null = {},
): Promise<DelegatePluginHooks> => {
  const scope = typeof directory === 'string' ? directory : '';
  let depthCompatibility = subagentDepthCompatibility(undefined);
  return {
    config: async (configValue: unknown) => {
      const config = recordValue(configValue);
      if (!config) throw new Error('OpenCode configuration must be an object');
      const state = stateFor(config);
      depthCompatibility = subagentDepthCompatibility(config.subagent_depth);
      state.depthCompatibility = depthCompatibility;
      if (!depthCompatibility.compatible && !state.depthWarningLogged) {
        state.depthWarningLogged = true;
        await logDepthIncompatibility(client, depthCompatibility);
      }
      if (state.disabled) return;
      try {
        const legacyOverrides = parseRoutingOverrides(state.overrides);
        const baseOverrides = mergeRoutingOverrides(state.overridesV2 ?? legacyOverrides, legacyOverrides);
        const overrides: NormalizedRoutingOverrides = mergeRoutingOverrides(baseOverrides, await readOverrides(options));
        restoreOriginals(config, state);
        const summary = applyRoutingToConfig(config, overrides);
        state.overrides = legacyProjection(overrides);
        state.overridesV2 = overrides;
        state.aliases = new Set(summary.aliases);
        shared.solModels.set(scope, summary.profiles.sol.model);
      } catch (error) {
        restoreOriginals(config, state);
        state.disabled = true;
        shared.solModels.delete(scope);
        await logFailure(client, error);
      }
    },
    event: async (input: unknown) => {
      const inputRecord = recordValue(input);
      const event = recordValue(inputRecord?.event);
      const properties = recordValue(event?.properties);
      const info = recordValue(properties?.info);
      if (event?.type === 'session.deleted') {
        if (typeof info?.id === 'string') shared.sessions.delete(info.id);
        return;
      }
      if ((event?.type === 'session.created' || event?.type === 'session.updated') && typeof info?.id === 'string') {
        updateSession(info.id, { root: !info.parentID });
      }
    },
    'chat.message': async (input: unknown) => {
      const message = recordValue(input);
      const model = recordValue(message?.model);
      const sessionID = message?.sessionID;
      updateSession(sessionID, {
        agent: typeof message?.agent === 'string' ? message.agent : undefined,
        modelID: typeof model?.modelID === 'string' ? model.modelID : undefined,
        providerID: typeof model?.providerID === 'string' ? model.providerID : undefined,
        variant: typeof message?.variant === 'string' ? message.variant : undefined,
      });
      if (typeof sessionID !== 'string' || !sessionID || !client.session?.get) return;
      try {
        const session = recordValue(responseData(await client.session.get(sessionOptions(sessionID, directory))));
        if (session?.id === sessionID) updateSession(sessionID, { root: !session.parentID });
      } catch {
        // The Task gate will retry hydration and fail closed if session metadata remains incomplete.
      }
    },
    'tool.execute.before': async (input: unknown, output: unknown) => {
      const hookInput = recordValue(input);
      const hookOutput = recordValue(output);
      const args = recordValue(hookOutput?.args);
      if (hookInput?.tool !== 'task' || !args) return;
      const target = args.subagent_type;
      if (ROOT_ONLY_NARU_AGENTS.has(target)) {
        throw new Error(`${String(target)} is root-only; use direct agent selection`);
      }
      if ((NARU_AGENTS.has(target) || isManagedRoutingAlias(target)) && args.task_id) {
        throw new Error('Naru Delegate requires a fresh child session; task_id resume is disabled');
      }
      if (!depthCompatibility.compatible && isNaruDispatcherTarget(target)) {
        throw new Error(`Cannot launch Naru dispatcher ${String(target)}: ${depthCompatibility.description}; required minimum is ${NARU_MINIMUM_SUBAGENT_DEPTH}. Set top-level subagent_depth to at least ${NARU_MINIMUM_SUBAGENT_DEPTH} in OpenCode config, then restart OpenCode.`);
      }
      if (isSolXhighAlias(target)) {
        const sessionID = hookInput.sessionID;
        if (typeof sessionID !== 'string' || !sessionID) {
          throw new Error('Sol xhigh routes require complete root session metadata');
        }
        await assertSolXhighRoot(client, directory, scope, sessionID);
      }
    },
  };
};
