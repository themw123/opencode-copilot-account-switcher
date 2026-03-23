import { guardSlashOnlyInput, type SlashOnlyCommand } from "./slash-guard.js"
import { loadAndRegisterOpenClawWeixin } from "./openclaw-host.js"

type SmokeMode = "self-test" | "real-account"

type OpenClawSmokeHarnessOptions = {
  mode: SmokeMode
}

type CompatHostLoader = typeof loadAndRegisterOpenClawWeixin

type CompatHostApi = Parameters<CompatHostLoader>[0]

type RunOpenClawSmokeOptions = {
  loadCompatHost?: CompatHostLoader
  inputs?: string[]
}

type SmokeGuardRejectResult = {
  route: "guard-reject"
  message: string
}

type SmokeHostSelfTestResult = {
  route: "host-self-test"
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

export type OpenClawSmokeHandleResult = SmokeGuardRejectResult | SmokeHostSelfTestResult | SmokeStubResult

export type OpenClawSmokeHarness = {
  handleIncomingText(input: string): Promise<OpenClawSmokeHandleResult>
}

function createCompatHostApiStub(): CompatHostApi {
  return {
    runtime: {
      channelRuntime: {
        mode: "slash-only",
      },
      gateway: {
        startAccount: {
          source: "wechat-smoke",
        },
      },
    },
    registerChannel() {},
    registerCli() {},
  }
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
    const plugin = await (options.loadCompatHost ?? loadAndRegisterOpenClawWeixin)(createCompatHostApiStub())
    results.push({
      route: "host-self-test",
      status: "loaded",
      pluginId: plugin.id ?? "unknown",
    })
  }

  const harness = createOpenClawSmokeHarness({ mode })
  const inputs = options.inputs ?? ["hello", "/status", "/reply smoke", "/allow once"]

  for (const input of inputs) {
    results.push(await harness.handleIncomingText(input))
  }

  return results
}
