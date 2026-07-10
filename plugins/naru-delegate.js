import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import {
  applyRoutingToConfig,
  isDeepAlias,
  mergeRoutingOverrides,
  NARU_AGENT_IDS,
  parseRoutingOverrides,
} from '../tools/naru-lib/model-routing.mjs'

const CONFIG_PATH = fileURLToPath(new URL('../naru-models.json', import.meta.url))
const MAX_CONFIG_BYTES = 64 * 1024
const NARU_AGENTS = new Set(NARU_AGENT_IDS)
const STATE_KEY = Symbol.for('naru.delegate.config-state.v1')
const shared = globalThis[STATE_KEY] ?? { configs: new WeakMap() }
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
    overrides: parseRoutingOverrides(),
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

export const NaruDelegatePlugin = async ({ client }, options = {}) => ({
  config: async (config) => {
    const state = stateFor(config)
    if (state.disabled) return
    try {
      const overrides = mergeRoutingOverrides(state.overrides, await readOverrides(options))
      restoreOriginals(config, state)
      const summary = applyRoutingToConfig(config, overrides)
      state.overrides = overrides
      state.aliases = new Set(summary.aliases)
    } catch (error) {
      restoreOriginals(config, state)
      state.disabled = true
      await logFailure(client, error)
    }
  },
  'tool.execute.before': async (input, output) => {
    if (input.tool !== 'task' || !output.args || typeof output.args !== 'object') return
    const target = output.args.subagent_type
    if ((NARU_AGENTS.has(target) || isDeepAlias(target)) && output.args.task_id) {
      throw new Error('Naru Delegate requires a fresh child session; task_id resume is disabled')
    }
  },
})
