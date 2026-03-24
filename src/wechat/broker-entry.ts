import path from "node:path"
import process from "node:process"
import { readFileSync, rmSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { startBrokerServer } from "./broker-server.js"
import { WECHAT_FILE_MODE, wechatStateRoot } from "./state-paths.js"

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
