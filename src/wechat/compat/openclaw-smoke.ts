import { guardSlashOnlyInput, type SlashOnlyCommand } from "./slash-guard.js"
import {
  loadOpenClawWeixinPublicHelpers,
  type OpenClawWeixinPublicHelpers,
  type OpenClawWeixinPublicHelpersLoaderOptions,
} from "./openclaw-public-helpers.js"
type SmokeMode = "self-test" | "real-account"

const REAL_ACCOUNT_REQUIRED_ENV_VARS = [
  "WECHAT_REAL_ACCOUNT_ID",
  "WECHAT_DEVICE_ID",
  "WECHAT_CONTEXT_TOKEN",
  "WECHAT_BOT_TOKEN",
] as const

const REAL_ACCOUNT_MANUAL_STEPS = [
  "执行 npm run wechat:smoke:real-account -- --dry-run，确认仅输出准备信息",
  "确认所有必填环境变量已配置，再执行 npm run wechat:smoke:guided 完成真实账号手测",
  "按 evidence/README.md 记录 blocked 或 known-unknown，并产出脱敏样本",
] as const

const REAL_ACCOUNT_ARTIFACT_PATHS = [
  "docs/superpowers/wechat-stage-a/evidence/README.md",
  "docs/superpowers/wechat-stage-a/api-samples-sanitized.md",
  "docs/superpowers/wechat-stage-a/go-no-go.md",
] as const

type OpenClawSmokeHarnessOptions = {
  mode: SmokeMode
}

type PublicHelpersLoader = (options?: OpenClawWeixinPublicHelpersLoaderOptions) => Promise<OpenClawWeixinPublicHelpers>

type RunOpenClawSmokeOptions = {
  loadOpenClawWeixinPublicHelpers?: PublicHelpersLoader
  publicHelpersOptions?: OpenClawWeixinPublicHelpersLoaderOptions
  inputs?: string[]
  dryRun?: boolean
  argv?: string[]
}

type SmokeGuardRejectResult = {
  route: "guard-reject"
  message: string
}

type SmokeHostSelfTestResult = {
  route: "public-self-test"
  status: "loaded"
  pluginId: string
}

type SmokeStubResult = {
  route: "stub"
  command: SlashOnlyCommand
  argument: string
  stubReason: "stage-a-command-stub"
  mode: SmokeMode
}

type SmokeRealAccountDryRunResult = {
  route: "real-account-dry-run"
  binding: "skipped"
  requiredEnvVars: readonly string[]
  missingEnvVars: readonly string[]
  manualSteps: readonly string[]
  artifactPaths: readonly string[]
}

export type OpenClawSmokeHandleResult =
  | SmokeGuardRejectResult
  | SmokeHostSelfTestResult
  | SmokeStubResult
  | SmokeRealAccountDryRunResult

export type OpenClawSmokeHarness = {
  handleIncomingText(input: string): Promise<OpenClawSmokeHandleResult>
}

export function resolveRealAccountDryRunFlag(options: Pick<RunOpenClawSmokeOptions, "dryRun" | "argv"> = {}): boolean {
  if (options.dryRun === true) {
    return true
  }

  const argv = options.argv ?? process.argv.slice(2)
  return argv.includes("--dry-run")
}

export function createRealAccountDryRunPreparation(): SmokeRealAccountDryRunResult {
  const missingEnvVars = REAL_ACCOUNT_REQUIRED_ENV_VARS.filter((name) => !process.env[name]?.trim())
  return {
    route: "real-account-dry-run",
    binding: "skipped",
    requiredEnvVars: [...REAL_ACCOUNT_REQUIRED_ENV_VARS],
    missingEnvVars,
    manualSteps: [...REAL_ACCOUNT_MANUAL_STEPS],
    artifactPaths: [...REAL_ACCOUNT_ARTIFACT_PATHS],
  }
}

export function sanitizeOpenClawEvidenceSample(input: string): string {
  return input
    .replace(/(contextToken\s*[=:]\s*)([^\s\n]+)/g, "$1[REDACTED_CONTEXT_TOKEN]")
    .replace(/("contextToken"\s*:\s*")([^"]+)(")/g, "$1[REDACTED_CONTEXT_TOKEN]$3")
    .replace(/(context_token\s*[=:]\s*)([^\s\n]+)/gi, "$1[REDACTED_CONTEXT_TOKEN]")
    .replace(/("context_token"\s*:\s*")([^"]+)(")/gi, "$1[REDACTED_CONTEXT_TOKEN]$3")
    .replace(/(bot_token\s*[=:]\s*)([^\s\n]+)/gi, "$1[REDACTED_BOT_TOKEN]")
    .replace(/("bot_token"\s*:\s*")([^"]+)(")/gi, "$1[REDACTED_BOT_TOKEN]$3")
    .replace(/(authorization\s*:\s*bearer\s+)([^\s\n]+)/gi, "$1[REDACTED_AUTHORIZATION]")
    .replace(/("authorization"\s*:\s*")Bearer\s+([^"]+)(")/gi, "$1Bearer [REDACTED_AUTHORIZATION]$3")
    .replace(/(userId\s*[=:]\s*)([^\s\n]+)/gi, "$1[REDACTED_USER_ID]")
    .replace(/("userId"\s*:\s*")([^"]+)(")/gi, "$1[REDACTED_USER_ID]$3")
    .replace(/(botId\s*[=:]\s*)([^\s\n]+)/gi, "$1[REDACTED_BOT_ID]")
    .replace(/("botId"\s*:\s*")([^"]+)(")/gi, "$1[REDACTED_BOT_ID]$3")
    .replace(/(qrCode\s*[=:]\s*)([^\s\n]+)/gi, "$1[REDACTED_QR_CODE]")
    .replace(/("qrCode"\s*:\s*")([^"]+)(")/gi, "$1[REDACTED_QR_CODE]$3")
    .replace(/(deviceId\s*[=:]\s*)([^\s\n]+)/gi, "$1[REDACTED_DEVICE_ID]")
    .replace(/("deviceId"\s*:\s*")([^"]+)(")/gi, "$1[REDACTED_DEVICE_ID]$3")
    .replace(/(messageId\s*[=:]\s*)([^\s\n]+)/gi, "$1[REDACTED_MESSAGE_ID]")
    .replace(/("messageId"\s*:\s*")([^"]+)(")/gi, "$1[REDACTED_MESSAGE_ID]$3")
    .replace(/(requestId\s*[=:]\s*)([^\s\n]+)/gi, "$1[REDACTED_REQUEST_ID]")
    .replace(/("requestId"\s*:\s*")([^"]+)(")/gi, "$1[REDACTED_REQUEST_ID]$3")
}

export function createOpenClawSmokeHarness(options: OpenClawSmokeHarnessOptions): OpenClawSmokeHarness {
  return {
    async handleIncomingText(input: string): Promise<OpenClawSmokeHandleResult> {
      const guarded = guardSlashOnlyInput(input)
      if (!guarded.accepted) {
        return {
          route: "guard-reject",
          message: guarded.message,
        }
      }

      return {
        route: "stub",
        command: guarded.command,
        argument: guarded.argument,
        stubReason: "stage-a-command-stub",
        mode: options.mode,
      }
    },
  }
}

export async function runOpenClawSmoke(mode: SmokeMode, options: RunOpenClawSmokeOptions = {}): Promise<OpenClawSmokeHandleResult[]> {
  const results: OpenClawSmokeHandleResult[] = []
  if (mode === "self-test") {
    const helpers = await (options.loadOpenClawWeixinPublicHelpers ?? loadOpenClawWeixinPublicHelpers)(options.publicHelpersOptions)
    results.push({
      route: "public-self-test",
      status: "loaded",
      pluginId: helpers.pluginId,
    })
  }

  if (mode === "real-account") {
    results.push(createRealAccountDryRunPreparation())
    return results
  }

  const harness = createOpenClawSmokeHarness({ mode })
  const inputs = options.inputs ?? ["hello", "/status", "/reply smoke", "/allow once"]

  for (const input of inputs) {
    results.push(await harness.handleIncomingText(input))
  }

  return results
}
