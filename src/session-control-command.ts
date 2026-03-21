import { showStatusToast } from "./status-command.js"

type ToastVariant = "info" | "success" | "warning" | "error"

type SessionToolPart = {
  id?: unknown
  type?: unknown
  callID?: unknown
  state?: unknown
  output?: unknown
  error?: unknown
}

export type SessionControlSessionToolPart = SessionToolPart
export type SessionControlSessionPart = SessionToolPart

type SessionMessage = {
  info?: {
    id?: unknown
    role?: unknown
  }
  model?: unknown
  parts?: Array<SessionToolPart>
}

export type SessionControlRunningTool = {
  callID?: unknown
  tool?: unknown
  state?: unknown
}

export type SessionControlToolContext = {
  parts?: Array<SessionControlSessionPart>
}

export type SessionControlToolInput = {
  sessionID: string
  runningTools?: Array<SessionControlRunningTool>
  context?: SessionControlToolContext
}

type SessionClient = {
  messages?: (input: { path: { id: string } }) => Promise<{ data?: Array<SessionMessage> } | undefined>
  summarize?: (input: Record<string, unknown>) => Promise<unknown>
  abort?: (input: Record<string, unknown>) => Promise<unknown>
  promptAsync?: (input: Record<string, unknown>) => Promise<unknown>
}

type PartClient = {
  update?: (input: {
    sessionID: string
    messageID: string
    partID: string
    directory?: string
    part: Record<string, unknown>
  }) => Promise<unknown>
}

type Sleep = (ms: number) => Promise<void>

type ToastClient = {
  tui?: {
    showToast?: (options: {
      body: {
        message: string
        variant: ToastVariant
      }
      query?: undefined
    }) => Promise<unknown>
  }
}

export class SessionControlCommandHandledError extends Error {
  constructor() {
    super("session-control-command-handled")
    this.name = "SessionControlCommandHandledError"
  }
}

function warnToastFailure(scope: string, error: unknown) {
  console.warn(`[${scope}] failed to show toast`, error)
}

async function showToast(input: {
  client?: ToastClient
  message: string
  variant: ToastVariant
}) {
  await showStatusToast({
    client: input.client,
    message: input.message,
    variant: input.variant,
    warn: warnToastFailure,
  })
}

async function getSessionMessages(session: SessionClient | undefined, sessionID: string) {
  const messages = await session?.messages?.({
    path: {
      id: sessionID,
    },
  }).catch(() => undefined)
  return Array.isArray(messages?.data) ? messages.data : []
}

function getLatestAssistantModel(messages: Array<SessionMessage>) {
  for (const message of messages) {
    if (message?.info?.role !== "assistant") continue
    if (typeof message.model === "string" && message.model.length > 0) return message.model
  }

  for (const message of messages) {
    if (typeof message.model === "string" && message.model.length > 0) return message.model
  }
  return undefined
}

function normalizeRunningTools(runningTools: unknown) {
  if (!Array.isArray(runningTools)) return []
  return runningTools.filter((item) => {
    if (!item || typeof item !== "object") return false
    const callID = (item as { callID?: unknown }).callID
    return typeof callID === "string" && callID.length > 0
  }).map((item) => {
    const normalized = item as { callID: string; tool?: unknown; state?: unknown }
    return {
      callID: normalized.callID,
      tool: normalized.tool,
      state: normalized.state,
    }
  })
}

function normalizeToolState(state: unknown) {
  if (state === "running" || state === "pending") return "running"
  if (typeof state === "string" && state.length > 0) return "other"
  return "unknown"
}

function getToolStateFromMessage(message: SessionMessage, callID: string) {
  const parts = Array.isArray(message.parts) ? message.parts : []
  for (const part of parts) {
    if (part?.type !== "tool") continue
    if (part?.callID !== callID) continue
    if (part?.state === "running" || part?.state === "pending") return "running"
    return "done"
  }
  return "missing"
}

function findAssistantStateForCallID(input: {
  messages: Array<SessionMessage>
  callID: string
  targetAssistantID?: string
}) {
  const assistants = input.messages.filter((message) => message?.info?.role === "assistant")

  if (input.targetAssistantID) {
    const target = assistants.find((message) => message?.info?.id === input.targetAssistantID)
    if (!target) return "unknown"
    const targetState = getToolStateFromMessage(target, input.callID)
    if (targetState === "running") return "running"
    if (targetState === "done") return "done"
    return "unknown"
  }

  for (const assistant of assistants) {
    const state = getToolStateFromMessage(assistant, input.callID)
    if (state === "running") return "running"
    if (state === "done") return "done"
  }
  return "unknown"
}

function resolveRunningCandidates(input: {
  messages: Array<SessionMessage>
  callIDs: string[]
}) {
  const running: Array<{ callID: string; assistantID?: string }> = []
  for (const callID of input.callIDs) {
    for (const message of input.messages) {
      if (message?.info?.role !== "assistant") continue
      const state = getToolStateFromMessage(message, callID)
      if (state !== "running") continue
      running.push({
        callID,
        assistantID: typeof message.info?.id === "string" && message.info.id.length > 0
          ? message.info.id
          : undefined,
      })
      break
    }
  }
  return running
}

async function waitForUniqueRunningCandidate(input: {
  session?: SessionClient
  sessionID: string
  callIDs: string[]
  sleep?: Sleep
  maxAttempts?: number
  intervalMs?: number
}) {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const maxAttempts = input.maxAttempts ?? 8
  const intervalMs = input.intervalMs ?? 30

  let sawMultiple = false
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const messages = await getSessionMessages(input.session, input.sessionID)
    const candidates = resolveRunningCandidates({
      messages,
      callIDs: input.callIDs,
    })
    if (candidates.length === 1) return {
      type: "unique" as const,
      candidate: candidates[0],
    }
    if (candidates.length > 1) sawMultiple = true
    if (attempt < maxAttempts - 1) await sleep(intervalMs)
  }
  if (sawMultiple) {
    return {
      type: "multiple" as const,
    }
  }
  return {
    type: "none" as const,
  }
}

function findRecentAssistantByCallID(input: {
  messages: Array<SessionMessage>
  callID: string
}) {
  for (const message of input.messages) {
    if (message?.info?.role !== "assistant") continue
    if (getToolStateFromMessage(message, input.callID) === "missing") continue
    const id = message.info?.id
    if (typeof id === "string" && id.length > 0) return id
    return undefined
  }
  return undefined
}

async function waitForToolToStop(input: {
  session?: SessionClient
  sessionID: string
  callID: string
  targetAssistantID?: string
  sleep?: Sleep
  maxAttempts?: number
  intervalMs?: number
}) {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const maxAttempts = input.maxAttempts ?? 30
  const intervalMs = input.intervalMs ?? 30
  let resolvedTargetAssistantID = input.targetAssistantID

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const messages = await getSessionMessages(input.session, input.sessionID)

    const assistants = messages.filter((message) => message?.info?.role === "assistant")
    if (!resolvedTargetAssistantID) {
      resolvedTargetAssistantID = findRecentAssistantByCallID({
        messages,
        callID: input.callID,
      })
    }

    const targets = resolvedTargetAssistantID
      ? assistants.filter((message) => message?.info?.id === resolvedTargetAssistantID)
      : assistants
    for (const message of targets) {
      const parts = Array.isArray(message.parts) ? message.parts : []
      for (const part of parts) {
        if (part?.type !== "tool") continue
        if (part?.callID !== input.callID) continue
        if (part?.state === "completed" || part?.state === "error") {
          return {
            type: "settled" as const,
            messageID: typeof message.info?.id === "string" ? message.info.id : undefined,
            part,
          }
        }
      }
    }

    const state = findAssistantStateForCallID({
      messages,
      callID: input.callID,
      targetAssistantID: resolvedTargetAssistantID,
    })
    if (state === "done") {
      return {
        type: "done-without-part" as const,
      }
    }
    if (attempt < maxAttempts - 1) await sleep(intervalMs)
  }

  return {
    type: "timeout" as const,
  }
}

function appendInterruptedNote(base: string) {
  const note = "用户主动中止，结果可能不完整。Interrupted by user; result may be incomplete."
  return `${base}${base.length > 0 ? "\n\n" : ""}${note}`
}

async function patchStoppedToolTranscript(input: {
  client?: unknown
  sessionID: string
  messageID?: string
  part: SessionToolPart
}) {
  const partID = typeof input.part.id === "string" ? input.part.id : undefined
  const partState = input.part.state

  let patch: Record<string, unknown>
  if (partState === "completed") {
    const output = typeof input.part.output === "string" ? input.part.output : ""
    patch = {
      output: appendInterruptedNote(output),
    }
  } else if (partState === "error") {
    const error = typeof input.part.error === "string" ? input.part.error : ""
    patch = {
      error: appendInterruptedNote(error),
    }
  } else {
    throw new Error("tool part is not in completed/error state")
  }

  const partClient = (input.client as { part?: PartClient } | undefined)?.part
  if (!partClient?.update || !input.messageID || !partID) {
    throw new Error("client.part.update unavailable")
  }

  await partClient.update({
    sessionID: input.sessionID,
    messageID: input.messageID,
    partID,
    part: patch,
  })
}

export async function handleCompactCommand(input: {
  client?: unknown
  sessionID: string
  model?: string
}): Promise<never> {
  const session = (input.client as { session?: SessionClient } | undefined)?.session
  const summarize = session?.summarize
  if (!summarize) {
    await showToast({
      client: input.client as ToastClient | undefined,
      message: "Session summarize is unavailable for compact.",
      variant: "warning",
    })
    throw new SessionControlCommandHandledError()
  }

  const model = input.model ?? getLatestAssistantModel(await getSessionMessages(session, input.sessionID))
  await summarize(model ? {
    auto: true,
    model,
  } : {
    auto: true,
  })

  throw new SessionControlCommandHandledError()
}

export async function handleStopToolCommand(input: {
  client?: unknown
  sessionID: string
  runningTools?: unknown
  syntheticAgentInitiatorEnabled?: boolean
}): Promise<never> {
  if (input.syntheticAgentInitiatorEnabled !== true) {
    await showToast({
      client: input.client as ToastClient | undefined,
      message: "Enable 'Send synthetic messages as agent' first; otherwise this recovery adds one extra billed synthetic turn.",
      variant: "warning",
    })
    throw new SessionControlCommandHandledError()
  }

  const runningTools = normalizeRunningTools(input.runningTools)
  if (runningTools.length === 0) {
    await showToast({
      client: input.client as ToastClient | undefined,
      message: "No running tool found.",
      variant: "warning",
    })
    throw new SessionControlCommandHandledError()
  }

  const runningPendingTools = runningTools.filter((item) => normalizeToolState(item.state) === "running")
  const hasExplicitToolState = runningTools.some((item) => normalizeToolState(item.state) !== "unknown")

  if (hasExplicitToolState && runningPendingTools.length === 0) {
    await showToast({
      client: input.client as ToastClient | undefined,
      message: "No running/pending tool found.",
      variant: "warning",
    })
    throw new SessionControlCommandHandledError()
  }

  if (hasExplicitToolState && runningPendingTools.length > 1) {
    await showToast({
      client: input.client as ToastClient | undefined,
      message: "Found multiple running/pending tools; abort a single tool only.",
      variant: "warning",
    })
    throw new SessionControlCommandHandledError()
  }

  if (!hasExplicitToolState && runningTools.length > 1) {
    await showToast({
      client: input.client as ToastClient | undefined,
      message: "Found multiple running tools; abort a single tool only.",
      variant: "warning",
    })
    throw new SessionControlCommandHandledError()
  }

  const session = (input.client as { session?: SessionClient } | undefined)?.session

  const sessionCandidate = hasExplicitToolState && runningPendingTools.length === 1
    ? {
        type: "unique" as const,
        candidate: {
          callID: runningPendingTools[0]!.callID,
          assistantID: undefined,
        },
      }
    : await waitForUniqueRunningCandidate({
        session,
        sessionID: input.sessionID,
        callIDs: [...new Set(runningTools.map((item) => item.callID))],
      })

  if (!session?.abort) {
    await showToast({
      client: input.client as ToastClient | undefined,
      message: "Stop-tool abort unavailable: session.abort capability is missing.",
      variant: "error",
    })
    throw new SessionControlCommandHandledError()
  }

  if (sessionCandidate.type === "none") {
    await showToast({
      client: input.client as ToastClient | undefined,
      message: "No running/pending tool found.",
      variant: "warning",
    })
    throw new SessionControlCommandHandledError()
  }

  if (sessionCandidate.type === "multiple") {
    await showToast({
      client: input.client as ToastClient | undefined,
      message: "Found multiple running/pending tools; abort a single tool only.",
      variant: "warning",
    })
    throw new SessionControlCommandHandledError()
  }

  const callID = sessionCandidate.candidate.callID
  const targetAssistantID = sessionCandidate.candidate.assistantID

  try {
    await session.abort({
      path: {
        id: input.sessionID,
      },
      callID,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await showToast({
      client: input.client as ToastClient | undefined,
      message: `Stop-tool abort failed: ${message}`,
      variant: "error",
    })
    throw new SessionControlCommandHandledError()
  }

  const settled = await waitForToolToStop({
    session,
    sessionID: input.sessionID,
    callID,
    targetAssistantID,
  })

  if (settled.type === "timeout") {
    await showToast({
      client: input.client as ToastClient | undefined,
      message: "Stop-tool failed: tool part state remained unstable and hit timeout.",
      variant: "error",
    })
    throw new SessionControlCommandHandledError()
  }

  if (settled.type !== "settled") {
    await showToast({
      client: input.client as ToastClient | undefined,
      message: "Stop-tool failed: tool part was not available for transcript patch.",
      variant: "error",
    })
    throw new SessionControlCommandHandledError()
  }

  try {
    await patchStoppedToolTranscript({
      client: input.client,
      sessionID: input.sessionID,
      messageID: settled.messageID,
      part: settled.part,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await showToast({
      client: input.client as ToastClient | undefined,
      message: `Stop-tool transcript patch failed: ${message}`,
      variant: "error",
    })
    throw new SessionControlCommandHandledError()
  }

  try {
    if (!session?.promptAsync) {
      throw new Error("promptAsync unavailable")
    }
    await session.promptAsync({
      sessionID: input.sessionID,
      synthetic: true,
      parts: [{
        type: "text",
        text: "The previous tool call was interrupted at the user's request. Treat its result as partial evidence. Do not resume that same tool call automatically unless the user explicitly asks for it.",
      }],
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await showToast({
      client: input.client as ToastClient | undefined,
      message: `Stop-tool recovery failed: ${message}`,
      variant: "error",
    })
  }

  throw new SessionControlCommandHandledError()
}
