import { readFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  loadOpenClawWeixinPublicHelpers,
  type OpenClawWeixinPublicHelpers,
  type OpenClawWeixinPublicHelpersLoaderOptions,
  type PublicWeixinMessage,
  type PublicWeixinSendMessage,
} from "./openclaw-public-helpers.js"
import { createOpenClawSmokeHarness, runOpenClawSmoke, sanitizeOpenClawEvidenceSample } from "./openclaw-smoke.js"
import type { SlashOnlyCommand } from "./slash-guard.js"

type GuidedSmokeStatus = "running" | "blocked" | "completed"
type GuidedSmokeConclusion = "known-unknown" | "no-go" | "go"

type GuidedSmokeTerminalStateInput = {
  stage: string
  reason: string
  nonSlash: { passed: number; total: number; failedChecks: string[] }
  keyFields: GuidedSmokeKeyFieldsCheck
}

type GuidedSmokeSelfTestResult = {
  ok: boolean
  reason?: string
}

type GuidedSmokeDependencyVersions = {
  "@tencent-weixin/openclaw-weixin": string
  openclaw: string
}

type GuidedSmokeCheckStatus = "pass" | "fail" | "known-unknown"

type GuidedSmokeNonSlashAttempt = {
  input?: string
  inbound?: Record<string, unknown> | null
  warningReply?: { ok?: boolean; text?: string; messageId?: string; error?: string } | null
  persisted?: boolean
}

type PublicWeixinMessageItem = {
  type?: number
  text_item?: {
    text?: string
  }
}

type SlashCaptureState = {
  getUpdatesBuf?: string
  pendingMessages?: PublicWeixinMessage[]
}

type GuidedPublicHelpers = Pick<OpenClawWeixinPublicHelpers, "entry" | "qrGateway" | "latestAccountState" | "getUpdates" | "sendMessageWeixin">

type GuidedPublicHelpersLoader = (options?: OpenClawWeixinPublicHelpersLoaderOptions) => Promise<GuidedPublicHelpers>

type GuidedSmokeKeyFieldsCheck = {
  login: { status: GuidedSmokeCheckStatus; detail?: string }
  getupdates: { status: GuidedSmokeCheckStatus; detail?: string }
  slashInbound: { status: GuidedSmokeCheckStatus; detail?: string }
  warningReply: { status: GuidedSmokeCheckStatus; detail?: string }
}

export const GUIDED_SMOKE_EVIDENCE_FILES = {
  preflight: "001-preflight.md",
  qrStart: "002-qr-start.md",
  loginSuccess: "003-login-success.md",
  statusCommand: "004-status-command.json",
  replyCommand: "005-reply-command.json",
  allowCommand: "006-allow-command.json",
} as const

const DEFAULT_QR_WAIT_TIMEOUT_MS = 480_000

const SLASH_SAMPLE_STEPS: readonly {
  command: SlashOnlyCommand
  input: string
  evidenceFile: string
}[] = [
  {
    command: "status",
    input: "/status",
    evidenceFile: GUIDED_SMOKE_EVIDENCE_FILES.statusCommand,
  },
  {
    command: "reply",
    input: "/reply smoke",
    evidenceFile: GUIDED_SMOKE_EVIDENCE_FILES.replyCommand,
  },
  {
    command: "allow",
    input: "/allow once",
    evidenceFile: GUIDED_SMOKE_EVIDENCE_FILES.allowCommand,
  },
]

export type GuidedSmokeRun = {
  runId: string
  cwd: string
  evidenceBaseDir: string
  evidenceDir: string
  status: GuidedSmokeStatus
  conclusion: GuidedSmokeConclusion
}

export type GuidedSmokeResult = {
  runId: string
  status: GuidedSmokeStatus
  conclusion: GuidedSmokeConclusion
  evidenceDir: string
  reason?: string
}

export type RunGuidedSmokeOptions = {
  runId?: string
  cwd?: string
  evidenceBaseDir?: string
  qrWaitTimeoutMs?: number
  apiSamplesDocPath?: string
  goNoGoDocPath?: string
  loadPublicEntry?: () => Promise<{ entryRelativePath: string }>
  runSelfTest?: () => Promise<GuidedSmokeSelfTestResult>
  runQrLogin?: (input: { waitTimeoutMs: number }) => Promise<{ status: "success" | "timeout"; connected?: boolean; qrPrinted?: boolean; qrUrl?: string; qrDataUrl?: string } | void>
  captureSlashInbound?: (command: SlashOnlyCommand) => Promise<Record<string, unknown> | null>
  runNonSlashVerification?: () => Promise<{
    passed: number
    total: number
    failedChecks?: string[]
    attempts?: GuidedSmokeNonSlashAttempt[]
    keyFieldsCheck?: Partial<GuidedSmokeKeyFieldsCheck>
  } | void>
  getDependencyVersions?: () => GuidedSmokeDependencyVersions
  loadOpenClawWeixinPublicHelpers?: GuidedPublicHelpersLoader
  publicHelpersOptions?: OpenClawWeixinPublicHelpersLoaderOptions
  slashCaptureWaitTimeoutMs?: number
  slashCapturePollIntervalMs?: number
  writeLine?: (line: string) => Promise<void> | void
}

type PreflightData = {
  runId: string
  cwd: string
  nodeVersion: string
  dependencyVersions: GuidedSmokeDependencyVersions
  dependencyVersionResolution: { status: "pass" | "fail"; detail: string }
  publicEntryLoad: { status: "pass" | "fail"; detail: string }
  evidenceDirectoryCreation: { status: "pass" | "fail"; detail: string }
  selfTest: { status: "pass" | "fail"; detail: string }
}

const DEFAULT_EVIDENCE_BASE_DIR = fileURLToPath(new URL("../../../docs/superpowers/wechat-stage-a/evidence", import.meta.url))
const DEFAULT_API_SAMPLES_DOC_PATH = fileURLToPath(new URL("../../../docs/superpowers/wechat-stage-a/api-samples-sanitized.md", import.meta.url))
const DEFAULT_GO_NO_GO_DOC_PATH = fileURLToPath(new URL("../../../docs/superpowers/wechat-stage-a/go-no-go.md", import.meta.url))
const FIXED_NON_SLASH_WARNING_TEXT = "请使用 slash 命令（/status、/reply、/allow）"

const DEFAULT_KEY_FIELDS_CHECK: GuidedSmokeKeyFieldsCheck = {
  login: { status: "known-unknown" },
  getupdates: { status: "known-unknown" },
  slashInbound: { status: "known-unknown" },
  warningReply: { status: "known-unknown" },
}

const DEFAULT_SLASH_CAPTURE_WAIT_TIMEOUT_MS = 180_000
const DEFAULT_SLASH_CAPTURE_POLL_INTERVAL_MS = 2_000
const DEFAULT_PUBLIC_GET_UPDATES_LONG_POLL_TIMEOUT_MS = 35_000

async function writeLineDefault(line: string): Promise<void> {
  process.stdout.write(`${line}\n`)
}

async function printGuidedPrompt(message: string, writeLine: (line: string) => Promise<void> | void): Promise<void> {
  await writeLine(message)
}

function createRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function resolveDependencyVersionsFromPackageJson(): GuidedSmokeDependencyVersions {
  const packageJsonPath = fileURLToPath(new URL("../../../package.json", import.meta.url))
  const packageJsonRaw = readFileSync(packageJsonPath, "utf8")
  const packageJson = JSON.parse(packageJsonRaw) as {
    dependencies?: Record<string, string>
  }
  return {
    "@tencent-weixin/openclaw-weixin": packageJson.dependencies?.["@tencent-weixin/openclaw-weixin"] ?? "unknown",
    openclaw: packageJson.dependencies?.openclaw ?? "unknown",
  }
}

async function runGuidedSelfTestDefault(): Promise<GuidedSmokeSelfTestResult> {
  try {
    const results = await runOpenClawSmoke("self-test")
    const loaded = results.some((item) => item.route === "public-self-test" && item.status === "loaded")
    if (!loaded) {
      return { ok: false, reason: "self-test missing public-self-test loaded result" }
    }
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

export function createGuidedSmokeRun(options: Pick<RunGuidedSmokeOptions, "runId" | "cwd" | "evidenceBaseDir"> = {}): GuidedSmokeRun {
  const runId = options.runId ?? createRunId()
  const cwd = options.cwd ?? process.cwd()
  const evidenceBaseDir = options.evidenceBaseDir ?? DEFAULT_EVIDENCE_BASE_DIR
  const evidenceDir = path.join(evidenceBaseDir, runId)

  return {
    runId,
    cwd,
    evidenceBaseDir,
    evidenceDir,
    status: "running",
    conclusion: "known-unknown",
  }
}

export function failGuidedSmoke(run: GuidedSmokeRun, reason?: string): GuidedSmokeResult {
  run.status = "blocked"
  run.conclusion = "known-unknown"
  return {
    runId: run.runId,
    status: run.status,
    conclusion: run.conclusion,
    evidenceDir: run.evidenceDir,
    reason,
  }
}

export function getGuidedSmokeExitCode(result: Pick<GuidedSmokeResult, "status">): number {
  return result.status === "blocked" ? 1 : 0
}

export async function writePreflightEvidence(run: GuidedSmokeRun, data: PreflightData): Promise<void> {
  const lines = [
    "# Guided Smoke Preflight",
    "",
    `- run id: \`${data.runId}\``,
    `- cwd: \`${data.cwd}\``,
    `- node version: \`${data.nodeVersion}\``,
    `- @tencent-weixin/openclaw-weixin: \`${data.dependencyVersions["@tencent-weixin/openclaw-weixin"]}\``,
    `- openclaw: \`${data.dependencyVersions.openclaw}\``,
    `- dependency versions: \`${data.dependencyVersionResolution.status}\` (${data.dependencyVersionResolution.detail})`,
    `- public entry load: \`${data.publicEntryLoad.status}\` (${data.publicEntryLoad.detail})`,
    `- evidence directory creation: \`${data.evidenceDirectoryCreation.status}\` (${data.evidenceDirectoryCreation.detail})`,
    `- self-test: \`${data.selfTest.status}\` (${data.selfTest.detail})`,
    "",
  ]

  const filePath = path.join(run.evidenceDir, GUIDED_SMOKE_EVIDENCE_FILES.preflight)
  await writeFile(filePath, lines.join("\n"), "utf8")
}

async function writeQrStartEvidence(run: GuidedSmokeRun, status: "pass" | "fail", detail: string, waitTimeoutMs: number): Promise<void> {
  const filePath = path.join(run.evidenceDir, GUIDED_SMOKE_EVIDENCE_FILES.qrStart)
  const lines = [
    "# Guided Smoke QR Start",
    "",
    `- status: \`${status}\``,
    `- wait timeout ms: \`${waitTimeoutMs}\``,
    `- detail: ${detail}`,
    "",
  ]
  await writeFile(filePath, lines.join("\n"), "utf8")
}

async function writeLoginSuccessEvidence(run: GuidedSmokeRun, status: "success" | "timeout", waitTimeoutMs: number): Promise<void> {
  const filePath = path.join(run.evidenceDir, GUIDED_SMOKE_EVIDENCE_FILES.loginSuccess)
  const lines = [
    "# Guided Smoke Login Wait",
    "",
    `- status: \`${status}\``,
    `- wait timeout ms: \`${waitTimeoutMs}\``,
    "",
  ]
  await writeFile(filePath, lines.join("\n"), "utf8")
}

async function writeFinalStatusEvidence(
  run: GuidedSmokeRun,
  input: { stage: string; status: "blocked" | "completed"; conclusion: GuidedSmokeConclusion; detail: string },
): Promise<void> {
  const filePath = path.join(run.evidenceDir, "999-final-status.md")
  const lines = [
    "# Guided Smoke Final Status",
    "",
    `- stage: \`${input.stage}\``,
    `- status: \`${input.status}\``,
    `- conclusion: \`${input.conclusion}\``,
    `- detail: ${input.detail}`,
    "",
  ]
  await writeFile(filePath, lines.join("\n"), "utf8")
}

function buildNonSlashEvidenceFileName(index: number): string {
  const sequence = String(index + 1).padStart(2, "0")
  const order = String(7 + index).padStart(3, "0")
  return `${order}-nonslash-warning-${sequence}.json`
}

function detectSensitiveResidue(input: string): string | null {
  const patterns = [
    /"contextToken"\s*:\s*"(?!\[REDACTED_)[^"]+"/i,
    /"context_token"\s*:\s*"(?!\[REDACTED_)[^"]+"/i,
    /"bot_token"\s*:\s*"(?!\[REDACTED_)[^"]+"/i,
    /"authorization"\s*:\s*"(?!Bearer \[REDACTED_AUTHORIZATION\])[^"]+"/i,
    /"userId"\s*:\s*"(?!\[REDACTED_)[^"]+"/i,
    /"botId"\s*:\s*"(?!\[REDACTED_)[^"]+"/i,
    /"qrCode"\s*:\s*"(?!\[REDACTED_)[^"]+"/i,
    /"deviceId"\s*:\s*"(?!\[REDACTED_)[^"]+"/i,
    /"messageId"\s*:\s*"(?!\[REDACTED_)[^"]+"/i,
    /"requestId"\s*:\s*"(?!\[REDACTED_)[^"]+"/i,
  ]
  for (const pattern of patterns) {
    const match = input.match(pattern)
    if (match) {
      return match[0]
    }
  }
  return null
}

async function maybeUpdateGoNoGoDoc(
  run: GuidedSmokeRun,
  goNoGoDocPath: string | undefined,
  input: {
    nonSlash: { passed: number; total: number; failedChecks: string[] }
    keyFields: GuidedSmokeKeyFieldsCheck
  },
): Promise<void> {
  if (!goNoGoDocPath) {
    return
  }

  await updateGoNoGoDoc(run, goNoGoDocPath, input)
}

async function writeNonSlashAttemptEvidence(
  run: GuidedSmokeRun,
  input: { index: number; attempt: GuidedSmokeNonSlashAttempt },
): Promise<{ fileName: string; sensitiveResidue: string | null }> {
  const fileName = buildNonSlashEvidenceFileName(input.index)
  const payload = {
    evidenceFile: fileName,
    evidenceId: `nonslash-warning-${String(input.index + 1).padStart(2, "0")}`,
    timestamp: new Date().toISOString(),
    input: input.attempt.input ?? null,
    routeResult: "guard-reject-warning",
    inbound: input.attempt.inbound ?? null,
    warningReply: input.attempt.warningReply ?? null,
    persisted: input.attempt.persisted === true,
  }
  const raw = JSON.stringify(payload, null, 2)
  const sanitized = sanitizeOpenClawEvidenceSample(raw)
  const filePath = path.join(run.evidenceDir, fileName)
  await writeFile(filePath, sanitized, "utf8")
  const written = await readFile(filePath, "utf8")
  return {
    fileName,
    sensitiveResidue: detectSensitiveResidue(written),
  }
}

function validateNonSlashAttempt(attempt: GuidedSmokeNonSlashAttempt): string | null {
  const hasInbound = Boolean(attempt.inbound && typeof attempt.inbound === "object")
  if (!hasInbound) {
    return "missing real inbound capture for non-slash attempt"
  }
  const warningOk = attempt.warningReply?.ok === true
  const warningTextMatched = attempt.warningReply?.text === FIXED_NON_SLASH_WARNING_TEXT
  if (!warningOk || !warningTextMatched) {
    return "fixed warning reply validation failed"
  }
  if (attempt.persisted !== true) {
    return "non-slash attempt is not persisted"
  }
  return null
}

async function writeKeyFieldsCheckEvidence(
  run: GuidedSmokeRun,
  input: GuidedSmokeKeyFieldsCheck,
): Promise<void> {
  const filePath = path.join(run.evidenceDir, "090-key-fields-check.md")
  const lines = [
    "# Guided Smoke Key Fields Check",
    "",
    `- login fields: \`${input.login.status}\`${input.login.detail ? ` (${input.login.detail})` : ""}`,
    `- getupdates fields: \`${input.getupdates.status}\`${input.getupdates.detail ? ` (${input.getupdates.detail})` : ""}`,
    `- slash inbound fields: \`${input.slashInbound.status}\`${input.slashInbound.detail ? ` (${input.slashInbound.detail})` : ""}`,
    `- warning reply fields: \`${input.warningReply.status}\`${input.warningReply.detail ? ` (${input.warningReply.detail})` : ""}`,
    "",
  ]
  await writeFile(filePath, lines.join("\n"), "utf8")
}

async function updateGoNoGoDoc(
  run: GuidedSmokeRun,
  filePath: string,
  input: {
    nonSlash: { passed: number; total: number; failedChecks: string[] }
    keyFields: GuidedSmokeKeyFieldsCheck
  },
): Promise<void> {
  const previous = await readFile(filePath, "utf8")
  const normalizedPrevious = previous.trimEnd()
  const failedChecks = input.nonSlash.failedChecks.length > 0 ? input.nonSlash.failedChecks.join(",") : "none"
  const section = [
    `## Guided Smoke Run (${run.runId})`,
    `- 运行状态：\`${run.status}\``,
    `- 最终结论：\`${run.conclusion}\``,
    `- 证据目录：\`${run.evidenceDir}\``,
    `- 非 slash 计数：\`${input.nonSlash.passed}/${input.nonSlash.total}\``,
    `- 非 slash 失败项：\`${failedChecks}\``,
    "- 关键字段检查：",
    `  - login: \`${input.keyFields.login.status}\``,
    `  - getupdates: \`${input.keyFields.getupdates.status}\``,
    `  - slash inbound: \`${input.keyFields.slashInbound.status}\``,
    `  - warning reply: \`${input.keyFields.warningReply.status}\``,
    "- 关键字段证据：`090-key-fields-check.md`",
    "",
  ].join("\n")
  await writeFile(filePath, `${normalizedPrevious}\n\n${section}`, "utf8")
}

function pickFirstString(source: unknown, keys: readonly string[]): string | undefined {
  if (!source || typeof source !== "object") {
    return undefined
  }
  const record = source as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim().length > 0) {
      return value
    }
  }
  return undefined
}

function extractTextFromPublicWeixinMessage(message: PublicWeixinMessage): string {
  for (const item of message.item_list ?? []) {
    if (item?.type === 1 && typeof item.text_item?.text === "string" && item.text_item.text.trim().length > 0) {
      return item.text_item.text
    }
  }
  return ""
}

function normalizeSlashInboundSample(input: {
  command: SlashOnlyCommand
  input: string
  message: PublicWeixinMessage
}): Record<string, unknown> {
  return {
    command: input.command,
    input: input.input,
    messageId: input.message.message_id ?? null,
    fromUserId: input.message.from_user_id ?? null,
    contextToken: input.message.context_token ?? null,
    createdAtMs: input.message.create_time_ms ?? null,
    text: extractTextFromPublicWeixinMessage(input.message),
    itemTypes: (input.message.item_list ?? []).map((item) => item?.type).filter((item): item is number => typeof item === "number"),
    normalizedBy: "guided-smoke-public-structure",
  }
}

export const normalizeSlashInboundSampleForTest = normalizeSlashInboundSample

function normalizeNonSlashInboundSample(message: PublicWeixinMessage): Record<string, unknown> {
  return {
    messageId: message.message_id ?? null,
    fromUserId: message.from_user_id ?? null,
    contextToken: message.context_token ?? null,
    createdAtMs: message.create_time_ms ?? null,
    text: extractTextFromPublicWeixinMessage(message),
    itemTypes: (message.item_list ?? []).map((item) => item?.type).filter((item): item is number => typeof item === "number"),
    normalizedBy: "guided-smoke-public-structure",
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function matchesSlashStep(message: PublicWeixinMessage, input: string): boolean {
  const text = extractTextFromPublicWeixinMessage(message).trim()
  return text === input.trim()
}

function matchesNonSlashStep(message: PublicWeixinMessage, expectedText?: string): boolean {
  const text = extractTextFromPublicWeixinMessage(message).trim()
  if (text.length === 0 || text.startsWith("/")) {
    return false
  }
  if (expectedText) {
    return text === expectedText.trim()
  }
  return true
}

async function captureSlashInboundFromPublicMessages(input: {
  command: SlashOnlyCommand
  input: string
  waitTimeoutMs?: number
  pollIntervalMs?: number
  getMessages: () => Promise<PublicWeixinMessage[]>
  stashMessages?: (messages: PublicWeixinMessage[]) => void
}): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + (input.waitTimeoutMs ?? DEFAULT_SLASH_CAPTURE_WAIT_TIMEOUT_MS)
  const seen = new Set<string>()

  while (Date.now() <= deadline) {
    const messages = await input.getMessages()
    for (const message of messages) {
      const key = `${message.message_id ?? "unknown"}:${message.create_time_ms ?? "unknown"}`
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      if (matchesSlashStep(message, input.input)) {
        const remaining = messages.filter((candidate) => {
          const candidateKey = `${candidate.message_id ?? "unknown"}:${candidate.create_time_ms ?? "unknown"}`
          return candidateKey !== key && !seen.has(candidateKey)
        })
        if (remaining.length > 0) {
          input.stashMessages?.(remaining)
        }
        return normalizeSlashInboundSample({
          command: input.command,
          input: input.input,
          message,
        })
      }
    }
    await sleep(input.pollIntervalMs ?? DEFAULT_SLASH_CAPTURE_POLL_INTERVAL_MS)
  }

  return null
}

export const captureSlashInboundFromPublicMessagesForTest = captureSlashInboundFromPublicMessages

async function captureNonSlashInboundFromPublicMessages(input: {
  expectedText?: string
  waitTimeoutMs?: number
  pollIntervalMs?: number
  getMessages: () => Promise<PublicWeixinMessage[]>
  stashMessages?: (messages: PublicWeixinMessage[]) => void
}): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + (input.waitTimeoutMs ?? DEFAULT_SLASH_CAPTURE_WAIT_TIMEOUT_MS)
  const seen = new Set<string>()

  while (Date.now() <= deadline) {
    const messages = await input.getMessages()
    for (const message of messages) {
      const key = `${message.message_id ?? "unknown"}:${message.create_time_ms ?? "unknown"}`
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      if (matchesNonSlashStep(message, input.expectedText)) {
        const remaining = messages.filter((candidate) => {
          const candidateKey = `${candidate.message_id ?? "unknown"}:${candidate.create_time_ms ?? "unknown"}`
          return candidateKey !== key && !seen.has(candidateKey)
        })
        if (remaining.length > 0) {
          input.stashMessages?.(remaining)
        }
        return normalizeNonSlashInboundSample(message)
      }
    }
    await sleep(input.pollIntervalMs ?? DEFAULT_SLASH_CAPTURE_POLL_INTERVAL_MS)
  }

  return null
}

async function runQrLoginDefault(input: {
  waitTimeoutMs: number
  writeLine: (line: string) => Promise<void> | void
}): Promise<{ status: "success" | "timeout"; connected?: boolean; qrPrinted?: boolean; qrUrl?: string; qrDataUrl?: string }> {
  const qrGateway = (input as { qrGateway?: OpenClawWeixinPublicHelpers["qrGateway"] }).qrGateway
  if (!qrGateway) {
    throw new Error("missing qrGateway helper")
  }

  const startResult = await Promise.resolve(qrGateway.loginWithQrStart({
    accountId: undefined,
    force: false,
    timeoutMs: input.waitTimeoutMs,
    verbose: false,
  }))
  const qrTerminal = pickFirstString(startResult, ["qrTerminal"])
  const qrUrl = pickFirstString(startResult, ["qrDataUrl"])
  const sessionKey = pickFirstString(startResult, ["sessionKey"])
  const qrStartMessage = pickFirstString(startResult, ["message", "detail", "reason"])
  if (!sessionKey) {
    throw new Error("missing sessionKey from qr start")
  }
  if (qrTerminal) {
    await input.writeLine(qrTerminal)
  } else if (qrUrl) {
    await input.writeLine(`QR URL fallback: ${qrUrl}`)
  } else {
    throw new Error(qrStartMessage || "invalid qr login result: missing qr code or qr url")
  }

  const waitResult = await Promise.resolve(qrGateway.loginWithQrWait({ timeoutMs: input.waitTimeoutMs, sessionKey }))
  if (waitResult && typeof waitResult === "object" && "status" in waitResult && String((waitResult as { status?: unknown }).status) === "timeout") {
    return { status: "timeout", qrPrinted: Boolean(qrTerminal), qrUrl }
  }
  return {
    status: "success",
    connected: waitResult && typeof waitResult === "object" && "connected" in waitResult ? (waitResult as { connected?: unknown }).connected === true : undefined,
    qrPrinted: Boolean(qrTerminal),
    qrUrl,
  }
}

async function writeSlashCommandEvidence(
  run: GuidedSmokeRun,
  input: {
    command: SlashOnlyCommand
    text: string
    evidenceFile: string
    inbound: Record<string, unknown> | null
    routeResult: string
    completed: boolean
  },
): Promise<void> {
  const filePath = path.join(run.evidenceDir, input.evidenceFile)
  const payload = {
    evidenceFile: input.evidenceFile,
    timestamp: new Date().toISOString(),
    input: input.text,
    command: input.command,
      inbound: input.inbound,
      routeResult: input.routeResult,
      completed: input.completed,
      outbound: {
        mode: "none",
        detail: "guided smoke slash sampling has no real outbound",
      },
    }
  const raw = JSON.stringify(payload, null, 2)
  const sanitized = sanitizeOpenClawEvidenceSample(raw)
  await writeFile(filePath, sanitized, "utf8")
}

async function captureSlashInboundDefault(
  command: SlashOnlyCommand,
  deps: {
    state?: SlashCaptureState
    loadOpenClawWeixinPublicHelpers?: GuidedPublicHelpersLoader
    publicHelpersOptions?: OpenClawWeixinPublicHelpersLoaderOptions
    waitTimeoutMs?: number
    pollIntervalMs?: number
  } = {},
): Promise<Record<string, unknown>> {
  let lastObservation: { msgCount: number; getUpdatesBuf?: string; texts: string[] } | null = null
  const loader = deps.loadOpenClawWeixinPublicHelpers ?? loadOpenClawWeixinPublicHelpers
  const helpers = await loader(deps.publicHelpersOptions)
  const accountState = helpers.latestAccountState
  if (!accountState) {
    return {
      command,
      synthetic: true,
      reason: "missing logged-in weixin account state",
    }
  }

  const publicHelpers = { getUpdates: helpers.getUpdates }

  const state = deps.state ?? {}
  let getUpdatesBuf = typeof state.getUpdatesBuf === "string"
    ? state.getUpdatesBuf
    : (typeof accountState.getUpdatesBuf === "string" ? accountState.getUpdatesBuf : "")
  const inbound = await captureSlashInboundFromPublicMessages({
    command,
    input: `/${command === "reply" ? "reply smoke" : command === "allow" ? "allow once" : "status"}`,
    waitTimeoutMs: deps.waitTimeoutMs,
    pollIntervalMs: deps.pollIntervalMs,
    getMessages: async () => {
      if (Array.isArray(state.pendingMessages) && state.pendingMessages.length > 0) {
        const queued = state.pendingMessages
        state.pendingMessages = []
        return queued
      }
      const response = await publicHelpers.getUpdates({
        baseUrl: accountState.baseUrl,
        token: accountState.token,
        get_updates_buf: getUpdatesBuf,
        timeoutMs: DEFAULT_PUBLIC_GET_UPDATES_LONG_POLL_TIMEOUT_MS,
      })
      if (typeof response.get_updates_buf === "string") {
        getUpdatesBuf = response.get_updates_buf
        state.getUpdatesBuf = response.get_updates_buf
      }
      const messages = Array.isArray(response.msgs) ? response.msgs : []
      lastObservation = {
        msgCount: messages.length,
        getUpdatesBuf: typeof response.get_updates_buf === "string" ? response.get_updates_buf : getUpdatesBuf,
        texts: messages.map((message: PublicWeixinMessage) => extractTextFromPublicWeixinMessage(message)).filter((text: string) => text.length > 0),
      }
      return messages
    },
    stashMessages: (messages) => {
      state.pendingMessages = messages
    },
  })

  return inbound ?? {
    command,
    synthetic: true,
    reason: `timed out waiting for real ${command} inbound`,
    getUpdatesObservation: lastObservation,
  }
}

export const captureSlashInboundDefaultForTest = captureSlashInboundDefault

async function runDefaultNonSlashVerification(input: {
  state?: SlashCaptureState
  loadOpenClawWeixinPublicHelpers?: GuidedPublicHelpersLoader
  publicHelpersOptions?: OpenClawWeixinPublicHelpersLoaderOptions
  inputs?: string[]
  waitTimeoutMs?: number
  pollIntervalMs?: number
}): Promise<{
  passed: number
  total: number
  failedChecks: string[]
  attempts: GuidedSmokeNonSlashAttempt[]
  keyFieldsCheck: GuidedSmokeKeyFieldsCheck
}> {
  const total = input.inputs?.length ?? 10
  const attempts: GuidedSmokeNonSlashAttempt[] = []
  const failedChecks: string[] = []
  const keyFieldsCheck: GuidedSmokeKeyFieldsCheck = {
    login: { status: "pass" },
    getupdates: { status: "known-unknown" },
    slashInbound: { status: "pass" },
    warningReply: { status: "known-unknown" },
  }

  const loader = input.loadOpenClawWeixinPublicHelpers ?? loadOpenClawWeixinPublicHelpers
  let helpers: GuidedPublicHelpers
  try {
    helpers = await loader(input.publicHelpersOptions)
  } catch (error) {
    return {
      passed: 0,
      total,
      failedChecks: [error instanceof Error ? error.message : String(error)],
      attempts,
      keyFieldsCheck,
    }
  }

  const accountState = helpers.latestAccountState
  if (!accountState) {
    return {
      passed: 0,
      total,
      failedChecks: ["missing logged-in weixin account state"],
      attempts,
      keyFieldsCheck,
    }
  }

  const publicHelpers = { getUpdates: helpers.getUpdates }
  const sendHelper = { sendMessageWeixin: helpers.sendMessageWeixin }

  const state = input.state ?? {}
  let getUpdatesBuf = typeof state.getUpdatesBuf === "string"
    ? state.getUpdatesBuf
    : (typeof accountState.getUpdatesBuf === "string" ? accountState.getUpdatesBuf : "")
  const harness = createOpenClawSmokeHarness({ mode: "real-account" })

  for (let index = 0; index < total; index += 1) {
    const expectedText = input.inputs?.[index]
    const inbound = await captureNonSlashInboundFromPublicMessages({
      expectedText,
      waitTimeoutMs: input.waitTimeoutMs,
      pollIntervalMs: input.pollIntervalMs,
      getMessages: async () => {
        if (Array.isArray(state.pendingMessages) && state.pendingMessages.length > 0) {
          const queued = state.pendingMessages
          state.pendingMessages = []
          return queued
        }
        const response = await publicHelpers.getUpdates({
          baseUrl: accountState.baseUrl,
          token: accountState.token,
          get_updates_buf: getUpdatesBuf,
          timeoutMs: DEFAULT_PUBLIC_GET_UPDATES_LONG_POLL_TIMEOUT_MS,
        })
        if (typeof response.get_updates_buf === "string") {
          getUpdatesBuf = response.get_updates_buf
          state.getUpdatesBuf = response.get_updates_buf
        }
        return Array.isArray(response.msgs) ? response.msgs : []
      },
      stashMessages: (messages) => {
        state.pendingMessages = messages
      },
    })

    if (!inbound) {
      keyFieldsCheck.getupdates = { status: "known-unknown", detail: "missing real inbound capture for non-slash attempt" }
      keyFieldsCheck.warningReply = { status: "known-unknown" }
      failedChecks.push("missing real inbound capture for non-slash attempt")
      attempts.push({
        input: expectedText ?? undefined,
        inbound: null,
        warningReply: { ok: false, text: "" },
        persisted: false,
      })
      break
    }

    keyFieldsCheck.getupdates = { status: "pass" }
    const route = await harness.handleIncomingText(String(inbound.text ?? ""))
    const warningText = route.route === "guard-reject" ? FIXED_NON_SLASH_WARNING_TEXT : ""
    let warningReply: GuidedSmokeNonSlashAttempt["warningReply"]
    try {
      const response = await sendHelper.sendMessageWeixin({
        to: String(inbound.fromUserId ?? ""),
        text: warningText,
        opts: {
          baseUrl: accountState.baseUrl,
          token: accountState.token,
          contextToken: typeof inbound.contextToken === "string" ? inbound.contextToken : undefined,
        },
      })
      warningReply = {
        ok: route.route === "guard-reject" && warningText === FIXED_NON_SLASH_WARNING_TEXT,
        text: warningText,
        messageId: response.messageId,
      }
    } catch (error) {
      warningReply = {
        ok: false,
        text: warningText,
        error: error instanceof Error ? error.message : String(error),
      }
    }

    attempts.push({
      input: String(inbound.text ?? expectedText ?? ""),
      inbound,
      warningReply,
      persisted: warningReply?.ok === true,
    })

    const validationError = validateNonSlashAttempt(attempts.at(-1) ?? null as never)
    if (validationError) {
      keyFieldsCheck.warningReply = { status: "known-unknown", detail: validationError }
      failedChecks.push(validationError)
      break
    }
  }

  const passed = attempts.filter((attempt) => validateNonSlashAttempt(attempt) === null).length
  if (passed === total && failedChecks.length === 0) {
    keyFieldsCheck.warningReply = { status: "pass" }
  }

  return {
    passed,
    total,
    failedChecks,
    attempts,
    keyFieldsCheck,
  }
}

export const runDefaultNonSlashVerificationForTest = runDefaultNonSlashVerification

async function runSlashSampling(
  run: GuidedSmokeRun,
  captureSlashInbound: (command: SlashOnlyCommand) => Promise<Record<string, unknown> | null>,
  writeLine: (line: string) => Promise<void> | void,
): Promise<{ ok: boolean; reason?: string }> {
  const harness = createOpenClawSmokeHarness({ mode: "real-account" })

  for (const step of SLASH_SAMPLE_STEPS) {
    const inbound = await captureSlashInbound(step.command)
    const route = await harness.handleIncomingText(step.input)
    const routeResult = route.route
    const hasRealInbound = Boolean(inbound) && (inbound?.synthetic !== true)
    const completed = hasRealInbound && routeResult === "stub"

    await writeSlashCommandEvidence(run, {
      command: step.command,
      text: step.input,
      evidenceFile: step.evidenceFile,
      inbound,
      routeResult,
      completed,
    })

    if (!completed) {
      return {
        ok: false,
        reason: `slash sampling incomplete: ${step.input}`,
      }
    }

    if (step.command === "status") {
      await printGuidedPrompt("已收到 `/status`，下一步请发送 `/reply smoke`", writeLine)
    } else if (step.command === "reply") {
      await printGuidedPrompt("已收到 `/reply smoke`，下一步请发送 `/allow once`", writeLine)
    } else {
      await printGuidedPrompt("已收到 `/allow once`，下一步开始发送 10 条普通文本", writeLine)
    }
  }

  return { ok: true }
}

async function updateApiSamplesSanitizedDoc(run: GuidedSmokeRun, filePath: string): Promise<void> {
  let previous = ""
  try {
    previous = await readFile(filePath, "utf8")
  } catch {
    previous = "# WeChat Stage A API 脱敏样本\n"
  }

  const normalizedPrevious = previous.trimEnd()
  const evidenceRelativePath = path.relative(path.dirname(filePath), run.evidenceDir).split(path.sep).join("/")
  const section = [
    `## slash 采样更新（${run.runId}）`,
    `- 证据目录：\`${evidenceRelativePath}\``,
    "- 命令样本：`/status`、`/reply smoke`、`/allow once`",
    `- 引用文件：\`${GUIDED_SMOKE_EVIDENCE_FILES.statusCommand}\`、\`${GUIDED_SMOKE_EVIDENCE_FILES.replyCommand}\`、\`${GUIDED_SMOKE_EVIDENCE_FILES.allowCommand}\``,
    "- outbound：`none`（无真实出站）",
    "",
  ].join("\n")

  const nextContent = `${normalizedPrevious}\n\n${section}`
  await writeFile(filePath, nextContent, "utf8")
}

function normalizeQrLoginResult(result: unknown): { status: "success" | "timeout"; connected?: boolean; qrPrinted?: boolean; qrUrl?: string } | null {
  if (!result || typeof result !== "object") {
    return null
  }

  const candidate = result as {
    status?: unknown
    connected?: unknown
    qrPrinted?: unknown
    qrDataUrl?: unknown
    qrUrl?: unknown
  }

  if (candidate.status !== "success" && candidate.status !== "timeout") {
    return null
  }

  if (candidate.status === "success") {
    if (candidate.connected !== true) {
      return null
    }
    const hasPrintedQr = candidate.qrPrinted === true
    const qrUrl = typeof candidate.qrDataUrl === "string" && candidate.qrDataUrl.trim().length > 0
      ? candidate.qrDataUrl
      : undefined
    const hasQrUrl = Boolean(qrUrl)
    if (!hasPrintedQr && !hasQrUrl) {
      return null
    }
  }

  const normalizedQrUrl = typeof candidate.qrDataUrl === "string" && candidate.qrDataUrl.trim().length > 0
    ? candidate.qrDataUrl
    : undefined

  return {
    status: candidate.status,
    connected: candidate.connected === true ? true : undefined,
    qrPrinted: candidate.qrPrinted === true,
    qrUrl: normalizedQrUrl,
  }
}

export const normalizeQrLoginResultForTest = normalizeQrLoginResult

function normalizeNonSlashVerificationResult(result: unknown): {
  passed: number
  total: number
  failedChecks: string[]
  attempts: GuidedSmokeNonSlashAttempt[]
  keyFieldsCheck: GuidedSmokeKeyFieldsCheck
} {
  if (!result || typeof result !== "object") {
    return {
      passed: 0,
      total: 10,
      failedChecks: ["non-slash verification not implemented"],
      attempts: [],
      keyFieldsCheck: DEFAULT_KEY_FIELDS_CHECK,
    }
  }

  const candidate = result as {
    passed?: unknown
    total?: unknown
    failedChecks?: unknown
    attempts?: unknown
    keyFieldsCheck?: unknown
  }
  const passed = Number(candidate.passed)
  const total = Number(candidate.total)
  const failedChecks = Array.isArray(candidate.failedChecks) ? candidate.failedChecks.filter((item): item is string => typeof item === "string") : []
  const attempts = Array.isArray(candidate.attempts)
    ? candidate.attempts.filter((item): item is GuidedSmokeNonSlashAttempt => Boolean(item) && typeof item === "object")
    : []

  const keyFieldsCandidate = candidate.keyFieldsCheck as Partial<GuidedSmokeKeyFieldsCheck> | undefined
  const keyFieldsCheck: GuidedSmokeKeyFieldsCheck = {
    login: keyFieldsCandidate?.login?.status ? { status: keyFieldsCandidate.login.status, detail: keyFieldsCandidate.login.detail } : DEFAULT_KEY_FIELDS_CHECK.login,
    getupdates: keyFieldsCandidate?.getupdates?.status
      ? { status: keyFieldsCandidate.getupdates.status, detail: keyFieldsCandidate.getupdates.detail }
      : DEFAULT_KEY_FIELDS_CHECK.getupdates,
    slashInbound: keyFieldsCandidate?.slashInbound?.status
      ? { status: keyFieldsCandidate.slashInbound.status, detail: keyFieldsCandidate.slashInbound.detail }
      : DEFAULT_KEY_FIELDS_CHECK.slashInbound,
    warningReply: keyFieldsCandidate?.warningReply?.status
      ? { status: keyFieldsCandidate.warningReply.status, detail: keyFieldsCandidate.warningReply.detail }
      : DEFAULT_KEY_FIELDS_CHECK.warningReply,
  }

  if (!Number.isFinite(passed) || !Number.isFinite(total)) {
    return {
      passed: 0,
      total: 10,
      failedChecks: ["non-slash verification not implemented"],
      attempts,
      keyFieldsCheck,
    }
  }

  return {
    passed,
    total,
    failedChecks,
    attempts,
    keyFieldsCheck,
  }
}

async function failWithFinalEvidence(
  run: GuidedSmokeRun,
  input: GuidedSmokeTerminalStateInput,
  goNoGoDocPath?: string,
): Promise<GuidedSmokeResult> {
  run.status = "blocked"
  run.conclusion = "known-unknown"

  if (goNoGoDocPath) {
    try {
      await maybeUpdateGoNoGoDoc(run, goNoGoDocPath, {
        nonSlash: input.nonSlash,
        keyFields: input.keyFields,
      })
    } catch {
      // fall through and always write final status evidence
    }
  }

  await writeFinalStatusEvidence(run, {
    stage: input.stage,
    status: "blocked",
    conclusion: "known-unknown",
    detail: input.reason,
  })
  return failGuidedSmoke(run, input.reason)
}

async function completeWithNoGoFinalEvidence(
  run: GuidedSmokeRun,
  input: GuidedSmokeTerminalStateInput,
  goNoGoDocPath?: string,
): Promise<GuidedSmokeResult> {
  run.status = "completed"
  run.conclusion = "no-go"

  if (goNoGoDocPath) {
    await maybeUpdateGoNoGoDoc(run, goNoGoDocPath, {
      nonSlash: input.nonSlash,
      keyFields: input.keyFields,
    })
  }

  await writeFinalStatusEvidence(run, {
    stage: input.stage,
    status: "completed",
    conclusion: run.conclusion,
    detail: input.reason,
  })
  return {
    runId: run.runId,
    status: run.status,
    conclusion: run.conclusion,
    evidenceDir: run.evidenceDir,
    reason: input.reason,
  }
}

export async function runGuidedSmoke(options: RunGuidedSmokeOptions = {}): Promise<GuidedSmokeResult> {
  const run = createGuidedSmokeRun(options)
  const waitTimeoutMs = options.qrWaitTimeoutMs ?? DEFAULT_QR_WAIT_TIMEOUT_MS
  const writeLine = options.writeLine ?? writeLineDefault
  const slashCaptureState: SlashCaptureState = {}
  const loadOpenClawPublicHelpers = options.loadOpenClawWeixinPublicHelpers ?? loadOpenClawWeixinPublicHelpers
  let cachedPublicHelpers: GuidedPublicHelpers | null = null
  const getPublicHelpers = async (): Promise<GuidedPublicHelpers> => {
    if (cachedPublicHelpers) {
      return cachedPublicHelpers
    }
    cachedPublicHelpers = await loadOpenClawPublicHelpers({
      ...options.publicHelpersOptions,
    })
    return cachedPublicHelpers
  }

  const loadPublicEntry = options.loadPublicEntry ?? (async () => {
    const helpers = await getPublicHelpers()
    return helpers.entry
  })
  const runSelfTest = options.runSelfTest ?? runGuidedSelfTestDefault
  const getDependencyVersions = options.getDependencyVersions ?? resolveDependencyVersionsFromPackageJson
  const runQrLogin = options.runQrLogin ?? (async (input: { waitTimeoutMs: number }) => {
    const helpers = await getPublicHelpers()
    return runQrLoginDefault({
      ...input,
      qrGateway: helpers.qrGateway,
      writeLine,
    } as {
      waitTimeoutMs: number
      qrGateway: OpenClawWeixinPublicHelpers["qrGateway"]
      writeLine: (line: string) => Promise<void> | void
    })
  })
  const captureSlashInbound = options.captureSlashInbound ?? ((command: SlashOnlyCommand) => captureSlashInboundDefault(command, {
    state: slashCaptureState,
    loadOpenClawWeixinPublicHelpers: async () => getPublicHelpers(),
    waitTimeoutMs: options.slashCaptureWaitTimeoutMs,
    pollIntervalMs: options.slashCapturePollIntervalMs,
  }))
  const runNonSlashVerification = options.runNonSlashVerification ?? (() => runDefaultNonSlashVerification({
    state: slashCaptureState,
    loadOpenClawWeixinPublicHelpers: async () => getPublicHelpers(),
  }))
  const apiSamplesDocPath =
    options.apiSamplesDocPath ??
    (run.evidenceBaseDir === DEFAULT_EVIDENCE_BASE_DIR ? DEFAULT_API_SAMPLES_DOC_PATH : undefined)
  const goNoGoDocPath =
    options.goNoGoDocPath ??
    (run.evidenceBaseDir === DEFAULT_EVIDENCE_BASE_DIR ? DEFAULT_GO_NO_GO_DOC_PATH : undefined)

  const blockedDefaults = {
    nonSlash: { passed: 0, total: 10, failedChecks: [] as string[] },
    keyFields: DEFAULT_KEY_FIELDS_CHECK,
  }

  let evidenceDirectoryCreation: PreflightData["evidenceDirectoryCreation"]
  try {
    await mkdir(run.evidenceDir, { recursive: true })
    evidenceDirectoryCreation = { status: "pass", detail: run.evidenceDir }
  } catch (error) {
    evidenceDirectoryCreation = {
      status: "fail",
      detail: `evidence directory creation failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  let publicEntryLoad: PreflightData["publicEntryLoad"]
  try {
    const entry = await loadPublicEntry()
    publicEntryLoad = { status: "pass", detail: entry.entryRelativePath }
  } catch (error) {
    publicEntryLoad = {
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    }
  }

  let selfTestResult: GuidedSmokeSelfTestResult
  try {
    selfTestResult = await runSelfTest()
  } catch (error) {
    selfTestResult = {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }

  let dependencyVersions: GuidedSmokeDependencyVersions
  let dependencyVersionResolution: PreflightData["dependencyVersionResolution"]
  try {
    dependencyVersions = getDependencyVersions()
    dependencyVersionResolution = { status: "pass", detail: "dependency versions resolved" }
  } catch (error) {
    dependencyVersions = {
      "@tencent-weixin/openclaw-weixin": "unknown",
      openclaw: "unknown",
    }
    dependencyVersionResolution = {
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    }
  }

  if (evidenceDirectoryCreation.status === "fail") {
    return failGuidedSmoke(run, evidenceDirectoryCreation.detail)
  }

  await writePreflightEvidence(run, {
    runId: run.runId,
    cwd: run.cwd,
    nodeVersion: process.versions.node,
    dependencyVersions,
    dependencyVersionResolution,
    publicEntryLoad,
    evidenceDirectoryCreation,
    selfTest: {
      status: selfTestResult.ok ? "pass" : "fail",
      detail: selfTestResult.reason ?? (selfTestResult.ok ? "self-test passed" : "self-test failed"),
    },
  })

  const preflightFailed =
    publicEntryLoad.status !== "pass" ||
    evidenceDirectoryCreation.status !== "pass" ||
    dependencyVersionResolution.status !== "pass" ||
    !selfTestResult.ok
  if (preflightFailed) {
    return failGuidedSmoke(
      run,
      publicEntryLoad.status !== "pass"
        ? publicEntryLoad.detail
        : dependencyVersionResolution.status !== "pass"
          ? dependencyVersionResolution.detail
          : selfTestResult.reason,
    )
  }

  try {
    const qrResult = await runQrLogin({ waitTimeoutMs })
    await writeQrStartEvidence(run, "pass", "loginWithQrStart succeeded", waitTimeoutMs)
    const normalizedQrResult = normalizeQrLoginResult(qrResult)
    if (!normalizedQrResult) {
      const qrFailureDetail = pickFirstString(qrResult, ["message", "detail", "reason"])
      return failWithFinalEvidence(run, {
        stage: "qr-login",
        reason: qrFailureDetail || "invalid qr login result: missing qr code or qr url",
        nonSlash: blockedDefaults.nonSlash,
        keyFields: blockedDefaults.keyFields,
      }, goNoGoDocPath)
    }
    if (normalizedQrResult.status === "timeout") {
      await writeLoginSuccessEvidence(run, "timeout", waitTimeoutMs)
      return failWithFinalEvidence(run, {
        stage: "qr-login",
        reason: "loginWithQrWait timeout",
        nonSlash: blockedDefaults.nonSlash,
        keyFields: blockedDefaults.keyFields,
      }, goNoGoDocPath)
    }
    await writeLoginSuccessEvidence(run, "success", waitTimeoutMs)
    await printGuidedPrompt("二维码登录成功，下一步请发送 `/status`", writeLine)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    await writeQrStartEvidence(run, "fail", detail, waitTimeoutMs)
    return failWithFinalEvidence(run, {
      stage: "qr-login",
      reason: detail,
      nonSlash: blockedDefaults.nonSlash,
      keyFields: blockedDefaults.keyFields,
    }, goNoGoDocPath)
  }

  let slashSampling: { ok: boolean; reason?: string }
  try {
    slashSampling = await runSlashSampling(run, captureSlashInbound, writeLine)
  } catch (error) {
    return failWithFinalEvidence(run, {
      stage: "slash-sampling",
      reason: error instanceof Error ? error.message : String(error),
      nonSlash: blockedDefaults.nonSlash,
      keyFields: blockedDefaults.keyFields,
    }, goNoGoDocPath)
  }
  if (!slashSampling.ok) {
    return failWithFinalEvidence(run, {
      stage: "slash-sampling",
      reason: slashSampling.reason ?? "slash sampling incomplete",
      nonSlash: blockedDefaults.nonSlash,
      keyFields: blockedDefaults.keyFields,
    }, goNoGoDocPath)
  }

  if (apiSamplesDocPath) {
    try {
      await updateApiSamplesSanitizedDoc(run, apiSamplesDocPath)
    } catch (error) {
      return failWithFinalEvidence(run, {
        stage: "documentation-update",
        reason: error instanceof Error ? error.message : String(error),
        nonSlash: blockedDefaults.nonSlash,
        keyFields: blockedDefaults.keyFields,
      }, goNoGoDocPath)
    }
  }

  let nonSlashVerificationRaw: unknown
  try {
    nonSlashVerificationRaw = await runNonSlashVerification()
  } catch (error) {
    return failWithFinalEvidence(run, {
      stage: "non-slash-verification",
      reason: error instanceof Error ? error.message : String(error),
      nonSlash: blockedDefaults.nonSlash,
      keyFields: blockedDefaults.keyFields,
    }, goNoGoDocPath)
  }

  const nonSlashVerification = normalizeNonSlashVerificationResult(nonSlashVerificationRaw)

  const attempts =
    nonSlashVerification.attempts.length > 0
      ? nonSlashVerification.attempts
      : [{
          input: "(missing non-slash attempt evidence)",
          inbound: null,
          warningReply: { ok: false, text: "" },
          persisted: false,
        }]

  for (let index = 0; index < attempts.length; index += 1) {
    const writeResult = await writeNonSlashAttemptEvidence(run, {
      index,
      attempt: attempts[index],
    })
    if (writeResult.sensitiveResidue) {
      return failWithFinalEvidence(run, {
        stage: "non-slash-verification",
        reason: `sensitive residue detected in ${writeResult.fileName}: ${writeResult.sensitiveResidue}`,
        nonSlash: {
          passed: nonSlashVerification.passed,
          total: nonSlashVerification.total,
          failedChecks: nonSlashVerification.failedChecks,
        },
        keyFields: nonSlashVerification.keyFieldsCheck,
      }, goNoGoDocPath)
    }
    const validationError = validateNonSlashAttempt(attempts[index])
    if (validationError) {
      return completeWithNoGoFinalEvidence(run, {
        stage: "non-slash-verification",
        reason: validationError,
        nonSlash: {
          passed: nonSlashVerification.passed,
          total: nonSlashVerification.total,
          failedChecks: nonSlashVerification.failedChecks,
        },
        keyFields: nonSlashVerification.keyFieldsCheck,
      }, goNoGoDocPath)
    }
    await printGuidedPrompt(`普通文本验证进度：${index + 1}/${attempts.length}`, writeLine)
  }

  const nonSlashPassed = nonSlashVerification.passed === 10 && nonSlashVerification.total === 10
  if (!nonSlashPassed) {
    const reason = nonSlashVerification.failedChecks[0] ?? `non-slash verification incomplete: ${nonSlashVerification.passed}/${nonSlashVerification.total}`
    return completeWithNoGoFinalEvidence(run, {
      stage: "non-slash-verification",
      reason,
      nonSlash: {
        passed: nonSlashVerification.passed,
        total: nonSlashVerification.total,
        failedChecks: nonSlashVerification.failedChecks,
      },
      keyFields: nonSlashVerification.keyFieldsCheck,
    }, goNoGoDocPath)
  }

  const keyFields = nonSlashVerification.keyFieldsCheck
  await writeKeyFieldsCheckEvidence(run, keyFields)
  const keyFieldsAllPassed =
    keyFields.login.status === "pass" &&
    keyFields.getupdates.status === "pass" &&
    keyFields.slashInbound.status === "pass" &&
    keyFields.warningReply.status === "pass"

  run.status = "completed"
  run.conclusion = keyFieldsAllPassed ? "go" : "no-go"

  if (goNoGoDocPath) {
    try {
      await updateGoNoGoDoc(run, goNoGoDocPath, {
        nonSlash: {
          passed: nonSlashVerification.passed,
          total: nonSlashVerification.total,
          failedChecks: nonSlashVerification.failedChecks,
        },
        keyFields,
      })
    } catch (error) {
      return failWithFinalEvidence(run, {
        stage: "documentation-update",
        reason: error instanceof Error ? error.message : String(error),
        nonSlash: {
          passed: nonSlashVerification.passed,
          total: nonSlashVerification.total,
          failedChecks: nonSlashVerification.failedChecks,
        },
        keyFields,
      }, goNoGoDocPath)
    }
  }

  await writeFinalStatusEvidence(run, {
    stage: "completed",
    status: "completed",
    conclusion: run.conclusion,
    detail: "guided smoke completed",
  })

  return {
    runId: run.runId,
    status: run.status,
    conclusion: run.conclusion,
    evidenceDir: run.evidenceDir,
  }
}

async function runGuidedSmokeCli(): Promise<void> {
  const result = await runGuidedSmoke()
  const output = {
    route: "guided-smoke",
    ...result,
    evidenceFiles: GUIDED_SMOKE_EVIDENCE_FILES,
  }
  process.stdout.write(`${JSON.stringify([output], null, 2)}\n`)
  process.exitCode = getGuidedSmokeExitCode(result)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runGuidedSmokeCli().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })
}
