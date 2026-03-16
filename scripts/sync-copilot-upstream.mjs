import { mkdir, readFile, writeFile } from "node:fs/promises"
import { execFile as execFileCallback } from "node:child_process"
import path from "node:path"
import process from "node:process"
import { promisify } from "node:util"

const execFile = promisify(execFileCallback)
const defaultOutput = path.resolve("src/upstream/copilot-plugin.snapshot.ts")
const upstreamRepo = process.env.OPENCODE_SYNC_UPSTREAM_REPO ?? "anomalyco/opencode"
const upstreamBranch = process.env.OPENCODE_SYNC_UPSTREAM_BRANCH ?? "dev"
const upstreamPath = "packages/opencode/src/plugin/copilot.ts"
const rawBaseUrl = (process.env.OPENCODE_SYNC_RAW_BASE_URL ?? "https://raw.githubusercontent.com").replace(/\/$/, "")
const githubApiBaseUrl = (process.env.OPENCODE_SYNC_GITHUB_API_BASE_URL ?? "https://api.github.com").replace(/\/$/, "")
const ghCommand = process.env.OPENCODE_SYNC_GH_COMMAND ?? "gh"
const defaultSourceUrl = `${rawBaseUrl}/${upstreamRepo}/${upstreamBranch}/${upstreamPath}`
const canonicalRepositoryUrl = `https://github.com/${upstreamRepo}`

function formatError(error) {
  return error instanceof Error ? error.message : String(error)
}

function createUpstreamFetchError(message, cause) {
  const error = new Error(`upstream fetch failed\n${message}`)
  error.cause = cause
  error.code = "UPSTREAM_FETCH_FAILED"
  return error
}

function createSnapshotDriftError(message) {
  const error = new Error(`snapshot drift detected\n${message}`)
  error.code = "SNAPSHOT_DRIFT_DETECTED"
  return error
}

function parseArgs(argv) {
  const result = {
    check: false,
    output: defaultOutput,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--check") {
      result.check = true
      continue
    }

    if (arg === "--source") {
      result.source = argv[i + 1]
      i += 1
      continue
    }

    if (arg === "--output") {
      result.output = path.resolve(argv[i + 1])
      i += 1
      continue
    }

    if (arg === "--upstream-commit") {
      result.upstreamCommit = argv[i + 1]
      i += 1
      continue
    }

    if (arg === "--sync-date") {
      result.syncDate = argv[i + 1]
      i += 1
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  return result
}

function resolveDefaultSource() {
  return defaultSourceUrl
}

async function fetchJson(url) {
  let response
  try {
    response = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "opencode-copilot-account-switcher-sync",
      },
    })
  } catch (error) {
    throw createUpstreamFetchError(`Failed to fetch metadata: ${formatError(error)}`, error)
  }
  if (!response.ok) {
    throw createUpstreamFetchError(`Failed to fetch metadata: ${response.status}`)
  }
  return response.json()
}

async function fetchJsonWithGhFallback(pathname) {
  try {
    return await fetchJson(`${githubApiBaseUrl}${pathname}`)
  } catch (error) {
    if (error?.code !== "UPSTREAM_FETCH_FAILED") {
      throw error
    }

    try {
      const target = pathname.replace(/^\//, "")
      const { stdout } = process.platform === "win32"
        ? await execFile(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", "call", ghCommand, "api", target], {
            cwd: process.cwd(),
            env: process.env,
          })
        : await execFile(ghCommand, ["api", target], {
            cwd: process.cwd(),
            env: process.env,
          })
      return JSON.parse(stdout)
    } catch (ghError) {
      throw createUpstreamFetchError(`${formatError(error)}\ngh api failed: ${formatError(ghError)}`, ghError)
    }
  }
}

async function resolveCanonicalUpstreamCommit() {
  const payload = await fetchJsonWithGhFallback(`/repos/${upstreamRepo}/branches/${upstreamBranch}`)
  const sha = payload?.commit?.sha
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error("Unable to resolve canonical upstream commit SHA")
  }
  return sha.toLowerCase()
}

async function readText(source) {
  if (/^https?:\/\//.test(source)) {
    let response
    try {
      response = await fetch(source)
    } catch (error) {
      throw createUpstreamFetchError(`Failed to fetch source: ${formatError(error)}`, error)
    }
    if (!response.ok) {
      throw createUpstreamFetchError(`Failed to fetch source: ${response.status}`)
    }
    return response.text()
  }

  return readFile(path.resolve(source), "utf8")
}

function normalize(text) {
  return text.replace(/\r\n/g, "\n")
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length
}

function ensureSingleMatch(text, pattern, label) {
  const count = countMatches(text, pattern)
  if (count !== 1) {
    throw new Error(`Expected exactly one ${label} anchor, found ${count}`)
  }
}

function stripImports(source) {
  const match = source.match(/^(?:import[^\n]*\n)+\n?/)
  if (!match) throw new Error("Unable to locate import block in upstream source")
  return source.slice(match[0].length).trimStart()
}

function buildHeader(meta) {
  return `// @ts-nocheck
import { AsyncLocalStorage } from "node:async_hooks"

/*
 * Upstream snapshot source:
 * - Repository: ${meta.repositoryUrl}
 * - Original path: ${upstreamPath}
 * - Sync date: ${meta.syncDate}
 * - Upstream commit: ${meta.upstreamCommit}
 *
 * Generated by scripts/sync-copilot-upstream.mjs.
 * Do not edit this file directly; update the sync script and regenerate it.
 */`
}

function buildShimBlock() {
  return `/* LOCAL_SHIMS_START */
type RequestInfo = Request | URL | string

type Hooks = any
type PluginInput = any
const officialCopilotExportBridgeStorage = new AsyncLocalStorage<{
  fetchImpl: typeof globalThis.fetch
  version: string
}>()

const officialCopilotExportBridge = {
  version: "snapshot",
  fetchImpl(request: RequestInfo | URL, init?: RequestInit) {
    return globalThis.fetch(request, init)
  },
  async run(options: { fetchImpl?: typeof globalThis.fetch; version?: string } = {}, fn: () => Promise<any>) {
    return officialCopilotExportBridgeStorage.run(
      {
        fetchImpl: options.fetchImpl ?? this.fetchImpl,
        version: options.version ?? this.version,
      },
      fn,
    )
  },
}

const Installation = {
  get VERSION() {
    return officialCopilotExportBridgeStorage.getStore()?.version ?? officialCopilotExportBridge.version
  },
  set VERSION(value) {
    officialCopilotExportBridge.version = value
  },
}

function fetch(request: RequestInfo | URL, init?: RequestInit) {
  return (officialCopilotExportBridgeStorage.getStore()?.fetchImpl ?? officialCopilotExportBridge.fetchImpl)(request, init)
}

function iife(fn) {
  return fn()
}

function sleep(ms) {
  return Bun.sleep(ms)
}

const Bun = {
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  },
}
/* LOCAL_SHIMS_END */`
}

function buildExportBridgeBlock() {
  return `/* GENERATED_EXPORT_BRIDGE_START */
export { officialCopilotExportBridge }
/* GENERATED_EXPORT_BRIDGE_END */`
}

function validateSnapshotMarkers(source) {
  const shims = {
    label: "LOCAL_SHIMS",
    start: /\/\* LOCAL_SHIMS_START \*\//g,
    end: /\/\* LOCAL_SHIMS_END \*\//g,
  }
  const shimsStart = countMatches(source, shims.start)
  const shimsEnd = countMatches(source, shims.end)
  if (shimsStart !== 1 || shimsEnd !== 1) {
    throw new Error(`Invalid ${shims.label} markers in snapshot`)
  }

  const legacy = {
    label: "GENERATED_EXPORTS",
    start: /\/\* GENERATED_EXPORTS_START \*\//g,
    end: /\/\* GENERATED_EXPORTS_END \*\//g,
  }
  const bridge = {
    label: "GENERATED_EXPORT_BRIDGE",
    start: /\/\* GENERATED_EXPORT_BRIDGE_START \*\//g,
    end: /\/\* GENERATED_EXPORT_BRIDGE_END \*\//g,
  }
  const legacyStart = countMatches(source, legacy.start)
  const legacyEnd = countMatches(source, legacy.end)
  const bridgeStart = countMatches(source, bridge.start)
  const bridgeEnd = countMatches(source, bridge.end)
  const hasLegacy = legacyStart > 0 || legacyEnd > 0
  const hasBridge = bridgeStart > 0 || bridgeEnd > 0

  if (hasLegacy && hasBridge) {
    throw new Error("Invalid generated export markers in snapshot")
  }

  if (hasLegacy) {
    if (legacyStart !== 1 || legacyEnd !== 1) {
      throw new Error(`Invalid ${legacy.label} markers in snapshot`)
    }
    return
  }

  if (bridgeStart !== 1 || bridgeEnd !== 1) {
    throw new Error(`Invalid ${bridge.label} markers in snapshot`)
  }
}

function isRepositoryOutput(output) {
  return path.resolve(output) === defaultOutput
}

function buildSnapshot(source, meta) {
  const normalized = normalize(source).trim() + "\n"
  ensureSingleMatch(normalized, /^export async function CopilotAuthPlugin\(input: PluginInput\): Promise<Hooks> \{/gm, "CopilotAuthPlugin")
  ensureSingleMatch(normalized, /async loader\(getAuth, provider\) \{/g, "auth.loader")
  ensureSingleMatch(normalized, /"chat\.headers": async \(incoming, output\) => \{/g, "chat.headers")
  ensureSingleMatch(normalized, /\n\s*methods: \[/g, "methods")
  const stripped = stripImports(normalized)

  return `${buildHeader(meta)}\n\n${buildShimBlock()}\n\n${stripped.trimEnd()}\n\n${buildExportBridgeBlock()}\n`
}

function summarizeMismatch(expected, actual) {
  const expectedLines = expected.split("\n")
  const actualLines = actual.split("\n")
  const limit = Math.max(expectedLines.length, actualLines.length)

  for (let index = 0; index < limit; index += 1) {
    if (expectedLines[index] === actualLines[index]) continue
    return [
      `first difference at line ${index + 1}`,
      `expected: ${expectedLines[index] ?? "<eof>"}`,
      `actual:   ${actualLines[index] ?? "<eof>"}`,
    ].join("\n")
  }

  return "files differ"
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const source = args.source ?? resolveDefaultSource()
  const upstreamCommit = args.upstreamCommit ?? (!args.source ? await resolveCanonicalUpstreamCommit() : undefined)
  if (isRepositoryOutput(args.output) && !upstreamCommit) {
    throw new Error("Repository snapshot generation requires --upstream-commit when --source is provided")
  }
  const currentBuffer = await readFile(args.output).catch(() => Buffer.alloc(0))
  const current = currentBuffer.toString("utf8")
  const normalizedCurrent = normalize(current)
  if (current && (isRepositoryOutput(args.output) || current.includes("LOCAL_SHIMS_START") || current.includes("GENERATED_EXPORTS_START") || current.includes("GENERATED_EXPORT_BRIDGE_START"))) {
    validateSnapshotMarkers(normalizedCurrent)
  }
  const meta = {
    repositoryUrl: canonicalRepositoryUrl,
    upstreamCommit: upstreamCommit ?? "unknown",
    syncDate: args.syncDate ?? new Date().toISOString().slice(0, 10),
  }
  const generated = buildSnapshot(await readText(source), meta)

  if (args.check) {
    try {
      if (current) validateSnapshotMarkers(normalizedCurrent)
    } catch (error) {
      process.stdout.write(`snapshot drift detected\n${formatError(error)}\n`)
      process.exitCode = 1
      return
    }
    if (currentBuffer.equals(Buffer.from(generated, "utf8"))) {
      process.stdout.write("in-sync\n")
      return
    }

    process.stdout.write(`snapshot drift detected\n${summarizeMismatch(generated, current)}\n`)
    process.exitCode = 1
    return
  }

  await mkdir(path.dirname(args.output), { recursive: true })
  await writeFile(args.output, generated, "utf8")
  process.stdout.write(`wrote ${args.output}\n`)
}

try {
  await main()
} catch (error) {
  process.stderr.write(`${formatError(error)}\n`)
  process.exitCode = 1
}
