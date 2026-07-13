/** @jsxImportSource @opentui/solid */
import { createEffect, createSignal, For, onCleanup } from "solid-js"

import {
  canonicalAgentForRoute,
  isManagedRoutingAlias,
  NARU_AGENT_IDS,
} from "../tools/naru-lib/model-routing.mjs"
import { parentTasks, routeText, statusText } from "./naru-minions-dashboard-state.mjs"

const COMMAND = "naru.minions"
const TITLE = "Naru Activity"
const NARU_AGENTS = new Set(NARU_AGENT_IDS)
const RECENT_MS = 15 * 60 * 1000

function responseData(result, fallback) {
  if (!result || typeof result !== "object") return fallback
  if (result.error) throw new Error(formatError(result.error))
  return result.data ?? fallback
}

function formatError(error) {
  if (!error) return "Unknown error"
  if (typeof error === "string") return error
  if (typeof error.message === "string") return error.message
  return "Unknown error"
}

function currentSessionID(api) {
  const current = api.route?.current
  if (current?.name !== "session") return undefined
  const id = current.params?.sessionID
  return typeof id === "string" && id ? id : undefined
}

function directory(api) {
  const value = api.state?.path?.directory
  return typeof value === "string" && value ? value : undefined
}

async function getSession(api, sessionID) {
  const cached = api.state?.session?.get?.(sessionID)
  if (cached) return cached
  return responseData(await api.client.session.get({ sessionID, directory: directory(api) }), undefined)
}

function statusRank(status) {
  if (status === "busy") return 0
  if (status.startsWith("retry")) return 1
  if (status === "running") return 2
  if (status === "pending") return 3
  if (status === "error") return 4
  if (status === "completed") return 5
  if (status === "idle") return 6
  return 7
}

function age(timestamp) {
  if (typeof timestamp !== "number") return "resolving"
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

function canonicalAgent(value) {
  if (typeof value !== "string" || !value.startsWith("naru-")) return undefined
  if (isManagedRoutingAlias(value)) return canonicalAgentForRoute(value)
  return NARU_AGENTS.has(value) ? value : undefined
}

function messageMetadata(messages) {
  let agent
  let provider
  let model
  let variant
  let task
  for (const message of messages) {
    const info = message.info ?? message
    agent ??= info.agent
    provider ??= info.providerID ?? info.providerId ?? info.model?.providerID
    model ??= info.modelID ?? info.modelId ?? info.model?.modelID
    variant ??= info.variant
    if (!task && info.role === "user") {
      const text = (message.parts ?? []).find((part) => part?.type === "text")?.text
      if (typeof text === "string" && text.trim()) task = text.trim()
    }
  }
  return { agent, model, provider, task, variant }
}

function actualModel(metadata) {
  if (!metadata.model) return "resolving"
  const model = metadata.provider ? `${metadata.provider}/${metadata.model}` : metadata.model
  return metadata.variant ? `${model} (${metadata.variant})` : model
}

function titleAgent(title) {
  if (typeof title !== "string") return undefined
  return NARU_AGENT_IDS.find((agent) => title === agent || title.startsWith(`${agent}:`) || title.startsWith(`${agent} `))
}

async function loadRows(api, sessionID) {
  const session = await getSession(api, sessionID)
  const rootID = session?.parentID || sessionID
  const [childrenResult, statusResult, parentMessagesResult] = await Promise.all([
    api.client.session.children({ sessionID: rootID, directory: directory(api) }),
    api.client.session.status({ directory: directory(api) }),
    api.client.session.messages({ sessionID: rootID, directory: directory(api) }),
  ])
  const children = responseData(childrenResult, [])
  const statuses = responseData(statusResult, {})
  const tasks = parentTasks(responseData(parentMessagesResult, []))
  const messages = await Promise.all(children.map(async (child) => {
    try {
      const result = await api.client.session.messages({ sessionID: child.id, directory: directory(api) })
      return [child.id, responseData(result, [])]
    } catch {
      return [child.id, []]
    }
  }))
  const messagesByChild = new Map(messages)

  const rows = children.flatMap((child) => {
    const task = tasks.get(child.id) ?? {}
    const metadata = messageMetadata(messagesByChild.get(child.id) ?? [])
    const rawAgent = task.agent ?? metadata.agent ?? titleAgent(child.title)
    const agent = canonicalAgent(rawAgent)
    if (!agent) return []
    const status = statusText(statuses[child.id] || api.state?.session?.status?.(child.id), task.status)
    const updated = child.time?.updated
    return [{
      agent,
      id: child.id,
      model: actualModel({
        model: task.model ?? metadata.model,
        provider: task.provider ?? metadata.provider,
        variant: task.variant ?? metadata.variant,
      }),
      route: routeText(rawAgent, agent, api.state?.config?.agent),
      status,
      mode: task.background === true ? "background" : task.background === false ? "foreground" : undefined,
      task: task.description ?? task.prompt ?? metadata.task ?? child.title ?? "Resolving task metadata",
      updated,
    }]
  }).sort((a, b) => statusRank(a.status) - statusRank(b.status) || (b.updated ?? 0) - (a.updated ?? 0))

  return { rootID, rows }
}

function compactRows(rows) {
  const cutoff = Date.now() - RECENT_MS
  return rows.filter((row) => !["idle", "completed", "error"].includes(row.status) || (row.updated ?? 0) >= cutoff).slice(0, 4)
}

function showError(api, message) {
  api.ui.toast({ variant: "error", title: TITLE, message, duration: 5000 })
}

async function showMinions(api) {
  const sessionID = currentSessionID(api)
  if (!sessionID) return showError(api, "Open a session before running /naru-minions.")
  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() => api.ui.DialogSelect({
    title: TITLE,
    options: [{ title: "Loading Naru activity...", value: "loading", disabled: true }],
    skipFilter: true,
  }))
  try {
    const { rootID, rows } = await loadRows(api, sessionID)
    const options = rows.length ? rows.map((row) => ({
      title: row.task,
      value: row.id,
      category: `${row.status} · ${age(row.updated)}`,
      description: `${row.agent} · ${row.route}${row.mode ? ` · ${row.mode}` : ""} · ${row.model}`,
    })) : [{
      title: "No recognized Naru child sessions",
      value: "none",
      description: "Unrelated Task children are intentionally hidden.",
      disabled: true,
    }]
    api.ui.dialog.replace(() => api.ui.DialogSelect({
      title: `${TITLE} for ${rootID.slice(0, 8)} (${rows.length})`,
      placeholder: "Filter child sessions",
      options,
      onSelect: (item) => {
        if (!item?.value || item.disabled) return
        api.ui.dialog.clear()
        api.route.navigate("session", { sessionID: item.value })
      },
    }))
  } catch (error) {
    api.ui.dialog.clear()
    showError(api, formatError(error))
  }
}

function registerCommand(api) {
  if (api.keymap?.registerLayer) {
    api.keymap.registerLayer({
      commands: [{
        name: COMMAND,
        title: TITLE,
        desc: "Show Naru child-session activity",
        category: "Naru",
        namespace: "palette",
        slashName: "naru-minions",
        run: () => void showMinions(api),
      }],
      bindings: api.tuiConfig?.keybinds?.gather?.("naru.minions", [COMMAND]) ?? [],
    })
    return
  }
  api.command?.register?.(() => [{
    title: TITLE,
    value: COMMAND,
    description: "Show Naru child-session activity",
    category: "Naru",
    slash: { name: "naru-minions" },
    onSelect: () => void showMinions(api),
  }])
}

function NaruActivity(props) {
  const [rows, setRows] = createSignal([])
  const [degraded, setDegraded] = createSignal(false)
  let debounce
  let generation = 0

  const refresh = async (sessionID) => {
    const current = ++generation
    if (!sessionID) return setRows([])
    try {
      const loaded = await loadRows(props.api, sessionID)
      if (current === generation) {
        setRows(compactRows(loaded.rows))
        setDegraded(false)
      }
    } catch {
      if (current === generation) {
        setRows([])
        setDegraded(true)
      }
    }
  }
  const schedule = () => {
    clearTimeout(debounce)
    debounce = setTimeout(() => void refresh(props.sessionID), 120)
  }
  const disposers = ["session.updated", "session.status", "message.updated", "message.part.updated"].flatMap((name) => {
    const off = props.api.event?.on?.(name, schedule) ?? props.api.events?.on?.(name, schedule)
    return typeof off === "function" ? [off] : []
  })
  const clock = setInterval(() => setRows((current) => [...current]), 30_000)
  createEffect(() => void refresh(props.sessionID))
  onCleanup(() => {
    generation += 1
    clearTimeout(debounce)
    clearInterval(clock)
    for (const dispose of disposers) dispose()
  })

  return <box flexDirection="column" paddingTop={1}>
    <text><b>Naru Activity</b></text>
    <For each={rows()} fallback={<text>{degraded() ? "Unavailable" : "No active minions"}</text>}>
      {(row) => <box flexDirection="column" paddingTop={1}>
        <text>{row.status} · {age(row.updated)} · {row.route}{row.mode ? ` · ${row.mode}` : ""}</text>
        <text>{row.agent}</text>
        <text>{row.task}</text>
        <text>{row.model}</text>
      </box>}
    </For>
  </box>
}

const plugin = {
  id: "naru-minions-dashboard",
  async tui(api) {
    registerCommand(api)
    api.slots.register({
      order: 100,
      slots: {
        sidebar_content(_ctx, props) {
          return <NaruActivity api={api} sessionID={props.session_id} />
        },
      },
    })
  },
}

export default plugin
