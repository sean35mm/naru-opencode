import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import {
  applyRoutingToConfig,
  isManagedRoutingAlias,
  isSolXhighAlias,
  mergeRoutingOverrides,
  NARU_AGENT_IDS,
  parseRoutingOverrides,
  resolveRoutingPolicy,
} from '../tools/naru-lib/model-routing.mjs'

const CONFIG_PATH = fileURLToPath(new URL('../naru-models.json', import.meta.url))
const MAX_CONFIG_BYTES = 64 * 1024
const MAX_SESSION_METADATA = 512
const SESSION_METADATA_TTL_MS = 30 * 60 * 1000
const NARU_AGENTS = new Set(NARU_AGENT_IDS)
const STATE_KEY = Symbol.for('naru.delegate.config-state.v1')
const shared = globalThis[STATE_KEY] ?? { configs: new WeakMap() }
shared.sessions ??= new Map()
shared.solModels ??= new Map()
globalThis[STATE_KEY] = shared

async function readOverrides(options) {
  if (Object.hasOwn(options ?? {}, 'routingOverrides')) return options.routingOverrides
  let info
  try {
    info = await lstat(CONFIG_PATH)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  if (info.isSymbolicLink()) throw new Error('naru-models.json must not be a symlink')
  if (!info.isFile()) throw new Error('naru-models.json must be a regular file')
  if (info.size > MAX_CONFIG_BYTES) throw new Error('naru-models.json exceeds 64 KiB')

  const handle = await open(CONFIG_PATH, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile()) throw new Error('naru-models.json must be a regular file')
    if (opened.size > MAX_CONFIG_BYTES) throw new Error('naru-models.json exceeds 64 KiB')
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1)
    let total = 0
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total > MAX_CONFIG_BYTES) throw new Error('naru-models.json exceeds 64 KiB')
    return JSON.parse(buffer.subarray(0, total).toString('utf8'))
  } finally {
    await handle.close()
  }
}

async function logFailure(client, error) {
  const message = error instanceof Error ? error.message : String(error)
  try {
    await client.app.log({
      body: {
        service: 'naru-delegate',
        level: 'error',
        message: `Dynamic model routing disabled: ${message}`,
      },
    })
  } catch {
    console.warn(`[naru-delegate] Dynamic model routing disabled: ${message}`)
  }
}

function clone(value) {
  return structuredClone(value)
}

function responseData(result) {
  if (result?.error) throw new Error(result.error.message ?? 'OpenCode client request failed')
  return result?.data ?? result
}

function sessionOptions(sessionID, directory) {
  return {
    path: { id: sessionID },
    ...(typeof directory === 'string' && directory ? { query: { directory } } : {}),
  }
}

function modelParts(model) {
  if (typeof model !== 'string') return {}
  const slash = model.indexOf('/')
  if (slash <= 0 || slash === model.length - 1) return {}
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
}

function pruneSessions(now = Date.now()) {
  for (const [sessionID, metadata] of shared.sessions) {
    if (metadata.updatedAt + SESSION_METADATA_TTL_MS <= now) shared.sessions.delete(sessionID)
  }
  while (shared.sessions.size > MAX_SESSION_METADATA) {
    shared.sessions.delete(shared.sessions.keys().next().value)
  }
}

function updateSession(sessionID, values) {
  if (typeof sessionID !== 'string' || !sessionID) return
  const current = shared.sessions.get(sessionID) ?? {}
  shared.sessions.delete(sessionID)
  shared.sessions.set(sessionID, { ...current, ...values, updatedAt: Date.now() })
  pruneSessions()
}

function messageMetadata(message) {
  const info = message?.info ?? message
  if (info?.role !== 'user') return
  return {
    agent: typeof info.agent === 'string' ? info.agent : undefined,
    modelID: typeof info.model?.modelID === 'string' ? info.model.modelID : undefined,
    providerID: typeof info.model?.providerID === 'string' ? info.model.providerID : undefined,
    variant: typeof info.variant === 'string' ? info.variant : undefined,
  }
}

function completeRootMetadata(metadata) {
  return (
    typeof metadata?.root === 'boolean' &&
    typeof metadata.agent === 'string' &&
    typeof metadata.providerID === 'string' &&
    typeof metadata.modelID === 'string' &&
    typeof metadata.variant === 'string'
  )
}

async function hydrateSession(client, directory, sessionID) {
  const session = responseData(await client.session.get(sessionOptions(sessionID, directory)))
  if (session?.id !== sessionID) throw new Error('OpenCode returned incomplete session metadata')
  updateSession(sessionID, { root: !session.parentID })
  let metadata = shared.sessions.get(sessionID)
  if (!completeRootMetadata(metadata)) {
    const messages = responseData(await client.session.messages(sessionOptions(sessionID, directory)))
    const user = Array.isArray(messages)
      ? messages.map(messageMetadata).findLast((value) => value !== undefined)
      : undefined
    if (user) updateSession(sessionID, user)
    metadata = shared.sessions.get(sessionID)
  }
  return metadata
}

async function rootMetadata(client, directory, sessionID) {
  pruneSessions()
  const cached = shared.sessions.get(sessionID)
  if (completeRootMetadata(cached)) return cached
  if (!client?.session?.get || !client?.session?.messages) return cached
  try {
    return await hydrateSession(client, directory, sessionID)
  } catch {
    return shared.sessions.get(sessionID)
  }
}

async function assertSolXhighRoot(client, directory, scope, sessionID) {
  const expected = modelParts(shared.solModels.get(scope))
  const metadata = await rootMetadata(client, directory, sessionID)
  const authorized =
    completeRootMetadata(metadata) &&
    metadata.root &&
    metadata.agent === 'naru-orchestrator' &&
    (metadata.variant === 'xhigh' || metadata.variant === 'max') &&
    metadata.providerID === expected.providerID &&
    metadata.modelID === expected.modelID
  if (!authorized) {
    throw new Error('Sol xhigh routes require a direct naru-orchestrator root running the configured Sol model at xhigh or max')
  }
}

function legacyProjection(value) {
  const policy = resolveRoutingPolicy(value)
  const agents = {}
  for (const agent of NARU_AGENT_IDS) agents[agent] = policy.agents[agent] === 'sol' ? 'deep' : 'fast'
  return {
    schemaVersion: 1,
    profiles: {
      fast: clone(policy.profiles.terra),
      deep: clone(policy.profiles.sol),
    },
    agents,
  }
}

function stateFor(config) {
  let state = shared.configs.get(config)
  if (state) return state
  const originals = {}
  for (const agent of NARU_AGENT_IDS) {
    const present = Boolean(config?.agent && Object.hasOwn(config.agent, agent))
    originals[agent] = { present, value: present ? clone(config.agent[agent]) : undefined }
  }
  state = {
    disabled: false,
    originals,
    aliases: new Set(),
    // A stale v1 plugin may share this state key, so keep its overrides in v1 form.
    overrides: { schemaVersion: 1, profiles: {}, agents: {} },
    overridesV2: parseRoutingOverrides(),
  }
  shared.configs.set(config, state)
  return state
}

function restoreOriginals(config, state) {
  if (!config?.agent || typeof config.agent !== 'object') return
  for (const alias of state.aliases) delete config.agent[alias]
  for (const agent of NARU_AGENT_IDS) {
    const original = state.originals[agent]
    if (original.present) config.agent[agent] = clone(original.value)
    else delete config.agent[agent]
  }
  state.aliases.clear()
}

export const NaruDelegatePlugin = async ({ client, directory }, options = {}) => {
  const scope = typeof directory === 'string' ? directory : ''
  return {
    config: async (config) => {
      const state = stateFor(config)
      if (state.disabled) return
      try {
        const legacyOverrides = parseRoutingOverrides(state.overrides)
        const baseOverrides = mergeRoutingOverrides(state.overridesV2 ?? legacyOverrides, legacyOverrides)
        const overrides = mergeRoutingOverrides(baseOverrides, await readOverrides(options))
        restoreOriginals(config, state)
        const summary = applyRoutingToConfig(config, overrides)
        state.overrides = legacyProjection(overrides)
        state.overridesV2 = overrides
        state.aliases = new Set(summary.aliases)
        shared.solModels.set(scope, summary.profiles.sol.model)
      } catch (error) {
        restoreOriginals(config, state)
        state.disabled = true
        shared.solModels.delete(scope)
        await logFailure(client, error)
      }
    },
    event: async ({ event }) => {
      const info = event?.properties?.info
      if (event?.type === 'session.deleted') {
        if (typeof info?.id === 'string') shared.sessions.delete(info.id)
        return
      }
      if ((event?.type === 'session.created' || event?.type === 'session.updated') && typeof info?.id === 'string') {
        updateSession(info.id, { root: !info.parentID })
      }
    },
    'chat.message': async (input) => {
      updateSession(input.sessionID, {
        agent: typeof input.agent === 'string' ? input.agent : undefined,
        modelID: typeof input.model?.modelID === 'string' ? input.model.modelID : undefined,
        providerID: typeof input.model?.providerID === 'string' ? input.model.providerID : undefined,
        variant: typeof input.variant === 'string' ? input.variant : undefined,
      })
      if (!client?.session?.get) return
      try {
        const session = responseData(await client.session.get(sessionOptions(input.sessionID, directory)))
        if (session?.id === input.sessionID) updateSession(input.sessionID, { root: !session.parentID })
      } catch {
        // The Task gate will retry hydration and fail closed if session metadata remains incomplete.
      }
    },
    'tool.execute.before': async (input, output) => {
      if (input.tool !== 'task' || !output.args || typeof output.args !== 'object') return
      const target = output.args.subagent_type
      if ((NARU_AGENTS.has(target) || isManagedRoutingAlias(target)) && output.args.task_id) {
        throw new Error('Naru Delegate requires a fresh child session; task_id resume is disabled')
      }
      if (isSolXhighAlias(target)) {
        await assertSolXhighRoot(client, directory, scope, input.sessionID)
      }
    },
  }
}
