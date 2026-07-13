import {
  canonicalAgentForRoute,
  isLunaAlias,
  isManagedRoutingAlias,
  isSolAlias,
  SOL_FLOOR_ROLES,
} from '../tools/naru-lib/model-routing.mjs'

const SOL_FLOOR = new Set(SOL_FLOOR_ROLES)

function canonicalAgent(value) {
  if (typeof value !== 'string') return undefined
  if (isManagedRoutingAlias(value)) return canonicalAgentForRoute(value)
  return value
}

function profile(agent) {
  if (!agent || typeof agent.model !== 'string') return undefined
  return `${agent.model}\u0000${agent.variant ?? ''}`
}

export function routeText(rawAgent, agent, configuredAgents = {}) {
  if (!agent) return 'Unknown'
  if (SOL_FLOOR.has(agent)) return 'Sol floor'
  if (isLunaAlias(rawAgent)) return 'Luna'
  if (isManagedRoutingAlias(rawAgent)) return 'Sol'

  const current = profile(configuredAgents[rawAgent] ?? configuredAgents[agent])
  const alias = Object.keys(configuredAgents).find(isSolAlias)
  const sol = profile(alias ? configuredAgents[alias] : configuredAgents[SOL_FLOOR_ROLES[0]])
  const terra = profile(alias ? configuredAgents[canonicalAgent(alias)] : undefined)
  if (!current) return 'Routed'
  if (sol && current === sol) return terra === sol ? 'Routed' : 'Sol'
  if (terra && current === terra) return 'Terra'
  return 'Routed'
}

export function statusText(nativeStatus, taskStatus) {
  // Terminal Task state is authoritative, followed by native active state,
  // Task pending/running, native or Task idle, and finally unknown state.
  if (taskStatus === "completed" || taskStatus === "error") return taskStatus
  if (nativeStatus?.type === "busy") return "busy"
  if (nativeStatus?.type === "retry") return `retry ${nativeStatus.attempt ?? ""}`.trim()
  if (taskStatus === "pending" || taskStatus === "running") return taskStatus
  if (nativeStatus?.type === "idle" || taskStatus === "idle") return "idle"
  return nativeStatus?.type || taskStatus || "unknown"
}

function taskSessionID(part) {
  const state = part?.state ?? {}
  const metadata = state.metadata ?? part?.metadata ?? {}
  for (const value of [metadata.sessionID, metadata.sessionId, metadata.childSessionID, state.sessionID]) {
    if (typeof value === "string" && value) return value
  }
}

export function parentTasks(messages) {
  const tasks = new Map()
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (part?.type !== "tool" || part.tool !== "task") continue
      const childID = taskSessionID(part)
      if (!childID) continue
      const input = part.state?.input ?? part.input ?? {}
      const metadata = part.state?.metadata ?? part.metadata ?? {}
      tasks.set(childID, {
        agent: input.subagent_type,
        background: input.background ?? metadata.background,
        description: input.description,
        model: metadata.modelID ?? metadata.modelId ?? metadata.model?.modelID,
        prompt: input.prompt,
        provider: metadata.providerID ?? metadata.providerId ?? metadata.model?.providerID,
        status: part.state?.status ?? part.status,
        variant: metadata.variant,
      })
    }
  }
  return tasks
}
