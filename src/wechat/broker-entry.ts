import path from "node:path"
import process from "node:process"
import { readFileSync, rmSync } from "node:fs"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { createOpencodeClient as createOpencodeClientV2, type QuestionAnswer } from "@opencode-ai/sdk/v2"
import { startBrokerServer } from "./broker-server.js"
import { WECHAT_FILE_MODE, wechatStateRoot, wechatStatusRuntimeDiagnosticsPath } from "./state-paths.js"
import {
  createWechatStatusRuntime,
  type WechatStatusRuntime,
  type WechatStatusRuntimeDiagnosticEvent,
} from "./wechat-status-runtime.js"
import type { WechatSlashCommand } from "./command-parser.js"

type BrokerState = {
  pid: number
  endpoint: string
  startedAt: number
  version: string
}

const BROKER_WECHAT_RUNTIME_AUTOSTART_DELAY_MS = 1_000

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
  createStatusRuntime?: (deps: {
    onSlashCommand: (input: { command: import("./command-parser.js").WechatSlashCommand }) => Promise<string>
    onDiagnosticEvent: (event: WechatStatusRuntimeDiagnosticEvent) => void | Promise<void>
  }) => WechatStatusRuntime
  handleWechatSlashCommand?: (command: import("./command-parser.js").WechatSlashCommand) => Promise<string>
  onRuntimeError?: (error: unknown) => void
  onDiagnosticEvent?: (event: WechatStatusRuntimeDiagnosticEvent) => void | Promise<void>
  stateRoot?: string
}

function createWechatStatusRuntimeDiagnosticsFileWriter(input: {
  stateRoot: string
  onRuntimeError: (error: unknown) => void
}): (event: WechatStatusRuntimeDiagnosticEvent) => Promise<void> {
  return async (event) => {
    try {
      await mkdir(input.stateRoot, { recursive: true, mode: 0o700 })
      const filePath = wechatStatusRuntimeDiagnosticsPath(input.stateRoot)
      const line = `${JSON.stringify({
        timestamp: Date.now(),
        ...event,
      })}\n`
      await appendFile(filePath, line, { encoding: "utf8", mode: WECHAT_FILE_MODE })
    } catch (error) {
      input.onRuntimeError(error)
    }
  }
}

export function shouldEnableBrokerWechatStatusRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  void env
  return true
}

type BrokerWechatSlashHandlerClient = {
  question?: {
    list?: (input?: { directory?: string }) => Promise<{ data?: Array<{ id?: string }> } | Array<{ id?: string }> | undefined>
    reply?: (input: { requestID: string; directory?: string; answers?: Array<QuestionAnswer> }) => Promise<unknown>
  }
  permission?: {
    list?: (input?: { directory?: string }) => Promise<{ data?: Array<{ id?: string }> } | Array<{ id?: string }> | undefined>
    reply?: (input: { requestID: string; directory?: string; reply?: "once" | "always" | "reject"; message?: string }) => Promise<unknown>
  }
}

function unwrapDataArray<T>(value: { data?: T[] } | T[] | undefined): T[] {
  if (Array.isArray(value)) {
    return value
  }
  return Array.isArray(value?.data) ? value.data : []
}

function withOptionalDirectory<T extends object>(input: T, directory: string | undefined): T & { directory?: string } {
  if (typeof directory === "string" && directory.trim().length > 0) {
    return {
      ...input,
      directory,
    }
  }
  return input
}

export function createBrokerWechatSlashCommandHandler(input: {
  handleStatusCommand: () => Promise<string>
  client?: BrokerWechatSlashHandlerClient
  directory?: string
}): (command: WechatSlashCommand) => Promise<string> {
  return async (command) => {
    if (command.type === "status") {
      return input.handleStatusCommand()
    }

    if (command.type === "reply") {
      const questions = unwrapDataArray(await input.client?.question?.list?.(withOptionalDirectory({}, input.directory)))
      const requestID = typeof questions[0]?.id === "string" ? questions[0].id : undefined
      if (!requestID) {
        return "当前没有待回复问题"
      }
      await input.client?.question?.reply?.(withOptionalDirectory({
        requestID,
        answers: [[command.text]],
      }, input.directory))
      return `已回复问题：${requestID}`
    }

    const permissions = unwrapDataArray(await input.client?.permission?.list?.(withOptionalDirectory({}, input.directory)))
    const requestID = typeof permissions[0]?.id === "string" ? permissions[0].id : undefined
    if (!requestID) {
      return "当前没有待处理权限请求"
    }
    await input.client?.permission?.reply?.(withOptionalDirectory({
      requestID,
      reply: command.reply,
      ...(command.message ? { message: command.message } : {}),
    }, input.directory))
    return `已处理权限请求：${requestID} (${command.reply})`
  }
}

export function createBrokerWechatStatusRuntimeLifecycle(
  deps: BrokerWechatStatusRuntimeLifecycleDeps = {},
): BrokerWechatStatusRuntimeLifecycle {
  const onRuntimeError = deps.onRuntimeError ?? ((error) => console.error(error))
  const stateRoot = deps.stateRoot ?? wechatStateRoot()
  const onDiagnosticEvent =
    deps.onDiagnosticEvent ?? createWechatStatusRuntimeDiagnosticsFileWriter({ stateRoot, onRuntimeError })
  const v2Client = createOpencodeClientV2({
    baseUrl: "http://localhost:4096",
    directory: process.cwd(),
  })
  const handleWechatSlashCommand = deps.handleWechatSlashCommand ?? createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "命令暂未实现：/status",
    client: v2Client,
    directory: process.cwd(),
  })
  const createStatusRuntime =
    deps.createStatusRuntime ??
    ((statusRuntimeDeps) =>
      createWechatStatusRuntime({
        onSlashCommand: async ({ command }) => statusRuntimeDeps.onSlashCommand({ command }),
        onRuntimeError,
        onDiagnosticEvent: statusRuntimeDeps.onDiagnosticEvent,
      }))

  let runtime: WechatStatusRuntime | null = null

  return {
    start: async () => {
      if (runtime) {
        return
      }
      const created = createStatusRuntime({
        onSlashCommand: async ({ command }) => handleWechatSlashCommand(command),
        onDiagnosticEvent,
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
    handleWechatSlashCommand: createBrokerWechatSlashCommandHandler({
      handleStatusCommand: async () => server.handleWechatSlashCommand({ type: "status" }),
      client: createOpencodeClientV2({
        baseUrl: "http://localhost:4096",
        directory: stateRoot,
      }),
      directory: stateRoot,
    }),
  })
  if (shouldEnableBrokerWechatStatusRuntime()) {
    setTimeout(() => {
      void wechatRuntimeLifecycle.start()
    }, BROKER_WECHAT_RUNTIME_AUTOSTART_DELAY_MS)
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
