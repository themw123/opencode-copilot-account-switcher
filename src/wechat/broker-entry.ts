import path from "node:path"
import process from "node:process"
import { readFileSync, rmSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { startBrokerServer } from "./broker-server.js"
import { WECHAT_FILE_MODE, wechatStateRoot } from "./state-paths.js"
import { createWechatStatusRuntime, type WechatStatusRuntime } from "./wechat-status-runtime.js"

type BrokerState = {
  pid: number
  endpoint: string
  startedAt: number
  version: string
}

async function readPackageVersion(): Promise<string> {
  const packageJsonPath = new URL("../../package.json", import.meta.url)
  return readFile(packageJsonPath, "utf8")
    .then((raw) => {
      const parsed = JSON.parse(raw) as { version?: unknown }
      if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
        return parsed.version
      }
      return "unknown"
    })
    .catch(() => "unknown")
}

function parseEndpointArg(argv: string[]): string {
  const prefix = "--endpoint="
  const endpointArg = argv.find((item) => item.startsWith(prefix))
  if (!endpointArg) {
    throw new Error("missing --endpoint argument")
  }
  const endpoint = endpointArg.slice(prefix.length)
  if (!endpoint) {
    throw new Error("missing --endpoint argument")
  }
  return endpoint
}

function parseStateRootArg(argv: string[]): string {
  const prefix = "--state-root="
  const arg = argv.find((item) => item.startsWith(prefix))
  if (!arg) {
    return wechatStateRoot()
  }

  const stateRoot = arg.slice(prefix.length)
  if (!stateRoot) {
    throw new Error("missing --state-root argument")
  }
  return stateRoot
}

function brokerStatePathForRoot(stateRoot: string): string {
  return path.join(stateRoot, "broker.json")
}

async function writeBrokerState(state: BrokerState, stateRoot: string) {
  await mkdir(stateRoot, { recursive: true, mode: 0o700 })
  const filePath = brokerStatePathForRoot(stateRoot)
  await writeFile(filePath, JSON.stringify(state, null, 2), { mode: WECHAT_FILE_MODE })
}

type BrokerOwnership = Pick<BrokerState, "pid" | "startedAt">

type BrokerWechatStatusRuntimeLifecycle = {
  start: () => Promise<void>
  close: () => Promise<void>
}

type BrokerWechatStatusRuntimeLifecycleDeps = {
  createStatusRuntime?: (deps: { onSlashCommand: (input: { command: import("./command-parser.js").WechatSlashCommand }) => Promise<string> }) => WechatStatusRuntime
  handleWechatSlashCommand?: (command: import("./command-parser.js").WechatSlashCommand) => Promise<string>
  onRuntimeError?: (error: unknown) => void
}

export function shouldEnableBrokerWechatStatusRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WECHAT_BROKER_ENABLE_STATUS_RUNTIME === "1"
}

export function createBrokerWechatStatusRuntimeLifecycle(
  deps: BrokerWechatStatusRuntimeLifecycleDeps = {},
): BrokerWechatStatusRuntimeLifecycle {
  const onRuntimeError = deps.onRuntimeError ?? ((error) => console.error(error))
  const handleWechatSlashCommand =
    deps.handleWechatSlashCommand ??
    (async (command) => {
      if (command.type === "status") {
        return "命令暂未实现：/status"
      }
      return `命令暂未实现：/${command.command}`
    })
  const createStatusRuntime =
    deps.createStatusRuntime ??
    ((statusRuntimeDeps) =>
      createWechatStatusRuntime({
        onSlashCommand: async ({ command }) => statusRuntimeDeps.onSlashCommand({ command }),
        onRuntimeError,
      }))

  let runtime: WechatStatusRuntime | null = null

  return {
    start: async () => {
      if (runtime) {
        return
      }
      const created = createStatusRuntime({
        onSlashCommand: async ({ command }) => handleWechatSlashCommand(command),
      })
      runtime = created
      try {
        await created.start()
      } catch (error) {
        onRuntimeError(error)
      }
    },
    close: async () => {
      if (!runtime) {
        return
      }
      const active = runtime
      runtime = null
      await active.close().catch((error) => {
        onRuntimeError(error)
      })
    },
  }
}

function removeOwnedBrokerStateFileSync(ownership: BrokerOwnership, stateRoot: string) {
  try {
    const filePath = brokerStatePathForRoot(stateRoot)
    const raw = readFileSync(filePath, "utf8")
    const parsed = JSON.parse(raw) as Partial<BrokerState>
    if (parsed.pid !== ownership.pid || parsed.startedAt !== ownership.startedAt) {
      return
    }

    rmSync(filePath, { force: true })
  } catch {
    // ignore cleanup errors on shutdown
  }
}

async function run() {
  const args = process.argv.slice(2)
  const endpoint = parseEndpointArg(args)
  const stateRoot = parseStateRootArg(args)
  const server = await startBrokerServer(endpoint)
  const version = await readPackageVersion()
  const state: BrokerState = {
    pid: process.pid,
    endpoint: server.endpoint,
    startedAt: server.startedAt,
    version,
  }

  await writeBrokerState(state, stateRoot)
  const wechatRuntimeLifecycle = createBrokerWechatStatusRuntimeLifecycle({
    handleWechatSlashCommand: server.handleWechatSlashCommand,
  })
  if (shouldEnableBrokerWechatStatusRuntime()) {
    await wechatRuntimeLifecycle.start()
  }
  const ownership: BrokerOwnership = {
    pid: state.pid,
    startedAt: state.startedAt,
  }

  let shuttingDown = false
  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true

    removeOwnedBrokerStateFileSync(ownership, stateRoot)
    await wechatRuntimeLifecycle.close()
    await server.close()
    process.exit(exitCode)
  }

  process.once("SIGINT", () => {
    void shutdown(0)
  })
  process.once("SIGTERM", () => {
    void shutdown(0)
  })

  if (process.env.WECHAT_BROKER_EXIT_ON_STDIN_EOF === "1") {
    process.stdin.on("end", () => {
      void shutdown(0)
    })
    process.stdin.resume()
  }

  process.once("uncaughtException", (error) => {
    console.error(error)
    void shutdown(1)
  })
  process.once("unhandledRejection", (error) => {
    console.error(error)
    void shutdown(1)
  })

  process.on("exit", () => {
    removeOwnedBrokerStateFileSync(ownership, stateRoot)
  })
}

function isDirectRun() {
  if (!process.argv[1]) {
    return false
  }
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
}

if (isDirectRun()) {
  void run().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
