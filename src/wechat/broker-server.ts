import net from "node:net"
import path from "node:path"
import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises"
import { registerConnection, revokeSessionToken, validateSessionToken } from "./ipc-auth.js"
import {
  createErrorEnvelope,
  parseEnvelopeLine,
  serializeEnvelope,
  type BrokerEnvelope,
  type BrokerMessageType,
} from "./protocol.js"
import { WECHAT_DIR_MODE, WECHAT_FILE_MODE, instanceStatePath, instancesDir } from "./state-paths.js"

const FUTURE_MESSAGE_TYPES = new Set<BrokerMessageType>([
  "collectStatus",
  "replyQuestion",
  "rejectQuestion",
  "replyPermission",
  "showFallbackToast",
])

export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000
const DEFAULT_HEARTBEAT_SCAN_INTERVAL_MS = 1_000

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function getRequestId(envelope: BrokerEnvelope): string {
  return envelope.id
}

function writeEnvelope(socket: net.Socket, envelope: BrokerEnvelope) {
  socket.write(serializeEnvelope(envelope))
}

function writeError(
  socket: net.Socket,
  code: "unauthorized" | "invalidMessage" | "notImplemented" | "brokerUnavailable",
  message: string,
  requestId: string,
) {
  writeEnvelope(socket, createErrorEnvelope(code, message, requestId))
}

function requireAuthorized(envelope: BrokerEnvelope): boolean {
  const instanceID = envelope.instanceID
  const sessionToken = envelope.sessionToken
  if (!isNonEmptyString(instanceID) || !isNonEmptyString(sessionToken)) {
    return false
  }
  return validateSessionToken(instanceID, sessionToken)
}

type RegistrationRecord = {
  socket: net.Socket
  sessionToken: string
  registeredAt: number
  brokerPid: number
}

type InstanceSnapshotStatus = "connected" | "stale"

type InstanceSnapshot = {
  instanceID: string
  pid: number
  displayName: string
  projectDir: string
  connectedAt: number
  lastHeartbeatAt: number
  status: InstanceSnapshotStatus
  staleSince?: number
}

const registrationByInstanceID = new Map<string, RegistrationRecord>()
const instanceIDsBySocket = new Map<net.Socket, Set<string>>()
const snapshotByInstanceID = new Map<string, InstanceSnapshot>()
const snapshotPersistQueueByInstanceID = new Map<string, Promise<void>>()

function toPositiveNumber(rawValue: string | undefined, fallback: number): number {
  if (!isNonEmptyString(rawValue)) {
    return fallback
  }

  const parsed = Number(rawValue)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }

  return parsed
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return {}
  }
  return value as Record<string, unknown>
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isSafeInstanceID(instanceID: string): boolean {
  if (!isNonEmptyString(instanceID)) {
    return false
  }
  if (instanceID.includes("/") || instanceID.includes("\\")) {
    return false
  }
  if (instanceID.includes("..")) {
    return false
  }
  return true
}

function makeConnectedSnapshot(instanceID: string, payload: unknown, now: number): InstanceSnapshot {
  const record = asObject(payload)
  return {
    instanceID,
    pid: isFiniteNumber(record.pid) ? record.pid : process.pid,
    displayName: isNonEmptyString(record.displayName) ? record.displayName : "",
    projectDir: isNonEmptyString(record.projectDir) ? record.projectDir : "",
    connectedAt: now,
    lastHeartbeatAt: now,
    status: "connected",
  }
}

function serializeSnapshot(snapshot: InstanceSnapshot) {
  if (snapshot.status === "stale") {
    return {
      instanceID: snapshot.instanceID,
      pid: snapshot.pid,
      displayName: snapshot.displayName,
      projectDir: snapshot.projectDir,
      connectedAt: snapshot.connectedAt,
      lastHeartbeatAt: snapshot.lastHeartbeatAt,
      status: snapshot.status,
      staleSince: snapshot.staleSince,
    }
  }

  return {
    instanceID: snapshot.instanceID,
    pid: snapshot.pid,
    displayName: snapshot.displayName,
    projectDir: snapshot.projectDir,
    connectedAt: snapshot.connectedAt,
    lastHeartbeatAt: snapshot.lastHeartbeatAt,
    status: snapshot.status,
  }
}

async function persistInstanceSnapshot(snapshot: InstanceSnapshot) {
  await mkdir(instancesDir(), { recursive: true, mode: WECHAT_DIR_MODE })
  await writeFile(instanceStatePath(snapshot.instanceID), JSON.stringify(serializeSnapshot(snapshot), null, 2), {
    mode: WECHAT_FILE_MODE,
  })
}

function queuePersistSnapshot(snapshot: InstanceSnapshot): Promise<void> {
  const currentChain = snapshotPersistQueueByInstanceID.get(snapshot.instanceID) ?? Promise.resolve()
  const nextWrite = currentChain.then(() => persistInstanceSnapshot(snapshot))
  const queueTail = nextWrite.catch(() => {})
  snapshotPersistQueueByInstanceID.set(snapshot.instanceID, queueTail)
  return nextWrite
}

async function upsertConnectedSnapshot(instanceID: string, payload: unknown, now: number): Promise<InstanceSnapshot> {
  const next = makeConnectedSnapshot(instanceID, payload, now)
  snapshotByInstanceID.set(instanceID, next)
  await queuePersistSnapshot(next)
  return next
}

async function recoverSnapshotFromHeartbeat(instanceID: string, now: number): Promise<void> {
  const current = snapshotByInstanceID.get(instanceID)
  if (!current) {
    const fallback: InstanceSnapshot = {
      instanceID,
      pid: process.pid,
      displayName: "",
      projectDir: "",
      connectedAt: now,
      lastHeartbeatAt: now,
      status: "connected",
    }
    snapshotByInstanceID.set(instanceID, fallback)
    await queuePersistSnapshot(fallback)
    return
  }

  const next: InstanceSnapshot = {
    instanceID: current.instanceID,
    pid: current.pid,
    displayName: current.displayName,
    projectDir: current.projectDir,
    connectedAt: current.connectedAt,
    lastHeartbeatAt: now,
    status: "connected",
  }
  snapshotByInstanceID.set(instanceID, next)
  await queuePersistSnapshot(next)
}

async function markStaleSnapshots(now: number, heartbeatTimeoutMs: number): Promise<void> {
  for (const [instanceID, snapshot] of snapshotByInstanceID.entries()) {
    if (snapshot.status !== "connected") {
      continue
    }

    if (now - snapshot.lastHeartbeatAt < heartbeatTimeoutMs) {
      continue
    }

    const staleSnapshot: InstanceSnapshot = {
      instanceID: snapshot.instanceID,
      pid: snapshot.pid,
      displayName: snapshot.displayName,
      projectDir: snapshot.projectDir,
      connectedAt: snapshot.connectedAt,
      lastHeartbeatAt: snapshot.lastHeartbeatAt,
      status: "stale",
      staleSince: now,
    }
    snapshotByInstanceID.set(instanceID, staleSnapshot)
    await queuePersistSnapshot(staleSnapshot)
  }
}

function bindSocketInstance(socket: net.Socket, instanceID: string) {
  const set = instanceIDsBySocket.get(socket) ?? new Set<string>()
  set.add(instanceID)
  instanceIDsBySocket.set(socket, set)
}

function unbindSocketInstance(socket: net.Socket, instanceID: string) {
  const set = instanceIDsBySocket.get(socket)
  if (!set) {
    return
  }
  set.delete(instanceID)
  if (set.size === 0) {
    instanceIDsBySocket.delete(socket)
  }
}

function cleanupSocketRegistrations(socket: net.Socket) {
  const set = instanceIDsBySocket.get(socket)
  if (!set) {
    return
  }

  for (const instanceID of set) {
    const current = registrationByInstanceID.get(instanceID)
    if (current?.socket === socket) {
      registrationByInstanceID.delete(instanceID)
      revokeSessionToken(instanceID)
    }
  }
  instanceIDsBySocket.delete(socket)
}

async function handleMessage(envelope: BrokerEnvelope, socket: net.Socket): Promise<void> {
  const requestId = getRequestId(envelope)

  if (envelope.type === "ping") {
    writeEnvelope(socket, {
      id: `pong-${requestId}`,
      type: "pong",
      payload: { message: "pong" },
    })
    return
  }

  if (envelope.type === "registerInstance") {
    if (!isSafeInstanceID(envelope.instanceID ?? "")) {
      writeError(socket, "invalidMessage", "instanceID is required", requestId)
      return
    }

    const instanceID = envelope.instanceID as string
    const existing = registrationByInstanceID.get(instanceID)

    if (existing && existing.socket === socket) {
      try {
        await upsertConnectedSnapshot(instanceID, envelope.payload, Date.now())
      } catch {
        writeError(socket, "brokerUnavailable", "failed to persist instance snapshot", requestId)
        return
      }

      writeEnvelope(socket, {
        id: `registerAck-${requestId}`,
        type: "registerAck",
        instanceID,
        payload: {
          sessionToken: existing.sessionToken,
          registeredAt: existing.registeredAt,
          brokerPid: existing.brokerPid,
        },
      })
      return
    }

    const registeredAt = Date.now()
    try {
      await upsertConnectedSnapshot(instanceID, envelope.payload, registeredAt)
    } catch {
      writeError(socket, "brokerUnavailable", "failed to persist instance snapshot", requestId)
      return
    }

    const sessionToken = registerConnection(instanceID, { socket })
    const nextRecord: RegistrationRecord = {
      socket,
      sessionToken,
      registeredAt,
      brokerPid: process.pid,
    }
    registrationByInstanceID.set(instanceID, nextRecord)
    bindSocketInstance(socket, instanceID)

    if (existing && existing.socket !== socket) {
      unbindSocketInstance(existing.socket, instanceID)
    }

    writeEnvelope(socket, {
      id: `registerAck-${requestId}`,
      type: "registerAck",
      instanceID,
      payload: {
        sessionToken,
        registeredAt: nextRecord.registeredAt,
        brokerPid: nextRecord.brokerPid,
      },
    })
    return
  }

  if (envelope.type === "heartbeat") {
    if (!requireAuthorized(envelope)) {
      writeError(socket, "unauthorized", "session token is invalid", requestId)
      return
    }

    try {
      await recoverSnapshotFromHeartbeat(envelope.instanceID!, Date.now())
    } catch {
      writeError(socket, "brokerUnavailable", "failed to persist instance snapshot", requestId)
      return
    }

    writeEnvelope(socket, {
      id: `pong-${requestId}`,
      type: "pong",
      payload: { message: "pong" },
    })
    return
  }

  if (FUTURE_MESSAGE_TYPES.has(envelope.type)) {
    if (!requireAuthorized(envelope)) {
      writeError(socket, "unauthorized", "session token is invalid", requestId)
      return
    }

    writeError(socket, "notImplemented", "future message is not implemented", requestId)
    return
  }

  writeError(socket, "notImplemented", `${envelope.type} is not implemented`, requestId)
}

async function tightenEndpointPermission(endpoint: string) {
  if (process.platform === "win32") {
    return
  }

  await chmod(endpoint, WECHAT_FILE_MODE)
  const info = await stat(endpoint)
  if ((info.mode & 0o777) !== WECHAT_FILE_MODE) {
    throw new Error("failed to enforce broker endpoint permission")
  }
}

async function ensureCurrentUserCanAccess(endpoint: string) {
  await new Promise<void>((resolve, reject) => {
    const probe = net.createConnection(endpoint)
    probe.once("connect", () => {
      probe.end()
      resolve()
    })
    probe.once("error", reject)
  })
}

async function prepareEndpoint(endpoint: string) {
  if (process.platform === "win32") {
    return
  }

  await mkdir(path.dirname(endpoint), { recursive: true, mode: WECHAT_DIR_MODE })
  await rm(endpoint, { force: true })
}

export type BrokerServerHandle = {
  endpoint: string
  startedAt: number
  close: () => Promise<void>
}

export async function startBrokerServer(endpoint: string): Promise<BrokerServerHandle> {
  await prepareEndpoint(endpoint)

  const heartbeatTimeoutMs = toPositiveNumber(
    process.env.WECHAT_BROKER_HEARTBEAT_TIMEOUT_MS,
    DEFAULT_HEARTBEAT_TIMEOUT_MS,
  )
  const heartbeatScanIntervalMs = toPositiveNumber(
    process.env.WECHAT_BROKER_HEARTBEAT_SCAN_INTERVAL_MS,
    DEFAULT_HEARTBEAT_SCAN_INTERVAL_MS,
  )

  const server = net.createServer((socket) => {
    let buffer = ""
    let messageChain: Promise<void> = Promise.resolve()

    socket.on("close", () => {
      cleanupSocketRegistrations(socket)
    })

    socket.on("error", () => {
      cleanupSocketRegistrations(socket)
    })

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")

      while (true) {
        const newlineIndex = buffer.indexOf("\n")
        if (newlineIndex === -1) {
          break
        }

        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)

        try {
          const envelope = parseEnvelopeLine(`${line}\n`)
          messageChain = messageChain.then(() => handleMessage(envelope, socket)).catch(() => {
            // errors are converted to response envelopes in handleMessage
          })
        } catch {
          writeError(socket, "invalidMessage", "invalid message line", "unknown")
        }
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(endpoint, () => {
      server.off("error", reject)
      resolve()
    })
  })

  try {
    await tightenEndpointPermission(endpoint)
    await ensureCurrentUserCanAccess(endpoint)
  } catch (error) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
    throw error
  }

  const staleScanTimer = setInterval(() => {
    void markStaleSnapshots(Date.now(), heartbeatTimeoutMs).catch((error) => {
      console.error("[wechat-broker] failed to persist stale snapshot", error)
    })
  }, heartbeatScanIntervalMs)

  let closed = false
  const close = async () => {
    if (closed) {
      return
    }
    closed = true

    clearInterval(staleScanTimer)

    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })

    if (process.platform !== "win32") {
      await rm(endpoint, { force: true })
    }
  }

  return {
    endpoint,
    startedAt: Date.now(),
    close,
  }
}
