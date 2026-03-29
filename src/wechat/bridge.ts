import type {
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
} from "@opencode-ai/sdk/v2"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { appendFile, mkdir } from "node:fs/promises"
import { connect } from "./broker-client.js"
import { connectOrSpawnBroker } from "./broker-launcher.js"
import { WECHAT_FILE_MODE, wechatBridgeDiagnosticsPath } from "./state-paths.js"
import {
  buildSessionDigest,
  groupPermissionsBySession,
  groupQuestionsBySession,
  pickRecentSessions,
  type SessionDigest,
} from "./session-digest.js"

type SessionMessages = Array<{ info: Message; parts: Part[] }>

type SessionLite = Pick<Session, "id" | "title" | "directory" | "time">

type SdkFieldsResult<T> = {
  data: T | undefined
  error?: unknown
  request?: unknown
  response?: unknown
}

type SdkReadResult<T> = T | SdkFieldsResult<T>

type WechatBridgeClient = {
  session: {
    list: () => Promise<SdkReadResult<SessionLite[]>>
    status: () => Promise<SdkReadResult<Record<string, SessionStatus | undefined>>>
    todo: (parameters: { sessionID: string } | string) => Promise<SdkReadResult<Todo[]>>
    messages: (parameters: { sessionID: string; limit?: number } | string) => Promise<SdkReadResult<SessionMessages>>
  }
  question: {
    list: () => Promise<SdkReadResult<QuestionRequest[]>>
  }
  permission: {
    list: () => Promise<SdkReadResult<PermissionRequest[]>>
  }
}

export type InstanceUnavailableKind = "sessionStatus" | "questionList" | "permissionList"

export type WechatInstanceStatusSnapshot = {
  instanceID: string
  instanceName: string
  pid: number
  projectName?: string
  directory: string
  collectedAt: number
  sessions: SessionDigest[]
  unavailable?: InstanceUnavailableKind[]
}

export type WechatBridgeInput = {
  instanceID: string
  instanceName: string
  pid: number
  projectName?: string
  directory: string
  client: WechatBridgeClient
  liveReadTimeoutMs?: number
  getActiveSessionID?: () => string | undefined
  onDiagnosticEvent?: (event: WechatBridgeDiagnosticEvent) => Promise<void> | void
}

export type WechatBridge = {
  collectStatusSnapshot: () => Promise<WechatInstanceStatusSnapshot>
}

export type WechatBridgeLifecycleInput = {
  client: WechatBridgeClient
  project?: {
    id?: string
    name?: string
  }
  directory?: string
  serverUrl?: URL
  statusCollectionEnabled?: boolean
  heartbeatIntervalMs?: number
  getActiveSessionID?: () => string | undefined
}

export type WechatBridgeLifecycle = {
  close: () => Promise<void>
}

const DEFAULT_LIVE_READ_TIMEOUT_MS = 2_000
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000
const PROCESS_INSTANCE_ID = toSafeInstanceID(`wechat-${process.pid}-${randomUUID().slice(0, 8)}`)

type WechatBridgeLifecycleDeps = {
  connectOrSpawnBrokerImpl?: typeof connectOrSpawnBroker
  connectImpl?: typeof connect
  setIntervalImpl?: typeof setInterval
  clearIntervalImpl?: typeof clearInterval
}

function toSafeInstanceID(input: string): string {
  const normalized = input.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
  if (normalized.length === 0) {
    return `wechat-${process.pid}`
  }
  return normalized.slice(0, 64)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function toProjectName(project: WechatBridgeLifecycleInput["project"]): string | undefined {
  if (typeof project?.name === "string" && project.name.trim().length > 0) {
    return project.name.trim()
  }
  if (typeof project?.id === "string" && project.id.trim().length > 0) {
    return project.id.trim()
  }
  return undefined
}

function toDirectory(inputDirectory: string | undefined): string {
  if (typeof inputDirectory === "string" && inputDirectory.trim().length > 0) {
    return inputDirectory
  }
  return process.cwd()
}

function toInstanceName(projectName: string | undefined, directory: string): string {
  if (projectName) {
    return projectName
  }
  const parts = directory.split(/[\\/]+/).filter((part) => part.length > 0)
  return parts.at(-1) ?? `wechat-${process.pid}`
}

function toInstanceID(projectName: string | undefined, directory: string): string {
  const seed = projectName ?? directory
  return toSafeInstanceID(seed)
}

function withTimeout<T>(task: () => Promise<T>, timeoutMs: number, name: string): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      reject(new Error(`${name} timed out in ${timeoutMs}ms`))
    }, timeoutMs)

    void Promise.resolve()
      .then(task)
      .then((value) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        resolve(value)
      })
      .catch((error) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        reject(error)
      })
  })
}

type WechatBridgeDiagnosticEvent =
  | {
      type: "collectStatusStage"
      instanceID: string
      stage: string
      status: "fulfilled" | "rejected"
      durationMs: number
      timeout?: boolean
      error?: string
    }
  | {
      type: "collectStatusCompleted"
      instanceID: string
      durationMs: number
      sessionCount: number
      unavailable?: InstanceUnavailableKind[]
    }

function isErrorWithMessage(value: unknown): value is { message: string } {
  return typeof value === "object" && value !== null && "message" in value && typeof (value as { message: unknown }).message === "string"
}

function createWechatBridgeDiagnosticsWriter(filePath: string = wechatBridgeDiagnosticsPath()) {
  let warned = false

  return async (event: WechatBridgeDiagnosticEvent) => {
    try {
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
      const line = `${JSON.stringify({ timestamp: Date.now(), ...event })}\n`
      await appendFile(filePath, line, { encoding: "utf8", mode: WECHAT_FILE_MODE })
    } catch (error) {
      if (!warned) {
        warned = true
        console.warn("[wechat-bridge] failed to write diagnostics", error)
      }
    }
  }
}

function isTimeoutError(error: unknown): boolean {
  return isErrorWithMessage(error) && /timed out/i.test(error.message)
}

function toDiagnosticErrorMessage(error: unknown): string {
  if (isErrorWithMessage(error)) {
    return error.message
  }
  return String(error)
}

function wrapDiagnosticStage<T>(
  input: {
    instanceID: string
    stage: string
    onDiagnosticEvent?: (event: WechatBridgeDiagnosticEvent) => Promise<void> | void
  },
  task: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now()
  return Promise.resolve()
    .then(task)
    .then((value) => {
      void Promise.resolve(input.onDiagnosticEvent?.({
        type: "collectStatusStage",
        instanceID: input.instanceID,
        stage: input.stage,
        status: "fulfilled",
        durationMs: Date.now() - startedAt,
      })).catch(() => {})
      return value
    })
    .catch((error) => {
      void Promise.resolve(input.onDiagnosticEvent?.({
        type: "collectStatusStage",
        instanceID: input.instanceID,
        stage: input.stage,
        status: "rejected",
        durationMs: Date.now() - startedAt,
        timeout: isTimeoutError(error),
        error: toDiagnosticErrorMessage(error),
      })).catch(() => {})
      throw error
    })
}

function isSdkFieldsResult<T>(value: SdkReadResult<T>): value is SdkFieldsResult<T> {
  return typeof value === "object"
    && value !== null
    && ("data" in value || "error" in value)
}

function unwrapSdkReadResult<T>(value: SdkReadResult<T>, name: string): T {
  if (!isSdkFieldsResult(value)) {
    return value
  }

  if (value.error != null) {
    throw value.error instanceof Error ? value.error : new Error(`${name} failed`)
  }

  if (value.data === undefined) {
    throw new Error(`${name} returned no data`)
  }

  return value.data
}

export function createWechatBridge(input: WechatBridgeInput): WechatBridge {
  const collectStatusSnapshot = async (): Promise<WechatInstanceStatusSnapshot> => {
    const startedAt = Date.now()
    const liveReadTimeoutMs =
      typeof input.liveReadTimeoutMs === "number" && Number.isFinite(input.liveReadTimeoutMs)
      ? Math.max(1, Math.floor(input.liveReadTimeoutMs))
      : DEFAULT_LIVE_READ_TIMEOUT_MS
    const unavailable = new Set<InstanceUnavailableKind>()
    const onDiagnosticEvent = input.onDiagnosticEvent
    const activeSessionID = input.getActiveSessionID?.()

    if (input.getActiveSessionID && !isNonEmptyString(activeSessionID)) {
      const snapshot = {
        instanceID: input.instanceID,
        instanceName: input.instanceName,
        pid: input.pid,
        projectName: input.projectName,
        directory: input.directory,
        collectedAt: Date.now(),
        sessions: [] as SessionDigest[],
        unavailable: undefined,
      }

      void Promise.resolve(onDiagnosticEvent?.({
        type: "collectStatusCompleted",
        instanceID: input.instanceID,
        durationMs: Date.now() - startedAt,
        sessionCount: 0,
        unavailable: snapshot.unavailable,
      })).catch(() => {})

      return snapshot
    }

    const [sessionListResult, statusResult, questionResult, permissionResult] = await Promise.allSettled([
      wrapDiagnosticStage({ instanceID: input.instanceID, stage: "session.list", onDiagnosticEvent }, () =>
        withTimeout(async () => unwrapSdkReadResult(await input.client.session.list(), "session.list"), liveReadTimeoutMs, "session.list"),
      ),
      wrapDiagnosticStage({ instanceID: input.instanceID, stage: "session.status", onDiagnosticEvent }, () =>
        withTimeout(async () => unwrapSdkReadResult(await input.client.session.status(), "session.status"), liveReadTimeoutMs, "session.status"),
      ),
      wrapDiagnosticStage({ instanceID: input.instanceID, stage: "question.list", onDiagnosticEvent }, () =>
        withTimeout(async () => unwrapSdkReadResult(await input.client.question.list(), "question.list"), liveReadTimeoutMs, "question.list"),
      ),
      wrapDiagnosticStage({ instanceID: input.instanceID, stage: "permission.list", onDiagnosticEvent }, () =>
        withTimeout(async () => unwrapSdkReadResult(await input.client.permission.list(), "permission.list"), liveReadTimeoutMs, "permission.list"),
      ),
    ])

    const sessions = sessionListResult.status === "fulfilled" ? sessionListResult.value : []
    const recentSessions = isNonEmptyString(activeSessionID)
      ? sessions.filter((session) => session.id === activeSessionID).slice(0, 1)
      : pickRecentSessions(sessions, 3)
    if (sessionListResult.status === "rejected") {
      unavailable.add("sessionStatus")
    }

    const statusBySession =
      statusResult.status === "fulfilled"
        ? statusResult.value
        : (unavailable.add("sessionStatus"), ({} as Record<string, SessionStatus | undefined>))

    const questionsBySession =
      questionResult.status === "fulfilled"
        ? groupQuestionsBySession(questionResult.value)
        : (unavailable.add("questionList"), groupQuestionsBySession([]))

    const permissionsBySession =
      permissionResult.status === "fulfilled"
        ? groupPermissionsBySession(permissionResult.value)
        : (unavailable.add("permissionList"), groupPermissionsBySession([]))

    const sessionDigests = await Promise.all(
      recentSessions.map(async (session) => {
        const [todoResult, messagesResult] = await Promise.allSettled([
          wrapDiagnosticStage({ instanceID: input.instanceID, stage: `session.todo:${session.id}`, onDiagnosticEvent }, () =>
            withTimeout(
              async () => unwrapSdkReadResult(
                await input.client.session.todo({ sessionID: session.id }),
                `session.todo:${session.id}`,
              ),
              liveReadTimeoutMs,
              `session.todo:${session.id}`,
            ),
          ),
          wrapDiagnosticStage({ instanceID: input.instanceID, stage: `session.messages:${session.id}`, onDiagnosticEvent }, () =>
            withTimeout(
              async () => unwrapSdkReadResult(
                await input.client.session.messages({ sessionID: session.id, limit: 1 }),
                `session.messages:${session.id}`,
              ),
              liveReadTimeoutMs,
              `session.messages:${session.id}`,
            ),
          ),
        ])

        const sessionUnavailable: Array<"messages" | "todo"> = []
        const todos = todoResult.status === "fulfilled" ? todoResult.value : (sessionUnavailable.push("todo"), [])
        const messages =
          messagesResult.status === "fulfilled"
            ? messagesResult.value
            : (sessionUnavailable.push("messages"), [])

        return buildSessionDigest({
          session,
          statusBySession,
          questionsBySession,
          permissionsBySession,
          todos,
          messages,
          unavailable: sessionUnavailable,
        })
      }),
    )

    const snapshot = {
      instanceID: input.instanceID,
      instanceName: input.instanceName,
      pid: input.pid,
      projectName: input.projectName,
      directory: input.directory,
      collectedAt: Date.now(),
      sessions: sessionDigests,
      unavailable: unavailable.size > 0 ? [...unavailable] : undefined,
    }

    void Promise.resolve(onDiagnosticEvent?.({
      type: "collectStatusCompleted",
      instanceID: input.instanceID,
      durationMs: Date.now() - startedAt,
      sessionCount: snapshot.sessions.length,
      unavailable: snapshot.unavailable,
    })).catch(() => {})

    return snapshot
  }

  return {
    collectStatusSnapshot,
  }
}

export async function createWechatBridgeLifecycle(
  input: WechatBridgeLifecycleInput,
  deps: WechatBridgeLifecycleDeps = {},
): Promise<WechatBridgeLifecycle> {
  if (input.statusCollectionEnabled !== true) {
    return {
      close: async () => {},
    }
  }

  const connectOrSpawnBrokerImpl = deps.connectOrSpawnBrokerImpl ?? connectOrSpawnBroker
  const connectImpl = deps.connectImpl ?? connect
  const setIntervalImpl = deps.setIntervalImpl ?? setInterval
  const clearIntervalImpl = deps.clearIntervalImpl ?? clearInterval

  const directory = toDirectory(input.directory)
  const projectName = toProjectName(input.project)
  const instanceID = PROCESS_INSTANCE_ID
  const bridge = createWechatBridge({
    instanceID,
    instanceName: toInstanceName(projectName, directory),
    pid: process.pid,
    projectName,
    directory,
    client: input.client,
    getActiveSessionID: input.getActiveSessionID,
    onDiagnosticEvent: createWechatBridgeDiagnosticsWriter(),
  })

  const broker = await connectOrSpawnBrokerImpl()
  const brokerClient = await connectImpl(broker.endpoint, { bridge })

  try {
    await brokerClient.registerInstance({
      instanceID,
      pid: process.pid,
    })
  } catch (error) {
    await brokerClient.close().catch(() => {})
    throw error
  }

  const heartbeatIntervalMs =
    typeof input.heartbeatIntervalMs === "number" && Number.isFinite(input.heartbeatIntervalMs)
      ? Math.max(1_000, Math.floor(input.heartbeatIntervalMs))
      : DEFAULT_HEARTBEAT_INTERVAL_MS
  const timer = setIntervalImpl(() => {
    void brokerClient.heartbeat().catch(() => {})
  }, heartbeatIntervalMs)

  let closed = false

  return {
    close: async () => {
      if (closed) {
        return
      }
      closed = true
      clearIntervalImpl(timer)
      await brokerClient.close().catch(() => {})
    },
  }
}
