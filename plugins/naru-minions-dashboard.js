const COMMAND = "naru.minions"
const TITLE = "Naru Minions"

function responseData(result, fallback) {
  if (!result || typeof result !== "object") return fallback
  if (result.error) throw new Error(formatError(result.error))
  return result.data ?? fallback
}

function formatError(error) {
  if (!error) return "Unknown error"
  if (typeof error === "string") return error
  if (typeof error.message === "string") return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return "Unknown error"
  }
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
  const result = await api.client.session.get({ sessionID, directory: directory(api) })
  return responseData(result, undefined)
}

function shortID(value) {
  return typeof value === "string" ? value.slice(0, 8) : "unknown"
}

function statusText(status) {
  if (!status || typeof status !== "object") return "unknown"
  if (status.type === "retry") return `retry ${status.attempt ?? ""}`.trim()
  return status.type || "unknown"
}

function statusRank(status) {
  const type = statusText(status)
  if (type === "busy") return 0
  if (type.startsWith("retry")) return 1
  if (type === "idle") return 2
  return 3
}

function age(timestamp) {
  if (typeof timestamp !== "number") return "unknown age"
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function showLoading(api) {
  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: TITLE,
      options: [
        {
          title: "Loading child sessions...",
          value: "loading",
          description: "Reading OpenCode session state",
          disabled: true,
        },
      ],
      skipFilter: true,
    }),
  )
}

function showError(api, message) {
  api.ui.toast({ variant: "error", title: TITLE, message, duration: 5000 })
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() =>
    api.ui.DialogAlert({
      title: `${TITLE} unavailable`,
      message,
      onConfirm: () => api.ui.dialog.clear(),
    }),
  )
}

async function loadRows(api, sessionID) {
  const session = await getSession(api, sessionID)
  const rootID = session?.parentID || sessionID
  const [childrenResult, statusResult] = await Promise.all([
    api.client.session.children({ sessionID: rootID, directory: directory(api) }),
    api.client.session.status({ directory: directory(api) }),
  ])
  const children = responseData(childrenResult, [])
  const statuses = responseData(statusResult, {})

  return {
    rootID,
    rows: [...children]
      .sort((a, b) => {
        const byStatus = statusRank(statuses[a.id]) - statusRank(statuses[b.id])
        if (byStatus !== 0) return byStatus
        return (b.time?.updated ?? 0) - (a.time?.updated ?? 0)
      })
      .map((child) => {
        const status = statusText(statuses[child.id] || api.state?.session?.status?.(child.id))
        const title = child.title || `Session ${shortID(child.id)}`
        return {
          title,
          value: child.id,
          category: status,
          description: `${status} - updated ${age(child.time?.updated)} - ${shortID(child.id)}`,
          footer: child.summary
            ? `${child.summary.files ?? 0} files, +${child.summary.additions ?? 0}/-${child.summary.deletions ?? 0}`
            : `parent ${shortID(rootID)}`,
        }
      }),
  }
}

async function showMinions(api) {
  const sessionID = currentSessionID(api)
  if (!sessionID) {
    showError(api, "Open a session first, then run /naru-minions from its root or child session.")
    return
  }

  showLoading(api)
  try {
    const { rootID, rows } = await loadRows(api, sessionID)
    const options = rows.length
      ? rows
      : [
          {
            title: "No child sessions found",
            value: "none",
            description: "Run naru-orchestrator or a Core workflow, then reopen /naru-minions.",
            disabled: true,
          },
        ]

    api.ui.dialog.setSize("large")
    api.ui.dialog.replace(() =>
      api.ui.DialogSelect({
        title: `${TITLE} for ${shortID(rootID)} (${rows.length})`,
        placeholder: "Filter child sessions",
        options,
        onSelect: (item) => {
          if (!item?.value || item.disabled) return
          api.ui.dialog.clear()
          api.route.navigate("session", { sessionID: item.value })
        },
      }),
    )
  } catch (error) {
    showError(api, formatError(error))
  }
}

function registerModernCommand(api) {
  if (!api.keymap?.registerLayer) return false
  api.keymap.registerLayer({
    commands: [
      {
        name: COMMAND,
        title: TITLE,
        desc: "Show child sessions for the current Naru workflow",
        category: "Naru",
        namespace: "palette",
        slashName: "naru-minions",
        run() {
          void showMinions(api)
        },
      },
    ],
    bindings: api.tuiConfig?.keybinds?.gather?.("naru.minions", [COMMAND]) ?? [],
  })
  return true
}

function registerLegacyCommand(api) {
  if (!api.command?.register) return false
  api.command.register(() => [
    {
      title: TITLE,
      value: COMMAND,
      description: "Show child sessions for the current Naru workflow",
      category: "Naru",
      slash: { name: "naru-minions" },
      onSelect() {
        void showMinions(api)
      },
    },
  ])
  return true
}

const plugin = {
  id: "naru-minions-dashboard",
  async tui(api) {
    if (!registerModernCommand(api)) registerLegacyCommand(api)
  },
}

export default plugin
