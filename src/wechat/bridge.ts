import type {
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
} from "@opencode-ai/sdk/v2"
import { connect } from "./broker-client.js"
import { connectOrSpawnBroker } from "./broker-launcher.js"
import {
  buildSessionDigest,
  groupPermissionsBySession,
  groupQuestionsBySession,
  pickRecentSessions,
  type SessionDigest,
} from "./session-digest.js"

type SessionMessages = Array<{ info: Message; parts: Part[] }>

type SessionLite = Pick<Session, "id" | "title" | "directory" | "time">

type WechatBridgeClient = {
  session: {
    list: () => Promise<SessionLite[]>
    status: () => Promise<Record<string, SessionStatus | undefined>>
    todo: (sessionID: string) => Promise<Todo[]>
    messages: (sessionID: string) => Promise<SessionMessages>
  }
  question: {
    list: () => Promise<QuestionRequest[]>
  }
  permission: {
    list: () => Promise<PermissionRequest[]>
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
}

export type WechatBridgeLifecycle = {
  close: () => Promise<void>
}

const DEFAULT_LIVE_READ_TIMEOUT_MS = 2_000
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000

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

export function createWechatBridge(input: WechatBridgeInput): WechatBridge {
  const collectStatusSnapshot = async (): Promise<WechatInstanceStatusSnapshot> => {
    const liveReadTimeoutMs =
      typeof input.liveReadTimeoutMs === "number" && Number.isFinite(input.liveReadTimeoutMs)
      ? Math.max(1, Math.floor(input.liveReadTimeoutMs))
      : DEFAULT_LIVE_READ_TIMEOUT_MS
    const unavailable = new Set<InstanceUnavailableKind>()

    const [sessionListResult, statusResult, questionResult, permissionResult] = await Promise.allSettled([
      withTimeout(() => input.client.session.list(), liveReadTimeoutMs, "session.list"),
      withTimeout(() => input.client.session.status(), liveReadTimeoutMs, "session.status"),
      withTimeout(() => input.client.question.list(), liveReadTimeoutMs, "question.list"),
      withTimeout(() => input.client.permission.list(), liveReadTimeoutMs, "permission.list"),
    ])

    const sessions = sessionListResult.status === "fulfilled" ? sessionListResult.value : []
    const recentSessions = pickRecentSessions(sessions, 3)
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
          withTimeout(() => input.client.session.todo(session.id), liveReadTimeoutMs, `session.todo:${session.id}`),
          withTimeout(
            () => input.client.session.messages(session.id),
            liveReadTimeoutMs,
            `session.messages:${session.id}`,
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

    return {
      instanceID: input.instanceID,
      instanceName: input.instanceName,
      pid: input.pid,
      projectName: input.projectName,
      directory: input.directory,
      collectedAt: Date.now(),
      sessions: sessionDigests,
      unavailable: unavailable.size > 0 ? [...unavailable] : undefined,
    }
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
  const instanceID = toInstanceID(projectName, directory)
  const bridge = createWechatBridge({
    instanceID,
    instanceName: toInstanceName(projectName, directory),
    pid: process.pid,
    projectName,
    directory,
    client: input.client,
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
