import path from "node:path"
import { execFile } from "node:child_process"
import { readdir, readFile, stat } from "node:fs/promises"
import {
  REDACTED_ACCOUNT_ID,
  REDACTED_USER_ID,
  redactDebugBundleContent,
  type WechatDebugBundleMode,
} from "./debug-bundle-redaction.js"
import { wechatStateRoot } from "./state-paths.js"

const LARGE_IRRELEVANT_FILE_BYTES = 256 * 1024
const LARGE_FILE_SAFE_EXTENSIONS = new Set([".json", ".jsonl", ".log", ".txt"])
const REDACTED_CWD = "[REDACTED_CWD]"
const REDACTED_STATE_ROOT = "[REDACTED_STATE_ROOT]"

type BundleCategory = "state" | "diagnostics" | "metadata"

type BundleEntry = {
  bundlePath: string
  category: BundleCategory
  content: Buffer
  redacted: boolean
  sourcePath: string | null
  redactedSourcePath?: string | null
}

type BundleManifestEntry = Omit<BundleEntry, "content">

type MissingPathEntry = {
  category: "state" | "diagnostics"
  relativePath: string
}

type SkippedBundleEntry = {
  bundlePath: string
  category: "state" | "diagnostics"
  reason: "file-too-large" | "temporary-token-file" | "file-disappeared"
  sourcePath: string | null
  redactedSourcePath?: string | null
}

type EnvironmentSummary = {
  pluginVersion: string
  nodeVersion: string
  platform: string
  cwd: string
  gitHead: string | null
  mode: WechatDebugBundleMode
  stateRoot: string
  stateRootExists: boolean
  checks: Record<string, boolean>
}

export type WechatDebugBundleManifest = {
  schemaVersion: 1
  mode: WechatDebugBundleMode
  exportedAt: string
  stateRoot: string
  missingPaths: MissingPathEntry[]
  skippedEntries: SkippedBundleEntry[]
  entries: BundleManifestEntry[]
}

export type WechatDebugBundle = {
  mode: WechatDebugBundleMode
  stateRoot: string
  entries: BundleEntry[]
  manifest: WechatDebugBundleManifest
}

export type CollectWechatDebugBundleOptions = {
  mode: WechatDebugBundleMode
  stateRoot?: string
  now?: Date
  cwd?: string
  pluginVersion?: string
  gitHead?: string | null
  nodeVersion?: string
  platform?: string
}

const STATE_FILE_TARGETS = [{ relativePath: "broker.json" }] as const
const STATE_DIRECTORY_TARGETS = [
  { relativePath: "tokens" },
  { relativePath: "notifications" },
  { relativePath: "requests" },
  { relativePath: "dead-letter" },
  { relativePath: "instances" },
] as const
const DIAGNOSTIC_FILE_TARGETS = [
  { relativePath: "wechat-status-runtime.diagnostics.jsonl" },
  { relativePath: "wechat-broker.diagnostics.jsonl" },
  { relativePath: "wechat-bridge.diagnostics.jsonl" },
  { relativePath: "broker-startup.diagnostics.log" },
] as const

let packageVersionPromise: Promise<string> | null = null

export async function collectWechatDebugBundle(
  options: CollectWechatDebugBundleOptions,
): Promise<WechatDebugBundle> {
  const stateRoot = options.stateRoot ?? wechatStateRoot()
  const stateRootStat = await safeStat(stateRoot)
  if (!stateRootStat?.isDirectory()) {
    throw new Error("微信状态目录不存在，无法导出调试包")
  }

  const mode = options.mode
  const visiblePathBuilder = createVisiblePathBuilder(mode, stateRoot)
  const exportedAt = (options.now ?? new Date()).toISOString()
  const cwd = options.cwd ?? process.cwd()
  const gitHead = options.gitHead === undefined ? await detectGitHead(cwd) : options.gitHead
  const pluginVersion = options.pluginVersion ?? (await readPackageVersion())
  const nodeVersion = options.nodeVersion ?? process.version
  const platform = options.platform ?? process.platform

  const environmentSummary = await buildEnvironmentSummary({
    cwd,
    gitHead,
    mode,
    nodeVersion,
    platform,
    pluginVersion,
    stateRoot,
  })

  const entries: BundleEntry[] = []
  const manifestEntries: BundleManifestEntry[] = []
  const missingPaths: MissingPathEntry[] = []
  const skippedEntries: SkippedBundleEntry[] = []

  for (const target of STATE_FILE_TARGETS) {
    await collectFileTarget({
      category: "state",
      entries,
      manifestEntries,
      missingPaths,
      mode,
      relativePath: target.relativePath,
      skippedEntries,
      visiblePathBuilder,
      sourcePath: path.join(stateRoot, target.relativePath),
    })
  }

  for (const target of STATE_DIRECTORY_TARGETS) {
    await collectDirectoryTarget({
      category: "state",
      entries,
      manifestEntries,
      missingPaths,
      mode,
      relativePath: target.relativePath,
      skippedEntries,
      visiblePathBuilder,
      sourcePath: path.join(stateRoot, target.relativePath),
    })
  }

  for (const target of DIAGNOSTIC_FILE_TARGETS) {
    await collectFileTarget({
      category: "diagnostics",
      entries,
      manifestEntries,
      missingPaths,
      mode,
      relativePath: target.relativePath,
      skippedEntries,
      visiblePathBuilder,
      sourcePath: path.join(stateRoot, target.relativePath),
    })
  }

  const environmentEntry = createBundleEntry({
    bundlePath: "environment-summary.json",
    category: "metadata",
    content: serializeJson(environmentSummary),
    redacted: false,
    sourcePath: null,
  })
  entries.push(environmentEntry)
  manifestEntries.push(toManifestEntry(environmentEntry))

  const manifestEntryMeta: BundleManifestEntry = {
    bundlePath: "manifest.json",
    category: "metadata",
    redacted: false,
    sourcePath: null,
  }

  const manifest: WechatDebugBundleManifest = {
    schemaVersion: 1,
    mode,
    exportedAt,
    stateRoot: mode === "sanitized" ? REDACTED_STATE_ROOT : stateRoot,
    missingPaths: sortMissingPaths(missingPaths),
    skippedEntries: sortSkippedEntries(skippedEntries),
    entries: sortManifestEntries([...manifestEntries, manifestEntryMeta]),
  }

  entries.push(
    createBundleEntry({
      bundlePath: manifestEntryMeta.bundlePath,
      category: manifestEntryMeta.category,
      content: serializeJson(manifest),
      redacted: false,
      sourcePath: null,
    }),
  )

  return {
    mode,
    stateRoot,
    entries: sortBundleEntries(entries),
    manifest,
  }
}

async function collectFileTarget(input: {
  category: "state" | "diagnostics"
  entries: BundleEntry[]
  manifestEntries: BundleManifestEntry[]
  missingPaths: MissingPathEntry[]
  mode: WechatDebugBundleMode
  relativePath: string
  skippedEntries: SkippedBundleEntry[]
  visiblePathBuilder: ReturnType<typeof createVisiblePathBuilder>
  sourcePath: string
}) {
  const fileStat = await safeStat(input.sourcePath)
  if (!fileStat?.isFile()) {
    input.missingPaths.push({ category: input.category, relativePath: input.relativePath })
    return
  }

  const bundleEntry = await loadBundleEntry({
    bundlePath: bundlePathFor(input.category, input.visiblePathBuilder.toVisibleRelativePath(input.relativePath)),
    category: input.category,
    mode: input.mode,
    skippedEntries: input.skippedEntries,
    sourcePath: input.sourcePath,
    statsSize: fileStat.size,
    redactedSourcePath: input.visiblePathBuilder.toVisibleSourcePath(input.relativePath),
  })
  if (!bundleEntry) {
    return
  }

  input.entries.push(bundleEntry)
  input.manifestEntries.push(toManifestEntry(bundleEntry))
}

async function collectDirectoryTarget(input: {
  category: "state" | "diagnostics"
  entries: BundleEntry[]
  manifestEntries: BundleManifestEntry[]
  missingPaths: MissingPathEntry[]
  mode: WechatDebugBundleMode
  relativePath: string
  skippedEntries: SkippedBundleEntry[]
  visiblePathBuilder: ReturnType<typeof createVisiblePathBuilder>
  sourcePath: string
}) {
  const directoryStat = await safeStat(input.sourcePath)
  if (!directoryStat?.isDirectory()) {
    input.missingPaths.push({ category: input.category, relativePath: input.relativePath })
    return
  }

  for (const filePath of await walkFiles(input.sourcePath)) {
    const fileStat = await safeStat(filePath)
    if (!fileStat?.isFile()) {
      const relativeSubPath = toPosixPath(path.relative(input.sourcePath, filePath))
      const relativePath = path.posix.join(input.relativePath, relativeSubPath)
      input.skippedEntries.push({
        bundlePath: bundlePathFor(input.category, input.visiblePathBuilder.peekVisibleRelativePath(relativePath)),
        category: input.category,
        reason: "file-disappeared",
        sourcePath: input.mode === "sanitized" ? null : filePath,
        ...(input.mode === "sanitized"
          ? { redactedSourcePath: input.visiblePathBuilder.peekVisibleSourcePath(relativePath) }
          : {}),
      })
      continue
    }

    const relativeSubPath = toPosixPath(path.relative(input.sourcePath, filePath))
    const relativePath = path.posix.join(input.relativePath, relativeSubPath)
    if (shouldSkipTemporaryTokenFile(input.mode, relativePath, filePath)) {
      input.skippedEntries.push({
        bundlePath: bundlePathFor(input.category, input.visiblePathBuilder.peekVisibleRelativePath(relativePath)),
        category: input.category,
        reason: "temporary-token-file",
        sourcePath: null,
        redactedSourcePath: input.visiblePathBuilder.peekVisibleSourcePath(relativePath),
      })
      continue
    }

    const bundleEntry = await loadBundleEntry({
      bundlePath: bundlePathFor(input.category, input.visiblePathBuilder.toVisibleRelativePath(relativePath)),
      category: input.category,
      mode: input.mode,
      skippedEntries: input.skippedEntries,
      sourcePath: filePath,
      statsSize: fileStat.size,
      redactedSourcePath: input.visiblePathBuilder.toVisibleSourcePath(relativePath),
    })
    if (!bundleEntry) {
      continue
    }

    input.entries.push(bundleEntry)
    input.manifestEntries.push(toManifestEntry(bundleEntry))
  }
}

async function loadBundleEntry(input: {
  bundlePath: string
  category: "state" | "diagnostics"
  mode: WechatDebugBundleMode
  skippedEntries: SkippedBundleEntry[]
  sourcePath: string
  statsSize: number
  redactedSourcePath: string
}): Promise<BundleEntry | null> {
  const normalizedRedactedSourcePath =
    input.redactedSourcePath !== input.sourcePath ? input.redactedSourcePath : null

  if (shouldSkipLargeIrrelevantFile(input.sourcePath, input.statsSize)) {
    input.skippedEntries.push({
      bundlePath: input.bundlePath,
      category: input.category,
      reason: "file-too-large",
      sourcePath: normalizedRedactedSourcePath ? null : input.sourcePath,
      ...(normalizedRedactedSourcePath ? { redactedSourcePath: normalizedRedactedSourcePath } : {}),
    })
    return null
  }

  let content: Buffer
  try {
    content = await readFile(input.sourcePath)
  } catch (error) {
    if (isMissingError(error)) {
      input.skippedEntries.push({
        bundlePath: input.bundlePath,
        category: input.category,
        reason: "file-disappeared",
        sourcePath: normalizedRedactedSourcePath ? null : input.sourcePath,
        ...(normalizedRedactedSourcePath ? { redactedSourcePath: normalizedRedactedSourcePath } : {}),
      })
      return null
    }
    throw error
  }

  const redacted = input.mode === "sanitized"
  return createBundleEntry({
    bundlePath: input.bundlePath,
    category: input.category,
    content: redacted ? redactDebugBundleContent(content, { bundlePath: input.bundlePath, mode: input.mode }) : content,
    redacted,
    sourcePath: input.sourcePath,
    redactedSourcePath: normalizedRedactedSourcePath,
  })
}

async function buildEnvironmentSummary(input: {
  cwd: string
  gitHead: string | null
  mode: WechatDebugBundleMode
  nodeVersion: string
  platform: string
  pluginVersion: string
  stateRoot: string
}): Promise<EnvironmentSummary> {
  const checks: Record<string, boolean> = {
    "broker.json": await pathExists(path.join(input.stateRoot, "broker.json")),
    tokens: await pathExists(path.join(input.stateRoot, "tokens")),
    notifications: await pathExists(path.join(input.stateRoot, "notifications")),
    requests: await pathExists(path.join(input.stateRoot, "requests")),
    "dead-letter": await pathExists(path.join(input.stateRoot, "dead-letter")),
    instances: await pathExists(path.join(input.stateRoot, "instances")),
    "wechat-status-runtime.diagnostics.jsonl": await pathExists(
      path.join(input.stateRoot, "wechat-status-runtime.diagnostics.jsonl"),
    ),
    "wechat-broker.diagnostics.jsonl": await pathExists(path.join(input.stateRoot, "wechat-broker.diagnostics.jsonl")),
    "wechat-bridge.diagnostics.jsonl": await pathExists(path.join(input.stateRoot, "wechat-bridge.diagnostics.jsonl")),
    "broker-startup.diagnostics.log": await pathExists(path.join(input.stateRoot, "broker-startup.diagnostics.log")),
  }

  return {
    pluginVersion: input.pluginVersion,
    nodeVersion: input.nodeVersion,
    platform: input.platform,
    cwd: input.mode === "sanitized" ? REDACTED_CWD : input.cwd,
    gitHead: input.gitHead,
    mode: input.mode,
    stateRoot: input.mode === "sanitized" ? REDACTED_STATE_ROOT : input.stateRoot,
    stateRootExists: true,
    checks,
  }
}

async function walkFiles(rootPath: string): Promise<string[]> {
  const entries = await readdir(rootPath, { withFileTypes: true })
  const sortedEntries = [...entries].sort((left, right) => left.name.localeCompare(right.name))
  const files: string[] = []

  for (const entry of sortedEntries) {
    const entryPath = path.join(rootPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(entryPath)))
      continue
    }
    if (entry.isFile()) {
      files.push(entryPath)
    }
  }

  return files
}

function shouldSkipLargeIrrelevantFile(filePath: string, size: number): boolean {
  if (size < LARGE_IRRELEVANT_FILE_BYTES) {
    return false
  }
  return !LARGE_FILE_SAFE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

function shouldSkipTemporaryTokenFile(mode: WechatDebugBundleMode, relativePath: string, sourcePath: string): boolean {
  return mode === "sanitized" && toPosixPath(relativePath).startsWith("tokens/") && path.basename(sourcePath).endsWith(".tmp")
}

function createVisiblePathBuilder(mode: WechatDebugBundleMode, stateRoot: string) {
  const accountPlaceholders = new Map<string, string>()
  const userPlaceholders = new Map<string, string>()
  const visibleRoot = mode === "sanitized" ? REDACTED_STATE_ROOT : stateRoot

  const mapVisibleRelativePath = (
    relativePath: string,
    accountMap: Map<string, string>,
    userMap: Map<string, string>,
  ): string => {
    if (mode !== "sanitized") {
      return toPosixPath(relativePath)
    }

    const segments = toPosixPath(relativePath).split("/")
    if (segments[0] !== "tokens" || segments.length < 2) {
      return toPosixPath(relativePath)
    }

    segments[1] = getPlaceholder(accountMap, segments[1], REDACTED_ACCOUNT_ID)
    for (let index = 2; index < segments.length; index += 1) {
      const segment = segments[index]
      const extension = index === segments.length - 1 ? path.posix.extname(segment) : ""
      const userId = extension.length > 0 ? segment.slice(0, -extension.length) : segment
      segments[index] = `${getPlaceholder(userMap, userId, REDACTED_USER_ID)}${extension}`
    }
    return segments.join("/")
  }

  return {
    toVisibleRelativePath(relativePath: string) {
      return mapVisibleRelativePath(relativePath, accountPlaceholders, userPlaceholders)
    },
    peekVisibleRelativePath(relativePath: string) {
      return mapVisibleRelativePath(relativePath, new Map(accountPlaceholders), new Map(userPlaceholders))
    },
    toVisibleSourcePath(relativePath: string) {
      return path.join(visibleRoot, ...mapVisibleRelativePath(relativePath, accountPlaceholders, userPlaceholders).split("/"))
    },
    peekVisibleSourcePath(relativePath: string) {
      return path.join(visibleRoot, ...mapVisibleRelativePath(relativePath, new Map(accountPlaceholders), new Map(userPlaceholders)).split("/"))
    },
  }
}

function getPlaceholder(map: Map<string, string>, value: string, baseLabel: string): string {
  const existing = map.get(value)
  if (existing) {
    return existing
  }

  const placeholder = `${baseLabel.slice(0, -1)}_${map.size + 1}]`
  map.set(value, placeholder)
  return placeholder
}

function createBundleEntry(entry: BundleEntry): BundleEntry {
  return {
    bundlePath: entry.bundlePath,
    category: entry.category,
    content: Buffer.from(entry.content),
    redacted: entry.redacted,
    sourcePath: entry.sourcePath,
    ...(entry.redactedSourcePath ? { redactedSourcePath: entry.redactedSourcePath } : {}),
  }
}

function toManifestEntry(entry: BundleEntry): BundleManifestEntry {
  return {
    bundlePath: entry.bundlePath,
    category: entry.category,
    redacted: entry.redacted,
    sourcePath: entry.redactedSourcePath ? null : entry.sourcePath,
    ...(entry.redactedSourcePath ? { redactedSourcePath: entry.redactedSourcePath } : {}),
  }
}

function bundlePathFor(category: "state" | "diagnostics", relativePath: string): string {
  return `${category}/${toPosixPath(relativePath)}`
}

function serializeJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function sortBundleEntries(entries: BundleEntry[]): BundleEntry[] {
  return [...entries].sort((left, right) => left.bundlePath.localeCompare(right.bundlePath))
}

function sortManifestEntries(entries: BundleManifestEntry[]): BundleManifestEntry[] {
  return [...entries].sort((left, right) => left.bundlePath.localeCompare(right.bundlePath))
}

function sortMissingPaths(entries: MissingPathEntry[]): MissingPathEntry[] {
  return [...entries].sort((left, right) => {
    if (left.category !== right.category) {
      return left.category.localeCompare(right.category)
    }
    return left.relativePath.localeCompare(right.relativePath)
  })
}

function sortSkippedEntries(entries: SkippedBundleEntry[]): SkippedBundleEntry[] {
  return [...entries].sort((left, right) => left.bundlePath.localeCompare(right.bundlePath))
}

function toPosixPath(filePath: string): string {
  return filePath.replaceAll("\\", "/")
}

async function safeStat(filePath: string) {
  try {
    return await stat(filePath)
  } catch (error) {
    if (isMissingError(error)) {
      return null
    }
    throw error
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  return (await safeStat(filePath)) !== null
}

function isMissingError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

async function readPackageVersion(): Promise<string> {
  packageVersionPromise ??= readFile(new URL("../../package.json", import.meta.url), "utf8").then((content) => {
    const parsed = JSON.parse(content) as { version?: unknown }
    return typeof parsed.version === "string" ? parsed.version : "unknown"
  })
  return packageVersionPromise
}

async function detectGitHead(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "HEAD"], { cwd }, (error, stdout) => {
      if (error) {
        resolve(null)
        return
      }

      const gitHead = stdout.trim()
      resolve(gitHead.length > 0 ? gitHead : null)
    })
  })
}
