import net from "node:net"
import path from "node:path"

type BrokerEndpointOptions = {
  platform?: NodeJS.Platform
  stateRoot?: string
  now?: () => number
  random?: () => number
}

type ParsedBrokerEndpoint =
  | {
      kind: "tcp"
      host: string
      port: number
    }
  | {
      kind: "path"
      path: string
    }

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

export function isTcpBrokerEndpoint(endpoint: string): boolean {
  return endpoint.startsWith("tcp://")
}

export function createDefaultBrokerEndpoint(options: BrokerEndpointOptions = {}): string {
  const platform = options.platform ?? process.platform
  const stateRoot = options.stateRoot ?? "."
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const suffix = `${now()}-${random().toString(16).slice(2)}`

  if (platform === "win32") {
    return "tcp://127.0.0.1:0"
  }

  return path.join(stateRoot, `broker-${suffix}.sock`)
}

export function parseBrokerEndpoint(endpoint: string): ParsedBrokerEndpoint {
  if (!isTcpBrokerEndpoint(endpoint)) {
    return {
      kind: "path",
      path: endpoint,
    }
  }

  const parsed = new URL(endpoint)
  if (parsed.protocol !== "tcp:") {
    throw new Error(`unsupported broker endpoint protocol: ${parsed.protocol}`)
  }
  if (!isNonEmptyString(parsed.hostname)) {
    throw new Error("tcp broker endpoint host is required")
  }

  const port = Number(parsed.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("tcp broker endpoint port is invalid")
  }

  return {
    kind: "tcp",
    host: parsed.hostname,
    port,
  }
}

export function createBrokerSocket(endpoint: string): net.Socket {
  const parsed = parseBrokerEndpoint(endpoint)
  if (parsed.kind === "tcp") {
    return net.createConnection({
      host: parsed.host,
      port: parsed.port,
    })
  }

  return net.createConnection(parsed.path)
}

export async function listenOnBrokerEndpoint(server: net.Server, endpoint: string): Promise<string> {
  const parsed = parseBrokerEndpoint(endpoint)

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    if (parsed.kind === "tcp") {
      server.listen({ host: parsed.host, port: parsed.port }, () => {
        server.off("error", reject)
        resolve()
      })
      return
    }

    server.listen(parsed.path, () => {
      server.off("error", reject)
      resolve()
    })
  })

  if (parsed.kind === "path") {
    return parsed.path
  }

  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("tcp broker endpoint failed to resolve bound address")
  }

  return `tcp://${address.address}:${address.port}`
}
