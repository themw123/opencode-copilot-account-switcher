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
import {
  createWechatNotificationDispatcher,
  type WechatNotificationSendInput,
} from "./notification-dispatcher.js"
import type { WechatSlashCommand } from "./command-parser.js"
import {
  findOpenRequestByHandle,
  markRequestAnswered,
  markRequestRejected,
} from "./request-store.js"
import {
  findSentNotificationByRequest,
  markNotificationResolved,
} from "./notification-store.js"

type BrokerState = {
  pid: number
  endpoint: string
  startedAt: number
  version: string
}

const BROKER_WECHAT_RUNTIME_AUTOSTART_DELAY_MS = 1_000
const DEFAULT_BROKER_IDLE_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_BROKER_IDLE_SCAN_INTERVAL_MS = 1_000

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

function toPositiveNumber(rawValue: string | undefined, fallback: number): number {
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    return fallback
  }

  const parsed = Number(rawValue)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }

  return parsed
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
    drainOutboundMessages: (input?: {
      sendMessage: (input: WechatNotificationSendInput) => Promise<void>
    }) => Promise<void>
  }) => WechatStatusRuntime
  createNotificationDispatcher?: (input: {
    sendMessage: (input: WechatNotificationSendInput) => Promise<void>
  }) => {
    drainOutboundMessages: () => Promise<void>
  }
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
    reply?: (input: { requestID: string; directory?: string; answers?: Array<QuestionAnswer> }) => Promise<unknown>
  }
  permission?: {
    reply?: (input: { requestID: string; directory?: string; reply?: "once" | "always" | "reject"; message?: string }) => Promise<unknown>
  }
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

function isInvalidHandleError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return /invalid handle format|raw requestID cannot be used as handle/i.test(error.message)
}

export function createBrokerWechatSlashCommandHandler(input: {
  handleStatusCommand: () => Promise<string>
  client?: BrokerWechatSlashHandlerClient
  directory?: string
}): (command: WechatSlashCommand) => Promise<string> {
  const findOpenRequestSafely = async (input: {
    kind: "question" | "permission"
    handle: string
  }) => {
    try {
      return await findOpenRequestByHandle(input)
    } catch (error) {
      if (isInvalidHandleError(error)) {
        return undefined
      }
      throw error
    }
  }

  const resolveNotificationForOpenRequest = async (request: {
    kind: "question" | "permission"
    routeKey: string
    handle: string
  }) => {
    try {
      const sentNotification = await findSentNotificationByRequest({
        kind: request.kind,
        routeKey: request.routeKey,
        handle: request.handle,
      })
      if (!sentNotification) {
        return
      }
      await markNotificationResolved({
        idempotencyKey: sentNotification.idempotencyKey,
        resolvedAt: Date.now(),
      })
    } catch {
      // best-effort only: notification resolve failure should not fail slash reply
    }
  }

  return async (command) => {
    if (command.type === "status") {
      return input.handleStatusCommand()
    }

    if (command.type === "reply") {
      const openQuestion = await findOpenRequestSafely({
        kind: "question",
        handle: command.handle,
      })
      if (!openQuestion) {
        return `未找到待回复问题：${command.handle}`
      }
      await input.client?.question?.reply?.(withOptionalDirectory({
        requestID: openQuestion.requestID,
        answers: [[command.text]],
      }, input.directory))
      await markRequestAnswered({
        kind: "question",
        routeKey: openQuestion.routeKey,
        answeredAt: Date.now(),
      })
      await resolveNotificationForOpenRequest(openQuestion)
      return `已回复问题：${openQuestion.handle}`
    }

    const openPermission = await findOpenRequestSafely({
      kind: "permission",
      handle: command.handle,
    })
    if (!openPermission) {
      return `未找到待处理权限请求：${command.handle}`
    }
    await input.client?.permission?.reply?.(withOptionalDirectory({
      requestID: openPermission.requestID,
      reply: command.reply,
      ...(command.message ? { message: command.message } : {}),
    }, input.directory))
    if (command.reply === "reject") {
      await markRequestRejected({
        kind: "permission",
        routeKey: openPermission.routeKey,
        rejectedAt: Date.now(),
      })
    } else {
      await markRequestAnswered({
        kind: "permission",
        routeKey: openPermission.routeKey,
        answeredAt: Date.now(),
      })
    }
    await resolveNotificationForOpenRequest(openPermission)
    return `已处理权限请求：${openPermission.handle} (${command.reply})`
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
        drainOutboundMessages: async (drainInput) => {
          await statusRuntimeDeps.drainOutboundMessages({
            sendMessage: async (message) => {
              await drainInput.sendMessage(message)
            },
          })
        },
      }))
  const createNotificationDispatcher = deps.createNotificationDispatcher ?? createWechatNotificationDispatcher

  let runtime: WechatStatusRuntime | null = null
  let dispatcher:
    | {
        drainOutboundMessages: () => Promise<void>
      }
    | null = null

  return {
    start: async () => {
      if (runtime) {
        return
      }
      let runtimeSendMessage:
        | ((input: WechatNotificationSendInput) => Promise<void>)
        | null = null
      dispatcher = createNotificationDispatcher({
        sendMessage: async (message) => {
          if (!runtimeSendMessage) {
            throw new Error("wechat runtime send helper unavailable")
          }
          await runtimeSendMessage(message)
        },
      })
      const created = createStatusRuntime({
        onSlashCommand: async ({ command }) => handleWechatSlashCommand(command),
        onDiagnosticEvent,
        drainOutboundMessages: async (runtimeDrainInput) => {
          if (runtimeDrainInput?.sendMessage) {
            runtimeSendMessage = runtimeDrainInput.sendMessage
          }
          if (!dispatcher) {
            return
          }
          await dispatcher.drainOutboundMessages()
        },
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
      dispatcher = null
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
  process.env.WECHAT_STATE_ROOT_OVERRIDE = stateRoot
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
  const idleTimeoutMs = toPositiveNumber(process.env.WECHAT_BROKER_IDLE_TIMEOUT_MS, DEFAULT_BROKER_IDLE_TIMEOUT_MS)
  const idleScanIntervalMs = toPositiveNumber(process.env.WECHAT_BROKER_IDLE_SCAN_INTERVAL_MS, DEFAULT_BROKER_IDLE_SCAN_INTERVAL_MS)

  let shuttingDown = false
  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true

    clearInterval(idleTimer)
    removeOwnedBrokerStateFileSync(ownership, stateRoot)
    await wechatRuntimeLifecycle.close()
    await server.close()
    process.exit(exitCode)
  }

  let idleSince: number | undefined
  const idleTimer = setInterval(() => {
    void server.hasBlockingActivity().then((hasBlockingActivity) => {
      if (hasBlockingActivity) {
        idleSince = undefined
        return
      }

      const now = Date.now()
      if (idleSince === undefined) {
        idleSince = now
        return
      }

      if (now - idleSince >= idleTimeoutMs) {
        void shutdown(0)
      }
    }).catch(() => {})
  }, idleScanIntervalMs)

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
