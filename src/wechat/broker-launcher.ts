import path from "node:path"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, open, readFile, rm } from "node:fs/promises"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createBrokerSocket, createDefaultBrokerEndpoint } from "./broker-endpoint.js"
import { wechatStateRoot } from "./state-paths.js"
import { parseEnvelopeLine, serializeEnvelope } from "./protocol.js"

type BrokerMetadata = {
  pid: number
  endpoint: string
  startedAt: number
  version: string
}

type LaunchLockContent = {
  pid: number
  acquiredAt: number
  lockId: string
}

type LaunchOptions = {
  stateRoot?: string
  brokerJsonPath?: string
  launchLockPath?: string
  backoffMs?: number
  maxAttempts?: number
  expectedVersion?: string
  endpointFactory?: () => string
  spawnImpl?: (endpoint: string, stateRoot: string) => { pid?: number | undefined; unref?: (() => void) | undefined }
  pingImpl?: (endpoint: string) => Promise<boolean>
  onLockAcquired?: (lock: LaunchLockContent) => void
}

const DEFAULT_BACKOFF_MS = 250
const DEFAULT_MAX_ATTEMPTS = 20

type ResolveBrokerSpawnCommandOptions = {
  platform?: NodeJS.Platform
  execPath?: string
  bunPathExists?: (candidate: string) => boolean
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export { createDefaultBrokerEndpoint }

export function resolveBrokerSpawnCommand(options: ResolveBrokerSpawnCommandOptions = {}): string {
  const platform = options.platform ?? process.platform
  const execPath = options.execPath ?? process.execPath
  const bunPathExists = options.bunPathExists ?? existsSync

  if (platform !== "win32") {
    return execPath
  }

  if (path.win32.basename(execPath).toLowerCase() !== "opencode.exe") {
    return execPath
  }

  const bunPath = path.win32.join(path.win32.dirname(execPath), "bun.exe")
  return bunPathExists(bunPath) ? bunPath : execPath
}

async function readCurrentPackageVersion(): Promise<string> {
  try {
    const packageJsonPath = new URL("../../package.json", import.meta.url)
    const raw = await readFile(packageJsonPath, "utf8")
    const parsed = JSON.parse(raw) as { version?: unknown }
    return isNonEmptyString(parsed.version) ? parsed.version : "unknown"
  } catch {
    return "unknown"
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function readBrokerMetadata(filePath: string): Promise<BrokerMetadata | null> {
  try {
    const raw = await readFile(filePath, "utf8")
    const parsed = JSON.parse(raw) as Partial<BrokerMetadata>
    if (!isFiniteNumber(parsed.pid) || !isNonEmptyString(parsed.endpoint) || !isFiniteNumber(parsed.startedAt)) {
      return null
    }
    return {
      pid: parsed.pid,
      endpoint: parsed.endpoint,
      startedAt: parsed.startedAt,
      version: isNonEmptyString(parsed.version) ? parsed.version : "unknown",
    }
  } catch {
    return null
  }
}

async function defaultPingImpl(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createBrokerSocket(endpoint)
    let buffer = ""
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, 500)

    socket.once("error", () => {
      clearTimeout(timer)
      resolve(false)
    })

    socket.once("connect", () => {
      socket.write(serializeEnvelope({ id: `launcher-ping-${Date.now()}`, type: "ping", payload: {} }))
    })

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      const newlineIndex = buffer.indexOf("\n")
      if (newlineIndex === -1) {
        return
      }

      clearTimeout(timer)
      socket.end()
      try {
        const response = parseEnvelopeLine(buffer.slice(0, newlineIndex + 1))
        resolve(response.type === "pong")
      } catch {
        resolve(false)
      }
    })
  })
}

async function readLaunchLock(filePath: string): Promise<LaunchLockContent | null> {
  try {
    const raw = await readFile(filePath, "utf8")
    const parsed = JSON.parse(raw) as Partial<LaunchLockContent>
    if (!isFiniteNumber(parsed.pid) || !isFiniteNumber(parsed.acquiredAt) || !isNonEmptyString(parsed.lockId)) {
      return null
    }
    return {
      pid: parsed.pid,
      acquiredAt: parsed.acquiredAt,
      lockId: parsed.lockId,
    }
  } catch {
    return null
  }
}

async function acquireLaunchLock(filePath: string): Promise<LaunchLockContent | null> {
  const lock: LaunchLockContent = {
    pid: process.pid,
    acquiredAt: Date.now(),
    lockId: randomUUID(),
  }

  try {
    const handle = await open(filePath, "wx", 0o600)
    await handle.writeFile(JSON.stringify(lock, null, 2), "utf8")
    await handle.close()
    return lock
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error
    }

    const existing = await readLaunchLock(filePath)
    if (existing && isProcessAlive(existing.pid)) {
      return null
    }

    await rm(filePath, { force: true })
    return null
  }
}

async function isBrokerAlive(
  brokerFilePath: string,
  pingImpl: (endpoint: string) => Promise<boolean>,
  expectedVersion?: string,
): Promise<BrokerMetadata | null> {
  const metadata = await readBrokerMetadata(brokerFilePath)
  if (!metadata) {
    return null
  }

  if (isNonEmptyString(expectedVersion) && metadata.version !== expectedVersion) {
    return null
  }

  const ok = await pingImpl(metadata.endpoint)
  if (!ok) {
    return null
  }
  return metadata
}

function defaultSpawnImpl(endpoint: string, stateRoot: string) {
  const entry = fileURLToPath(new URL("./broker-entry.js", import.meta.url))
  const child = spawn(resolveBrokerSpawnCommand(), [entry, `--endpoint=${endpoint}`, `--state-root=${stateRoot}`], {
    cwd: path.resolve(fileURLToPath(new URL("../..", import.meta.url))),
    detached: true,
    stdio: "ignore",
  })
  child.unref()
  return child
}

export async function connectOrSpawnBroker(options: LaunchOptions = {}): Promise<BrokerMetadata> {
  const stateRoot = options.stateRoot ?? wechatStateRoot()
  const brokerJsonFile = options.brokerJsonPath ?? path.join(stateRoot, "broker.json")
  const launchLockFile = options.launchLockPath ?? path.join(stateRoot, "launch.lock")
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const expectedVersion = options.expectedVersion ?? await readCurrentPackageVersion()
  const pingImpl = options.pingImpl ?? defaultPingImpl
  const spawnImpl = options.spawnImpl ?? defaultSpawnImpl
  const endpointFactory = options.endpointFactory ?? (() => createDefaultBrokerEndpoint({ stateRoot }))

  await mkdir(stateRoot, { recursive: true, mode: 0o700 })

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const running = await isBrokerAlive(brokerJsonFile, pingImpl, expectedVersion)
    if (running) {
      return running
    }

    const lock = await acquireLaunchLock(launchLockFile)
    if (!lock) {
      await delay(backoffMs)
      continue
    }

    options.onLockAcquired?.(lock)

    try {
      const secondCheck = await isBrokerAlive(brokerJsonFile, pingImpl, expectedVersion)
      if (secondCheck) {
        return secondCheck
      }

      const endpoint = endpointFactory()
      const child = spawnImpl(endpoint, stateRoot)
      void child?.unref?.()

      for (let n = 0; n < 20; n += 1) {
        await delay(100)
        const spawned = await isBrokerAlive(brokerJsonFile, pingImpl, expectedVersion)
        if (spawned) {
          return spawned
        }
      }

      throw new Error("spawned broker did not become available")
    } finally {
      await rm(launchLockFile, { force: true })
    }
  }

  throw new Error("broker unavailable")
}
