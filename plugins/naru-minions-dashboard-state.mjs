import {
  canonicalAgentForRoute,
  isLunaAlias,
  isManagedRoutingAlias,
  isSolAlias,
  isSolXhighAlias,
  SOL_FLOOR_ROLES,
} from '../tools/naru-lib/model-routing.mjs'

const SOL_FLOOR = new Set(SOL_FLOOR_ROLES)
const TERMINAL_STATUSES = new Set(['completed', 'error', 'idle'])
const RECENT_MS = 15 * 60 * 1000
const COMPACT_PRIMARY_COLUMNS = [
  ['STATUS', 11],
  ['AGENT', 12],
  ['AGE', 9],
  ['TASK', 26],
]
export const SIDEBAR_WIDTH = 32
export const DASHBOARD_SENTINELS = Object.freeze({
  loading: 'naru-dashboard:loading',
  empty: 'naru-dashboard:empty',
  unavailable: 'naru-dashboard:unavailable',
})
const SENTINEL_VALUES = new Set(Object.values(DASHBOARD_SENTINELS))

export function sanitizeText(value) {
  if (value === undefined || value === null) return ''
  return String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function truncateText(value, width) {
  const text = sanitizeText(value)
  const size = Math.max(0, Math.floor(Number(width) || 0))
  if (text.length <= size) return text
  if (size === 0) return ''
  if (size === 1) return '…'
  return `${text.slice(0, size - 1)}…`
}

export function padCell(value, width, align = 'left') {
  const size = Math.max(0, Math.floor(Number(width) || 0))
  const text = truncateText(value, size)
  return align === 'right' ? text.padStart(size) : text.padEnd(size)
}

export function dividerLine(width) {
  return '-'.repeat(Math.max(0, Math.floor(Number(width) || 0)))
}

export function shortSessionID(value) {
  return truncateText(value, 8)
}

export function shortAgent(value) {
  const agent = sanitizeText(value)
    .replace(/^naru-minion-/, '')
    .replace(/^naru-/, '')
  return truncateText(agent || 'unknown', 12)
}

export function shortModel(value) {
  const model = sanitizeText(value)
  const slash = model.lastIndexOf('/')
  return truncateText(slash === -1 ? model : model.slice(slash + 1), 20) || 'resolving'
}

export function ageText(timestamp, now = Date.now()) {
  if (typeof timestamp !== 'number') return 'resolving'
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

export function statusPresentation(status) {
  const value = sanitizeText(status).toLowerCase()
  if (value === 'busy') return { symbol: '●', label: 'BUSY' }
  if (value.startsWith('retry')) return { symbol: '↻', label: value.toUpperCase() }
  if (value === 'running') return { symbol: '▶', label: 'RUNNING' }
  if (value === 'pending') return { symbol: '◌', label: 'PENDING' }
  if (value === 'completed') return { symbol: '✓', label: 'DONE' }
  if (value === 'error') return { symbol: '!', label: 'ERROR' }
  if (value === 'idle') return { symbol: '○', label: 'IDLE' }
  return { symbol: '?', label: value ? value.toUpperCase() : 'UNKNOWN' }
}

function isRecent(row, now) {
  return typeof row?.updated === 'number' && row.updated >= now - RECENT_MS
}

export function activityCounts(rows, now = Date.now()) {
  let active = 0
  let recent = 0
  for (const row of rows ?? []) {
    if (TERMINAL_STATUSES.has(row.status)) {
      if (isRecent(row, now)) recent += 1
    } else {
      active += 1
    }
  }
  return { active, recent }
}

export function visibleActivityRows(rows, limit = 4, now = Date.now()) {
  return (rows ?? [])
    .filter((row) => !TERMINAL_STATUSES.has(row.status) || isRecent(row, now))
    .slice(0, Math.max(0, limit))
}

export function hiddenCount(total, visible) {
  return Math.max(0, Math.floor(Number(total) || 0) - Math.floor(Number(visible) || 0))
}

function modeText(mode) {
  if (mode === 'background') return 'BG'
  if (mode === 'foreground') return 'FG'
  return '—'
}

function compactValues(row, now) {
  const status = statusPresentation(row?.status)
  return {
    status: `${status.symbol} ${status.label}`,
    agent: shortAgent(row?.agent),
    route: sanitizeText(row?.route) || 'Unknown',
    mode: modeText(row?.mode),
    age: ageText(row?.updated, now),
    task: sanitizeText(row?.task) || 'Resolving task metadata',
    model: shortModel(row?.model),
    session: shortSessionID(row?.id),
  }
}

export function compactLegend() {
  return COMPACT_PRIMARY_COLUMNS.map(([label, width]) => padCell(label, width)).join(' ')
}

export function compactRowTitle(row, now = Date.now()) {
  const value = compactValues(row, now)
  return COMPACT_PRIMARY_COLUMNS
    .map(([label, width]) => padCell(value[label.toLowerCase()], width))
    .join(' ')
}

export function compactRowMetadata(row) {
  const value = compactValues(row, 0)
  return `Route: ${truncateText(value.route, 10)} · Mode: ${value.mode} · Model: ${value.model} · Session: ${value.session}`
}

export function isSelectableSessionValue(value) {
  return typeof value === 'string' && value.length > 0 && !SENTINEL_VALUES.has(value)
}

export function sidebarLine(value) {
  return truncateText(value, SIDEBAR_WIDTH)
}

export function sidebarHeaderLine(active, recent) {
  return sidebarLine(`Naru Activity · A:${truncateText(active, 4)} · R:${truncateText(recent, 4)}`)
}

export function sidebarDividerLine() {
  return dividerLine(SIDEBAR_WIDTH)
}

export function sidebarStatusLine(row, now = Date.now()) {
  const value = compactValues(row, now)
  return sidebarLine(`${padCell(value.status, 11)} ${padCell(value.agent, 10)} ${truncateText(value.age, 9)}`)
}

export function sidebarTaskLine(row) {
  return sidebarLine(row?.task || 'Resolving task metadata')
}

export function sidebarMetadataLine(row) {
  const value = compactValues(row, 0)
  return sidebarLine(`${truncateText(value.route, 10)} · ${value.mode} · ${value.model}`)
}

export function sidebarOverflowLine(count) {
  const value = Math.max(0, Math.floor(Number(count) || 0))
  return sidebarLine(`+${truncateText(value, 6)} more · /naru-minions`)
}

function schedulerMode(telemetry) {
  const mode = sanitizeText(telemetry?.mode).toUpperCase()
  return mode || 'UNKNOWN'
}

export function schedulerHeaderLine(telemetry) {
  if (!telemetry) return ''
  return sidebarLine(`Scheduler · ${schedulerMode(telemetry)} · local`)
}

export function schedulerCountsLine(telemetry) {
  if (!telemetry) return ''
  const counts = telemetry.counts ?? {}
  return sidebarLine(`Live ${counts.live ?? 0} · Pend ${counts.pending ?? 0} · Block ${counts.blocked ?? 0}`)
}

export function schedulerBudgetLine(telemetry) {
  if (!telemetry) return ''
  const budget = telemetry.budget ?? {}
  const usage = budget.usage ?? {}
  const limits = budget.limits ?? {}
  return sidebarLine(`Local budget ${budget.pressure ?? 'unknown'} · ${usage.totalChildren ?? 0}/${limits.maxTotalChildren ?? 0}`)
}

export function schedulerQualityLine(telemetry) {
  if (!telemetry) return ''
  return sidebarLine(`Quality gate · ${telemetry.qualityGate?.status ?? 'unknown'}`)
}

export function schedulerBlockedLine(telemetry, now = Date.now()) {
  const blocked = telemetry?.oldestBlocked
  if (!blocked) return ''
  const age = Number.isSafeInteger(blocked.since) ? ageText(blocked.since, now) : 'age unknown'
  return sidebarLine(`Oldest block · ${blocked.workItemId} · ${age}`)
}

export function schedulerActorsLine(telemetry) {
  const actors = telemetry?.actors ?? []
  if (actors.length === 0) return ''
  const values = actors.slice(0, 2).map((actor) => (
    `${shortAgent(actor.agent)} A${actor.active ?? 0}/E${actor.artifacts ?? 0}`
  ))
  if ((telemetry.omittedActorCount ?? 0) > 0 || actors.length > 2) values.push('+more')
  return sidebarLine(`Roles · ${values.join(' · ')}`)
}

export function schedulerDialogTitle(telemetry) {
  if (!telemetry) return ''
  const counts = telemetry.counts ?? {}
  return truncateText(
    `Scheduler ${schedulerMode(telemetry)} local · L:${counts.live ?? 0} P:${counts.pending ?? 0} B:${counts.blocked ?? 0}`,
    61,
  )
}

export function schedulerDialogMetadata(telemetry) {
  if (!telemetry) return ''
  const budget = telemetry.budget ?? {}
  const usage = budget.usage ?? {}
  const limits = budget.limits ?? {}
  const blocked = telemetry.oldestBlocked?.workItemId ?? 'none'
  return truncateText(
    `Process-local budget: ${budget.pressure ?? 'unknown'} ${usage.totalChildren ?? 0}/${limits.maxTotalChildren ?? 0} · Quality: ${telemetry.qualityGate?.status ?? 'unknown'} · Oldest blocked: ${blocked}`,
    100,
  )
}

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
  if (isLunaAlias(rawAgent)) return 'Luna'
  if (isSolXhighAlias(rawAgent)) return 'Sol xhigh'
  if (isManagedRoutingAlias(rawAgent)) return 'Sol'
  if (SOL_FLOOR.has(agent)) return 'Sol floor'

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
