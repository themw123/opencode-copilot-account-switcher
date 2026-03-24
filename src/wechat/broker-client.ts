import net from "node:net"
import { parseEnvelopeLine, serializeEnvelope, type BrokerEnvelope } from "./protocol.js"

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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

export async function connect(endpoint: string): Promise<BrokerClient> {
  const socket = net.createConnection(endpoint)
  let sequence = 0
  let pendingResolve: ((value: BrokerEnvelope) => void) | null = null
  let pendingReject: ((reason?: unknown) => void) | null = null
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
        const resolve = pendingResolve
        const reject = pendingReject
        pendingResolve = null
        pendingReject = null
        try {
          resolve(parseEnvelopeLine(frame))
        } catch (error) {
          reject?.(error)
        }
      }
    }
  })

  socket.on("error", (error) => {
    if (pendingReject) {
      const reject = pendingReject
      pendingResolve = null
      pendingReject = null
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
      reject(new Error("broker connection closed"))
    }
  })

  await connectedReady

  function nextRequestId(prefix: string) {
    sequence += 1
    return `${prefix}-${Date.now()}-${sequence}`
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
      socket.end()
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve())
      })
    },
  }
}
