import net from "node:net"
import path from "node:path"
import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises"
import { createBrokerSocket, isTcpBrokerEndpoint, listenOnBrokerEndpoint } from "./broker-endpoint.js"
import { registerConnection, revokeSessionToken, validateSessionToken } from "./ipc-auth.js"
import {
  createErrorEnvelope,
  parseEnvelopeLine,
  serializeEnvelope,
  type BrokerEnvelope,
  type BrokerMessageType,
  type CollectStatusPayload,
  type SyncWechatNotificationsPayload,
  type StatusSnapshotPayload,
  type WechatNotificationCandidate,
} from "./protocol.js"
import { WECHAT_DIR_MODE, WECHAT_FILE_MODE, instanceStatePath, instancesDir } from "./state-paths.js"
import { formatAggregatedStatusReply } from "./status-format.js"
import type { WechatSlashCommand } from "./command-parser.js"
import { upsertNotification } from "./notification-store.js"
import { readOperatorBinding } from "./operator-store.js"
import { createHandle, createRouteKey } from "./handle.js"
import { findOpenRequestByIdentity, listActiveRequests, upsertRequest } from "./request-store.js"

const FUTURE_MESSAGE_TYPES = new Set<BrokerMessageType>([
  "collectStatus",
  "replyQuestion",
  "rejectQuestion",
  "replyPermission",
  "showFallbackToast",
])

export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000
const DEFAULT_HEARTBEAT_SCAN_INTERVAL_MS = 1_000
export const DEFAULT_STATUS_COLLECT_WINDOW_MS = 5_000

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

type AggregatedStatusInstance =
  | {
      instanceID: string
      status: "ok"
      snapshot: unknown
    }
  | {
      instanceID: string
      status: "timeout/unreachable"
    }

type CollectStatusResult = {
  requestId: string
  instances: AggregatedStatusInstance[]
  reply: string
}

type PendingCollectStatus = {
  requestedInstanceIDs: Set<string>
  snapshotsByInstanceID: Map<string, unknown>
  resolve: (result: CollectStatusResult) => void
  timer: NodeJS.Timeout
}

const registrationByInstanceID = new Map<string, RegistrationRecord>()
const instanceIDsBySocket = new Map<net.Socket, Set<string>>()
const snapshotByInstanceID = new Map<string, InstanceSnapshot>()
const snapshotPersistQueueByInstanceID = new Map<string, Promise<void>>()
const pendingCollectStatusByRequestId = new Map<string, PendingCollectStatus>()
let syncWechatNotificationsChain: Promise<void> = Promise.resolve()

function clearRuntimeState() {
  for (const instanceID of registrationByInstanceID.keys()) {
    revokeSessionToken(instanceID)
  }
  registrationByInstanceID.clear()
  instanceIDsBySocket.clear()
  snapshotByInstanceID.clear()
  snapshotPersistQueueByInstanceID.clear()
  pendingCollectStatusByRequestId.clear()
  syncWechatNotificationsChain = Promise.resolve()
}

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

function hasCollectStatusPayload(payload: unknown): payload is CollectStatusPayload {
  return asObject(payload).requestId !== undefined && isNonEmptyString(asObject(payload).requestId)
}

function hasStatusSnapshotPayload(payload: unknown): payload is StatusSnapshotPayload {
  const record = asObject(payload)
  return isNonEmptyString(record.requestId) && "snapshot" in record
}

function isWechatNotificationCandidate(value: unknown): value is WechatNotificationCandidate {
  const record = asObject(value)
  if (!isNonEmptyString(record.idempotencyKey) || !isFiniteNumber(record.createdAt)) {
    return false
  }
  if (record.kind === "sessionError") {
    return true
  }
  if (record.kind === "question" || record.kind === "permission") {
    return isNonEmptyString(record.requestID) && isNonEmptyString(record.routeKey) && isNonEmptyString(record.handle)
  }
  return false
}

function hasSyncWechatNotificationsPayload(payload: unknown): payload is SyncWechatNotificationsPayload {
  const record = asObject(payload)
  if (!Array.isArray(record.candidates)) {
    return false
  }
  return record.candidates.every((candidate) => isWechatNotificationCandidate(candidate))
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

function finalizePendingCollectStatus(requestId: string) {
  const pending = pendingCollectStatusByRequestId.get(requestId)
  if (!pending) {
    return
  }

  clearTimeout(pending.timer)
  pendingCollectStatusByRequestId.delete(requestId)

  const instances: AggregatedStatusInstance[] = []
  for (const instanceID of pending.requestedInstanceIDs) {
    if (pending.snapshotsByInstanceID.has(instanceID)) {
      instances.push({
        instanceID,
        status: "ok",
        snapshot: pending.snapshotsByInstanceID.get(instanceID),
      })
      continue
    }

    instances.push({
      instanceID,
      status: "timeout/unreachable",
    })
  }

  pending.resolve({
    requestId,
    instances,
    reply: formatAggregatedStatusReply({
      requestId,
      instances,
    }),
  })
}

function queueSyncWechatNotifications(task: () => Promise<void>): Promise<void> {
  const next = syncWechatNotificationsChain.then(task)
  syncWechatNotificationsChain = next.catch(() => {})
  return next
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

  if (envelope.type === "statusSnapshot") {
    if (!requireAuthorized(envelope)) {
      writeError(socket, "unauthorized", "session token is invalid", requestId)
      return
    }

    const payload = envelope.payload
    if (!hasStatusSnapshotPayload(payload)) {
      writeError(socket, "invalidMessage", "statusSnapshot payload is invalid", requestId)
      return
    }

    const pending = pendingCollectStatusByRequestId.get(payload.requestId)
    if (!pending) {
      return
    }

    const sourceInstanceID = envelope.instanceID
    if (!isNonEmptyString(sourceInstanceID)) {
      return
    }

    if (!pending.requestedInstanceIDs.has(sourceInstanceID)) {
      return
    }

    pending.snapshotsByInstanceID.set(sourceInstanceID, payload.snapshot)
    if (pending.snapshotsByInstanceID.size >= pending.requestedInstanceIDs.size) {
      finalizePendingCollectStatus(payload.requestId)
    }
    return
  }

  if (envelope.type === "syncWechatNotifications") {
    if (!requireAuthorized(envelope)) {
      writeError(socket, "unauthorized", "session token is invalid", requestId)
      return
    }

    const payload = envelope.payload
    if (!hasSyncWechatNotificationsPayload(payload)) {
      writeError(socket, "invalidMessage", "syncWechatNotifications payload is invalid", requestId)
      return
    }

    const binding = await readOperatorBinding().catch(() => undefined)
    if (!binding) {
      return
    }

    await queueSyncWechatNotifications(async () => {
      for (const candidate of payload.candidates) {
        if (candidate.kind === "sessionError") {
          await upsertNotification({
            idempotencyKey: candidate.idempotencyKey,
            kind: "sessionError",
            wechatAccountId: binding.wechatAccountId,
            userId: binding.userId,
            createdAt: candidate.createdAt,
          })
          continue
        }

        const existingOpen = await findOpenRequestByIdentity({
          kind: candidate.kind,
          requestID: candidate.requestID,
          wechatAccountId: binding.wechatAccountId,
          userId: binding.userId,
          scopeKey: envelope.instanceID,
        })

        let canonicalRouteKey: string
        let canonicalHandle: string

        if (existingOpen) {
          canonicalRouteKey = existingOpen.routeKey
          canonicalHandle = existingOpen.handle
        } else {
          const activeRequests = await listActiveRequests()
          const existingHandles = activeRequests
            .filter((item) => item.kind === candidate.kind && item.status === "open")
            .map((item) => item.handle)

          const nextRouteKey = createRouteKey({
            kind: candidate.kind,
            requestID: candidate.requestID,
            scopeKey: envelope.instanceID,
          })
          const nextHandle = createHandle(candidate.kind, existingHandles)

          const created = await upsertRequest({
            kind: candidate.kind,
            requestID: candidate.requestID,
            routeKey: nextRouteKey,
            handle: nextHandle,
            wechatAccountId: binding.wechatAccountId,
            userId: binding.userId,
            createdAt: candidate.createdAt,
          })

          canonicalRouteKey = created.routeKey
          canonicalHandle = created.handle
        }

        await upsertNotification({
          idempotencyKey: candidate.idempotencyKey,
          kind: candidate.kind,
          wechatAccountId: binding.wechatAccountId,
          userId: binding.userId,
          routeKey: canonicalRouteKey,
          handle: canonicalHandle,
          createdAt: candidate.createdAt,
        })
      }
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
  if (process.platform === "win32" || isTcpBrokerEndpoint(endpoint)) {
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
    const probe = createBrokerSocket(endpoint)
    probe.once("connect", () => {
      probe.end()
      resolve()
    })
    probe.once("error", reject)
  })
}

async function prepareEndpoint(endpoint: string) {
  if (process.platform === "win32" || isTcpBrokerEndpoint(endpoint)) {
    return
  }

  await mkdir(path.dirname(endpoint), { recursive: true, mode: WECHAT_DIR_MODE })
  await rm(endpoint, { force: true })
}

export type BrokerServerHandle = {
  endpoint: string
  startedAt: number
  collectStatus: () => Promise<CollectStatusResult>
  handleWechatSlashCommand: (command: WechatSlashCommand) => Promise<string>
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
  const statusCollectWindowMs = toPositiveNumber(
    process.env.WECHAT_BROKER_STATUS_COLLECT_WINDOW_MS,
    DEFAULT_STATUS_COLLECT_WINDOW_MS,
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

  const boundEndpoint = await listenOnBrokerEndpoint(server, endpoint)

  try {
    await tightenEndpointPermission(boundEndpoint)
    await ensureCurrentUserCanAccess(boundEndpoint)
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

  const collectStatus = async (): Promise<CollectStatusResult> => {
    const requestId = `collect-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const requestedInstanceIDs = new Set<string>()

    for (const [instanceID, record] of registrationByInstanceID.entries()) {
      if (record.socket.destroyed) {
        continue
      }
      requestedInstanceIDs.add(instanceID)
      writeEnvelope(record.socket, {
        id: `collectStatus-${requestId}-${instanceID}`,
        type: "collectStatus",
        instanceID,
        sessionToken: record.sessionToken,
        payload: {
          requestId,
        } as CollectStatusPayload,
      })
    }

    if (requestedInstanceIDs.size === 0) {
      return {
        requestId,
        instances: [],
        reply: formatAggregatedStatusReply({
          requestId,
          instances: [],
        }),
      }
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        finalizePendingCollectStatus(requestId)
      }, statusCollectWindowMs)

      pendingCollectStatusByRequestId.set(requestId, {
        requestedInstanceIDs,
        snapshotsByInstanceID: new Map(),
        resolve,
        timer,
      })
    })
  }

  const handleWechatSlashCommand = async (command: WechatSlashCommand): Promise<string> => {
    if (command.type === "status") {
      const result = await collectStatus()
      return result.reply
    }

    if (command.type === "reply") {
      return "命令暂未实现：/reply"
    }

    return "命令暂未实现：/allow"
  }

  const close = async () => {
    if (closed) {
      return
    }
    closed = true

    clearInterval(staleScanTimer)

    for (const requestId of pendingCollectStatusByRequestId.keys()) {
      finalizePendingCollectStatus(requestId)
    }

    for (const record of registrationByInstanceID.values()) {
      if (!record.socket.destroyed) {
        record.socket.destroy()
      }
    }

    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })

    if (process.platform !== "win32" && !isTcpBrokerEndpoint(endpoint)) {
      await rm(endpoint, { force: true })
    }

    clearRuntimeState()
  }

  return {
    endpoint: boundEndpoint,
    startedAt: Date.now(),
    collectStatus,
    handleWechatSlashCommand,
    close,
  }
}
