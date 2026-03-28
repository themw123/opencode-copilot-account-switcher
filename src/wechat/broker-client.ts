import { createBrokerSocket } from "./broker-endpoint.js"
import {
  parseEnvelopeLine,
  serializeEnvelope,
  type BrokerEnvelope,
  type CollectStatusPayload,
} from "./protocol.js"
import type { WechatBridge } from "./bridge.js"

type RegisterMeta = {
  instanceID: string
  pid: number
}

export type RegisterAck = {
  sessionToken: string
  registeredAt: number
  brokerPid: number
}

type SessionSnapshot = {
  instanceID: string
  sessionToken: string
  registeredAt: number
  brokerPid: number
}

type BrokerClient = {
  ping: () => Promise<BrokerEnvelope>
  registerInstance: (meta: RegisterMeta) => Promise<RegisterAck>
  heartbeat: () => Promise<BrokerEnvelope>
  getSessionSnapshot: () => SessionSnapshot | null
  close: () => Promise<void>
}

export type CollectStatusInput = {
  requestId: string
}

export type BrokerClientOptions = {
  onCollectStatus?: (input: CollectStatusInput) => Promise<unknown> | unknown
  bridge?: WechatBridge
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isResponseForRequest(response: BrokerEnvelope, requestId: string): boolean {
  if (response.id === requestId) {
    return true
  }
  if (response.id.endsWith(`-${requestId}`)) {
    return true
  }
  if (response.type === "error") {
    const payload = response.payload as { requestId?: unknown }
    return payload.requestId === requestId
  }
  return false
}

export async function connect(endpoint: string, options: BrokerClientOptions = {}): Promise<BrokerClient> {
  if (options.bridge && options.onCollectStatus) {
    throw new Error("broker client options are ambiguous: provide either bridge or onCollectStatus")
  }

  const socket = createBrokerSocket(endpoint)
  let sequence = 0
  let pendingResolve: ((value: BrokerEnvelope) => void) | null = null
  let pendingReject: ((reason?: unknown) => void) | null = null
  let pendingRequestId: string | null = null
  let buffer = ""
  let connected = false
  let closed = false
  let session: SessionSnapshot | null = null

  const connectedReady = new Promise<void>((resolve, reject) => {
    socket.once("connect", () => {
      connected = true
      resolve()
    })
    socket.once("error", reject)
  })

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8")
    while (true) {
      const newlineIndex = buffer.indexOf("\n")
      if (newlineIndex === -1) {
        break
      }

      const frame = buffer.slice(0, newlineIndex + 1)
      buffer = buffer.slice(newlineIndex + 1)
      if (pendingResolve) {
        try {
          const parsed = parseEnvelopeLine(frame)
          if (parsed.type === "collectStatus") {
            handleCollectStatus(parsed)
            continue
          }

          if (pendingRequestId && !isResponseForRequest(parsed, pendingRequestId)) {
            continue
          }

          const resolve = pendingResolve
          pendingResolve = null
          pendingReject = null
          pendingRequestId = null
          resolve(parsed)
        } catch (error) {
          const reject = pendingReject
          pendingResolve = null
          pendingReject = null
          pendingRequestId = null
          reject?.(error)
        }
      } else {
        try {
          const parsed = parseEnvelopeLine(frame)
          if (parsed.type === "collectStatus") {
            handleCollectStatus(parsed)
          }
        } catch {
          // ignore unsolicited invalid frames when no pending request exists
        }
      }
    }
  })

  socket.on("error", (error) => {
    if (pendingReject) {
      const reject = pendingReject
      pendingResolve = null
      pendingReject = null
      pendingRequestId = null
      reject(error)
    }
  })

  socket.on("close", () => {
    connected = false
    closed = true
    session = null
    if (pendingReject) {
      const reject = pendingReject
      pendingResolve = null
      pendingReject = null
      pendingRequestId = null
      reject(new Error("broker connection closed"))
    }
  })

  await connectedReady

  function nextRequestId(prefix: string) {
    sequence += 1
    return `${prefix}-${Date.now()}-${sequence}`
  }

  function sendStatusSnapshot(requestId: string, snapshot: unknown) {
    if (!session) {
      return
    }

    const envelope: BrokerEnvelope = {
      id: nextRequestId("statusSnapshot"),
      type: "statusSnapshot",
      instanceID: session.instanceID,
      sessionToken: session.sessionToken,
      payload: {
        requestId,
        snapshot,
      },
    }
    socket.write(serializeEnvelope(envelope))
  }

  function handleCollectStatus(envelope: BrokerEnvelope) {
    const payload = envelope.payload as Partial<CollectStatusPayload>
    if (!isNonEmptyString(payload.requestId)) {
      return
    }
    const hasBridge = options.bridge !== undefined
    const hasHook = options.onCollectStatus !== undefined
    if (!hasBridge && !hasHook) {
      return
    }

    const collectPromise = hasBridge
      ? options.bridge!.collectStatusSnapshot()
      : options.onCollectStatus!({ requestId: payload.requestId })

    void Promise.resolve(collectPromise)
      .then((snapshot) => {
        sendStatusSnapshot(payload.requestId as string, snapshot)
      })
      .catch(() => {
        // swallow collect handler errors to keep socket alive
      })
  }

  async function send(envelope: BrokerEnvelope): Promise<BrokerEnvelope> {
    if (!connected || closed) {
      throw new Error("broker connection closed")
    }
    if (pendingResolve) {
      throw new Error("broker client has pending request")
    }

    return new Promise((resolve, reject) => {
      pendingResolve = resolve
      pendingReject = reject
      pendingRequestId = envelope.id
      socket.write(serializeEnvelope(envelope))
    })
  }

  return {
    async ping() {
      return send({
        id: nextRequestId("ping"),
        type: "ping",
        payload: {},
      })
    },
    async registerInstance(meta) {
      const instanceID = meta.instanceID
      if (!isNonEmptyString(instanceID)) {
        throw new Error("invalid instanceID")
      }
      if (!isFiniteNumber(meta.pid)) {
        throw new Error("invalid pid")
      }

      const response = await send({
        id: nextRequestId("register"),
        type: "registerInstance",
        instanceID,
        payload: { pid: meta.pid },
      })

      if (response.type !== "registerAck") {
        throw new Error("register failed")
      }

      const payload = response.payload as Partial<RegisterAck>
      if (!isNonEmptyString(payload.sessionToken)) {
        throw new Error("registerAck missing sessionToken")
      }
      if (!isFiniteNumber(payload.registeredAt)) {
        throw new Error("registerAck missing registeredAt")
      }
      if (!isFiniteNumber(payload.brokerPid)) {
        throw new Error("registerAck missing brokerPid")
      }

      session = {
        instanceID,
        sessionToken: payload.sessionToken,
        registeredAt: payload.registeredAt,
        brokerPid: payload.brokerPid,
      }

      return {
        sessionToken: session.sessionToken,
        registeredAt: session.registeredAt,
        brokerPid: session.brokerPid,
      }
    },
    async heartbeat() {
      if (!session) {
        throw new Error("missing broker session")
      }

      return send({
        id: nextRequestId("heartbeat"),
        type: "heartbeat",
        instanceID: session.instanceID,
        sessionToken: session.sessionToken,
        payload: {},
      })
    },
    getSessionSnapshot() {
      if (!session) {
        return null
      }
      return { ...session }
    },
    async close() {
      if (closed) {
        return
      }
      if (socket.destroyed) {
        closed = true
        connected = false
        session = null
        return
      }

      const closePromise = new Promise<void>((resolve) => {
        socket.once("close", () => resolve())
      })
      socket.end()
      await Promise.race([
        closePromise,
        new Promise<void>((resolve) => {
          setTimeout(() => {
            if (!socket.destroyed) {
              socket.destroy()
            }
            resolve()
          }, 200)
        }),
      ])
    },
  }
}
